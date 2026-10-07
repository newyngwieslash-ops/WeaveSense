import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { testResearchRun } from "./test-db.ts";
import type { AgentSql } from "../../../src/lib/server/agent-transaction.ts";
import { saveResearchCandidate, startResearchReview, saveResearchReview } from "../../../src/lib/server/agent-candidates.ts";
import { admitGovernedModelCall } from "../../../src/lib/server/agent-budget.ts";
import { completeRun } from "../../../src/lib/server/agent-completion.ts";
import { cancelResearchJob } from "../../../src/lib/server/agent-research-status.ts";
import { enqueueResearchJob } from "../../../src/lib/server/agent-queue.ts";
import { hashRunToken } from "../../../src/lib/server/agent-data.ts";
import { evidenceSourceFor } from "../../../src/lib/server/agent-context.ts";
import { mapAgentItem } from "../../../src/lib/server/agent-retrieval.ts";

function testPort() {
  const port = Number(process.env.REVIEW_PG_PORT), container = process.env.REVIEW_PG_CONTAINER ?? "";
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && /^loom-opencode-validation-[a-z0-9-]+$/.test(container), "postgres_not_covered: explicit disposable container and port required");
  const inspect = (format: string) => execFileSync("docker", ["inspect", container, "--format", format], { encoding: "utf8", windowsHide: true }).trim();
  assert.equal(inspect('{{index .Config.Labels "weavesense.validation"}}'), "agent-opencode", "wrong_test_container_label");
  assert.deepEqual(JSON.parse(inspect("{{json .NetworkSettings.Ports}}"))["5432/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(port) }], "test_container_port_mismatch");
  return port;
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const schema = "oc_fault_" + randomUUID().replaceAll("-", ""), port = testPort();
  const clients: pg.Client[] = [];
  async function connect(suffix: string) {
    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "review-only-local", database: "review", application_name: schema + suffix, statement_timeout: 10000 });
    clients.push(c); await c.connect(); return c;
  }
  const control = await connect("-control");
  await control.query(`create schema ${schema}`);
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.query("rollback")));
    await Promise.all(clients.slice(1).map(c => c.end()));
    await control.query(`drop schema ${schema} cascade`); await control.end();
  });
  await control.query(`set search_path to ${schema}`);
  for (const name of readdirSync("migrations").filter(n => /^\d+.*\.sql$/.test(n)).sort()) await control.query(readFileSync("migrations/" + name, "utf8"));
  async function scoped(suffix: string) { const c = await connect(suffix); await c.query(`set search_path to ${schema}`); return c; }
  const a = await scoped("-a"), b = await scoped("-b"), locker = await scoped("-locker");
  const wrap = (c: pg.Client): AgentSql => ({
    query: async <T>(text: string, params: unknown[] = []) => (await c.query(text, params)).rows as T[],
    async transaction<T>(fn: (tx: AgentSql) => Promise<T>) {
      await c.query("begin");
      try { const result = await fn({ query: async <R>(text: string, params: unknown[] = []) => (await c.query(text, params)).rows as R[] }); await c.query("commit"); return result; }
      catch (error) { await c.query("rollback"); throw error; }
    },
  });
  async function waitLocks(count: number) {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const { rows } = await control.query("select count(*)::int as n from pg_stat_activity where application_name=any($1::text[]) and wait_event_type='Lock'", [[schema + "-a", schema + "-b"]]);
      if (rows[0].n >= count) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("required_postgres_lock_schedule_not_established");
  }
  return { sql: wrap(control), sa: wrap(a), sb: wrap(b), locker, waitLocks };
}

const candidate = { content: "材料不足，不能确认。", citations: [], insufficient_evidence: true, coverage: "full" as const, warnings: [] };
async function run(sql: AgentSql, overrides: Record<string, unknown> = {}) {
  return testResearchRun(sql as Parameters<typeof testResearchRun>[0], { governed: true, ...overrides });
}
async function reviewed(sql: AgentSql, overrides: Record<string, unknown> = {}) {
  const r = await run(sql, overrides);
  assert.equal((await saveResearchCandidate(sql, { ...r, result: candidate })).ok, true);
  const intent = await startResearchReview(sql, { ...r, grantSecret: "offline-test-secret" });
  assert.ok(intent.ok);
  const req = intent.request;
  const auth = { role: "reviewer" as const, tokenHash: hashRunToken(req.reviewer_grant) };
  const call = { call_id: req.review_call_id, request_digest: req.request_digest, model: "fake", policy_version: "loom-agent-v1" };
  assert.equal(await admitGovernedModelCall(sql, r.runId, auth, { ...call, phase: "started" }), "send_once");
  assert.equal(await admitGovernedModelCall(sql, r.runId, auth, { ...call, phase: "completed", input_tokens: 5, output_tokens: 2 }), "completed");
  const report = { schema_version: 1, run_id: r.runId, candidate_digest: req.candidate_digest, evidence_digest: req.evidence_digest, policy_digest: req.policy_digest,
    checks: ["support", "scope", "conflicts", "source_independence", "uncertainty"].map(id => ({ id, status: "pass" })), findings: [] };
  assert.equal((await saveResearchReview(sql, { ...r, report })).ok, true);
  return r;
}
function publish(sql: AgentSql, r: { runId: string; claimToken: string }) {
  return completeRun(sql, { ...r, status: "succeeded", responseJson: { result: candidate }, write: async tx => {
    await tx.query("insert into knowledge_notes(id,title,content,kind,item_ids,run_id) values($1,'PG测试',$2,'answer','[]',$1)", [r.runId, candidate.content]);
    return { note_id: r.runId };
  } });
}

