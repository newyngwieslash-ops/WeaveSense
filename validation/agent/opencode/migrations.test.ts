import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { createServer } from "vite";
import pg from "pg";

type Db = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; exec(text: string): Promise<unknown> };
const files = readdirSync("migrations").filter(n => /^\d+.*\.sql$/.test(n)).sort();

async function legacy(db: Db) {
  await db.exec("create table _migrations(name text primary key,applied_at timestamptz not null default now())");
  for (const name of files.filter(n => Number(n.slice(0, 4)) <= 21)) {
    await db.exec(readFileSync("migrations/" + name, "utf8"));
    await db.query("insert into _migrations(name) values($1)", [name]);
  }
  await db.exec(`insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at)
    values('legacy-run','legacy-request','research','eino','input','material','old-policy','{}','succeeded','old-claim',now());
    insert into knowledge_notes(id,title,content,kind,item_ids,run_id) values('legacy-note','保留旧笔记','旧研究正文','answer','[]','legacy-run');
    insert into ai_model_calls(run_id,call_id,model,policy_version,execution_day,state,input_tokens,output_tokens)
      values('legacy-run','old-call','old-model','old-policy','2026-10-06','completed',20,10);
    insert into ai_jobs(id,item_id,material_hash,policy_version,status,run_id,payload)
      values('conflicting-job','research:legacy','material','old-policy','succeeded','legacy-run','{"provider":"unknown","mode":"research"}');
    insert into ai_jobs(id,item_id,material_hash,policy_version,status,payload)
      values('no-kind-job','research:nokind','material','old-policy','queued','{}');`);
}

