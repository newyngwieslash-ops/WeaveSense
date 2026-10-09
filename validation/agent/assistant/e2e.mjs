#!/usr/bin/env node
/**
 * Assistant e2e acceptance (plan Task 18 / §9 subset runnable without a paid
 * model or a real OpenCode runtime):
 *   A04  same request id replays one turn; different content 409s;
 *   A05  second active turn conflicts;
 *   A12  completed collection replays its receipt, never re-collects;
 *   A13  crash-after-send converges by observation only;
 *   A30  result_saved without stop confirmation holds the turn;
 *   A31  reconcile converges expired previews and finished children.
 *
 * Explicit --run is required: importing never starts processes or IO.
 * Uses an in-memory PGlite per section; production parity runs via
 * `npm run agent:assistant:pg` on a real PostgreSQL (Task 19 sign-off).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const args = process.argv.slice(2);
if (!args.includes("--run")) {
  console.log(JSON.stringify({ ok: true, checks: 0, mode: "import-only", note: "pass --run to execute" }));
  process.exit(0);
}

const silent = { log() {}, warn() {}, error() {} };

async function openDb() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
    await pg.exec(readFileSync("migrations/" + name, "utf8"));
  }
  const sql = {
    async query(text, params = []) { return (await pg.query(text, params)).rows; },
    async transaction(fn) {
      return pg.transaction(async (inner) => fn({
        async query(text, params = []) { return (await inner.query(text, params)).rows; },
      }));
    },
  };
  return { pg, sql };
}

async function seedTurn(sql, status = "running") {
  const [conv] = await sql.query("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}',$4) returning id`,
    [randomUUID(), conv.id, randomUUID(), status],
  );
  return { conversationId: conv.id, turnId: turn.id };
}

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

// A04: message submission idempotency.
{
  const { pg, sql } = await openDb();
  const t = await seedTurn(sql, "completed");
  // Free slot already terminal; submit fresh.
  const input = {
    request_id: randomUUID(), expected_revision: 0,
    text: "看看最近采集失败的任务",
    context: { page: "overview", filters: {}, references: [] },
  };
  const { submitAssistantMessage } = await import("../../../src/lib/server/assistant-events.ts");
  const first = await submitAssistantMessage(sql, t.conversationId, input);
  const second = await submitAssistantMessage(sql, t.conversationId, input);
  const conflict = await submitAssistantMessage(sql, t.conversationId, { ...input, text: "不同的内容" });
  record("A04", first.kind === "won" && second.kind === "replay" && second.turn.id === first.turn.id && conflict.kind === "conflict",
    `first=${first.kind} replay=${second.kind} conflict=${conflict.kind}`);
  await pg.close();
}

// A05: second active turn conflicts.
{
  const { pg, sql } = await openDb();
  const t = await seedTurn(sql, "completed");
  const { submitAssistantMessage } = await import("../../../src/lib/server/assistant-events.ts");
  const input = { request_id: randomUUID(), expected_revision: 0, text: "第一轮", context: { page: "overview", filters: {}, references: [] } };
  const first = await submitAssistantMessage(sql, t.conversationId, input);
  const second = await submitAssistantMessage(sql, t.conversationId, { ...input, request_id: randomUUID(), text: "第二轮" });
  record("A05", first.kind === "won" && second.kind === "conflict", `first=${first.kind} second=${second.kind}`);
  await pg.close();
}

// A12/A13: collection replay + crash observation.
{
  const { pg, sql } = await openDb();
  const { prepareAssistantCollection, observeAssistantCollection } = await import("../../../src/lib/server/assistant-action-dispatch.ts");
  const t = await seedTurn(sql, "running");
  const [action] = await sql.query(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,'keyword.collect_once','{"keyword_id":"kw-1"}'::jsonb,'${"b".repeat(64)}','approved') returning id`,
    [randomUUID(), t.turnId],
  );
  await sql.query("insert into keywords(id,phrase,platforms,interval_minutes,enabled,status) values('kw-1','固态电池','[\"rss\"]'::jsonb,30,true,'idle')");
  const actionId = action.id;
  const prepared = await prepareAssistantCollection(sql, {
    actionId, turnId: t.turnId, conversationId: t.conversationId, kind: "keyword.collect_once", targetId: "kw-1",
  });
  // Simulate send-then-crash: dispatch stamp set, job succeeded, no receipt.
  await sql.query("update assistant_actions set status='executing', dispatch_started_at=clock_timestamp() where id=$1", [actionId]);
  await sql.query("update jobs set status='succeeded', items_new=2, items_found=3 where id=$1", [prepared.jobId]);
  const observed = await observeAssistantCollection(sql, { actionId, conversationId: t.conversationId, turnId: t.turnId, jobId: prepared.jobId });
  const jobs = await sql.query("select count(*)::int as n from jobs");
  record("A13", observed.status === "succeeded" && observed.counts?.inserted === 2 && jobs[0].n === 1,
    `observed=${observed.status} inserted=${observed.counts?.inserted} jobs=${jobs[0].n}`);
  // Retry prepare on the completed action: replay, no new job.
  const replay = await prepareAssistantCollection(sql, {
    actionId, turnId: t.turnId, conversationId: t.conversationId, kind: "keyword.collect_once", targetId: "kw-1",
  });
  const jobs2 = await sql.query("select count(*)::int as n from jobs");
  record("A12", replay.kind === "replay" && replay.jobId === prepared.jobId && jobs2[0].n === 1,
    `replay=${replay.kind} same=${replay.jobId === prepared.jobId} jobs=${jobs2[0].n}`);
  await pg.close();
}

// A30: result_saved without stop confirmation holds everything.
{
  const { pg, sql } = await openDb();
  const { claimAssistantJob, completeAssistantRun } = await import("../../../src/lib/server/assistant-jobs.ts");
  const t = await seedTurn(sql, "queued");
  const jobId = randomUUID();
  await sql.query(
    `insert into ai_jobs(id, item_id, material_hash, policy_version, status, runtime_provider, job_kind, payload, claim_token)
     values($1,$2,'materials','loom-assistant-v1','queued','opencode','assistant','{"provider":"opencode","question":"看看关键词"}',$3)`,
    [jobId, `assistant:${t.turnId}`, randomUUID()],
  );
  const claim = await claimAssistantJob(sql, { leaseSeconds: 60 });
  record("A30-claim", claim !== null && claim.turnId === t.turnId, claim ? `claimed turn ${claim.turnId === t.turnId ? "match" : "mismatch"}` : "null");
  if (claim) {
    const [runRow] = await sql.query(
      `insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,data_token_hash)
       values($1,$2,'research','opencode','i','m','loom-assistant-v1','{}','running',$3, clock_timestamp()+interval '5 minutes','dtok') returning id`,
      [randomUUID(), randomUUID(), claim.claimToken],
    );
    await sql.query("update ai_jobs set run_id=$2 where id=$1", [jobId, runRow.id]);
    const payload = {
      schema_version: 1, conversation_id: t.conversationId, turn_id: t.turnId,
      result: { version: 1, answer: "答案", citations: [], actions: [] },
      runtime: { model: "offline-model", prompt_version: "v1", skill_versions: { "project-assistant": "x" }, input_tokens: 10, output_tokens: 2, model_calls: 1, tool_calls: 0, events: [] },
    };
    await completeAssistantRun(sql, { runId: runRow.id, jobId, claimToken: claim.claimToken, stage: "result_saved", payload });
    const [turn] = await sql.query("select status from assistant_turns where id=$1", [t.turnId]);
    const msgs = await sql.query("select count(*)::int as n from assistant_messages where conversation_id=$1", [t.conversationId]);
    record("A30-hold", turn.status !== "completed" && msgs[0].n === 0,
      `turn=${turn.status} messages=${msgs[0].n}`);
    // Now the stop receipt lands and the run settles exactly once.
    const settle1 = await completeAssistantRun(sql, { runId: runRow.id, jobId, claimToken: claim.claimToken, stage: "runtime_stopped", payload: { epoch: randomUUID(), instance: "inst", ok: true } });
    const settle2 = await completeAssistantRun(sql, { runId: runRow.id, jobId, claimToken: claim.claimToken, stage: "runtime_stopped", payload: { epoch: randomUUID(), instance: "inst", ok: true } });
    const msgs2 = await sql.query("select count(*)::int as n from assistant_messages where conversation_id=$1", [t.conversationId]);
    record("A30-settle", msgs2[0].n === 1 && settle1.ok && settle2.ok, `messages=${msgs2[0].n} settle1=${JSON.stringify(settle1)} settle2=${JSON.stringify(settle2)}`);
  }
  await pg.close();
}

// A31: reconcile converges expired previews + finished children once.
{
  const { pg, sql } = await openDb();
  const { reconcileAssistant } = await import("../../../src/lib/server/assistant-reconcile.ts");
  const t = await seedTurn(sql, "awaiting_confirmation");
  await sql.query(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status, expires_at)
     values($1,$2,0,'keyword.create','{}','${"b".repeat(64)}','proposed', clock_timestamp() - interval '1 minute')`,
    [randomUUID(), t.turnId],
  );
  const first = await reconcileAssistant(sql);
  const second = await reconcileAssistant(sql);
  const events = await sql.query("select count(*)::int as n from assistant_events where conversation_id=$1 and type='action.updated'", [t.conversationId]);
  record("A31", first.expiredPreviews === 1 && second.expiredPreviews === 0 && events[0].n === 1,
    `first=${first.expiredPreviews} second=${second.expiredPreviews} events=${events[0].n}`);
  await pg.close();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.length }));
process.exit(failed.length === 0 ? 0 : 1);
