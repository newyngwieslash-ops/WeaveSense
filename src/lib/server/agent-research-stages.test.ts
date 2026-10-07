import assert from "node:assert/strict";
import test from "node:test";
import { researchTestDb, testResearchRun } from "../../../validation/agent/opencode/test-db.ts";
import { handleAgentJobs } from "./agent-jobs.ts";
import { admitGovernedModelCall } from "./agent-budget.ts";
import { hashRunToken } from "./agent-data.ts";

const draft = { content: "没有足够材料确认结论。", citations: [], insufficient_evidence: true, coverage: "full", warnings: [] };
async function setup(mode = "enforce", provider: "eino" | "opencode" = "eino") {
  const db = await researchTestDb();
  const run = await testResearchRun(db.sql, { governed: true, provider,
    producer_deadline_at: new Date(Date.now() + 60_000).toISOString(), skill_snapshot_digest: "a".repeat(64),
    review_policy: { mode, version: "loom-agent-v1", question: "材料支持什么结论？", model: "fake", max_output_tokens_per_call: 1800 } });
  const [job] = await db.sql.query<{ id: string }>("select id from ai_jobs where run_id=$1", [run.runId]);
  const ids = { job_id: job.id, run_id: run.runId, claim_token: run.claimToken };
  const response = { schema_version: 1, run_id: run.runId, ok: true, result: draft, evidence: [],
    runtime: { model: "fake", prompt_version: "v1", skill_versions: {}, input_tokens: 1, output_tokens: 1, model_calls: 1, tool_calls: 0, events: [] } };
  const send = (action: string, extra: Record<string, unknown> = {}) => handleAgentJobs({ sql: db.sql, authorized: true, provider, action, params: { action, ...ids, ...extra } });
  return { ...db, ...run, ids, response, send };
}

test("governed stage protocol publishes one immutable candidate with replay-safe final ACK", async () => {
  const f = await setup("off");
  try {
    assert.equal((await f.send("candidate", { response: f.response })).status, 200);
    assert.equal((await f.send("candidate", { response: f.response })).status, 200);
    assert.deepEqual((await f.send("review_start")).body, { ok: true, skip: true });
    const first = await f.send("finalize"), replay = await f.send("finalize");
    assert.equal(first.status, 200, JSON.stringify(first));
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.equal(replay.body.note_id, first.body.note_id);
    assert.equal((await f.sql.query("select id from knowledge_notes")).length, 1);
    assert.equal((await f.send("candidate", { response: { ...f.response, result: { ...draft, content: "另一个草稿" } } })).status, 409);
  } finally { await f.pg.close(); }
});

test("OpenCode finalization derives tool counts from the host ledger", async () => {
  const f = await setup("off", "opencode");
  try {
    await f.sql.query(`insert into ai_tool_calls(run_id,call_id,tool,request_digest,state)
      values($1,'tool-1','search_items',$2,'completed'),($1,'tool-2','get_item',$2,'completed')`, [f.runId, "a".repeat(64)]);
    assert.equal((await f.send("candidate", { response: f.response })).status, 200);
    assert.equal((await f.send("finalize")).status, 200);
    const [run] = await f.sql.query<{ tool_calls: number; response_json: { runtime: { tool_calls: number } } }>("select tool_calls,response_json from ai_runs where id=$1", [f.runId]);
    assert.equal(run.tool_calls, 2);
    assert.equal(run.response_json.runtime.tool_calls, 2);
  } finally { await f.pg.close(); }
});

test("unreviewed enforce finalize blocks publication; worker cannot choose final status", async () => {
  const f = await setup();
  try {
    assert.equal((await f.send("candidate", { response: f.response })).status, 200);
    assert.equal((await f.send("finalize", { status: "succeeded" })).status, 400);
    const pending = await f.send("finalize");
    assert.equal(pending.status, 409, JSON.stringify(pending));
    assert.equal((await f.sql.query("select id from knowledge_notes")).length, 0);
    assert.equal((await f.sql.query<{ status: string }>("select status from ai_runs where id=$1", [f.runId]))[0].status, "running");
  } finally { await f.pg.close(); }
});

