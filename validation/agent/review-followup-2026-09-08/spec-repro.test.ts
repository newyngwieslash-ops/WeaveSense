import { confirmJobNotSent } from "../../../src/lib/server/agent-budget.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { enqueueResearchJob, enqueueReadyAnalyses, claimAiJob, finishAiJob } from "../../../src/lib/server/agent-queue.ts";
import { handleAgentJobs } from "../../../src/lib/server/agent-jobs.ts";
import { askKnowledgeWith } from "../../../src/lib/server/analyze.ts";
import { saveCheckpoint } from "../../../src/lib/server/agent-checkpoints.ts";

async function setup(t: any) {
  const pg = new PGlite();
  await pg.waitReady;
  t.after(() => pg.close());
  for (const name of ["0002_schema.sql","0004_production.sql","0007_extract_target_state.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql","0022_research_review.sql","0023_research_runtime.sql","0024_research_call_roles.sql","0025_research_tool_calls.sql","0027_assistant_runtime.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources (id, platform, name) values ('s','rss','Source')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('i','s','rss','e','Battery','Battery storage material.')");
  const sql = {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    }, async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) { return (await pg.query<T>(text, params)).rows; } };
  return { pg, sql };
}
async function claimed(sql: any, requestId = randomUUID()) {
  await enqueueResearchJob(sql, { question: "Battery", requestId, materialHash: "h" });
  const claim = await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} });
  assert.equal(claim.status, 200);
  return claim.body;
}
function response(runId: unknown) {
  return { schema_version: 1, run_id: runId, ok: true,
    result: { content: "An answer.", citations: [], insufficient_evidence: false, coverage: "full", warnings: [] },
    runtime: { model: "fake", prompt_version: "v1", skill_versions: {}, input_tokens: null, output_tokens: null, model_calls: 1, tool_calls: 0, events: [] }, evidence: [] };
}

// These tests enqueue the current governed workflow; no model endpoint is called.
function fakeResearchConfig(t: { after: (fn: () => void) => void }) {
  const values = { AGENT_MODEL_NAME: "fake", AGENT_PRICE_INPUT_RMB_PER_MILLION: "1", AGENT_PRICE_OUTPUT_RMB_PER_MILLION: "1",
    AGENT_SKILL_SNAPSHOT_DIGEST: "a".repeat(64), AGENT_RESEARCH_RUNTIME: "eino", AGENT_RESEARCH_REVIEW: "off",
    AGENT_RESEARCH_DAILY_LIMIT: "20", AGENT_RESEARCH_DAILY_BUDGET_RMB: "20", AGENT_RESEARCH_PRICE_VERSION: "test" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test("S01 complete without response cannot produce succeeded job", async (t) => {
  const { sql } = await setup(t);
  const claim = await claimed(sql);
  const result = await handleAgentJobs({ sql, authorized: true, action: "complete", params: { ...claim, status: "succeeded" } });
  assert.equal(result.status, 400);
});
test("S02 expired job lease must prevent answer and run commit", async (t) => {
  const { sql } = await setup(t);
  const claim = await claimed(sql);
  await sql.query("update ai_jobs set lease_until = now() - interval '1 second' where id = $1", [claim.job_id]);
  const result = await handleAgentJobs({ sql, authorized: true, action: "complete", params: { ...claim, status: "succeeded", response: response(claim.run_id) } });
  assert.equal(result.status, 409);
  assert.deepEqual(await sql.query("select id from knowledge_notes"), [], "denied complete already committed answer");
});
test("S03 successful complete replay must be idempotently accepted", async (t) => {
  const { sql } = await setup(t);
  const claim = await claimed(sql);
  const request = { sql, authorized: true, action: "complete", params: { ...claim, status: "succeeded", response: response(claim.run_id) } };
  assert.equal((await handleAgentJobs(request)).status, 200);
  assert.equal((await handleAgentJobs(request)).status, 200);
});
test("S04 queued same request ID with changed question must return conflict", async (t) => {
  fakeResearchConfig(t);
  const { sql } = await setup(t);
  const requestId = randomUUID();
  const a = await askKnowledgeWith({ sql, question: "Battery", requestId, engine: "eino", async: true });
  assert.equal(a.ok, true);
  const b = await askKnowledgeWith({ sql, question: "Battery storage", requestId, engine: "eino", async: true });
  assert.equal(b.error_code, "request_conflict", JSON.stringify(b));
});
test("S05 same async request after claim must remain in progress rather than conflict", async (t) => {
  fakeResearchConfig(t);
  const { sql } = await setup(t);
  const requestId = randomUUID();
  const a = await askKnowledgeWith({ sql, question: "Battery", requestId, engine: "eino", async: true });
  assert.equal(a.ok, true);
  await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} });
  const b = await askKnowledgeWith({ sql, question: "Battery", requestId, engine: "eino", async: true });
  assert.equal(b.error_code, "run_in_progress", JSON.stringify(b));
});
test("S06 expired run cannot save checkpoint", async (t) => {
  const { sql } = await setup(t);
  const claim = await claimed(sql);
  await sql.query("update ai_runs set expires_at = now() - interval '1 second' where id = $1", [claim.run_id]);
  const result = await saveCheckpoint(sql, { checkPointId: "cp", runId: String(claim.run_id), claimToken: String(claim.claim_token), sequence: 1, schemaVersion: "1", runtimeVersion: "v1", payload: Buffer.from("state") });
  assert.equal(result, "stale");
});
test("S07 same checkpoint sequence with different payload must be rejected", async (t) => {
  const { sql } = await setup(t);
  const claim = await claimed(sql);
  const input = { checkPointId: "cp", runId: String(claim.run_id), claimToken: String(claim.claim_token), sequence: 1, schemaVersion: "1", runtimeVersion: "v1", payload: Buffer.from("first") };
  assert.equal(await saveCheckpoint(sql, input), "ok");
  assert.equal(await saveCheckpoint(sql, { ...input, payload: Buffer.from("different") }), "stale");
});
test("S08 safely failed job release must reconcile reserved daily total", async (t) => {
  const { sql } = await setup(t);
  await enqueueReadyAnalyses(sql, { autoAnalyze: true, dailyLimit: 2, dailyBudgetRmb: 2, priceVersion: "test", worstCostRmb: 1 }, "2026-09-08");
  const job = await claimAiJob(sql, { worker: "test", leaseSeconds: 60 });
  assert.ok(job);
  // Establish the trusted preflight fact; a caller-supplied label alone is not proof.
  assert.equal(await confirmJobNotSent(sql, job.id, job.claim_token), true);
  assert.equal(await finishAiJob(sql, { id: job.id, claimToken: job.claim_token, status: "failed", errorCode: "not_sent" }), true);
  const rows = await sql.query<{ reserved_count: number; reserved_rmb: string }>("select reserved_count, reserved_rmb from ai_budget_days");
  assert.equal(Number(rows[0].reserved_rmb), 0);
});
