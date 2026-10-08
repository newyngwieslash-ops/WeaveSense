/**
 * Assistant context assembly (plan Task 4 / §4.1).
 *
 * The host assembles a bounded prompt-side context: the frozen request
 * context, at most the 12 most recent completed messages (code-point
 * truncated, truncation marked), and the user question. There are no hidden
 * summarization model calls and no DOM upload. The 64KiB cap is on the
 * serialized context JSON; the ModelProxy 512KiB envelope stays separate.
 */

export const ASSISTANT_CONTEXT_MAX_BYTES = 64 * 1024;
export const ASSISTANT_HISTORY_MESSAGES = 12;
export const ASSISTANT_HISTORY_TEXT_POINTS = 2000;

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export type HistoryMessage = { role: string; text: string; omitted?: boolean };

export type AssistantContext = {
  page: string;
  filters: Record<string, unknown>;
  references: Array<{ kind: string; id: string }>;
  history: HistoryMessage[];
  context_json: string;
};

function truncateCodePoints(value: string, max: number): { text: string; omitted: boolean } {
  const points = Array.from(value);
  if (points.length <= max) return { text: value, omitted: false };
  return { text: points.slice(0, max).join("") + "…", omitted: true };
}

/**
 * Build the next request context. History rows come from
 * assistant_messages (role user/assistant/action_result); each message keeps
 * only its text, cut on code points with an explicit omitted marker.
 */
export function buildAssistantContext(
  input: { text: string; context: { page: string; filters: Record<string, unknown>; references: Array<{ kind: string; id: string }> } },
  history: Array<{ role: string; content_json: unknown }> = [],
): AssistantContext {
  // The frozen context itself must fit the byte budget; oversize means the
  // caller bypassed the contract — refuse instead of truncating silently.
  const frozen = JSON.stringify({ page: input.context.page, filters: input.context.filters, references: input.context.references });
  if (Buffer.byteLength(frozen, "utf8") > ASSISTANT_CONTEXT_MAX_BYTES) {
    throw new Error("context_too_large");
  }
  const recent = history.slice(-ASSISTANT_HISTORY_MESSAGES).map((m) => {
    const raw = typeof m.content_json === "string" ? JSON.parse(m.content_json) : (m.content_json ?? {}) as Record<string, unknown>;
    const text = typeof raw.text === "string" ? raw.text : "";
    const cut = truncateCodePoints(text, ASSISTANT_HISTORY_TEXT_POINTS);
    return { role: m.role, text: cut.text, ...(cut.omitted ? { omitted: true } : {}) };
  });
  return {
    page: input.context.page,
    filters: input.context.filters,
    references: input.context.references,
    history: recent,
    context_json: frozen,
  };
}

/** Pure read of recent messages for the next model turn; no side effects. */
export async function recentHistory(sql: Queryable, conversationId: string, limit = ASSISTANT_HISTORY_MESSAGES) {
  const rows = await sql.query<Record<string, unknown>>(
    `select role, content_json from assistant_messages
     where conversation_id = $1 order by ordinal desc limit $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}
