import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { researchTestDb, testResearchRun } from "../../../validation/agent/opencode/test-db.ts";
import { mapResearchStatus, getResearchStatus, cancelResearchJob } from "./agent-research-status.ts";

test("status uses durable state, separates drafts and never exposes execution credentials", () => {
  const row = { id: "job", status: "running", payload: { review_policy: { mode: "shadow" }, key: "secret" },
    request_json: { prompt: "secret" }, data_token_hash: "secret", grant_hash: "secret", runtime_event: "secret",
    result_json: { content: "草稿正文", citations: [{ evidence_id: "e1", quote: "原文" }], extra_secret: "secret" } };
  const dto = mapResearchStatus(row);
  assert.equal(dto.phase, "reviewing"); assert.equal(dto.review_mode, "shadow");
  assert.equal(dto.candidate?.content, "草稿正文"); assert.equal(dto.note_id, undefined);
  assert.ok(!JSON.stringify(dto).includes("secret"));
  assert.equal(mapResearchStatus({ ...row, status: "queued" }).phase, "queued");
  assert.equal(mapResearchStatus({ ...row, result_json: null }).phase, "researching");
  assert.equal(mapResearchStatus({ ...row, payload: { cancel_requested: true } }).phase, "cancel_requested");
  assert.equal(mapResearchStatus({ ...row, status: "failed", error_code: "review_blocked" }).phase, "blocked");
  assert.equal(mapResearchStatus({ ...row, status: "outcome_unknown" }).phase, "outcome_unknown");
  assert.equal(mapResearchStatus({ ...row, status: "succeeded", note_id: "note" }).phase, "published");
  assert.equal(mapResearchStatus({ ...row, status: "succeeded" }).phase, "outcome_unknown");
  assert.equal(mapResearchStatus({ ...row, error_code: "secret-provider-key" }).error_code, "research_failed");
});

test("status reads are side-effect free; unauthorized cancellation never queries the database", async () => {
  const sql = { query: async () => { throw new Error("must_not_query"); } };
  assert.deepEqual(await cancelResearchJob(sql, "job", false), { ok: false, error_code: "forbidden" });
  const { pg, sql: db } = await researchTestDb();
  try {
    const id = randomUUID();
    await db.query("insert into ai_jobs(id,item_id,material_hash,policy_version,status,job_kind) values($1,'research:read','h','v1','queued','research')", [id]);
    assert.equal((await getResearchStatus(db, id))?.phase, "queued");
    assert.equal((await getResearchStatus(db, id))?.status, "queued");
    assert.equal((await db.query<{ status: string }>("select status from ai_jobs where id=$1", [id]))[0].status, "queued");
  } finally { await pg.close(); }
});

test("running cancellation revokes both grants without claiming the model stopped or refunding unknown calls", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true });
    const [job] = await sql.query<{ id: string }>("select id from ai_jobs where run_id=$1", [run.runId]);
    const d = "a".repeat(64);
    await sql.query("insert into ai_research_candidates(run_id,result_json,evidence_json,candidate_digest,evidence_digest,policy_digest,frozen_policy) values($1,'{}','[]',$2,$2,$2,'{}')", [run.runId, d]);
    await sql.query("insert into ai_research_reviews(run_id,candidate_digest,evidence_digest,policy_digest,grant_hash) values($1,$2,$2,$2,'review-secret')", [run.runId, d]);
    const cancelled = await cancelResearchJob(sql, job.id, true);
    assert.equal(cancelled.ok && cancelled.phase, "cancel_requested");
    const [facts] = await sql.query<{ status: string; data_token_hash: string; grant_hash: string | null }>("select r.status,r.data_token_hash,v.grant_hash from ai_runs r join ai_research_reviews v on v.run_id=r.id where r.id=$1", [run.runId]);
    assert.equal(facts.status, "running"); assert.equal(facts.data_token_hash, ""); assert.equal(facts.grant_hash, null);
    assert.equal((await sql.query<{ status: string }>("select status from ai_budget_reservations where job_id=$1", [job.id]))[0].status, "reserved");
    assert.equal((await cancelResearchJob(sql, job.id, true)).ok, true);
    assert.equal((await getResearchStatus(sql, job.id))?.phase, "cancel_requested");
  } finally { await pg.close(); }
});

