import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { claimSource, completeSourceClaim, finishItemInsert, finishSourceJob,
  mergeExistingItem } from "./scheduler-atomic.ts";

async function sourceDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table sources (
    id text primary key,
    enabled boolean not null,
    status text not null,
    last_error text not null,
    last_external_id text not null default '',
    last_published_at timestamptz,
    last_scanned_at timestamptz,
    claim_token text not null default '',
    claimed_at timestamptz
  )`);
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  return { pg, sql };
}

test("concurrent source claims allow only one worker through", async () => {
  const { pg, sql } = await sourceDb();
  await pg.query("insert into sources (id, enabled, status, last_error) values ($1, true, 'idle', 'old')", ["source-1"]);

  let arrived = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const contender = async (token: string) => {
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    return claimSource(sql, "source-1", token);
  };
  const claims = await Promise.all([contender("job-1"), contender("job-2")]);
  assert.equal(claims.filter(Boolean).length, 1);
  const row = await pg.query<{ status: string; last_error: string; claim_token: string }>(
    "select status, last_error, claim_token from sources where id = $1", ["source-1"],
  );
  assert.equal(row.rows[0]?.status, "running");
  assert.equal(row.rows[0]?.last_error, "");
  assert.ok(["job-1", "job-2"].includes(row.rows[0]?.claim_token ?? ""));
  await pg.close();
});

test("expired source claims are recoverable and completion is token-bound", async () => {
  const { pg, sql } = await sourceDb();
  await pg.query(
    `insert into sources (id, enabled, status, last_error, last_external_id, claim_token, claimed_at)
     values ($1, true, 'running', 'old error', 'old-cursor', 'old-job', now() - interval '16 minutes')`,
    ["source-1"],
  );
  const reclaimed = await claimSource(sql, "source-1", "new-job");
  assert.equal(reclaimed?.claim_token, "new-job");
  await pg.query("update sources set last_error = 'new-worker-state' where id = $1", ["source-1"]);

  assert.equal(await completeSourceClaim(sql, "source-1", "old-job", "stale-cursor", null), false);
  let current = await pg.query<{ status: string; claim_token: string; last_external_id: string; last_error: string }>(
    "select status, claim_token, last_external_id, last_error from sources where id = $1", ["source-1"],
  );
  assert.deepEqual(current.rows, [{ status: "running", claim_token: "new-job",
    last_external_id: "old-cursor", last_error: "new-worker-state" }]);

  assert.equal(await completeSourceClaim(sql, "source-1", "new-job", "new-cursor", null), true);
  current = await pg.query<{ status: string; claim_token: string; last_external_id: string; last_error: string }>(
    "select status, claim_token, last_external_id, last_error from sources where id = $1", ["source-1"],
  );
  assert.deepEqual(current.rows, [{ status: "ok", claim_token: "",
    last_external_id: "new-cursor", last_error: "" }]);
  await pg.close();
});

test("a conflicted item insert never enqueues media", async () => {
  let enqueued = 0;
  const inserted = await finishItemInsert([], ["https://img.example/cover.jpg"], "image", async () => {
    enqueued += 1;
  });
  assert.equal(inserted, false);
  assert.equal(enqueued, 0);
});

test("source job completion persists successful and failed provider attempts", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table jobs (
    id text primary key, status text not null, finished_at timestamptz,
    items_found integer not null default 0, items_new integer not null default 0,
    error text not null default '', provider text not null default '',
    attempts jsonb not null default '[]'::jsonb, paid_call boolean not null default false
  )`);
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  await pg.exec("insert into jobs (id,status) values ('ok','running'),('failed','running')");
  await finishSourceJob(sql, "ok", "ok", "", 0, 0,
    { provider: "dajiala", attempts: ["primary", "dajiala"], paid_call: true });
  await finishSourceJob(sql, "failed", "error", "wechat_gateway_http_503", 0, 0,
    { provider: "", attempts: ["primary", "dajiala"], paid_call: true });
  const rows = await pg.query("select id,status,items_found,items_new,error,provider,attempts,paid_call from jobs order by id");
  assert.deepEqual(rows.rows, [
    { id: "failed", status: "error", items_found: 0, items_new: 0,
      error: "wechat_gateway_http_503", provider: "", attempts: ["primary", "dajiala"], paid_call: true },
    { id: "ok", status: "ok", items_found: 0, items_new: 0,
      error: "", provider: "dajiala", attempts: ["primary", "dajiala"], paid_call: true },
  ]);
  await pg.close();
});

test("duplicate merge preserves body and cover while extending provider history", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table items (
    id text primary key, title text, body text, author text, url text, media_type text,
    media_urls jsonb not null default '[]', thumbnail_url text, views integer, likes integer,
    published_at timestamptz, extra jsonb not null default '{}', matched_keywords jsonb not null default '[]'
  ); insert into items values ('item','旧标题','完整正文','作者','https://mp.weixin.qq.com/s/a',
    'article','[]','https://mmbiz.qpic.cn/cover.jpg',null,null,null,
    '{"body_complete":true,"providers_seen":["primary"]}','[]')`);
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  await mergeExistingItem(sql, "item", {
    title: "付费标题", body: "", author: "", url: "", media_type: "article", media_urls: [],
    thumbnail_url: "", views: null, likes: null, published_at: null,
    extra: { provider: "dajiala", providers_seen: ["primary", "dajiala"], body_complete: false },
  }, []);
  const result = await pg.query<{ body: string; thumbnail_url: string;
    extra: { providers_seen?: string[] } }>("select body,thumbnail_url,extra from items where id='item'");
  assert.equal(result.rows[0]?.body, "完整正文");
  assert.equal(result.rows[0]?.thumbnail_url, "https://mmbiz.qpic.cn/cover.jpg");
  assert.deepEqual(result.rows[0]?.extra.providers_seen, ["primary", "dajiala"]);
  await pg.close();
});

test("merging an existing item stores a long body in full (T11)", async () => {
  // The merge path is the second ingestion entry point. It must not re-introduce
  // the 8,000-character cut that was removed from the insert path and the parser.
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table items (
    id text primary key, title text not null default '', body text not null default '',
    author text not null default '', url text not null default '', media_type text not null default 'article',
    media_urls jsonb not null default '[]', thumbnail_url text not null default '', views integer, likes integer,
    published_at timestamptz, extra jsonb not null default '{}', matched_keywords jsonb not null default '[]'
  )`);
  await pg.query(
    "insert into items (id, title, body, author, url, media_type, extra) values ('long','t','','a','u','article','{}')",
  );
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  const body = `${"正文段落。".repeat(1100)}${"补充说明。".repeat(1400)}TAIL-READINESS-12500`;
  assert.ok(body.length > 12_000, `fixture too short: ${body.length}`);
  await mergeExistingItem(sql, "long", {
    title: "", body, author: "", url: "", media_type: "article", media_urls: [],
    thumbnail_url: "", views: null, likes: null, published_at: null, extra: { body_complete: true },
  }, []);
  const { rows } = await pg.query<{ body: string }>("select body from items where id = 'long'");
  assert.equal(rows[0].body.length, body.length, "the merged body must keep its tail");
  assert.ok(rows[0].body.endsWith("TAIL-READINESS-12500"));
  await pg.close();
});
