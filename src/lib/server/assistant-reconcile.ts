/**
 * Bounded reconcile loop for assistant state (plan Task 13 / §5.4).
 *
 * Runs between model runs and on the idle poll; no model calls, no external
 * IO. Each batch handles at most a few dozen objects with per-row locks:
 *   - expired previews      → status='expired' + one action.updated event;
 *   - finished child jobs   → executing research.start actions settle to
 *                             succeeded/failed + one child.updated event;
 *   - settled turns         → waiting_child/awaiting_confirmation turns whose
 *                             actions all reached a terminal state release the
 *                             conversation's active slot (turn → completed).
 * Event dedupe rides the unique (conversation_id, seq) index plus per-row
 * status checks, so re-running the reconcile never emits duplicate events.
 */
import { randomUUID } from "node:crypto";
import { agentTransaction } from "./agent-transaction.ts";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

export type ReconcileSummary = {
  expiredPreviews: number;
  finishedChildren: number;
  releasedTurns: number;
};

const BATCH = 50;

async function nextSeq(tx: Tx, conversationId: string): Promise<number> {
  const [row] = await tx.query<{ n: number | null }>(
    "select coalesce(max(seq)+1, 0)::int as n from assistant_events where conversation_id = $1",
    [conversationId],
  );
  return Number(row?.n ?? 0);
}

async function appendEvent(tx: Tx, conversationId: string, turnId: string, type: string, payload: unknown) {
  const seq = await nextSeq(tx, conversationId);
  await tx.query(
    `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
     values($1,$2,$3,$4,$5,$6::jsonb)`,
    [randomUUID(), conversationId, turnId, seq, type, JSON.stringify(payload)],
  );
}

export async function reconcileAssistant(sql: Queryable): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { expiredPreviews: 0, finishedChildren: 0, releasedTurns: 0 };
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    // 1. Expired previews.
    const expired = await tx.query<{ id: string; turn_id: string; conversation_id: string }>(
      `select a.id, a.turn_id, t.conversation_id
       from assistant_actions a join assistant_turns t on t.id = a.turn_id
       where a.status = 'proposed' and a.expires_at is not null and a.expires_at <= clock_timestamp()
       order by a.id for update skip locked limit $1`,
      [BATCH],
    );
    for (const row of expired) {
      await tx.query("update assistant_actions set status='expired' where id=$1", [row.id]);
      await appendEvent(tx, row.conversation_id, row.turn_id, "action.updated", { action_id: row.id, status: "expired" });
      summary.expiredPreviews++;
    }
    // 2. Finished child research jobs.
    const children = await tx.query<{ action_id: string; turn_id: string; conversation_id: string; job_status: string; job_error: string }>(
      `select a.id as action_id, a.turn_id, t.conversation_id, j.status as job_status, j.error_code as job_error
       from assistant_actions a
       join assistant_turns t on t.id = a.turn_id
       join ai_jobs j on j.id = a.child_job_id
       where a.status = 'executing' and a.kind = 'research.start'
         and j.status in ('succeeded','failed','outcome_unknown')
       order by a.id for update of a skip locked limit $1`,
      [BATCH],
    );
    for (const row of children) {
      const status = row.job_status === "succeeded" ? "succeeded" : row.job_status === "failed" ? "failed" : "outcome_unknown";
      await tx.query(
        "update assistant_actions set status=$2, result_json=$3::jsonb where id=$1 and status='executing'",
        [row.action_id, status, JSON.stringify({ action_id: row.action_id, status, child_job_status: row.job_status, error_code: row.job_error || undefined })],
      );
      await appendEvent(tx, row.conversation_id, row.turn_id, "child.updated", { job_id: row.action_id, status: row.job_status });
      summary.finishedChildren++;
    }
    // 3. Release settled turns.
    const settled = await tx.query<{ id: string; conversation_id: string }>(
      `select t.id, t.conversation_id from assistant_turns t
       where t.status in ('awaiting_confirmation','waiting_child')
         and not exists (
           select 1 from assistant_actions a
           where a.turn_id = t.id and a.status in ('proposed','approved','executing')
         )
       order by t.id for update skip locked limit $1`,
      [BATCH],
    );
    for (const row of settled) {
      const [anyFailed] = await tx.query<{ n: number }>(
        "select count(*)::int as n from assistant_actions where turn_id=$1 and status in ('failed','outcome_unknown')",
        [row.id],
      );
      const status = anyFailed.n > 0 ? "failed" : "completed";
      await tx.query(
        "update assistant_turns set status=$2, finished_at=clock_timestamp() where id=$1 and status in ('awaiting_confirmation','waiting_child')",
        [row.id, status],
      );
      await appendEvent(tx, row.conversation_id, row.id, "turn.finished", { status });
      summary.releasedTurns++;
    }
    return summary;
  });
}

/** Convenience wrapper for agentTransaction-shaped callers. */
export function reconcileAssistantTx(sql: Parameters<typeof agentTransaction>[0]) {
  return reconcileAssistant(sql as Queryable);
}
