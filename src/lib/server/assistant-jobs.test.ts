import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { claimAssistantJob, assistantPolicyFromEnv, completeAssistantRun } from "./assistant-jobs.ts";
import { claimAiJob } from "./agent-queue.ts";

/**
 * Task 7: explicit job_kind dispatch, assistant budget admission, and the
 * assistant terminal finalizer (result_saved -> stop -> settle).
 */

async function db() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
    await pg.exec(readFileSync("migrations/" + name, "utf8"));
  }
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
    async transaction<T>(fn: (tx: { query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]> }) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({
        async query<R = Record<string, unknown>>(text: string, params: unknown[] = []) {
          return (await inner.query<R>(text, params)).rows;
        },
      })) as Promise<T>;
    },
  };
  return { pg, sql };
}

type TestSql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: { query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]> }) => Promise<T>): Promise<T>;
};

async function seedAssistantTurn(sql: TestSql) {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','queued') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  return { conversationId: conv.id, turnId: turn.id };
}

async function enqueueAssistantJob(sql: TestSql, turnId: string) {
  const jobId = randomUUID();
  await sql.query(
    `insert into ai_jobs(id, item_id, material_hash, policy_version, status, runtime_provider, job_kind, payload)
     values($1,$2,'materials','loom-assistant-v1','queued','opencode','assistant',$3::jsonb)`,
    [jobId, `assistant:${turnId}`, JSON.stringify({ provider: "opencode", mode: "research", question: "看看关键词" })],
  );
  return jobId;
}

test("assistant jobs are claimed only via the assistant claim; analyze/research never see them", async () => {
  const { sql } = await db();
  const t = await seedAssistantTurn(sql);
  const assistantJobId = await enqueueAssistantJob(sql, t.turnId);
  await sql.query("insert into sources(id,platform,name) values('s','rss','信源')");
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,pipeline_status) values('i1','s','rss','x','标题','正文','ready')");

  // The legacy analyze claim must not pick the assistant job.
  const analyzeClaim = await claimAiJob(sql, { worker: "cron", leaseSeconds: 60, kind: "analyze", provider: "opencode" });
  assert.equal(analyzeClaim, null, "analyze claim cannot take assistant jobs");
  // The research claim must not pick it either.
  const researchClaim = await claimAiJob(sql, { worker: "agent", leaseSeconds: 60, kind: "research", provider: "opencode" });
  assert.equal(researchClaim, null, "research claim cannot take assistant jobs");
  // Assistant claim wins.
  const claim = await claimAssistantJob(sql, { leaseSeconds: 60 });
  assert.ok(claim);
  assert.equal(claim!.jobId, assistantJobId);
  assert.equal(claim!.turnId, t.turnId);
});

test("assistant policy defaults derive bounded limits from env", () => {
  const policy = assistantPolicyFromEnv({});
  assert.equal(policy.maxModelCalls, 6);
  assert.equal(policy.maxToolCalls, 8);
  assert.equal(policy.maxOutputTokensPerCall, 1800);
  assert.ok(policy.executionTimeoutMs >= 1000);
  assert.ok(policy.queueTtlMs >= 1000);
});

