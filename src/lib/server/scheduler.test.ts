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

test("source completion normalizes dates and preserves the last valid timestamp", async () => {
  const { pg, sql } = await sourceDb();
  try {
    await pg.query("insert into sources (id,enabled,status,last_error) values ('dates',true,'idle','')");
    const valid = "2026-10-13T08:00:00+08:00";
    for (const [index, published] of [valid, "invalid", "", null].entries()) {
      const token = `date-job-${index}`;
      assert.ok(await claimSource(sql, "dates", token));
      assert.equal(await completeSourceClaim(sql, "dates", token, `anchor-${index}`, published), true);
      const [source] = await sql.query<{ status: string; last_external_id: string; last_published_at: Date }>(
        "select status,last_external_id,last_published_at from sources where id='dates'",
      );
      assert.equal(source.status, "ok");
      assert.equal(source.last_external_id, `anchor-${index}`);
      assert.equal(source.last_published_at.toISOString(), "2026-10-13T00:00:00.000Z");
    }
  } finally { await pg.close(); }
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
    attempts jsonb not null default '[]'::jsonb, paid_call boolean not null default false,
    coverage jsonb not null default '{}'::jsonb
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

test("runSourceJob ingests all 60 RSS entries and a replay adds no rows", async () => {
  const { createServer } = await import("vite");
  const { resolve } = await import("node:path");
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "test", LOOM_RUNTIME_MODE: "test", AI_ENGINE: "legacy", DATABASE_URL: "",
    LOOM_MODEL_CONFIG: resolve(".superpowers/nonexistent-offline-model.json"), XAI_API_KEY: "",
    EXTRACT_AUTO: "false", AUTO_ANALYZE: "false", AGENT_ASYNC_RESEARCH_ENABLED: "false",
    AGENT_WORKER_ENABLED: "false", AGENT_OPENCODE_WORKER_ENABLED: "false",
    AGENT_ASSISTANT_ENABLED: "false", AGENT_ASSISTANT_ACTIONS_ENABLED: "false",
  });
  const vite = await createServer({
    configFile: false, logLevel: "silent", resolve: { alias: { "@": resolve("src") } }, server: { middlewareMode: true },
  });
  let database: { getPglite: () => Promise<PGlite> } | undefined;
  try {
    const { runSourceJob } = await vite.ssrLoadModule("/src/lib/server/scheduler.ts");
    const db = await vite.ssrLoadModule("/src/lib/db.ts");
    database = db as { getPglite: () => Promise<PGlite> };
    const sql = await db.getSql();
    const expectedIds = Array.from({ length: 60 }, (_, i) => `entry-${i}`);
    const xml = `<rss version="2.0"><channel><title>60 entry fixture</title>${expectedIds.map((id) =>
      `<item><guid>${id}</guid><title>Item ${id}</title><link>https://example.org/${id}</link><description>Offline body</description><pubDate>Tue, 13 Oct 2026 00:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`;
    let calls = 0;
    const io = {
      resolver: { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } },
      transport: async () => {
        calls += 1;
        return { status: 200, headers: { "content-type": "application/rss+xml" }, body: new Response(xml).body! };
      },
    };
    await sql.query(`insert into sources (id,platform,name,adapter,feed_url) values ('a05-rss','rss','60 entry fixture','rss','https://example.org/feed')`);
    const first = await runSourceJob("a05-rss", "incremental", io);
    const second = await runSourceJob("a05-rss", "incremental", io);
    assert.equal(first.error, "");
    assert.equal(second.error, "");
    assert.equal(first.items_found, 60);
    assert.equal(first.items_new, 60);
    assert.equal(second.items_found, 60);
    assert.equal(second.items_new, 0);
    const storedIds = (await sql.query("select external_id from items where source_id='a05-rss'")).map((row: { external_id: string }) => row.external_id);
    assert.equal(storedIds.length, 60);
    assert.deepEqual(expectedIds.filter((id) => !storedIds.includes(id)), []);
    assert.equal(new Set(storedIds).size, 60);
    assert.equal(calls, 2);
    const jobs = await sql.query("select status,coverage from jobs where source_id='a05-rss' order by started_at");
    assert.deepEqual(jobs, [
      { status: "ok", coverage: { complete: false, window_only: true, note: "initial_window" } },
      { status: "ok", coverage: { complete: false, window_only: true, note: "window_overlap" } },
    ]);
  } finally {
    await vite.close();
    if (database) await (await database.getPglite()).close();
    for (const key of ["__pgliteInstance__", "__pgliteMigrateChain__", "__pgBootstrapPromise__"]) Reflect.deleteProperty(globalThis, key);
    process.env = previousEnv;
  }
});
