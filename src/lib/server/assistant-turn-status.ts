import { agentTransaction } from "./agent-transaction.ts";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

/**
 * Turn status read + cancel (plan §5.3 / A17). Read path is pure: turn row,
 * its actions and child research links, no side effects. Cancel path is the
 * Task 13 scoping rule applied over one transaction.
 */

export type TurnStatusView = {
  turn_id: string;
  conversation_id: string;
  status: string;
  job_id: string | null;
  run_id: string | null;
  actions: Array<{ id: string; kind: string; status: string; child_job_id: string | null }>;
  children: Array<{ job_id: string; status: string }>;
};

export async function assistantActionStatus(sql: Queryable, turnId: string): Promise<TurnStatusView | null> {
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [turn] = await tx.query<Record<string, unknown>>(
      "select id, conversation_id, status, job_id, run_id from assistant_turns where id = $1",
      [turnId],
    );
    if (!turn) return null;
    const actions = await tx.query<Record<string, unknown>>(
      "select id, kind, status, child_job_id from assistant_actions where turn_id = $1 order by ordinal",
      [turnId],
    );
    const children = await tx.query<Record<string, unknown>>(
      `select j.id, j.status from ai_jobs j
       join assistant_actions a on a.child_job_id = j.id
       where a.turn_id = $1`,
      [turnId],
    );
    return {
      turn_id: String(turn.id),
      conversation_id: String(turn.conversation_id),
      status: String(turn.status),
      job_id: turn.job_id == null ? null : String(turn.job_id),
      run_id: turn.run_id == null ? null : String(turn.run_id),
      actions: actions.map((a) => ({
        id: String(a.id), kind: String(a.kind), status: String(a.status),
        child_job_id: a.child_job_id == null ? null : String(a.child_job_id),
      })),
      children: children.map((c) => ({ job_id: String(c.id), status: String(c.status) })),
    };
  });
}

/** Idempotent cancel; delegates the scoping rules to cancelAssistantTurn. */
export async function cancelTurn(sql: Queryable, conversationId: string, turnId: string): Promise<{ ok: boolean; error_code?: string }> {
  const { cancelAssistantTurn } = await import("./assistant-research.ts");
  return agentTransaction(sql as never, async () => cancelAssistantTurn(sql, conversationId, turnId));
}
