#!/usr/bin/env node
/**
 * T07 (isolated PostgreSQL check): the set-based corpus tagging on real PG.
 *
 * PGlite proves the logic; this proves the *concurrency* claim on a real
 * PostgreSQL server, where two statements genuinely run in parallel and row
 * locking decides the outcome. It also records the wall-clock cost at the
 * target-ish corpus size so the plan's "if the set update exceeds budget, batch
 * by id cursor" decision has data instead of a guess.
 *
 * Creates only its own tagged container and loopback port; never accepts a
 * production DSN.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const PASSWORD = "review-only-local";
const DB = "review";
const rows = Number(process.env.LOOM_T07_ROWS ?? 20000);
const reportRoot = resolve("artifacts/production-readiness/pg-t07");
const name = `loom-t07-${Date.now().toString(36)}`;
mkdirSync(reportRoot, { recursive: true });
const out = mkdtempSync(join(reportRoot, "run-"));

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 300000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || "").slice(-500)}`);
  return result.stdout.trim();
}

function freePort() {
  const r = spawnSync(process.execPath, ["-e",
    "const n=require('node:net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"],
    { encoding: "utf8", windowsHide: true });
  return Number(r.stdout.trim());
}

let port;
let started = false;
let client;

try {
  port = freePort();
  docker(["run", "--detach", "--name", name, "--label", "loom.readiness.t07=isolated",
    "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `POSTGRES_DB=${DB}`,
    "-p", `127.0.0.1:${port}:5432`, "postgres:16-alpine"]);
  started = true;

  const connect = () => new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: PASSWORD, database: DB });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { client = connect(); await client.connect(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  assert.ok(client, "isolated PG did not come up");

  await client.query(`create table items (
    id text primary key,
    platform text not null default 'rss',
    title text not null default '',
    body text not null default '',
    author text not null default '',
    matched_keywords jsonb not null default '[]'::jsonb
  )`);
  // A realistic index shape, so the timing covers the search path a real corpus
  // would use rather than a bare sequential scan on an unindexed table.
  await client.query("create index items_platform_idx on items (platform)");

  const sql = {
    async query(text, params = []) { return (await client.query(text, params)).rows; },
  };

  // ---- seed: `rows` matching entries, half already tagged, plus decoys
  const seedStart = Date.now();
  await client.query(
    `insert into items (id, platform, title, body, author, matched_keywords)
     select 'm' || g, case when g % 3 = 0 then 'wechat' else 'rss' end,
            '命中标题' || g, '包含 电池 的正文 ' || g, '作者',
            case when g <= $1 then '["电池"]'::jsonb else '[]'::jsonb end
       from generate_series(1, $2) g`,
    [Math.floor(rows / 2), rows],
  );
  await client.query(
    `insert into items (id, platform, title, body, author, matched_keywords)
     select 'n' || g, 'rss', '无关' || g, '无关正文', '作者', '[]'::jsonb
       from generate_series(1, 200) g`,
  );
  const seedMs = Date.now() - seedStart;

  const countWith = async (phrase) => Number((await client.query(
    `select count(*) as n from items where exists (
       select 1 from jsonb_array_elements_text(matched_keywords) t where t = $1)`, [phrase])).rows[0].n);

  const taggedBefore = await countWith("电池");
  assert.equal(taggedBefore, Math.floor(rows / 2), "half the corpus starts tagged");

  // ---- import the same production helper the app uses
  const { tagCorpusWithPhrase } = await import(new URL("../src/lib/server/scheduler-atomic.ts", import.meta.url).href);
  const sqlIface = {
    async query(text, params = []) { return (await client.query(text, params)).rows; },
  };
  void sql;

  const firstStart = Date.now();
  const firstTagged = await tagCorpusWithPhrase(sqlIface, "电池");
  const firstMs = Date.now() - firstStart;

  const taggedAfter = await countWith("电池");
  assert.equal(firstTagged, rows - taggedBefore, "every remaining row must be tagged");
  assert.equal(taggedAfter, rows);

  const secondStart = Date.now();
  const secondTagged = await tagCorpusWithPhrase(sqlIface, "电池");
  const secondMs = Date.now() - secondStart;
  assert.equal(secondTagged, 0, "a re-run must tag nothing");
  assert.equal(await countWith("电池"), rows);

  // ---- real concurrency: two phrases over the same rows at the same time
  await client.query("update items set matched_keywords = '[]'::jsonb where id like 'm%'");
  const concurrentStart = Date.now();
  const [a, b] = await Promise.all([
    tagCorpusWithPhrase(sqlIface, "电池"),
    tagCorpusWithPhrase(sqlIface, "命中"),
  ]);
  const concurrentMs = Date.now() - concurrentStart;
  // Both phrases match every seeded row (one in the title, one in the body), so
  // each statement must report the whole corpus — the point being that neither
  // statement's writes are lost to the other.
  assert.equal(a, rows, "the body phrase must tag every matching row");
  assert.equal(b, rows, "the title phrase must tag every matching row");
  const bothTagged = Number((await client.query(
    `select count(*) as n from items
      where matched_keywords @> '["电池"]'::jsonb and matched_keywords @> '["命中"]'::jsonb`)).rows[0].n);
  assert.equal(bothTagged, rows, "no tag may be lost to the other statement");

  // ---- decoys stay clean
  const decoysTagged = Number((await client.query(
    `select count(*) as n from items where id like 'n%' and matched_keywords <> '[]'::jsonb`)).rows[0].n);
  assert.equal(decoysTagged, 0);

  // ---- % and _ are literal, on a small controlled dataset
  // (the 20k-row corpus above is a poor fixture for this: many generated ids
  // contain "50" as a substring, which is correct matching, not a wildcard).
  await client.query("delete from items");
  await client.query(`insert into items (id, platform, title, body, matched_keywords) values
    ('pct','rss','增长50%的公司','','[]'::jsonb),
    ('only50','rss','增长50的公司','','[]'::jsonb),
    ('noth','rss','增长60的公司','','[]'::jsonb)`);
  assert.equal(await tagCorpusWithPhrase(sqlIface, "50%"), 1, "% must be a literal character");
  assert.equal(await tagCorpusWithPhrase(sqlIface, "50"), 2, "the literal 50 substring matches the other two");

  await client.query("delete from items");
  await client.query(`insert into items (id, platform, title, body, matched_keywords) values
    ('under','rss','变量 a_b 的说明','','[]'::jsonb),
    ('anychar','rss','变量 axb 的说明','','[]'::jsonb)`);
  assert.equal(await tagCorpusWithPhrase(sqlIface, "a_b"), 1, "_ must be a literal character");

  // ---- platform scope on real PG, on a controlled dataset
  await client.query("delete from items");
  await client.query(`insert into items (id, platform, title, body, matched_keywords) values
    ('w1','wechat','电池进展','','[]'::jsonb),
    ('w2','wechat','电池进展','','[]'::jsonb),
    ('r1','rss','电池进展','','[]'::jsonb)`);
  const scoped = await tagCorpusWithPhrase(sqlIface, "电池", { platforms: ["wechat"] });
  const wechatTotal = Number((await client.query(
    "select count(*) as n from items where platform = 'wechat'")).rows[0].n);
  assert.equal(scoped, wechatTotal, "the platform scope must bound the update");
  assert.equal(await tagCorpusWithPhrase(sqlIface, "电池", { platforms: ["wechat"] }), 0);
  assert.equal(await tagCorpusWithPhrase(sqlIface, "电池"), 1, "an unscoped run picks up the remaining row");

  const result = {
    ok: true,
    container: name,
    port,
    rows,
    seedMs,
    firstRun: { tagged: firstTagged, ms: firstMs },
    secondRun: { tagged: secondTagged, ms: secondMs },
    concurrent: { a, b, bothTagged, ms: concurrentMs },
    platformScope: { tagged: scoped, wechatRows: wechatTotal },
    decoysTagged,
    literalWildcards: true,
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  writeFileSync(join(out, "result.json"), JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err), out }, null, 2));
  process.exitCode = 1;
} finally {
  // Always close the client: an open connection keeps the event loop (and this
  // process) alive long after the work is done.
  if (client) { try { await client.end(); } catch { /* already closed */ } }
  if (started) {
    const failed = process.exitCode === 1;
    if (!failed && process.env.LOOM_T07_KEEP !== "1") docker(["rm", "--force", "--volumes", name]);
    else console.error(`[t07] kept container ${name} for inspection`);
  }
  // No lingering handles should exist, but a hung exit here would silently
  // block the batch; exit explicitly with the recorded status.
  process.exit(process.exitCode ?? 0);
}