test("queued unclaimed cancellation releases only a proven unsent reservation and preserves terminal results", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const id = randomUUID();
    await sql.query("insert into ai_jobs(id,item_id,material_hash,policy_version,status,job_kind) values($1,'research:cancel','h','v1','queued','research')", [id]);
    await sql.query("insert into ai_budget_days(day,price_version,reserved_count,reserved_rmb) values('2026-10-07','v1',1,2)");
    await sql.query("insert into ai_budget_reservations(id,job_id,day,price_version,reserved_rmb,status,pricing) values($1,$2,'2026-10-07','v1',2,'reserved','{}')", [randomUUID(), id]);
    const cancelled = await cancelResearchJob(sql, id, true);
    assert.equal(cancelled.ok && cancelled.phase, "blocked");
    assert.equal(cancelled.ok && cancelled.error_code, "cancelled");
    assert.equal((await sql.query<{ status: string }>("select status from ai_budget_reservations where job_id=$1", [id]))[0].status, "released");
    assert.equal((await cancelResearchJob(sql, id, true)).ok, true);
    assert.deepEqual(await cancelResearchJob(sql, randomUUID(), true), { ok: false, error_code: "not_found" });
  } finally { await pg.close(); }
});

test("cancellation rolls back revoked grants on failure and cannot change an already published job", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true });
    const [job] = await sql.query<{ id: string }>("select id from ai_jobs where run_id=$1", [run.runId]);
    const failing = { ...sql, transaction: <T>(fn: (tx: any) => Promise<T>) => sql.transaction(tx => fn({ query: async (text: string, params?: unknown[]) => {
      if (text.includes("update ai_jobs set payload")) throw new Error("injected_cancel_failure");
      return tx.query(text, params);
    } })) };
    await assert.rejects(cancelResearchJob(failing, job.id, true), /injected_cancel_failure/);
    assert.equal((await sql.query<{ data_token_hash: string }>("select data_token_hash from ai_runs where id=$1", [run.runId]))[0].data_token_hash, "producer-token-hash");
    await sql.query("update ai_jobs set status='succeeded' where id=$1", [job.id]);
    await sql.query("update ai_runs set status='succeeded' where id=$1", [run.runId]);
    await sql.query("insert into knowledge_notes(id,title,content,kind,item_ids,run_id) values('published','结果','已发布内容','answer','[]',$1)", [run.runId]);
    const result = await cancelResearchJob(sql, job.id, true);
    assert.equal(result.ok && result.phase, "published");
    assert.equal((await sql.query<{ data_token_hash: string }>("select data_token_hash from ai_runs where id=$1", [run.runId]))[0].data_token_hash, "producer-token-hash");
  } finally { await pg.close(); }
});

test("a mismatched job/run claim cannot revoke another execution's access", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true });
    const [job] = await sql.query<{ id: string }>("select id from ai_jobs where run_id=$1", [run.runId]);
    await sql.query("update ai_jobs set claim_token='old-claim' where id=$1", [job.id]);
    assert.deepEqual(await cancelResearchJob(sql, job.id, true), { ok: false, error_code: "stale" });
    assert.equal((await sql.query<{ data_token_hash: string }>("select data_token_hash from ai_runs where id=$1", [run.runId]))[0].data_token_hash, "producer-token-hash");
  } finally { await pg.close(); }
});
test("an offline worker's expired run converges without cancelling another job or losing its draft", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { governed: true });
    const [job] = await sql.query<{ id: string }>("select id from ai_jobs where run_id=$1", [run.runId]);
    const digest = "a".repeat(64);
    await sql.query("insert into ai_research_candidates(run_id,result_json,evidence_json,candidate_digest,evidence_digest,policy_digest,frozen_policy) values($1,'{\"content\":\"已保存草稿\"}','[]',$2,$2,$2,'{}')", [run.runId, digest]);
    const other = randomUUID();
    await sql.query("insert into ai_jobs(id,item_id,material_hash,policy_version,status,job_kind) values($1,'research:unrelated','h','v1','queued','research')", [other]);
    await sql.query("update ai_runs set expires_at=clock_timestamp()-interval '1 second' where id=$1", [run.runId]);
    await sql.query("update ai_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    const status = await getResearchStatus(sql, job.id);
    assert.equal(status?.terminal, true);
    assert.equal(status?.can_cancel, false);
    assert.equal(status?.candidate?.content, "已保存草稿");
    assert.equal((await sql.query<{ status: string }>("select status from ai_jobs where id=$1", [other]))[0].status, "queued");
    assert.equal((await sql.query<{ status: string }>("select status from ai_budget_reservations where job_id=$1", [job.id]))[0].status, "unknown");
  } finally { await pg.close(); }
});