test("PG: competing identical candidates persist once; different content and SQL updates cannot overwrite", async t => {
  const { sql, sa, sb, locker, waitLocks } = await setup(t), r = await run(sql);
  await locker.query("begin"); await locker.query("select id from ai_jobs where run_id=$1 for update", [r.runId]);
  const pending = [saveResearchCandidate(sa, { ...r, result: candidate }), saveResearchCandidate(sb, { ...r, result: candidate })];
  try { await waitLocks(2); } finally { await locker.query("commit"); }
  assert.ok((await Promise.all(pending)).every(result => result.ok));
  assert.equal((await sql.query("select * from ai_research_candidates")).length, 1);
  assert.deepEqual(await saveResearchCandidate(sql, { ...r, result: { ...candidate, content: "其他草稿" } }), { ok: false, error: "candidate_conflict" });
  await assert.rejects(sql.query("update ai_research_candidates set result_json='{}' where run_id=$1", [r.runId]), /immutable/);
});

test("PG: concurrent review intents share call/grant and only one send boundary wins", async t => {
  const { sql, sa, sb, locker, waitLocks } = await setup(t), r = await run(sql);
  await saveResearchCandidate(sql, { ...r, result: candidate });
  await locker.query("begin"); await locker.query("select id from ai_jobs where run_id=$1 for update", [r.runId]);
  const intents = [sa, sb].map(db => startResearchReview(db, { ...r, grantSecret: "offline-test-secret" }));
  try { await waitLocks(2); } finally { await locker.query("commit"); }
  const [first, second] = await Promise.all(intents); assert.ok(first.ok && second.ok);
  assert.equal(first.request.review_call_id, second.request.review_call_id); assert.equal(first.request.reviewer_grant, second.request.reviewer_grant);
  const req = first.request, auth = { role: "reviewer" as const, tokenHash: hashRunToken(req.reviewer_grant) };
  const input = { call_id: req.review_call_id, request_digest: req.request_digest, model: "fake", policy_version: "loom-agent-v1", phase: "started" as const };
  await locker.query("begin"); await locker.query("select id from ai_jobs where run_id=$1 for update", [r.runId]);
  const sends = [sa, sb].map(db => admitGovernedModelCall(db, r.runId, auth, input));
  try { await waitLocks(2); } finally { await locker.query("commit"); }
  assert.deepEqual((await Promise.all(sends)).sort(), ["already_started", "send_once"]);
  assert.equal((await sql.query("select * from ai_model_calls")).length, 1);
  assert.equal(await admitGovernedModelCall(sql, r.runId, auth, { ...input, phase: "unknown" }), "unknown");
  assert.equal(await admitGovernedModelCall(sql, r.runId, auth, input), "unknown", "a simulated crash/unknown response is never a new send");
  await completeRun(sql, { ...r, status: "outcome_unknown", errorCode: "model_outcome_unknown" });
  assert.equal((await sql.query<{ status: string }>("select status from ai_budget_reservations"))[0].status, "unknown");
});

test("PG: publication after a completed review survives a lost ACK and creates one note", async t => {
  const { sql, sa, sb, locker, waitLocks } = await setup(t), r = await reviewed(sql);
  await locker.query("begin"); await locker.query("select id from ai_jobs where run_id=$1 for update", [r.runId]);
  const pending = [publish(sa, r), publish(sb, r)];
  try { await waitLocks(2); } finally { await locker.query("commit"); }
  const results = await Promise.all(pending); assert.ok(results.every(result => result.ok));
  assert.equal((await publish(sql, r)).ok, true, "retry the same completion after dropping its ACK");
  assert.equal((await sql.query("select * from knowledge_notes")).length, 1);
});

