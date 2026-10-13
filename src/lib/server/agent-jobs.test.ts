import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { enqueueResearchJob } from "./agent-queue.ts";
import { handleAgentJobs } from "./agent-jobs.ts";
import { saveCheckpoint } from "./agent-checkpoints.ts";
import { mapAgentItem } from "./agent-retrieval.ts";
import { evidenceSourceFor } from "./agent-context.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql","0022_research_review.sql","0023_research_runtime.sql","0024_research_call_roles.sql","0027_assistant_runtime.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources (id, platform, name) values ('s','rss','信源')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','电池','电池原始正文。')");
  const sql = {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    }, async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  return { pg, sql };
}

test("claim issues a run token and complete persists an answer", async () => {
  const { pg, sql } = await setup();
  await enqueueResearchJob(sql, { question: "电池", requestId: randomUUID(), materialHash: "h" });
  const claimed = await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} });
  assert.equal(claimed.status, 200);
  assert.ok(claimed.body.data_access_token);
  const runId = String(claimed.body.run_id);
  const complete = await handleAgentJobs({
    sql, authorized: true, action: "complete", params: {
      job_id: claimed.body.job_id, run_id: runId, claim_token: claimed.body.claim_token, status: "succeeded",
      question: "电池",
      response: {
        schema_version: 1, run_id: runId, ok: true,
        result: { content: "根据材料回答。", citations: [], insufficient_evidence: false, coverage: "full", warnings: [] },
        runtime: { model: "test", prompt_version: "v1", skill_versions: {}, input_tokens: null, output_tokens: null, model_calls: 1, tool_calls: 0, events: [] },
        evidence: [],
      },
    },
  });
  assert.equal(complete.status, 200, JSON.stringify(complete));
  const notes = await sql.query("select id from knowledge_notes");
  const runs = await sql.query<{ status: string }>("select status from ai_runs where id = $1", [runId]);
  assert.equal(notes.length, 1);
  assert.equal(runs[0]?.status, "succeeded");
  await pg.close();
});

test("a delayed first claim creates one fresh persisted execution deadline", async () => {
  const { pg, sql } = await setup();
  try {
    const queued = await enqueueResearchJob(sql, { question: "电池", requestId: randomUUID(), materialHash: "h" });
    assert.ok(queued);
    await sql.query("update ai_jobs set payload=jsonb_set(payload,'{policy,deadline_at}',to_jsonb('2000-01-01T00:00:00Z'::text)) where id=$1", [queued.id]);
    const before = Date.now();
    const claim = await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} });
    assert.equal(claim.status, 200);
    const policy = claim.body.policy as { deadline_at: string };
    assert.ok(Date.parse(policy.deadline_at) >= before + 119_000);
    const [run] = await sql.query<{ expires_at: string; request_json: { policy: { deadline_at: string } } }>("select expires_at,request_json from ai_runs where id=$1", [claim.body.run_id]);
    assert.equal(new Date(run.expires_at).toISOString(), policy.deadline_at);
    assert.equal(run.request_json.policy.deadline_at, policy.deadline_at);
    const [job] = await sql.query<{ payload: { policy: { deadline_at: string } } }>("select payload from ai_jobs where id=$1", [queued.id]);
    assert.equal(job.payload.policy.deadline_at, policy.deadline_at);
  } finally { await pg.close(); }
});

test("queue expiration is not renewed by claiming a research job", async () => {
  const { pg, sql } = await setup();
  try {
    const queued = await enqueueResearchJob(sql, { question: "电池", requestId: randomUUID(), materialHash: "h" });
    assert.ok(queued);
    await sql.query("update ai_jobs set payload=jsonb_set(payload,'{queue_expires_at}',to_jsonb('2000-01-01T00:00:00Z'::text)) where id=$1", [queued.id]);
    const claim = await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} });
    assert.equal(claim.status, 404);
    const [job] = await sql.query<{ status: string; error_code: string }>("select status,error_code from ai_jobs where id=$1", [queued.id]);
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "queue_expired");
    assert.equal((await sql.query("select id from ai_runs")).length, 0);
  } finally { await pg.close(); }
});

test("renewing a lease preserves the originally persisted execution deadline", async () => {
  const { pg, sql } = await setup();
  try {
    await enqueueResearchJob(sql, { question: "电池", requestId: randomUUID(), materialHash: "h" });
    const claim = await handleAgentJobs({ sql, authorized: true, action: "claim", params: {} });
    const [before] = await sql.query<{ expires_at: string }>("select expires_at from ai_runs where id=$1", [claim.body.run_id]);
    const renewed = await handleAgentJobs({ sql, authorized: true, action: "renew", params: {
      job_id: claim.body.job_id, run_id: claim.body.run_id, claim_token: claim.body.claim_token,
    } });
    assert.equal(renewed.status, 200);
    const [after] = await sql.query<{ expires_at: string }>("select expires_at from ai_runs where id=$1", [claim.body.run_id]);
    assert.equal(String(after.expires_at), String(before.expires_at));
  } finally { await pg.close(); }
});

for (const changed of [false, true]) test(`expired checkpoint ${changed ? "refuses changed library material" : "resumes unchanged library material"}`, async t => {
  const f = await setup(); t.after(() => f.pg.close());
  const [raw] = await f.sql.query<Record<string, unknown>>("select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id='item-1'");
  const item = mapAgentItem(raw);
  const source = evidenceSourceFor(item, { start: 0, end: Array.from(item.body).length, text: item.body }, "full");
  const job = await enqueueResearchJob(f.sql, { question: "电池", requestId: randomUUID(), materialHash: "h", snapshot: { sources: [source] } });
  assert.ok(job);
  const claim = await handleAgentJobs({ sql: f.sql, authorized: true, action: "claim", params: {} });
  assert.equal(claim.status, 200);
  assert.equal(await saveCheckpoint(f.sql, { runId: String(claim.body.run_id), checkPointId: "cp", claimToken: String(claim.body.claim_token),
    sequence: 1, schemaVersion: "1", runtimeVersion: "eino-v0.9.19", payload: Buffer.from("opaque-state") }), "ok");
  if (changed) await f.sql.query("update items set body=body||'最新材料' where id='item-1'");
  await f.sql.query("update ai_jobs set lease_until=now()-interval '1 minute' where id=$1", [claim.body.job_id]);
  const resumed = await handleAgentJobs({ sql: f.sql, authorized: true, action: "claim", params: {} });
  if (changed) {
    assert.equal(resumed.status, 404); assert.notEqual(resumed.body.resume, true);
    const [run] = await f.sql.query<{ status: string; error_code: string; claim_token: string }>("select * from ai_runs where id=$1", [claim.body.run_id]);
    assert.equal(run.status, "outcome_unknown"); assert.equal(run.error_code, "checkpoint_input_changed");
    assert.equal(run.claim_token, claim.body.claim_token, "stale checkpoint must not receive a new owner token");
    assert.equal((await f.sql.query("select * from ai_model_calls")).length, 0);
    assert.equal((await f.sql.query("select * from knowledge_notes")).length, 0);
  } else {
    assert.equal(resumed.status, 200); assert.equal(resumed.body.resume, true);
    assert.notEqual(resumed.body.claim_token, claim.body.claim_token); assert.equal(resumed.body.sequence, 1);
  }
});