async function records(db: Db) {
  return (await db.query("select to_jsonb(n) as note,to_jsonb(r) as run from knowledge_notes n join ai_runs r on n.run_id=r.id where n.id='legacy-note'")).rows;
}
async function rollbackProof(db: Db) {
  assert.equal((await db.query("select name from _migrations where name like '0022%'")).rows.length, 1, "earlier successful migration remains recorded");
  assert.equal((await db.query("select name from _migrations where name like '0023%' or name like '0024%'")).rows.length, 0);
  assert.equal((await db.query("select column_name from information_schema.columns where table_schema=current_schema() and table_name='ai_jobs' and column_name='runtime_provider'")).rows.length, 0, "failed migration rolls back DDL");
  assert.equal((await db.query("select to_regclass('ai_runtime_bindings') as t")).rows[0].t, null);
}
async function successProof(db: Db, before: unknown) {
  assert.deepEqual(await records(db), before, "old note and run remain byte-equivalent JSON values");
  assert.deepEqual((await db.query("select role,request_digest,input_tokens::int,output_tokens::int from ai_model_calls where call_id='old-call'")).rows, [{ role: "producer", request_digest: null, input_tokens: 20, output_tokens: 10 }]);
  assert.equal((await db.query("select runtime_provider from ai_jobs where id='conflicting-job'")).rows[0].runtime_provider, "eino");
  assert.equal((await db.query("select name from _migrations")).rows.length, files.length);
  assert.equal((await db.query("select count(*)::int as n from ai_research_candidates")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from ai_research_reviews")).rows[0].n, 0);
}

test("PGlite actual app runner: conflicting backfill rolls back, retry preserves legacy data, HMR repeat skips applied SQL", async () => {
  const db = new PGlite();
  await legacy(db);
  const before = await records(db);
  const globals = globalThis as typeof globalThis & { __pgliteInstance__?: Promise<PGlite>; __pgliteMigrateChain__?: Promise<void>; __pgBootstrapPromise__?: Promise<void> };
  const old = { instance: globals.__pgliteInstance__, chain: globals.__pgliteMigrateChain__, bootstrap: globals.__pgBootstrapPromise__, database: process.env.DATABASE_URL, mode: process.env.LOOM_RUNTIME_MODE };
  globals.__pgliteInstance__ = Promise.resolve(db);
  globals.__pgliteMigrateChain__ = undefined;
  globals.__pgBootstrapPromise__ = Promise.resolve();
  delete process.env.DATABASE_URL;
  process.env.LOOM_RUNTIME_MODE = "test";
  const vite = await createServer({ configFile: false, cacheDir: resolve(".repo", "migration-vite-" + randomUUID()),
    logLevel: "silent", server: { middlewareMode: true, watch: null } });
  try {
    const first = await vite.ssrLoadModule("/src/lib/db.ts");
    assert.equal(first.dbSource, "pglite");
    await assert.rejects(first.getSql(), /unprovable research runtime ownership/);
    await rollbackProof(db);
    assert.deepEqual(await records(db), before);
    await db.query("update ai_jobs set payload=$1 where id='conflicting-job'", [{ provider: "eino", mode: "research" }]);
    await first.getSql();
    await successProof(db, before);
    const ledger = (await db.query("select name,applied_at from _migrations order by name")).rows;
    vite.moduleGraph.invalidateAll();
    const second = await vite.ssrLoadModule("/src/lib/db.ts");
    assert.notEqual(second.getSql, first.getSql, "repeat must instantiate a new app module, not reuse a memoized client");
    await second.getSql();
    assert.deepEqual((await db.query("select name,applied_at from _migrations order by name")).rows, ledger);
    await successProof(db, before);
  } finally {
    await vite.close(); await db.close();
    globals.__pgliteInstance__ = old.instance; globals.__pgliteMigrateChain__ = old.chain; globals.__pgBootstrapPromise__ = old.bootstrap;
    if (old.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = old.database;
    if (old.mode === undefined) delete process.env.LOOM_RUNTIME_MODE; else process.env.LOOM_RUNTIME_MODE = old.mode;
  }
});

test("PostgreSQL actual deployment runner: conflicting backfill rolls back and repeated migration preserves legacy rows", async () => {
  const port = Number(process.env.REVIEW_PG_PORT), container = process.env.REVIEW_PG_CONTAINER ?? "";
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && /^loom-opencode-validation-[a-z0-9-]+$/.test(container), "postgres_not_covered: explicit disposable container and port required");
  const inspect = (format: string) => execFileSync("docker", ["inspect", container, "--format", format], { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(inspect('{{index .Config.Labels "weavesense.validation"}}'), "agent-opencode");
  assert.deepEqual(JSON.parse(inspect("{{json .NetworkSettings.Ports}}"))["5432/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(port) }]);
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "review-only-local", database: "review" });
  const schema = "oc_migrate_" + randomUUID().replaceAll("-", "");
  await client.connect();
  await client.query(`create schema ${schema}`);
  try {
    await client.query(`set search_path to ${schema}`);
    const db: Db = { query: (text, params) => client.query(text, params), exec: text => client.query(text) };
    await legacy(db);
    const before = await records(db);
    const target = new URL(`postgresql://postgres:review-only-local@127.0.0.1:${port}/review`);
    target.searchParams.set("options", "-c search_path=" + schema);
    const migrate = () => execFileSync(process.execPath, ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: target.href, LOOM_RUNTIME_MODE: "test" }, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    assert.throws(migrate, /unprovable research runtime ownership/);
    await rollbackProof(db);
    assert.deepEqual(await records(db), before);
    await db.query("update ai_jobs set payload=$1 where id='conflicting-job'", [{ provider: "eino", mode: "research" }]);
    assert.match(migrate(), /applied 0023[\s\S]*applied 0024/);
    await successProof(db, before);
    const ledger = (await db.query("select name,applied_at from _migrations order by name")).rows;
    assert.match(migrate(), /up to date/);
    assert.deepEqual((await db.query("select name,applied_at from _migrations order by name")).rows, ledger);
    await successProof(db, before);
  } finally {
    await client.query(`drop schema ${schema} cascade`); await client.end();
  }
});