test("PG: changed source after a real lock wait invalidates publication", async t => {
  const { sql, sa, locker, waitLocks } = await setup(t);
  await sql.query("insert into sources(id,platform,name) values('s','rss','Original source')");
  await sql.query("insert into items(id,source_id,platform,external_id,title,body) values('i','s','rss','i','资料','原文')");
  const [row] = await sql.query("select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id='i'");
  const item = mapAgentItem(row), source = evidenceSourceFor(item, { start: 0, end: 2, text: "原文" }, "full");
  const r = await reviewed(sql, { sources: [source] });
  await locker.query("begin"); await locker.query("update sources set name='Changed source' where id='s'");
  const pending = publish(sa, r);
  try { await waitLocks(1); } finally { await locker.query("commit"); }
  assert.deepEqual(await pending, { ok: false, error: "input_changed" });
  assert.equal((await sql.query("select * from knowledge_notes")).length, 0);
});

test("PG: changed claim after lock wait and cancellation both reject publication", async t => {
  const { sql, sa, locker, waitLocks } = await setup(t), old = await reviewed(sql);
  await locker.query("begin"); await locker.query("update ai_jobs set claim_token='new-owner' where run_id=$1", [old.runId]);
  const pending = publish(sa, old);
  try { await waitLocks(1); } finally { await locker.query("commit"); }
  assert.deepEqual(await pending, { ok: false, error: "stale" });
  const cancelled = await reviewed(sql);
  const [job] = await sql.query<{ id: string }>("select id from ai_jobs where run_id=$1", [cancelled.runId]);
  assert.equal((await cancelResearchJob(sql, job.id, true)).ok, true);
  assert.deepEqual(await publish(sql, cancelled), { ok: false, error: "cancel_requested" });
  assert.equal((await sql.query("select * from knowledge_notes")).length, 0);
});

test("PG: reviewed publication database failure rolls back note and completion together", async t => {
  const { sql } = await setup(t), r = await reviewed(sql);
  await sql.query("create function reject_finish() returns trigger language plpgsql as $$begin if new.status='succeeded' then raise exception 'injected_publish_failure'; end if; return new; end$$; create trigger reject_finish before update on ai_jobs for each row execute function reject_finish()");
  await assert.rejects(publish(sql, r), /injected_publish_failure/);
  assert.equal((await sql.query("select * from knowledge_notes")).length, 0);
  assert.equal((await sql.query<{ status: string }>("select status from ai_runs where id=$1", [r.runId]))[0].status, "running");
  assert.equal((await sql.query<{ state: string }>("select state from ai_research_reviews where run_id=$1", [r.runId]))[0].state, "completed");
  await sql.query("drop trigger reject_finish on ai_jobs");
  assert.equal((await publish(sql, r)).ok, true);
});

const snapshot = { governed: true, provider: "eino", mode: "research", budget: { dailyLimit: 1, dailyBudgetRmb: 1, priceVersion: "test", worstCostRmb: 1, pricing: { model: "fake", input_per_million: 2, output_per_million: 4 } } };
test("PG: two research admissions competing for one daily allowance create one job", async t => {
  const { sql, sa, sb, locker, waitLocks } = await setup(t);
  const [{ day }] = await sql.query<{ day: string }>("select to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day");
  await sql.query("insert into ai_budget_admission_days(day) values($1)", [day]);
  await locker.query("begin"); await locker.query("select day from ai_budget_admission_days where day=$1 for update", [day]);
  const pending = [sa, sb].map(db => enqueueResearchJob(db, { question: "研究测试", requestId: randomUUID(), materialHash: "m", snapshot }));
  try { await waitLocks(2); } finally { await locker.query("commit"); }
  assert.equal((await Promise.all(pending)).filter(result => result?.kind === "won").length, 1);
  assert.equal((await sql.query("select * from ai_jobs")).length, 1);
  assert.equal((await sql.query("select * from ai_budget_reservations")).length, 1);
  assert.equal(Number((await sql.query<{ reserved_rmb: string }>("select reserved_rmb from ai_budget_days"))[0].reserved_rmb), 1);
});

test("PG: failed research reservation leaves no partial job or daily budget", async t => {
  const { sql } = await setup(t);
  await sql.query("create function reject_reservation() returns trigger language plpgsql as $$begin raise exception 'injected_reservation_failure';end$$; create trigger reject_reservation before insert on ai_budget_reservations for each row execute function reject_reservation()");
  await assert.rejects(enqueueResearchJob(sql, { question: "研究测试", requestId: randomUUID(), materialHash: "m", snapshot }), /injected_reservation_failure/);
  for (const table of ["ai_jobs", "ai_budget_days", "ai_budget_reservations", "ai_budget_admission_days"]) assert.equal((await sql.query(`select * from ${table}`)).length, 0, table);
});