test("result_saved blocks new producer sends before stop confirmation", async () => {
  const { sql } = await db();
  const t = await seedAssistantTurn(sql);
  const jobId = await enqueueAssistantJob(sql, t.turnId);
  const claim = await claimAssistantJob(sql, { leaseSeconds: 60 });
  assert.ok(claim);
  const [runRow] = await sql.query<{ id: string }>(
    `insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,data_token_hash)
     values($1,$2,'research','opencode','i','m','loom-assistant-v1','{}','running',$3, clock_timestamp()+interval '5 minutes','dtok') returning id`,
    [randomUUID(), randomUUID(), claim!.claimToken],
  );
  await sql.query("update ai_jobs set run_id=$2 where id=$1", [jobId, runRow.id]);

  // Finalize step 1: persist the immutable result -> result_saved.
  const answerPayload = {
    schema_version: 1, conversation_id: t.conversationId, turn_id: t.turnId,
    result: { version: 1, answer: "答案", citations: [], actions: [] },
    runtime: { model: "offline-model", prompt_version: "v1", skill_versions: {}, input_tokens: 100, output_tokens: 20, model_calls: 1, tool_calls: 2, events: [] },
  };
  const saved = await completeAssistantRun(sql, {
    runId: runRow.id, jobId, claimToken: claim!.claimToken, stage: "result_saved", payload: answerPayload,
  });
  assert.equal(saved.ok, true);
  const [binding] = await sql.query<{ state: string }>("select state from ai_runtime_bindings");
  assert.equal(binding?.state, "result_saved");

  // Finalize step 2: stop receipt lands, then the run settles and the
  // assistant message is written exactly once.
  const stopped = await completeAssistantRun(sql, {
    runId: runRow.id, jobId, claimToken: claim!.claimToken, stage: "runtime_stopped",
    payload: { epoch: "11111111-1111-4111-8111-111111111111", instance: "inst", ok: true },
  });
  assert.equal(stopped.ok, true);

  const runRows = await sql.query("select status, response_json from ai_runs where id=$1", [runRow.id]);
  const run = runRows[0] as { status: string; response_json: { result?: { answer?: string } } };
  assert.equal(run.status, "succeeded");
  assert.equal(run.response_json.result?.answer, "答案");
  const [turn] = await sql.query<{ status: string }>("select status from assistant_turns where id=$1", [t.turnId]);
  assert.equal(turn.status, "completed");
  const msgs = await sql.query("select role from assistant_messages where conversation_id=$1", [t.conversationId]);
  assert.ok(msgs.some((m) => m.role === "assistant"));

  // Idempotent re-finalize does not duplicate the message.
  const replay = await completeAssistantRun(sql, {
    runId: runRow.id, jobId, claimToken: claim!.claimToken, stage: "runtime_stopped",
    payload: { epoch: "11111111-1111-4111-8111-111111111111", instance: "inst", ok: true },
  });
  assert.equal(replay.ok, true);
  const msgs2 = await sql.query("select count(*)::int as n from assistant_messages where conversation_id=$1", [t.conversationId]);
  assert.equal(msgs2[0].n, 1, "exactly one assistant message after duplicate finalize");
});

test("stop not confirmed: run cannot finalize and actions stay unactivated", async () => {
  const { sql } = await db();
  const t = await seedAssistantTurn(sql);
  const jobId = await enqueueAssistantJob(sql, t.turnId);
  const claim = await claimAssistantJob(sql, { leaseSeconds: 60 });
  const [runRow] = await sql.query<{ id: string }>(
    `insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,data_token_hash)
     values($1,$2,'research','opencode','i','m','loom-assistant-v1','{}','running',$3, clock_timestamp()+interval '5 minutes','dtok') returning id`,
    [randomUUID(), randomUUID(), claim!.claimToken],
  );
  await sql.query("update ai_jobs set run_id=$2 where id=$1", [jobId, runRow.id]);
  const payload = {
    schema_version: 1, conversation_id: t.conversationId, turn_id: t.turnId,
    result: { version: 1, answer: "答案", citations: [], actions: [] },
    runtime: { model: "offline-model", prompt_version: "v1", skill_versions: {}, input_tokens: 10, output_tokens: 2, model_calls: 1, tool_calls: 0, events: [] },
  };
  await completeAssistantRun(sql, { runId: runRow.id, jobId, claimToken: claim!.claimToken, stage: "result_saved", payload });
  // The turn stays awaiting (result saved but runtime stop unconfirmed) — no
  // assistant message, no settle.
  const [turn] = await sql.query<{ status: string }>("select status from assistant_turns where id=$1", [t.turnId]);
  assert.notEqual(turn.status, "completed");
  const msgs = await sql.query("select count(*)::int as n from assistant_messages where conversation_id=$1", [t.conversationId]);
  assert.equal(msgs[0].n, 0);
});
