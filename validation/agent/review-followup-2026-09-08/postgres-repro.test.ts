// Review-only. Use the disposable followup container, never the application DB.
// Assertions express required behavior. Original review evidence is preserved.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { enqueueResearchJob, claimAiJob } from "../../../src/lib/server/agent-queue.ts";
import { beginRun, finishAnalyzeAtomically } from "../../../src/lib/server/agent-runs.ts";

const port = Number(process.env.REVIEW_PG_PORT);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, "REVIEW_PG_PORT must identify the disposable review container");
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const clients: pg.Client[] = [];
  t.after(async () => { await Promise.all(clients.map(c => c.end())); });
  const schema = "followup_" + randomUUID().replaceAll("-", "");
  async function connect(name: string) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "review-only-local",
      database: "review", application_name: name, statement_timeout: 8000 });
    clients.push(c); await c.connect(); return c;
  }
  const control = await connect("followup-control");
  await control.query(`create schema ${schema}`);
  await control.query(`set search_path to ${schema}`);
  for (const name of ["0002_schema.sql", "0011_ai_runs.sql", "0012_ai_jobs.sql", "0013_agent_checkpoints.sql", "0014_agent_integrity.sql", "0015_agent_budget_reservations.sql"])
    await control.query(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  async function scoped(name: string) { const c = await connect(name); await c.query(`set search_path to ${schema}`); return c; }
  const a = await scoped("followup-a"), b = await scoped("followup-b"), locker = await scoped("followup-locker");
  const wrap = (c: pg.Client) => ({ async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await c.query(text, params)).rows as T[];
  }});
  async function waitLocks(count: number) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const r = await control.query("select count(*)::int as n from pg_stat_activity where application_name in ('followup-a','followup-b') and wait_event_type='Lock'");
      if (r.rows[0].n >= count) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error("Test did not establish the required lock schedule");
  }
  return { sql: wrap(control), sa: wrap(a), sb: wrap(b), locker, waitLocks };
}

test("PG-F01: SKIP LOCKED skips owned rows and two connections produce one winner", async t => {
  const { sql, sa, sb, locker } = await setup(t);
  const job = await enqueueResearchJob(sql, { question: "review", requestId: randomUUID(), materialHash: "m" });
  assert.ok(job);
  await locker.query("begin");
  await locker.query("select id from ai_jobs where id=$1 for update", [job.id]);
  try {
    const skipped = await Promise.all([claimAiJob(sa, { worker: "a", leaseSeconds: 60, kind: "research" }), claimAiJob(sb, { worker: "b", leaseSeconds: 60, kind: "research" })]);
    assert.deepEqual(skipped, [null, null]);
  } finally { await locker.query("commit"); }
  const results = await Promise.all([claimAiJob(sa, { worker: "a", leaseSeconds: 60, kind: "research" }), claimAiJob(sb, { worker: "b", leaseSeconds: 60, kind: "research" })]);
  assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results));
});

test("PG-F02: concurrent body update cannot receive stale analysis", async t => {
  const { sql, sa, locker, waitLocks } = await setup(t);
  await sql.query("insert into sources(id,platform,name) values('s','rss','source')");
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,author,url) values('i','s','rss','i','title','old body','author','https://example.com')");
  const runId = randomUUID(), claim = randomUUID();
  await beginRun(sql, { id: runId, requestId: randomUUID(), mode: "analyze_item", provider: "eino", inputHash: "h",
    materialHash: "m", policyVersion: "v1", requestJson: {}, claimToken: claim, expiresAt: new Date(Date.now() + 60000).toISOString() });
  await locker.query("begin");
  await locker.query("update items set body='new body' where id='i'");
  const finishing = finishAnalyzeAtomically(sa, { runId, claimToken: claim, itemId: "i", title: "title", body: "old body",
    author: "author", url: "https://example.com", platform: "rss", sourceName: "source", analysisId: randomUUID(), summary: "old summary",
    topics: [], entities: [], insights: "", tags: [], model: "review", promptVersion: "v1", skillVersions: {}, responseJson: {},
    inputTokens: null, outputTokens: null, modelCalls: 1, toolCalls: 0 });
  try { await waitLocks(1); } finally { await locker.query("commit"); }
  const result = await finishing;
  const rows = await sql.query("select body,pipeline_status from items where id='i'");
  assert.notEqual(result, "ok", JSON.stringify({ result, rows }));
});
