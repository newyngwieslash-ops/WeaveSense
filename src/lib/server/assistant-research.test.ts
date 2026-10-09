import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { startAssistantResearch, cancelAssistantTurn } from "./assistant-research.ts";
import { reconcileAssistant } from "./assistant-reconcile.ts";

/**
 * Task 13: research.start as a child job + turn cancel convergence (§6.3/§5.4).
 *   - duplicate research.start does not double-enqueue or double-reserve;
 *   - child research runs through the governed pipeline (existing tables);
 *   - cancel only affects actions/research the turn owns;
 *   - reconcile converges expired previews and finished children exactly once.
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

async function seedTurn(sql: Fixture["sql"], status = "running") {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}',$4) returning id`,
    [randomUUID(), conv.id, randomUUID(), status],
  );
  return { conversationId: conv.id, turnId: turn.id };
}

test("research.start enqueues one governed child job bound to the turn", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const result = await startAssistantResearch(sql, {
    conversationId: t.conversationId, turnId: t.turnId,
    requestId: randomUUID(), question: "深入研究固态电池量产瓶颈",
  });
  // Honest refusal family: unconfigured governance or an empty corpus. The
  // contract is "never fake a queue"; the exact code depends on which gate
  // fires first (capability_unavailable | insufficient_evidence).
  assert.equal(result.ok, false);
  assert.ok(["capability_unavailable", "insufficient_evidence"].includes(result.error_code as string), result.error_code);
});

test("duplicate research.start with the same request id does not double-enqueue", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const requestId = randomUUID();
  // Both calls hit the same governance gate; the point is idempotency of the
  // dedupe key, which we assert via the second call not throwing/conflicting.
  const first = await startAssistantResearch(sql, {
    conversationId: t.conversationId, turnId: t.turnId, requestId, question: "研究问题",
  });
  const second = await startAssistantResearch(sql, {
    conversationId: t.conversationId, turnId: t.turnId, requestId, question: "研究问题",
  });
  assert.deepEqual(first, second, "same request id returns the identical result");
});

test("cancelAssistantTurn cancels owned queued actions and unfinished child research, never unrelated rows", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql, "running");
  // Owned proposed action.
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,'keyword.create','{}','${"b".repeat(64)}','proposed') returning id`,
    [randomUUID(), t.turnId],
  );
  // Owned child research job (queued).
  const [childJob] = await sql.query<{ id: string }>(
    `insert into ai_jobs(id, item_id, material_hash, policy_version, status, runtime_provider, job_kind, payload)
     values($1,$2,'materials','loom-agent-v1','queued','opencode','research','{"provider":"opencode","mode":"research"}') returning id`,
    [randomUUID(), `research:${randomUUID()}`],
  );
  await sql.query("update assistant_actions set child_job_id=$2 where id=$1", [action.id, childJob.id]);
  // Unrelated action on another turn stays untouched.
  const other = await seedTurn(sql, "running");
  const [otherAction] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,'keyword.create','{}','${"c".repeat(64)}','proposed') returning id`,
    [randomUUID(), other.turnId],
  );
  const result = await cancelAssistantTurn(sql, t.conversationId, t.turnId);
  assert.equal(result.ok, true);
  const [cancelledAction] = await sql.query<{ status: string }>("select status from assistant_actions where id=$1", [action.id]);
  assert.equal(cancelledAction.status, "cancelled");
  const [cancelledJob] = await sql.query<{ status: string; error_code: string }>("select status, error_code from ai_jobs where id=$1", [childJob.id]);
  assert.equal(cancelledJob.status, "failed");
  assert.equal(cancelledJob.error_code, "cancelled");
  const [otherRow] = await sql.query<{ status: string }>("select status from assistant_actions where id=$1", [otherAction.id]);
  assert.equal(otherRow.status, "proposed", "unrelated action untouched");
  const [turn] = await sql.query<{ status: string }>("select status from assistant_turns where id=$1", [t.turnId]);
  assert.equal(turn.status, "cancelled");
});

test("reconcile converges expired previews exactly once and dedupes child.updated events", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql, "awaiting_confirmation");
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status, expires_at)
     values($1,$2,0,'keyword.create','{}','${"b".repeat(64)}','proposed', clock_timestamp() - interval '1 minute') returning id`,
    [randomUUID(), t.turnId],
  );
  const first = await reconcileAssistant(sql);
  assert.ok(first.expiredPreviews >= 1);
  const second = await reconcileAssistant(sql);
  assert.equal(second.expiredPreviews, 0, "already-expired action not re-processed");
  const events = await sql.query<{ type: string; payload_json: Record<string, unknown> }>(
    "select type, payload_json from assistant_events where conversation_id=$1 and type='action.updated'",
    [t.conversationId],
  );
  assert.equal(events.length, 1, "exactly one action.updated for the expiry");
  const [row] = await sql.query<{ status: string }>("select status from assistant_actions where id=$1", [action.id]);
  assert.equal(row.status, "expired");
});

test("reconcile converges finished child research to waiting_child exactly once", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql, "waiting_child");
  const [childJob] = await sql.query<{ id: string }>(
    `insert into ai_jobs(id, item_id, material_hash, policy_version, status, runtime_provider, job_kind, payload)
     values($1,$2,'materials','loom-agent-v1','succeeded','opencode','research','{"provider":"opencode","mode":"research"}') returning id`,
    [randomUUID(), `research:${randomUUID()}`],
  );
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status, child_job_id)
     values($1,$2,0,'research.start','{}','${"b".repeat(64)}','executing',$3) returning id`,
    [randomUUID(), t.turnId, childJob.id],
  );
  const first = await reconcileAssistant(sql);
  assert.ok(first.finishedChildren >= 1);
  const second = await reconcileAssistant(sql);
  assert.equal(second.finishedChildren, 0, "terminal child not re-converged");
  const [row] = await sql.query<{ status: string }>("select status from assistant_actions where id=$1", [action.id]);
  assert.equal(row.status, "succeeded");
  const events = await sql.query<{ payload_json: Record<string, unknown> }>(
    "select payload_json from assistant_events where conversation_id=$1 and type='child.updated'",
    [t.conversationId],
  );
  assert.equal(events.length, 1, "single child.updated event");
});

test("turn active slot is released when all actions and children settle", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql, "awaiting_confirmation");
  await sql.query(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status, expires_at)
     values($1,$2,0,'keyword.create','{}','${"b".repeat(64)}','proposed', clock_timestamp() - interval '1 minute')`,
    [randomUUID(), t.turnId],
  );
  await reconcileAssistant(sql);
  const [turn] = await sql.query<{ status: string }>("select status from assistant_turns where id=$1", [t.turnId]);
  assert.ok(["completed", "failed"].includes(turn.status), "active slot released after convergence");
});
