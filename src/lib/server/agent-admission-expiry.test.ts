import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { researchTestDb, testResearchRun } from "../../../validation/agent/opencode/test-db.ts";
import { admitGovernedModelCall } from "./agent-budget.ts";
import { saveResearchCandidate, startResearchReview } from "./agent-candidates.ts";
import { evidenceSourceFor } from "./agent-context.ts";
import { hashRunToken } from "./agent-data.ts";
import { mapAgentItem } from "./agent-retrieval.ts";
import type { AgentSql } from "./agent-transaction.ts";

const candidate = { content: "材料不足，无法确认结论。", citations: [], insufficient_evidence: true, coverage: "full" as const, warnings: [] };

// Delay a real query at the same boundary as a row-lock wait. Ownership and
// expiry are still evaluated using the database wall clock, never a mock.
function delayedQuery(sql: AgentSql, fragment: string) {
  let waited = false;
  const delayed: AgentSql = {
    query: sql.query.bind(sql),
    transaction: fn => sql.transaction!(tx => fn({
      query: async <T>(query: string, params: unknown[] = []) => {
        if (!waited && query.includes(fragment)) {
          waited = true;
          await new Promise(resolve => setTimeout(resolve, 1100));
        }
        return tx.query<T>(query, params);
      },
    })),
  };
  return { delayed, assertWaited: () => assert.equal(waited, true, "the admission reached the delayed lock boundary") };
}

test("candidate sealing rechecks the lease after evidence locks wait", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    await sql.query("insert into sources(id,platform,name) values('s','rss','信源')");
    await sql.query("insert into items(id,source_id,platform,external_id,title,body) values('i','s','rss','i','材料','原始材料')");
    const [row] = await sql.query("select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id='i'");
    const item = mapAgentItem(row);
    const source = evidenceSourceFor(item, { start: 0, end: 4, text: "原始材料" }, "full");
    const run = await testResearchRun(sql, { governed: true, sources: [source] });
    await sql.query("update ai_jobs set lease_until=clock_timestamp()+interval '1 second' where run_id=$1", [run.runId]);
    const delay = delayedQuery(sql, "select * from items where id=any");
    assert.deepEqual(await saveResearchCandidate(delay.delayed, { ...run, result: candidate }), { ok: false, error: "stale" });
    delay.assertWaited();
    assert.equal((await sql.query("select * from ai_research_candidates")).length, 0);
  } finally { await pg.close(); }
});

for (const deadline of ["producer", "run"] as const) test(`new Producer send rechecks ${deadline} deadline after budget locks wait`, async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true });
    if (deadline === "producer") await sql.query("update ai_runs set request_json=jsonb_set(request_json,'{producer_deadline_at}',to_jsonb(clock_timestamp()+interval '1 second')) where id=$1", [run.runId]);
    else await sql.query("update ai_runs set expires_at=clock_timestamp()+interval '1 second' where id=$1", [run.runId]);
    const delay = delayedQuery(sql, "select * from ai_budget_reservations");
    const disposition = await admitGovernedModelCall(delay.delayed, run.runId, { role: "producer", tokenHash: "producer-token-hash" }, {
      call_id: randomUUID(), phase: "started", model: "fake", policy_version: "loom-agent-v1", request_digest: "a".repeat(64),
    });
    delay.assertWaited();
    assert.equal(disposition, "denied");
    assert.equal((await sql.query("select * from ai_model_calls")).length, 0);
    assert.equal((await sql.query<{ dispatch_state: string }>("select dispatch_state from ai_budget_reservations"))[0].dispatch_state, "unconfirmed");
  } finally { await pg.close(); }
});

test("new Reviewer send rechecks the grant deadline after budget locks wait", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true });
    assert.equal((await saveResearchCandidate(sql, { ...run, result: candidate })).ok, true);
    await sql.query("update ai_runs set request_json=jsonb_set(request_json,'{review_deadline_at}',to_jsonb(clock_timestamp()+interval '1 second')) where id=$1", [run.runId]);
    const intent = await startResearchReview(sql, { ...run, grantSecret: "fake-local-grant-secret" });
    assert.equal(intent.ok, true);
    if (!intent.ok) throw new Error("review_intent_missing");
    const delay = delayedQuery(sql, "select * from ai_budget_reservations");
    const request = intent.request;
    const disposition = await admitGovernedModelCall(delay.delayed, run.runId, { role: "reviewer", tokenHash: hashRunToken(request.reviewer_grant) }, {
      call_id: request.review_call_id, phase: "started", model: "fake", policy_version: "loom-agent-v1", request_digest: request.request_digest,
    });
    delay.assertWaited();
    assert.equal(disposition, "denied");
    assert.equal((await sql.query("select * from ai_model_calls")).length, 0);
    assert.equal((await sql.query<{ state: string }>("select state from ai_research_reviews"))[0].state, "pending");
  } finally { await pg.close(); }
});
