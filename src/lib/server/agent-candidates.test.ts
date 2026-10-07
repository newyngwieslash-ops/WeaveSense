import assert from "node:assert/strict";
import test from "node:test";
import { researchTestDb, testResearchRun } from "../../../validation/agent/opencode/test-db.ts";
import { getResearchCandidate, saveResearchCandidate, startResearchReview, saveResearchReview } from "./agent-candidates.ts";

const result = { content: "当前材料不足以得出结论。", citations: [], insufficient_evidence: true, coverage: "full" as const, warnings: [] };

test("a research candidate is immutable and identical deliveries replay", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql);
    const first = await saveResearchCandidate(sql, { ...run, result });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((await saveResearchCandidate(sql, { ...run, result })).ok, true);
    assert.deepEqual(await saveResearchCandidate(sql, { ...run, result: { ...result, content: "替换正文" } }), { ok: false, error: "candidate_conflict" });
    assert.equal((await getResearchCandidate(sql, run.runId))?.result_json.content, result.content);
    await assert.rejects(sql.query("update ai_research_candidates set result_json='{}'::jsonb where run_id=$1", [run.runId]), /immutable/);
  } finally { await pg.close(); }
});

test("candidate intake checks actual citations, size and current ownership", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql);
    assert.deepEqual(await saveResearchCandidate(sql, { ...run, claimToken: "old", result }), { ok: false, error: "stale" });
    assert.deepEqual(await saveResearchCandidate(sql, { ...run, result: { ...result, citations: [{ evidence_id: "invented", quote: "原文" }] } }), { ok: false, error: "invalid_citation" });
    assert.equal((await saveResearchCandidate(sql, { ...run, result: { ...result, content: "中".repeat(12001) } })).ok, false);
    assert.equal((await sql.query("select * from ai_research_candidates")).length, 0);
  } finally { await pg.close(); }
});

test("review intent is stable and a producer cannot invent a completed review", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql);
    await saveResearchCandidate(sql, { ...run, result });
    const intent = { ...run, grantSecret: "fake-local-grant-secret" };
    const first = await startResearchReview(sql, intent), replay = await startResearchReview(sql, intent);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(replay.ok, true);
    if (!first.ok || !replay.ok) return;
    assert.equal(first.request.review_call_id, replay.request.review_call_id);
    assert.equal(first.request.reviewer_grant, replay.request.reviewer_grant);
    assert.equal(first.request.candidate_digest, replay.request.candidate_digest);
    const report = { schema_version: 1, run_id: run.runId, candidate_digest: first.request.candidate_digest,
      evidence_digest: first.request.evidence_digest, policy_digest: first.request.policy_digest,
      checks: ["support", "scope", "conflicts", "source_independence", "uncertainty"].map(id => ({ id, status: "pass" })), findings: [] };
    assert.deepEqual(await saveResearchReview(sql, { ...run, report }), { ok: false, error: "review_call_not_completed" });
    await sql.query("update ai_runs set claim_token='revoked' where id=$1", [run.runId]);
    assert.deepEqual(await startResearchReview(sql, intent), { ok: false, error: "stale" });
  } finally { await pg.close(); }
});