test("trusted reviewer receipt followed by report permits enforce publication", async () => {
  const f = await setup();
  const oldSecret = process.env.AGENT_DATA_TOKEN;
  process.env.AGENT_DATA_TOKEN = "test-stage-secret";
  try {
    assert.equal((await f.send("candidate", { response: f.response })).status, 200);
    const start = await f.send("review_start");
    assert.equal(start.status, 200, JSON.stringify(start));
    const req = start.body.request as Record<string, any>;
    const call = { call_id: req.review_call_id, request_digest: req.request_digest, model: "fake", policy_version: "loom-agent-v1" };
    const auth = { role: "reviewer" as const, tokenHash: hashRunToken(req.reviewer_grant) };
    const report = { schema_version: 1, run_id: f.runId, candidate_digest: req.candidate_digest, evidence_digest: req.evidence_digest, policy_digest: req.policy_digest,
      checks: ["support", "scope", "conflicts", "source_independence", "uncertainty"].map(id => ({ id, status: "pass" })), findings: [] };
    assert.equal((await f.send("review_result", { report })).status, 409);
    assert.equal(await admitGovernedModelCall(f.sql, f.runId, auth, { ...call, phase: "started" }), "send_once");
    assert.equal(await admitGovernedModelCall(f.sql, f.runId, auth, { ...call, phase: "completed", input_tokens: 4, output_tokens: 3 }), "completed");
    assert.equal((await f.send("review_result", { report })).status, 200);
    assert.equal((await f.send("review_result", { report })).status, 200);
    assert.deepEqual((await f.send("review_start")).body, { ok: true, skip: true });
    assert.equal((await f.send("finalize")).status, 200);
    const [run] = await f.sql.query<{ model_calls: number; input_tokens: number }>("select model_calls,input_tokens from ai_runs where id=$1", [f.runId]);
    assert.equal(run.model_calls, 1); // Ledger facts, not producer's reported counts.
    assert.equal(run.input_tokens, 4);
  } finally {
    if (oldSecret === undefined) delete process.env.AGENT_DATA_TOKEN; else process.env.AGENT_DATA_TOKEN = oldSecret;
    await f.pg.close();
  }
});

test("expired worker with saved candidate resumes review, never regenerates Producer", async () => {
  const f = await setup();
  try {
    assert.equal((await f.send("candidate", { response: f.response })).status, 200);
    await f.sql.query("update ai_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [f.ids.job_id]);
    const next = await handleAgentJobs({ sql: f.sql, authorized: true, action: "claim", params: {} });
    assert.equal(next.status, 200, JSON.stringify(next));
    assert.equal(next.body.phase, "review");
    assert.equal(next.body.run_id, f.runId);
    assert.notEqual(next.body.claim_token, f.claimToken);
    assert.equal((await f.send("review_error", { error_code: "cancelled", outcome_unknown: true })).status, 409);
    assert.equal((await f.sql.query("select * from ai_model_calls")).length, 0);
  } finally { await f.pg.close(); }
});

test("cancelled candidate is acknowledged without publication and unknown cost is retained", async () => {
  const f = await setup("shadow");
  try {
    assert.equal((await f.send("candidate", { response: f.response })).status, 200);
    await f.sql.query("update ai_jobs set payload=jsonb_set(payload,'{cancel_requested}','true') where id=$1", [f.ids.job_id]);
    assert.equal((await f.send("renew")).body.cancel_requested, true);
    assert.equal((await f.send("review_error", { error_code: "cancelled", outcome_unknown: true })).status, 200);
    const done = await f.send("finalize");
    assert.equal(done.status, 200, JSON.stringify(done));
    assert.equal(done.body.status, "outcome_unknown");
    assert.equal((await f.sql.query("select * from knowledge_notes")).length, 0);
    assert.equal((await f.sql.query<{ status: string }>("select status from ai_budget_reservations"))[0].status, "unknown");
  } finally { await f.pg.close(); }
});
