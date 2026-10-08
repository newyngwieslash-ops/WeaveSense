/**
 * Assistant conversation store (plan Task 4 / §4.1).
 *
 * The database is the single source of truth for product conversations, turns
 * and messages. Every write runs in a short transaction; turn submission is
 * idempotent by request_id and serialized by the partial unique index
 * `assistant_one_active_turn`. No model calls and no seeding happen here.
 */
import { randomUUID } from "node:crypto";
import { hashCanonical } from "./agent-runs.ts";
import type { AssistantMessageInput } from "../assistant-contract.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export type ConversationRow = {
  id: string;
  title: string;
  revision: number;
  status: "open" | "archived";
  created_at: string;
  updated_at: string;
};

export type TurnRow = {
  id: string;
  conversation_id: string;
  request_id: string;
  status: string;
  job_id: string | null;
  run_id: string | null;
  context: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
};

export type TurnSubmission =
  | { kind: "won"; turn: TurnRow; revision: number }
  | { kind: "replay"; turn: TurnRow; revision: number }
  | { kind: "conflict"; reason: "revision_conflict" | "active_turn" | "request_conflict" };

function mapTurn(row: Record<string, unknown>): TurnRow {
  const raw = row.context_json;
  const context = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    request_id: String(row.request_id),
    status: String(row.status),
    job_id: row.job_id == null ? null : String(row.job_id),
    run_id: row.run_id == null ? null : String(row.run_id),
    context,
    created_at: String(row.created_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
  };
}

export async function createConversation(sql: Queryable, _opts: { title?: string } = {}): Promise<ConversationRow> {
  // Title is derived later from the first user message (§4.1: no model calls).
  const [row] = await sql.query<Record<string, unknown>>(
    "insert into assistant_conversations(id, title) values($1, '') returning *",
    [randomUUID()],
  );
  return {
    id: String(row.id),
    title: String(row.title),
    revision: Number(row.revision),
    status: row.status === "archived" ? "archived" : "open",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function getConversation(sql: Queryable, id: string): Promise<ConversationRow | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    "select * from assistant_conversations where id = $1", [id],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    revision: Number(row.revision),
    status: row.status === "archived" ? "archived" : "open",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Idempotent turn submission (§6.1 / A04/A05):
 *  - same request_id + same request hash -> replay the stored turn;
 *  - same request_id + different content -> hard conflict;
 *  - stale expected_revision or an existing active turn -> conflict 409;
 *  - otherwise insert the turn (the partial unique index arbitrates races).
 */
export async function submitTurn(sql: Queryable, conversationId: string, input: AssistantMessageInput): Promise<TurnSubmission> {
  const requestHash = hashCanonical({ text: input.text, context: input.context, intent: input.intent ?? null });
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [conv] = await tx.query<Record<string, unknown>>(
      "select id, revision, status from assistant_conversations where id = $1 for update",
      [conversationId],
    );
    if (!conv) throw new Error("conversation_not_found");
    const revision = Number(conv.revision);

    const [existing] = await tx.query<Record<string, unknown>>(
      "select * from assistant_turns where request_id = $1", [input.request_id],
    );
    if (existing) {
      const turn = mapTurn(existing);
      if (String(existing.request_hash) !== requestHash || turn.conversation_id !== conversationId) {
        return { kind: "conflict", reason: "request_conflict" } as TurnSubmission;
      }
      return { kind: "replay", turn, revision } as TurnSubmission;
    }

    if (input.expected_revision !== revision) {
      return { kind: "conflict", reason: "revision_conflict" } as TurnSubmission;
    }

    const active = await tx.query<Record<string, unknown>>(
      `select id from assistant_turns
       where conversation_id = $1
         and status in ('queued','running','awaiting_confirmation','executing','waiting_child')`,
      [conversationId],
    );
    if (active.length > 0) return { kind: "conflict", reason: "active_turn" } as TurnSubmission;

    const [row] = await tx.query<Record<string, unknown>>(
      `insert into assistant_turns(id, conversation_id, request_id, request_hash, status, context_json, policy_json, authorization_json)
       values($1,$2,$3,$4,'queued',$5::jsonb,'{}'::jsonb,$6::jsonb)
       returning *`,
      [
        randomUUID(), conversationId, input.request_id, requestHash,
        JSON.stringify(input.context), input.intent ? JSON.stringify(input.intent) : null,
      ],
    );
    // User message + revision bump + event in the same transaction (§5.4).
    await tx.query(
      `insert into assistant_messages(id, conversation_id, turn_id, ordinal, role, content_json)
       values($1,$2,$3,
         coalesce((select max(ordinal)+1 from assistant_messages where conversation_id=$2), 0),
         'user', $4::jsonb)`,
      [randomUUID(), conversationId, row.id, JSON.stringify({ text: input.text })],
    );
    const [bumped] = await tx.query<Record<string, unknown>>(
      `update assistant_conversations set revision = revision + 1, updated_at = clock_timestamp() where id = $1 returning revision`,
      [conversationId],
    );
    // Seq rides the conversation-scoped counter: allocate from the turn whose
    // active marker serializes submissions — the newest turn in this conversation.
    const [seqRow] = await tx.query<{ seq: string | number }>(
      `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
       values($1,$2,$3,
         coalesce((select max(e.seq)+1 from assistant_events e where e.conversation_id=$2), 0),
         'turn.queued', $4::jsonb)
       returning seq`,
      [randomUUID(), conversationId, row.id, JSON.stringify({ status: "queued" })],
    );
    const seq = Number(seqRow.seq);
    await tx.query("update assistant_conversations set title = $2 where id = $1 and title = ''",
      [conversationId, input.text.slice(0, 40)]);
    return { kind: "won", turn: mapTurn(row), revision: Number(bumped.revision) } as TurnSubmission;
  });
}

type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

export async function listMessages(sql: Queryable, conversationId: string): Promise<Array<{ id: string; role: string; ordinal: number; content: Record<string, unknown> }>> {
  const rows = await sql.query<Record<string, unknown>>(
    `select id, role, ordinal, content_json from assistant_messages
     where conversation_id = $1 order by ordinal`, [conversationId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    role: String(row.role),
    ordinal: Number(row.ordinal),
    content: typeof row.content_json === "string" ? JSON.parse(row.content_json) : (row.content_json ?? {}) as Record<string, unknown>,
  }));
}

export async function getConversationSnapshot(sql: Queryable, conversationId: string) {
  const conv = await getConversation(sql, conversationId);
  if (!conv) return null;
  const turnRows = await sql.query<Record<string, unknown>>(
    "select * from assistant_turns where conversation_id = $1 order by created_at", [conversationId],
  );
  return {
    conversation: conv,
    turns: turnRows.map(mapTurn),
    messages: await listMessages(sql, conversationId),
  };
}
