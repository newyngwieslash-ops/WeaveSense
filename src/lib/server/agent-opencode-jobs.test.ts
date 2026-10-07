import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { researchTestDb } from "../../../validation/agent/opencode/test-db.ts";
import { enqueueResearchJob } from "./agent-queue.ts";
import { handleAgentJobs } from "./agent-jobs.ts";
import { handleOpenCodeJobs } from "./agent-opencode-jobs.ts";

test("OpenCode claims are isolated, bindings immutable, and uncertain dispatch is reconciled without resend", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    await enqueueResearchJob(sql, { question: "独立任务", materialHash: "materials", requestId: randomUUID(), snapshot: { provider: "opencode" } });
    assert.equal((await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} })).status, 404);
    const claim = await handleOpenCodeJobs({ sql, authorized: true, action: "claim", params: {} });
    assert.equal(claim.status, 409); // Ungoverned third-party execution is not eligible.
    assert.equal((await sql.query<{ status: string }>("select status from ai_jobs"))[0].status, "queued");
    await sql.query("delete from ai_jobs");
    await enqueueResearchJob(sql, { question: "受控任务", materialHash: "materials", requestId: randomUUID(), snapshot: { provider: "opencode", governed: true,
      model_profile: { model: "fake", input_per_million: 2, output_per_million: 4 }, role_limits: { producer: 6, reviewer: 1 }, skill_snapshot_digest: "a".repeat(64),
      review_policy: { mode: "off", model: "fake", version: "loom-agent-v1", question: "受控任务" },
      budget: { dailyLimit: 20, dailyBudgetRmb: 200, priceVersion: "test", worstCostRmb: 10, pricing: { model: "fake", input_per_million: 2, output_per_million: 4 } } } });
    const got = await handleOpenCodeJobs({ sql, authorized: true, action: "claim", params: {} });
    assert.equal(got.status, 200, JSON.stringify(got));
    const ids = { job_id: got.body.job_id, run_id: got.body.run_id, claim_token: got.body.claim_token };
    const send = (action: string, extra: Record<string, unknown> = {}) => handleOpenCodeJobs({ sql, authorized: true, action, params: { action, ...ids, ...extra } });
    const binding = { instance_id: randomUUID(), epoch: randomUUID(), session_id: "ses_test123", runtime_version: "1.3.13", config_digest: "b".repeat(64) };
    assert.equal((await send("bind", binding)).status, 200);
    assert.equal((await send("bind", binding)).status, 200);
    assert.equal((await send("bind", { ...binding, epoch: randomUUID() })).status, 409);
    assert.equal((await send("submitted")).status, 409);
    assert.equal((await send("dispatching")).status, 200);
    assert.equal((await send("dispatching")).status, 200);
    await sql.query("update ai_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [ids.job_id]);
    const recovered = await handleOpenCodeJobs({ sql, authorized: true, action: "claim", params: {} });
    assert.equal(recovered.status, 200, JSON.stringify(recovered));
    assert.equal(recovered.body.phase, "reconcile");
    assert.equal((recovered.body.runtime_binding as { state: string }).state, "dispatch_unknown");
    assert.equal((await send("submitted")).status, 409);
    const nextIds = { ...ids, claim_token: recovered.body.claim_token };
    const dispatch = await handleOpenCodeJobs({ sql, authorized: true, action: "dispatching", params: { action: "dispatching", ...nextIds } });
    assert.equal(dispatch.status, 409);
    assert.equal((await sql.query("select * from ai_model_calls")).length, 0);
    assert.equal((await handleAgentJobs({ sql, authorized: true, action: "renew", params: nextIds })).status, 409);
  } finally { await pg.close(); }
});
