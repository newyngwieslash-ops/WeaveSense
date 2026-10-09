/**
 * Assistant event storage, snapshots and message submission (plan Task 14 /
 * §5.4). The snapshot's last_seq and its events are read in ONE transaction
 * so a watermark can never lag the events a client has already seen. Replays
 * use after-cursors; a cursor below the retained floor demands a resync
 * instead of silently skipping events. Nothing here seeds or calls models.
 */
import { agentTransaction } from "./agent-transaction.ts";
import { submitTurn, type TurnSubmission } from "./assistant-store.ts";
import type { AssistantMessageInput } from "../assistant-contract.ts";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

export type AssistantEventRow = {
  seq: number;
  type: string;
  turn_id: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ConversationSnapshot = {
  conversation: { id: string; title: string; revision: number; status: string };
  lastSeq: number;
  events: AssistantEventRow[];
  turns: Array<{ id: string; status: string; context: Record<string, unknown> }>;
  messages: Array<{ id: string; role: string; ordinal: number; content: Record<string, unknown> }>;
};

export async function appendAssistantEvent(
  sql: Queryable,
  conversationId: string,
  turnId: string,
  type: string,
  payload: unknown,
): Promise<number> {
  return await agentTransaction(sql as never, async (tx) => {
    const [row] = await tx.query<{ seq: number }>(
      `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
       values($1,$2,$3,
         coalesce((select max(e.seq)+1 from assistant_events e where e.conversation_id=$2), 0),
         $4, $5::jsonb)
       returning seq`,
      [randomId(), conversationId, turnId, type, JSON.stringify(payload ?? {})],
    );
    return Number(row.seq);
  });
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * One consistent snapshot: conversation row, turns, messages and the event
 * page up to now share a single repeatable read transaction.
 */
export async function getSnapshot(sql: Queryable, conversationId: string): Promise<ConversationSnapshot | null> {
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [conversation] = await tx.query<Record<string, unknown>>(
      "select id, title, revision, status from assistant_conversations where id = $1",
      [conversationId],
    );
    if (!conversation) return null;
    const events = await tx.query<Record<string, unknown>>(
      `select seq, type, turn_id, payload_json, created_at
       from assistant_events where conversation_id = $1 order by seq`,
      [conversationId],
    );
    const turns = await tx.query<Record<string, unknown>>(
      "select id, status, context_json from assistant_turns where conversation_id = $1 order by created_at",
      [conversationId],
    );
    const messages = await tx.query<Record<string, unknown>>(
      "select id, role, ordinal, content_json from assistant_messages where conversation_id = $1 order by ordinal",
      [conversationId],
    );
    const lastSeq = events.length > 0 ? Number(events[events.length - 1].seq) : -1;
    return {
      conversation: {
        id: String(conversation.id), title: String(conversation.title),
        revision: Number(conversation.revision), status: String(conversation.status),
      },
      lastSeq,
      events: events.map(mapEvent),
      turns: turns.map((row) => ({
        id: String(row.id), status: String(row.status),
        context: typeof row.context_json === "string" ? JSON.parse(row.context_json) : (row.context_json ?? {}) as Record<string, unknown>,
      })),
      messages: messages.map((row) => ({
        id: String(row.id), role: String(row.role), ordinal: Number(row.ordinal),
        content: typeof row.content_json === "string" ? JSON.parse(row.content_json) : (row.content_json ?? {}) as Record<string, unknown>,
      })),
    };
  });
}

function mapEvent(row: Record<string, unknown>): AssistantEventRow {
  return {
    seq: Number(row.seq),
    type: String(row.type),
    turn_id: String(row.turn_id),
    payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : (row.payload_json ?? {}) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

/**
 * Replay events strictly after `after`. If the client's cursor sits below
 * the earliest retained seq (event archival happened), demand a resync
 * rather than silently skipping the gap.
 */
export async function listEventsAfter(
  sql: Queryable,
  conversationId: string,
  after: number,
): Promise<{ events: AssistantEventRow[]; resyncRequired: boolean }> {
  if (!Number.isSafeInteger(after) || after < -1) {
    return { events: [], resyncRequired: true };
  }
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [floor] = await tx.query<{ min_seq: number | null }>(
      "select min(seq)::int as min_seq from assistant_events where conversation_id = $1",
      [conversationId],
    );
    const minSeq = floor?.min_seq == null ? null : Number(floor.min_seq);
    if (minSeq != null && after + 1 < minSeq) {
      return { events: [], resyncRequired: true };
    }
    const rows = await tx.query<Record<string, unknown>>(
      `select seq, type, turn_id, payload_json, created_at
       from assistant_events where conversation_id = $1 and seq > $2 order by seq`,
      [conversationId, after],
    );
    return { events: rows.map(mapEvent), resyncRequired: false };
  });
}

/** Submit a user message through the store's idempotent turn path. */
export async function submitAssistantMessage(
  sql: Queryable,
  conversationId: string,
  input: AssistantMessageInput,
): Promise<TurnSubmission> {
  return submitTurn(sql, conversationId, input);
}
