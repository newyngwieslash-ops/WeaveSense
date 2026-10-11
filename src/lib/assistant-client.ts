/**
 * Typed fetch client for the assistant public API (plan Task 15). Pure
 * browser-side: same-origin calls, no-store implicit, no credentials beyond
 * cookies the browser already holds. Errors surface stable codes.
 */

export type Capabilities = { enabled: boolean; reason?: string; actions_enabled: boolean; profile: string };

export type ConversationMeta = { id: string; title: string; revision: number; status: string; turn_count?: number; updated_at?: string };

export type Snapshot = {
  conversation: { id: string; title: string; revision: number; status: string };
  lastSeq: number;
  events: Array<{ seq: number; type: string; turn_id: string; payload: Record<string, unknown>; created_at: string }>;
  turns: Array<{ id: string; status: string }>;
  messages: Array<{ id: string; role: string; ordinal: number; content: Record<string, unknown> }>;
};

export type EventPage = { resync_required: boolean; events: Array<{ seq: number; type: string; turn_id: string; conversation_id?: string; payload: Record<string, unknown>; created_at: string }> };

async function jsonOrError<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) code = body.error;
    } catch { /* keep status code */ }
    throw new Error(code);
  }
  return await res.json() as T;
}

export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await fetch("/api/assistant/capabilities", { headers: { accept: "application/json" } });
  return jsonOrError<Capabilities>(res);
}

export async function createConversation(): Promise<{ id: string; revision: number; status: string }> {
  const res = await fetch("/api/assistant/conversations", { method: "POST" });
  return jsonOrError<{ id: string; revision: number; status: string }>(res);
}

export async function fetchSnapshot(conversationId: string): Promise<Snapshot> {
  const res = await fetch(`/api/assistant/conversations/${conversationId}`, { headers: { accept: "application/json" } });
  return jsonOrError<Snapshot>(res);
}

export async function fetchEvents(conversationId: string, after: number): Promise<EventPage> {
  const res = await fetch(`/api/assistant/conversations/${conversationId}/events?after=${encodeURIComponent(after)}`, { headers: { accept: "application/json" } });
  return jsonOrError<EventPage>(res);
}

export type SubmitInput = {
  conversationId: string;
  requestId: string;
  expectedRevision: number;
  text: string;
  context: { page: string; filters: Record<string, unknown>; references: Array<{ kind: string; id: string }> };
  intent?: Record<string, unknown>;
};

export async function submitMessage(input: SubmitInput): Promise<{ turn_id: string; status: string; revision: number; replay: boolean }> {
  const res = await fetch(`/api/assistant/conversations/${input.conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: input.requestId,
      expected_revision: input.expectedRevision,
      text: input.text,
      context: input.context,
      ...(input.intent ? { intent: input.intent } : {}),
    }),
  });
  return jsonOrError<{ turn_id: string; status: string; revision: number; replay: boolean }>(res);
}

export async function cancelTurn(turnId: string, conversationId: string): Promise<void> {
  const res = await fetch(`/api/assistant/turns/${turnId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId }),
  });
  if (!res.ok) throw new Error("cancel_failed");
}

export async function decideAction(actionId: string, requestId: string, decision: "approve" | "reject", previewDigest: string, expectedRevision: number): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/assistant/actions/${actionId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, decision, preview_digest: previewDigest, expected_revision: expectedRevision }),
  });
  return jsonOrError<Record<string, unknown>>(res);
}
