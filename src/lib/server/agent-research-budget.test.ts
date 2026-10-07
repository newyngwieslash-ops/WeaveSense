import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { researchTestDb, testResearchRun } from "../../../validation/agent/opencode/test-db.ts";
import { admitGovernedModelCall } from "./agent-budget.ts";
import { saveResearchCandidate, startResearchReview } from "./agent-candidates.ts";

test("producer sends once and cannot spend the reviewer's reserved call", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true, role_limits: { producer: 1, reviewer: 1 }, policy: { max_model_calls: 2, version: "loom-agent-v1" } });
    const input = { call_id: randomUUID(), phase: "started" as const, model: "fake", policy_version: "loom-agent-v1", request_digest: "a".repeat(64) };
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, input), "send_once");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, input), "already_started");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, { ...input, request_digest: "b".repeat(64) }), "denied");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, { ...input, call_id: randomUUID() }), "denied");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, { ...input, phase: "completed", input_tokens: 20, output_tokens: 4 }), "completed");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, input), "completed");
    await saveResearchCandidate(sql, { ...run, result: { content: "材料不足。", citations: [], insufficient_evidence: true, coverage: "full", warnings: [] } });
    const started = await startResearchReview(sql, { ...run, grantSecret: "fake-grant-secret" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const req = started.request;
    const { hashRunToken } = await import("./agent-data.ts");
    const reviewInput = { ...input, call_id: req.review_call_id, request_digest: req.request_digest };
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "reviewer", tokenHash: "producer-token-hash" }, reviewInput), "denied");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "reviewer", tokenHash: hashRunToken(req.reviewer_grant) }, reviewInput), "send_once");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "reviewer", tokenHash: hashRunToken(req.reviewer_grant) }, { ...reviewInput, phase: "unknown" }), "unknown");
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "reviewer", tokenHash: hashRunToken(req.reviewer_grant) }, reviewInput), "unknown");
  } finally { await pg.close(); }
});

test("a revoked review grant and a producer past its child deadline cannot send", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true, producer_deadline_at: "2000-01-01T00:00:00Z" });
    const input = { call_id: randomUUID(), phase: "started" as const, model: "fake", policy_version: "loom-agent-v1", request_digest: "a".repeat(64) };
    assert.equal(await admitGovernedModelCall(sql, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, input), "denied");
    assert.equal((await sql.query("select * from ai_model_calls")).length, 0);
  } finally { await pg.close(); }
});

test("fresh SDK retry IDs cannot spend after a started or unknown Producer request", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true });
    const auth = { role: "producer" as const, tokenHash: "producer-token-hash" };
    const input = { call_id: randomUUID(), phase: "started" as const, model: "fake", policy_version: "loom-agent-v1", request_digest: "a".repeat(64) };
    assert.equal(await admitGovernedModelCall(sql, run.runId, auth, input), "send_once");
    assert.equal(await admitGovernedModelCall(sql, run.runId, auth, { ...input, call_id: randomUUID() }), "denied");
    assert.equal(await admitGovernedModelCall(sql, run.runId, auth, { ...input, phase: "unknown" }), "unknown");
    assert.equal(await admitGovernedModelCall(sql, run.runId, auth, { ...input, call_id: randomUUID() }), "denied");
    assert.equal((await saveResearchCandidate(sql, { ...run, result: { content: "无法确认", citations: [], insufficient_evidence: true, coverage: "full", warnings: [] } })).ok, false);
    assert.equal((await sql.query("select * from ai_model_calls")).length, 1);
  } finally { await pg.close(); }
});
