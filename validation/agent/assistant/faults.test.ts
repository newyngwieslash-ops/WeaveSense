import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { claimAssistantJob, completeAssistantRun } from "../../../src/lib/server/assistant-jobs.ts";
import { prepareAssistantCollection, observeAssistantCollection } from "../../../src/lib/server/assistant-action-dispatch.ts";
import { decideAssistantAction, proposeAssistantActions } from "../../../src/lib/server/assistant-actions.ts";
import { reconcileAssistant } from "../../../src/lib/server/assistant-reconcile.ts";
import { cancelAssistantTurn } from "../../../src/lib/server/assistant-research.ts";

/**
 * Task 18 faults: crash-after-save, stop-unconfirmed hold, duplicate
 * finalize, cancel/approve races, partial batch failures. All observable
 * facts come from persisted rows (A13/A17/A30/A31).
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

async function seedQueuedAssistantJob(sql: Awaited<ReturnType<typeof db>>["sql"], turnStatus = "queued") {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}',$4) returning id`,
    [randomUUID(), conv.id, randomUUID(), turnStatus],
  );
  const jobId = randomUUID();
  await sql.query(
    `insert into ai_jobs(id, item_id, material_hash, policy_version, status, runtime_provider, job_kind, payload)
     values($1,$2,'materials','loom-assistant-v1','queued','opencode','assistant','{"provider":"opencode","question":"q"}')`,
    [jobId, `assistant:${turn.id}`],
  );
  return { conversationId: conv.id, turnId: turn.id, jobId };
}

const answerPayload = (conversationId: string, turnId: string) => ({
  schema_version: 1, conversation_id: conversationId, turn_id: turnId,
  result: { version: 1, answer: "答案", citations: [], actions: [] },
  runtime: { model: "offline-model", prompt_version: "v1", skill_versions: { "project-assistant": "x" }, input_tokens: 10, output_tokens: 2, model_calls: 1, tool_calls: 0, events: [] },
});

test("A13/A30: crash after result_saved — no message, no activation; recovery converges once", async () => {
  const { sql } = await db();
  const t = await seedQueuedAssistantJob(sql);
  const claim = await claimAssistantJob(sql, { leaseSeconds: 60 });
  assert.ok(claim);
  const [runRow] = await sql.query<{ id: string }>(
    `insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,data_token_hash)
     values($1,$2,'research','opencode','i','m','loom-assistant-v1','{}','running',$3, clock_timestamp()+interval '5 minutes','dtok') returning id`,
    [randomUUID(), randomUUID(), claim!.claimToken],
  );
  await sql.query("update ai_jobs set run_id=$2 where id=$1", [t.jobId, runRow.id]);
  // Stage 1 lands, then the worker crashes: no stop receipt.
  const saved = await completeAssistantRun(sql, {
    runId: runRow.id, jobId: t.jobId, claimToken: claim!.claimToken, stage: "result_saved", payload: answerPayload(t.conversationId, t.turnId),
  });
  assert.equal(saved.ok, true);
  const turn = await sql.query<{ status: string }>("select status from assistant_turns where id=$1", [t.turnId]);
  assert.equal(turn[0]?.status, "queued", "turn must not settle without the stop receipt");
  const actions = await sql.query("select count(*)::int as n from assistant_actions");
  assert.equal(actions[0].n, 0, "no activation rows from a crashed run");
  // Recovery: stop receipt arrives; a second observer replays.
  const settle = await completeAssistantRun(sql, {
    runId: runRow.id, jobId: t.jobId, claimToken: claim!.claimToken, stage: "runtime_stopped",
    payload: { epoch: randomUUID(), instance: "inst", ok: true },
  });
  assert.equal(settle.ok, true);
  const settle2 = await completeAssistantRun(sql, {
    runId: runRow.id, jobId: t.jobId, claimToken: claim!.claimToken, stage: "runtime_stopped",
    payload: { epoch: randomUUID(), instance: "inst", ok: true },
  });
  assert.equal(settle2.ok, true);
  const msgs = await sql.query("select count(*)::int as n from assistant_messages where conversation_id=$1", [t.conversationId]);
  assert.equal(msgs[0].n, 1, "exactly one assistant message after recovery");
});

test("A17: cancel during awaiting_confirmation stops execution and blocks approval", async () => {
  const { sql } = await db();
  const t = await seedQueuedAssistantJob(sql, "awaiting_confirmation");
  const [proposal] = await proposeAssistantActions(sql, {
    conversationId: t.conversationId, turnId: t.turnId,
    actions: [{ ordinal: 0, kind: "keyword.create", args: { keyword: "冲突关键词", platforms: ["rss"], interval: 30, enabled: true } }],
  });
  const cancelled = await cancelAssistantTurn(sql, t.conversationId, t.turnId);
  assert.equal(cancelled.ok, true);
  // A late approval after cancel must not execute.
  const late = await decideAssistantAction(sql, t.conversationId, proposal.id, {
    requestId: randomUUID(), decision: "approve",
    previewDigest: proposal.previewDigest, revision: 0,
  });
  assert.equal(late.status, "conflict", "cancelled turn blocks late approval");
  const keywords = await sql.query("select count(*)::int as n from keywords where phrase='冲突关键词'");
  assert.equal(keywords[0].n, 0, "no write after cancellation");
  const [action] = await sql.query<{ status: string }>(
    "select status from assistant_actions where id=$1", [proposal.id],
  );
  assert.equal(action.status, "cancelled");
});

test("A14: a failed step does not fabricate batch success; sibling rows keep real state", async () => {
  const { sql } = await db();
  const t = await seedQueuedAssistantJob(sql, "running");
  // Two proposed actions; one fails via unknown target, one succeeds.
  const proposals = await proposeAssistantActions(sql, {
    conversationId: t.conversationId, turnId: t.turnId,
    actions: [
      { ordinal: 0, kind: "keyword.create", args: { keyword: "成功关键词", platforms: ["rss"], interval: 30, enabled: true } },
      { ordinal: 1, kind: "keyword.update", args: { keyword_id: "kw-missing", interval: 5 } },
    ],
  });
  const [p0, p1] = proposals as Array<{ id: string; previewDigest: string }>;
  const r0 = await decideAssistantAction(sql, t.conversationId, p0.id, {
    requestId: randomUUID(), decision: "approve", previewDigest: p0.previewDigest, revision: 0,
  });
  assert.equal(r0.status, "succeeded");
  const r1 = await decideAssistantAction(sql, t.conversationId, p1.id, {
    requestId: randomUUID(), decision: "approve", previewDigest: p1.previewDigest, revision: 0,
  });
  assert.equal(r1.status, "not_found", "missing target is honest, not success");
  const createdRows = await sql.query("select count(*)::int as n from keywords where phrase='成功关键词'");
  assert.equal(createdRows[0].n, 1, "sibling success persists");
  const [failedRow] = await sql.query<{ status: string; result_json: Record<string, unknown> }>(
    "select status, result_json from assistant_actions where id=$1", [p1.id],
  );
  assert.equal(failedRow.status, "failed");
  assert.equal((failedRow.result_json as { error_code?: string }).error_code, "not_found");
});

test("A31: reconcile after crash converges expired previews and releases the slot", async () => {
  const { sql } = await db();
  const t = await seedQueuedAssistantJob(sql, "awaiting_confirmation");
  await proposeAssistantActions(sql, {
    conversationId: t.conversationId, turnId: t.turnId,
    actions: [{ ordinal: 0, kind: "keyword.create", args: { keyword: "过期预览", platforms: ["rss"], interval: 30, enabled: true } }],
  }, { expiresInMs: -1000 });
  const first = await reconcileAssistant(sql);
  assert.ok(first.expiredPreviews >= 1);
  const second = await reconcileAssistant(sql);
  assert.equal(second.expiredPreviews, 0, "convergence is once-only");
  const [turn] = await sql.query<{ status: string }>("select status from assistant_turns where id=$1", [t.turnId]);
  assert.ok(["completed", "failed"].includes(turn.status), "active slot released without a browser");
});

test("A12/A13 collection fault: crash between send and receipt converges by observation", async () => {
  const { sql } = await db();
  const t = await seedQueuedAssistantJob(sql, "running");
  await sql.query("insert into keywords(id,phrase,platforms,interval_minutes,enabled,status) values('kw-f','故障词','[\"rss\"]'::jsonb,30,true,'idle')");
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,'keyword.collect_once','{"keyword_id":"kw-f"}'::jsonb,'${"c".repeat(64)}','approved') returning id`,
    [randomUUID(), t.turnId],
  );
  const prepared = await prepareAssistantCollection(sql, {
    actionId: action.id, turnId: t.turnId, conversationId: t.conversationId,
    kind: "keyword.collect_once", targetId: "kw-f",
  });
  // Crash: dispatch stamp written, job finished, receipt never persisted.
  await sql.query("update assistant_actions set status='executing', dispatch_started_at=clock_timestamp() where id=$1", [action.id]);
  await sql.query("update jobs set status='succeeded', items_new=1, items_found=2 where id=$1", [prepared.jobId]);
  const receipt = await observeAssistantCollection(sql, {
    actionId: action.id, conversationId: t.conversationId, turnId: t.turnId, jobId: prepared.jobId,
  });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.counts?.inserted, 1);
  const jobs = await sql.query("select count(*)::int as n from jobs");
  assert.equal(jobs[0].n, 1, "observation created no second send");
});
