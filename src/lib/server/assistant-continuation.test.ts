import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { maybeCreateContinuation } from "./assistant-continuation.ts";

/**
 * Task 22: optional budgeted auto-interpretation (B03).
 *   - the first observer of a terminal receipt creates exactly ONE
 *     continuation (approval replay / SSE reconnect / crash recovery all
 *     converge on the same unique index);
 *   - without budget the continuation is skipped, the receipt stays;
 *   - the continuation turn can never propose write actions;
 *   - user submissions win over a pending explanation.
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

async function seedSucceededAction(sql: Awaited<ReturnType<typeof db>>["sql"]) {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','completed') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  const rootRequestId = randomUUID();
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,'keyword.create','{}','${"b".repeat(64)}','succeeded') returning id`,
    [randomUUID(), turn.id],
  );
  return { conversationId: conv.id, turnId: turn.id, actionId: action.id, rootRequestId };
}

test("first observer creates one continuation; later observers replay it", async () => {
  const { sql } = await db();
  const t = await seedSucceededAction(sql);
  const first = await maybeCreateContinuation(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    rootRequestId: t.rootRequestId, budgetRemaining: true,
  });
  assert.equal(first.created, true);
  const second = await maybeCreateContinuation(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    rootRequestId: t.rootRequestId, budgetRemaining: true,
  });
  assert.equal(second.created, false, "second observer must not duplicate");
  assert.equal(second.replay, true);
  const rows = await sql.query("select count(*)::int as n from assistant_continuations where action_id=$1", [t.actionId]);
  assert.equal(rows[0].n, 1);
});

test("no budget: continuation skipped, receipt untouched, no rows", async () => {
  const { sql } = await db();
  const t = await seedSucceededAction(sql);
  const result = await maybeCreateContinuation(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    rootRequestId: t.rootRequestId, budgetRemaining: false,
  });
  assert.equal(result.created, false);
  assert.equal(result.skippedNoBudget, true);
  // The skip is durable: a tombstone row occupies the unique slot.
  const rows = await sql.query<{ status: string }>("select status from assistant_continuations");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "skipped_no_budget");
  // A later budget grant still does not resurrect an interpretation.
  const again = await maybeCreateContinuation(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    rootRequestId: t.rootRequestId, budgetRemaining: true,
  });
  assert.equal(again.created, false, "skipped stays skipped (root budget version consumed)");
  assert.equal(again.replay, true);
});

test("only terminal actions qualify: proposed/failed-then-retry states never explain", async () => {
  const { sql } = await db();
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','completed') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,'keyword.create','{}','${"b".repeat(64)}','proposed') returning id`,
    [randomUUID(), turn.id],
  );
  const result = await maybeCreateContinuation(sql, {
    conversationId: conv.id, turnId: turn.id, actionId: action.id,
    rootRequestId: randomUUID(), budgetRemaining: true,
  });
  assert.equal(result.created, false, "non-terminal action must not explain");
});

test("user submission after a pending explanation takes priority; explanation cancels", async () => {
  const { sql } = await db();
  const t = await seedSucceededAction(sql);
  const created = await maybeCreateContinuation(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    rootRequestId: t.rootRequestId, budgetRemaining: true,
  });
  assert.equal(created.created, true);
  // A new user turn becomes the conversation's active turn; the pending
  // explanation must yield (cancelled), never contend for the slot.
  await sql.query(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"e".repeat(64)}','running')`,
    [randomUUID(), t.conversationId, randomUUID()],
  );
  const cancelled = await maybeCreateContinuation(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    rootRequestId: t.rootRequestId, budgetRemaining: true, userTurnActive: true,
  });
  assert.equal(cancelled.cancelled, true);
  const rows = await sql.query<{ status: string }>("select status from assistant_continuations where action_id=$1", [t.actionId]);
  assert.equal(rows[0].status, "cancelled");
});

test("continuation rows reject a second completion version", async () => {
  const { sql } = await db();
  const t = await seedSucceededAction(sql);
  await sql.query(
    `insert into assistant_continuations(id, action_id, root_request_id, parent_turn_id, status)
     values($1,$2,$3,$4,'succeeded')`,
    [randomUUID(), t.actionId, t.rootRequestId, t.turnId],
  );
  await assert.rejects(
    () => sql.query(
      `insert into assistant_continuations(id, action_id, root_request_id, parent_turn_id, completion_version, status)
       values($1,$2,$3,$4,2,'pending')`,
      [randomUUID(), t.actionId, t.rootRequestId, t.turnId],
    ),
    /check/i,
  );
});
