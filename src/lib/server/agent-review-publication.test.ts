import assert from "node:assert/strict";
import test from "node:test";
import { researchTestDb, testResearchRun } from "../../../validation/agent/opencode/test-db.ts";
import { saveResearchCandidate, startResearchReview, saveResearchReview } from "./agent-candidates.ts";
import { admitGovernedModelCall } from "./agent-budget.ts";
import { completeRun } from "./agent-completion.ts";
import { hashRunToken } from "./agent-data.ts";

const candidate = { content: "材料不足，无法确认结论。", citations: [], insufficient_evidence: true, coverage: "full" as const, warnings: [] };
async function reviewed(sql: Awaited<ReturnType<typeof researchTestDb>>["sql"], mode = "enforce", blocked = false) {
  const run = await testResearchRun(sql, { governed: true, review_policy: { mode, version: "loom-agent-v1", question: "材料支持什么结论？", model: "fake", max_output_tokens_per_call: 1800 } });
  await saveResearchCandidate(sql, { ...run, result: candidate });
  const intent = await startResearchReview(sql, { ...run, grantSecret: "fake-grant-secret" });
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error("missing_review_intent");
  const req = intent.request, auth = { role: "reviewer" as const, tokenHash: hashRunToken(req.reviewer_grant) };
  const call = { call_id: req.review_call_id, request_digest: req.request_digest, model: "fake", policy_version: "loom-agent-v1" };
  assert.equal(await admitGovernedModelCall(sql, run.runId, auth, { ...call, phase: "started" }), "send_once");
  assert.equal(await admitGovernedModelCall(sql, run.runId, auth, { ...call, phase: "completed", input_tokens: 30, output_tokens: 10 }), "completed");
  const report = { schema_version: 1, run_id: run.runId, candidate_digest: req.candidate_digest, evidence_digest: req.evidence_digest, policy_digest: req.policy_digest,
    checks: ["support", "scope", "conflicts", "source_independence", "uncertainty"].map(id => ({ id, status: blocked && id === "support" ? "fail" : "pass" })), findings: [] };
  assert.equal((await saveResearchReview(sql, { ...run, report })).ok, true);
  return run;
}
function publish(sql: Awaited<ReturnType<typeof researchTestDb>>["sql"], run: { runId: string; claimToken: string }, result = candidate) {
  return completeRun(sql, { ...run, status: "succeeded", responseJson: { result }, write: async tx => {
    await tx.query("insert into knowledge_notes(id,title,content,kind,item_ids,run_id) values($1,'研究',$2,'answer','[]'::jsonb,$1)", [run.runId, result.content]);
    return { note_id: run.runId };
  } });
}

test("every research publication rejects missing review and review-A/candidate-B", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const missing = await testResearchRun(sql, { governed: true });
    assert.equal((await publish(sql, missing)).ok, false);
    const run = await reviewed(sql);
    const altered = await publish(sql, run, { ...candidate, content: "另一版本" });
    assert.deepEqual(altered, { ok: false, error: "candidate_mismatch" });
    assert.equal((await sql.query("select * from knowledge_notes")).length, 0);
    const first = await publish(sql, run), replay = await publish(sql, run);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(replay.ok, true);
    assert.equal((await sql.query("select * from knowledge_notes")).length, 1);
  } finally { await pg.close(); }
});

test("enforce blocks semantic fail while shadow publishes with the recorded finding", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    assert.deepEqual(await publish(sql, await reviewed(sql, "enforce", true)), { ok: false, error: "review_blocked" });
    const shadow = await reviewed(sql, "shadow", true);
    assert.equal((await publish(sql, shadow)).ok, true);
    assert.equal((await sql.query("select * from knowledge_notes")).length, 1);
    assert.equal((await sql.query<{ state: string }>("select state from ai_research_reviews where run_id=$1", [shadow.runId]))[0].state, "completed");
  } finally { await pg.close(); }
});

test("cancel request prevents late publication and new grants", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await reviewed(sql);
    await sql.query("update ai_jobs set payload=jsonb_set(payload,'{cancel_requested}','true') where run_id=$1", [run.runId]);
    assert.deepEqual(await publish(sql, run), { ok: false, error: "cancel_requested" });
    assert.deepEqual(await startResearchReview(sql, { ...run, grantSecret: "fake-grant-secret" }), { ok: false, error: "cancel_requested" });
    assert.equal((await sql.query("select * from knowledge_notes")).length, 0);
  } finally { await pg.close(); }
});
