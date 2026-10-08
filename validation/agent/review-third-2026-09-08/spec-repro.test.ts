import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { enqueueResearchJob, enqueueReadyAnalyses, claimAiJob, finishAiJob } from "../../../src/lib/server/agent-queue.ts";
import { handleAgentJobs } from "../../../src/lib/server/agent-jobs.ts";
import { saveCheckpoint } from "../../../src/lib/server/agent-checkpoints.ts";

async function setup(t: any) {
  const pg = new PGlite(); await pg.waitReady; t.after(() => pg.close());
  for (const name of ["0002_schema.sql","0004_production.sql","0007_extract_target_state.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql","0022_research_review.sql","0023_research_runtime.sql","0024_research_call_roles.sql","0025_research_tool_calls.sql","0027_assistant_runtime.sql"]) await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  await pg.query("insert into sources (id, platform, name) values ('s','rss','Source')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('i','s','rss','e','Battery','Battery material.')");
  const sql = {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    }, async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) { return (await pg.query<T>(text, params)).rows; } };
  return { pg, sql };
}
async function claim(sql: any) {
  await enqueueResearchJob(sql, { question: "Battery", requestId: randomUUID(), materialHash: "h" });
  const result = await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} });
  assert.equal(result.status, 200); return result.body;
}
function response(runId: unknown, content = "Answer") {
  return { schema_version: 1, run_id: runId, ok: true,
    result: { content, citations: [], insufficient_evidence: false, coverage: "full", warnings: [] },
    runtime: { model: "fake", prompt_version: "v1", skill_versions: {}, input_tokens: 100, output_tokens: 30, model_calls: 1, tool_calls: 0, events: [] }, evidence: [] };
}
async function complete(sql: any, claimed: any, extra = {}) {
  return handleAgentJobs({ sql, authorized: true, action: "complete", params: { ...claimed, status: "succeeded", response: response(claimed.run_id), ...extra } });
}
test("TSP01 completed job rejects a different completion content", async (t) => {
  const { sql } = await setup(t); const c = await claim(sql);
  assert.equal((await complete(sql, c)).status, 200);
  assert.equal((await complete(sql, c, { response: response(c.run_id, "Different answer") })).status, 409);
});
test("TSP02 completed job rejects a forged claim token on replay", async (t) => {
  const { sql } = await setup(t); const c = await claim(sql);
  assert.equal((await complete(sql, c)).status, 200);
  assert.equal((await complete(sql, c, { claim_token: "not-the-owner" })).status, 409);
});
test("TSP03 response run ID must match envelope run ID", async (t) => {
  const { sql } = await setup(t); const c = await claim(sql);
  assert.equal((await complete(sql, c, { response: response(randomUUID()) })).status, 400);
});
test("TSP04 expired job failure cannot mutate still-live run", async (t) => {
  const { sql } = await setup(t); const c = await claim(sql);
  await sql.query("update ai_jobs set lease_until = now() - interval '1 second' where id = $1", [c.job_id]);
  assert.equal((await complete(sql, c, { status: "failed", error_code: "invalid_output" })).status, 409);
  const rows = await sql.query<{status: string}>("select status from ai_runs where id = $1", [c.run_id]);
  assert.equal(rows[0].status, "running");
});
test("TSP05 expired job lease cannot save a checkpoint", async (t) => {
  const { sql } = await setup(t); const c = await claim(sql);
  await sql.query("update ai_jobs set lease_until = now() - interval '1 second' where id = $1", [c.job_id]);
  assert.equal(await saveCheckpoint(sql, { checkPointId: "cp", runId: String(c.run_id), claimToken: String(c.claim_token), sequence: 1, schemaVersion: "1", runtimeVersion: "v1", payload: Buffer.from("state") }), "stale");
});
test("TSP06 failed paid model call does not release all reserved cost", async (t) => {
  const { sql } = await setup(t);
  await enqueueReadyAnalyses(sql, { autoAnalyze: true, dailyLimit: 2, dailyBudgetRmb: 2, priceVersion: "test", worstCostRmb: 1 }, "2026-09-08");
  const job = await claimAiJob(sql, { worker: "test", leaseSeconds: 60 }); assert.ok(job);
  // Invalid model output happens after a supplier call; a failure is not proof of zero spend.
  assert.equal(await finishAiJob(sql, { id: job.id, claimToken: job.claim_token, status: "failed", errorCode: "invalid_output" }), true);
  const rows = await sql.query<{reserved_rmb: string}>("select reserved_rmb from ai_budget_days");
  assert.equal(Number(rows[0].reserved_rmb), 1);
});
