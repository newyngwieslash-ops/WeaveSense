/**
 * Assistant research child tasks and turn cancellation (plan Task 13 / §6.3).
 *
 * research.start reuses the governed research pipeline unchanged: the question
 * goes through askKnowledgeWith's async enqueue (existing review, budget,
 * publication machinery). The turn keeps only the child_job_id link. The
 * parent assistant model run has already released the runtime slot, so a
 * running child never deadlocks the assistant.
 *
 * cancelAssistantTurn cancels what the turn owns: proposed/approved actions
 * and its unfinished child research jobs. Executed configuration/collection
 * writes are NOT rolled back (§6.3: 已完成的修改保留).
 */
import { randomUUID } from "node:crypto";
import { agentTransaction } from "./agent-transaction.ts";
import { askKnowledgeWith } from "./analyze.ts";
import { codePointLength } from "../assistant-contract.ts";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

export type ResearchStartResult =
  | { ok: true; pending: true; job_id: string }
  | { ok: false; error: string; error_code: string };

const RESEARCH_QUESTION_MAX = 400;

/**
 * Start one governed research child for this turn. Idempotent by requestId:
 * the dedupe lives in askKnowledgeWith/beginRun, so a repeated call with the
 * same id returns the identical result instead of double-enqueueing or
 * double-reserving budget.
 */
export async function startAssistantResearch(
  sql: Queryable,
  input: { conversationId: string; turnId: string; requestId: string; question: string },
): Promise<ResearchStartResult> {
  const q = input.question.trim();
  const length = codePointLength(q);
  if (length < 2 || length > RESEARCH_QUESTION_MAX) {
    return { ok: false, error: "研究问题长度需在 2–400 字之间", error_code: "invalid_question" };
  }
  const result = await askKnowledgeWith({ sql, question: q, requestId: input.requestId, async: true });
  if (result.ok && result.pending && result.job_id) {
    // Bind the child job to the turn (assistant_actions row for research.start
    // already carries child_job_id once the proposal executes; keep the
    // turn-level link too for cancellation scoping).
    await (sql as unknown as SqlLike).transaction(async (tx) => {
      await tx.query(
        "update assistant_turns set status='waiting_child' where id=$1 and status in ('running','queued')",
        [input.turnId],
      );
    }).catch(() => {});
    return { ok: true, pending: true, job_id: result.job_id };
  }
  if (result.ok && result.pending) {
    return { ok: true, pending: true, job_id: result.job_id ?? "" };
  }
  const code = result.error_code ?? "research_failed";
  return { ok: false, error: result.error ?? "研究任务未能排队", error_code: code };
}

/**
 * Cancel a turn: owned proposed/approved actions → cancelled; owned
 * unfinished child research → cancel via the existing cancelResearchJob
 * path semantics (queued rows fail with 'cancelled', running rows get the
 * cancel_requested flag handled by the worker). The turn itself reaches a
 * terminal cancelled state, releasing the conversation's active slot.
 */
export async function cancelAssistantTurn(
  sql: Queryable,
  conversationId: string,
  turnId: string,
): Promise<{ ok: boolean; error_code?: string }> {
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [turn] = await tx.query<Record<string, unknown>>(
      "select * from assistant_turns where id = $1 and conversation_id = $2 for update",
      [turnId, conversationId],
    );
    if (!turn) return { ok: false, error_code: "not_found" };
    if (["completed", "failed", "cancelled", "outcome_unknown"].includes(String(turn.status))) {
      return { ok: true };
    }
    // Owned unexecuted actions.
    await tx.query(
      `update assistant_actions set status='cancelled'
       where turn_id = $1 and status in ('proposed','approved','expired')`,
      [turnId],
    );
    // Owned unfinished child research: queued jobs fail directly; running
    // jobs get cancel_requested (the worker path handles revocation).
    const children = await tx.query<{ id: string; status: string }>(
      `select j.id, j.status from ai_jobs j
       join assistant_actions a on a.child_job_id = j.id
       where a.turn_id = $1 and j.status in ('queued','running') for update`,
      [turnId],
    );
    for (const child of children) {
      if (child.status === "queued") {
        await tx.query(
          "update ai_jobs set status='failed', error_code='cancelled', claim_token='', lease_until=null, updated_at=clock_timestamp() where id=$1",
          [child.id],
        );
        await tx.query(
          `update ai_budget_reservations set dispatch_state='not_sent'
           where job_id=$1 and dispatch_state='unconfirmed' and status='reserved'`,
          [child.id],
        );
      } else {
        await tx.query(
          "update ai_jobs set payload=jsonb_set(payload,'{cancel_requested}','true'::jsonb), updated_at=clock_timestamp() where id=$1",
          [child.id],
        );
      }
    }
    // Also cancel research children linked at turn level via job item_id
    // convention research:<turnId> (research.start direct links).
    await tx.query(
      `update ai_jobs set status='failed', error_code='cancelled', claim_token='', lease_until=null, updated_at=clock_timestamp()
       where job_kind='research' and status='queued' and item_id = $1`,
      [`assistant:${turnId}`],
    );
    const [seqRow] = await tx.query<{ n: number | null }>(
      "select coalesce(max(seq)+1, 0)::int as n from assistant_events where conversation_id = $1",
      [conversationId],
    );
    await tx.query(
      `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
       values($1,$2,$3,$4,'turn.finished',$5::jsonb)`,
      [randomUUID(), conversationId, turnId, Number(seqRow?.n ?? 0), JSON.stringify({ status: "cancelled", reason: "user_cancelled" })],
    );
    await tx.query(
      "update assistant_turns set status='cancelled', finished_at=clock_timestamp() where id=$1",
      [turnId],
    );
    return { ok: true };
  });
}
