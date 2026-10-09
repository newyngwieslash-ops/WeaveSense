import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  prepareAssistantCollection,
  observeAssistantCollection,
  dispatchAssistantActions,
  mapCollectionReceipt,
} from "./assistant-action-dispatch.ts";

/**
 * Task 12: collect_once background execution with exactly-one external send.
 *   - prepare persists a stable jobs id + action link in one transaction;
 *   - dispatch_started_at lands BEFORE any IO (A13);
 *   - a completed action retried by id never re-collects;
 *   - a crash after the external send converges to observe-only, no resend;
 *   - scheduler outcomes map to structured receipts (errors are honest,
 *     "已停用" is skipped, not success).
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

type Fixture = Awaited<ReturnType<typeof db>>;

async function seedCollectionAction(sql: Fixture["sql"], kind: "keyword.collect_once" | "source.collect_once", enabled = true) {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','awaiting_confirmation') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  const targetId = kind === "keyword.collect_once" ? "kw-1" : "src-1";
  const args = kind === "keyword.collect_once" ? { keyword_id: targetId } : { source_id: targetId };
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,$3,$4::jsonb,'${"b".repeat(64)}','approved') returning id`,
    [randomUUID(), turn.id, kind, JSON.stringify(args)],
  );
  if (kind === "keyword.collect_once") {
    await sql.query(
      "insert into keywords(id,phrase,platforms,interval_minutes,enabled,status) values($1,'固态电池','[\"rss\"]'::jsonb,30,$2,'idle')",
      [targetId, enabled],
    );
  } else {
    await sql.query(
      "insert into sources(id,platform,name,url,feed_url,interval_minutes,enabled,status,adapter) values($1,'rss','信源','https://example.com/f.xml','https://example.com/f.xml',30,$2,'idle','rss')",
      [targetId, enabled],
    );
  }
  return { conversationId: conv.id, turnId: turn.id, actionId: action.id, targetId };
}

test("prepare persists a stable jobs id and action link before IO", async () => {
  const { sql } = await db();
  const t = await seedCollectionAction(sql, "keyword.collect_once");
  const prepared = await prepareAssistantCollection(sql, {
    actionId: t.actionId, turnId: t.turnId, conversationId: t.conversationId,
    kind: "keyword.collect_once", targetId: t.targetId,
  });
  assert.ok(prepared.jobId, "stable jobs id assigned at prepare");
  const [job] = await sql.query<{ id: string; kind: string }>("select id, kind from jobs where id=$1", [prepared.jobId]);
  assert.ok(job, "job row exists before execution");
  const [action] = await sql.query<{ child_job_id: string }>("select child_job_id from assistant_actions where id=$1", [t.actionId]);
  assert.equal(action.child_job_id, prepared.jobId, "action -> job link persisted");
});

test("completed action retried by id never re-collects (observe-only replay)", async () => {
  const { sql } = await db();
  const t = await seedCollectionAction(sql, "keyword.collect_once");
  const prepared = await prepareAssistantCollection(sql, {
    actionId: t.actionId, turnId: t.turnId, conversationId: t.conversationId,
    kind: "keyword.collect_once", targetId: t.targetId,
  });
  // Mark succeeded with a receipt, as if the first execution completed.
  await sql.query(
    `update assistant_actions set status='succeeded', result_json=$2::jsonb, dispatch_started_at=clock_timestamp() where id=$1`,
    [t.actionId, JSON.stringify({ status: "succeeded", items_new: 2 })],
  );
  const replay = await prepareAssistantCollection(sql, {
    actionId: t.actionId, turnId: t.turnId, conversationId: t.conversationId,
    kind: "keyword.collect_once", targetId: t.targetId,
  });
  assert.equal(replay.kind, "replay");
  assert.equal(replay.jobId, prepared.jobId, "same stable jobs id");
  const jobs = await sql.query("select id from jobs");
  assert.equal(jobs.length, 1, "no second job was created");
});

test("dispatch_started_at is persisted before the external call runs", async () => {
  const { sql } = await db();
  const t = await seedCollectionAction(sql, "keyword.collect_once");
  const prepared = await prepareAssistantCollection(sql, {
    actionId: t.actionId, turnId: t.turnId, conversationId: t.conversationId,
    kind: "keyword.collect_once", targetId: t.targetId,
  });
  let sawDispatchAt = false;
  const run = dispatchAssistantActions(sql, {
    conversationId: t.conversationId,
    turnId: t.turnId,
    execute: async (step) => {
      const [row] = await sql.query<{ dispatch_started_at: string | null }>(
        "select dispatch_started_at from assistant_actions where id=$1", [step.actionId],
      );
      sawDispatchAt = row.dispatch_started_at != null;
      return { status: "succeeded" as const, outcome: { items_found: 3, items_new: 1, error: "" } };
    },
    jobFactory: prepared,
  });
  await run;
  assert.ok(sawDispatchAt, "dispatch_started_at visible inside execute (IO ran after persist)");
});

test("crash after send converges by observation, never an automatic resend", async () => {
  const { sql } = await db();
  const t = await seedCollectionAction(sql, "keyword.collect_once");
  const prepared = await prepareAssistantCollection(sql, {
    actionId: t.actionId, turnId: t.turnId, conversationId: t.conversationId,
    kind: "keyword.collect_once", targetId: t.targetId,
  });
  // Simulate a crash after dispatch: dispatch_started_at set, job stuck running, no receipt.
  await sql.query("update assistant_actions set status='executing', dispatch_started_at=clock_timestamp(), child_job_id=$2 where id=$1", [t.actionId, prepared.jobId]);
  await sql.query("update jobs set status='succeeded', items_new=2, items_found=3 where id=$1", [prepared.jobId]);
  const receipt = await observeAssistantCollection(sql, {
    actionId: t.actionId, conversationId: t.conversationId, turnId: t.turnId, jobId: prepared.jobId,
  });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.counts?.inserted, 2, "counts read from the persisted job, not re-run");
  const jobs = await sql.query("select count(*)::int as n from jobs");
  assert.equal(jobs[0].n, 1, "observation created no new job");
});

test("disabled target maps to skipped, not success; missing target to not_found", async () => {
  const { sql } = await db();
  const disabled = await seedCollectionAction(sql, "source.collect_once", false);
  const p1 = await prepareAssistantCollection(sql, {
    actionId: disabled.actionId, turnId: disabled.turnId, conversationId: disabled.conversationId,
    kind: "source.collect_once", targetId: disabled.targetId,
  });
  const r1 = await observeAssistantCollection(sql, {
    actionId: disabled.actionId, conversationId: disabled.conversationId, turnId: disabled.turnId, jobId: p1.jobId,
  });
  assert.equal(r1.status, "skipped");
  const [missingAction] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,1,'keyword.collect_once','{"keyword_id":"kw-gone"}'::jsonb,'${"c".repeat(64)}','approved') returning id`,
    [randomUUID(), disabled.turnId],
  );
  const p2 = await prepareAssistantCollection(sql, {
    actionId: missingAction.id, turnId: disabled.turnId, conversationId: disabled.conversationId,
    kind: "keyword.collect_once", targetId: "kw-gone",
  });
  const r2 = await observeAssistantCollection(sql, {
    actionId: missingAction.id, conversationId: disabled.conversationId, turnId: disabled.turnId, jobId: p2.jobId,
  });
  assert.equal(r2.status, "not_found");
});

test("scheduler outcomes map to structured receipts honestly", () => {
  const ok = mapCollectionReceipt({ items_found: 5, items_new: 2, error: "" });
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.counts?.inserted, 2);
  const zeroNew = mapCollectionReceipt({ items_found: 4, items_new: 0, error: "" });
  assert.equal(zeroNew.status, "succeeded");
  assert.equal(zeroNew.warnings?.some((w) => w.code === "zero_new"), true, "0 new is stated, not hidden");
  const allFailed = mapCollectionReceipt({ items_found: 0, items_new: 0, error: "外部检索全部失败（rss：network_error）" });
  assert.equal(allFailed.status, "failed");
  assert.ok(allFailed.error_code);
  const running = mapCollectionReceipt({ items_found: 0, items_new: 0, error: "正在运行" });
  assert.equal(running.status, "conflict");
  const skipped = mapCollectionReceipt({ items_found: 0, items_new: 0, error: "已停用" });
  assert.equal(skipped.status, "skipped");
});
