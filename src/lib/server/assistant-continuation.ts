/**
 * Optional budgeted auto-interpretation (plan Task 22 / §6.4, B03).
 *
 * When an action reaches a terminal state, ONE continuation may explain the
 * receipt. Concurrency-safe by the unique (action_id, completion_version)
 * index: whichever observer wins the insert creates the internal turn;
 * everyone else replays. The explanation consumes the ROOT request's
 * remaining budget — no second allocation — and the internal turn carries
 * no write authority. A new user submission always wins: a pending
 * explanation is cancelled rather than contending for the conversation's
 * one-active-turn slot.
 */
import { randomUUID } from "node:crypto";
import { agentTransaction } from "./agent-transaction.ts";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

const TERMINAL_ACTION_STATUSES = ["succeeded", "failed", "outcome_unknown"];

export type ContinuationResult = {
  created: boolean;
  replay?: boolean;
  skippedNoBudget?: boolean;
  cancelled?: boolean;
  continuation_id?: string;
};

/**
 * Create-or-replay the continuation for one terminal action. Safe to call
 * from any observer (worker settle, decision API, reconcile) any number of
 * times.
 */
export async function maybeCreateContinuation(
  sql: Queryable,
  input: {
    conversationId: string;
    turnId: string;
    actionId: string;
    rootRequestId: string;
    budgetRemaining: boolean;
    /** A newer user turn holds the conversation slot. */
    userTurnActive?: boolean;
  },
): Promise<ContinuationResult> {
  return agentTransaction(sql as never, async (tx) => {
    // Only terminal actions qualify.
    const [action] = await tx.query<Record<string, unknown>>(
      "select id, status from assistant_actions where id = $1 for update",
      [input.actionId],
    );
    if (!action || !TERMINAL_ACTION_STATUSES.includes(String(action.status))) {
      return { created: false };
    }
    // Idempotent replay: any existing row wins.
    const [existingRow] = await tx.query<Record<string, unknown>>(
      "select id, status from assistant_continuations where action_id = $1 and completion_version = 1 for update",
      [input.actionId],
    );
    if (existingRow) {
      const status = String(existingRow.status);
      // A user turn that became active after creation cancels a pending
      // explanation — the user's question takes priority.
      if (input.userTurnActive && status === "pending") {
        await tx.query(
          "update assistant_continuations set status='cancelled', finished_at=clock_timestamp() where id=$1",
          [String(existingRow.id)],
        );
        return { created: false, cancelled: true, continuation_id: String(existingRow.id) };
      }
      return { created: false, replay: true, continuation_id: String(existingRow.id) };
    }
    // Without root budget the interpretation is skipped — the receipt stands
    // on its own and no row is recorded (a later budget grant does not
    // resurrect it; the root request's budget version was consumed).
    if (!input.budgetRemaining) {
      // Persist the tombstone: the unique (action, version) index makes
      // "skipped" durable — a later budget grant does not resurrect the
      // interpretation because the root budget version was consumed.
      const [tombstone] = await tx.query<{ id: string }>(
        `insert into assistant_continuations(id, action_id, root_request_id, parent_turn_id, status)
         values($1,$2,$3,$4,'skipped_no_budget')
         on conflict (action_id, completion_version) do nothing
         returning id`,
        [randomUUID(), input.actionId, input.rootRequestId, input.turnId],
      );
      return { created: false, skippedNoBudget: true, continuation_id: tombstone?.id };
    }
    // Create the single continuation.
    const [created] = await tx.query<{ id: string }>(
      `insert into assistant_continuations(id, action_id, root_request_id, parent_turn_id, status)
       values($1,$2,$3,$4,'pending') returning id`,
      [randomUUID(), input.actionId, input.rootRequestId, input.turnId],
    );
    // If a user turn became active between observation and creation, cancel
    // immediately instead of racing for the active-turn slot.
    if (input.userTurnActive) {
      await tx.query(
        "update assistant_continuations set status='cancelled', finished_at=clock_timestamp() where id=$1",
        [created.id],
      );
      return { created: false, cancelled: true, continuation_id: created.id };
    }
    return { created: true, continuation_id: created.id };
  });
}

/**
 * Settle a continuation with its explanation text. Idempotent: only a
 * pending row may move to succeeded, and the terminal event is emitted
 * once via the conversation's seq index.
 */
export async function completeContinuation(
  sql: Queryable,
  input: { continuationId: string; conversationId: string; explanation: string },
): Promise<{ ok: boolean; replay: boolean }> {
  return agentTransaction(sql as never, async (tx) => {
    const [row] = await tx.query<Record<string, unknown>>(
      "select id, status, parent_turn_id from assistant_continuations where id = $1 for update",
      [input.continuationId],
    );
    if (!row) return { ok: false, replay: false };
    if (String(row.status) === "succeeded") return { ok: true, replay: true };
    if (String(row.status) !== "pending") return { ok: false, replay: true };
    await tx.query(
      "update assistant_continuations set status='succeeded', explanation=$2, finished_at=clock_timestamp() where id=$1",
      [input.continuationId, input.explanation.slice(0, 4000)],
    );
    const [seqRow] = await tx.query<{ n: number | null }>(
      "select coalesce(max(seq)+1, 0)::int as n from assistant_events where conversation_id = $1",
      [input.conversationId],
    );
    await tx.query(
      `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
       values($1,$2,$3,$4,'message.completed',$5::jsonb)`,
      [randomUUID(), input.conversationId, String(row.parent_turn_id), Number(seqRow?.n ?? 0),
        JSON.stringify({ message_id: input.continuationId, kind: "continuation" })],
    );
    return { ok: true, replay: false };
  });
}
