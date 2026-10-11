/**
 * Client-side assistant state (plan Task 15 / §2.2).
 *
 * A pure reducer over server events and local intents: duplicate/foreign
 * events dedupe by seq, out-of-order events buffer until the gap fills,
 * stale snapshots from a switched conversation are dropped, and closing the
 * panel never cancels the running turn. No window access at module scope —
 * the provider reads local preferences in effects only (SSR-safe).
 */

export type AssistantConversationMeta = { id: string; title: string; revision: number; status: string };

export type AssistantEvent = {
  seq: number;
  type: string;
  turn_id: string;
  payload: Record<string, unknown>;
  conversation_id?: string;
  created_at: string;
};

export type StageMarker = { call_id: string; tool: string; state: "running" | "done" | "failed" };

export type ProposalRef = { action_id: string; kind: string; status: string; preview_text?: string; preview_digest?: string; expires_at?: string | null };

export type AssistantMessageView = { id: string; role: string; ordinal: number; content: Record<string, unknown> };

export type AssistantState = {
  panelOpen: boolean;
  conversationId: string | null;
  conversation: AssistantConversationMeta | null;
  messages: AssistantMessageView[];
  lastSeq: number;
  pendingEvents: AssistantEvent[];
  resyncing: boolean;
  turnActive: boolean;
  stages: StageMarker[];
  reasonTail?: string;
  proposals: ProposalRef[];
  sending: boolean;
  composerError: string | null;
  loading: boolean;
};

export type AssistantReducerAction =
  | { type: "panel/opened" }
  | { type: "panel/closed" }
  | { type: "conversation/loaded"; conversation: AssistantConversationMeta; lastSeq: number; events: AssistantEvent[]; messages: AssistantMessageView[]; turns: Array<{ id: string; status: string }> }
  | { type: "conversation/switched"; conversation: AssistantConversationMeta; lastSeq: number; events: AssistantEvent[]; messages: AssistantMessageView[]; turns: Array<{ id: string; status: string }> }
  | { type: "snapshot/loaded"; conversationId: string; snapshot: { conversation: AssistantConversationMeta; lastSeq: number; events: AssistantEvent[]; turns: Array<{ id: string; status: string }>; messages: AssistantMessageView[] } }
  | { type: "events/applied"; events: AssistantEvent[]; conversationId: string }
  | { type: "events/resync" }
  | { type: "submit/started"; conversationId: string }
  | { type: "submit/failed"; conversationId: string; error: string }
  | { type: "submit/completed"; conversationId: string };

export function initialAssistantState(): AssistantState {
  return {
    panelOpen: false,
    conversationId: null,
    conversation: null,
    messages: [],
    lastSeq: -1,
    pendingEvents: [],
    resyncing: false,
    turnActive: false,
    stages: [],
    reasonTail: undefined,
    proposals: [],
    sending: false,
    composerError: null,
    loading: false,
  };
}

function conversationPayload(action: Extract<AssistantReducerAction, { conversation: AssistantConversationMeta }>) {
  return {
    conversationId: action.conversation.id,
    conversation: action.conversation,
    lastSeq: action.lastSeq,
    messages: action.messages,
    pendingEvents: [],
    resyncing: false,
    turnActive: action.turns.some((t) => ["queued", "running", "awaiting_confirmation", "executing", "waiting_child"].includes(t.status)),
    stages: [],
    reasonTail: undefined,
    proposals: [],
    composerError: null,
    loading: false,
  };
}

function applyEvent(state: AssistantState, e: AssistantEvent): AssistantState {
  let next: AssistantState = { ...state, lastSeq: e.seq };
  switch (e.type) {
    case "turn.started":
      next = { ...next, turnActive: true };
      break;
    case "turn.finished":
      next = { ...next, turnActive: false, sending: false, stages: [], reasonTail: undefined };
      break;
    case "assistant.progress": {
      // Live tool stages + reasoning tail from the worker's message poll.
      const tools = Array.isArray(e.payload.tools) ? e.payload.tools : [];
      const stages = tools
        .slice(-12)
        .map((t) => {
          const rec = t as Record<string, unknown>;
          const callId = String(rec.call_id ?? "");
          const tool = String(rec.tool ?? "");
          const raw = String(rec.state ?? "running");
          const mapped: StageMarker["state"] = raw === "completed" ? "done" : raw === "error" ? "failed" : "running";
          return callId && tool ? { call_id: callId, tool, state: mapped } : null;
        })
        .filter((s): s is StageMarker => s !== null);
      const tail = typeof e.payload.reason_tail === "string" ? e.payload.reason_tail : undefined;
      next = { ...next, stages, reasonTail: tail };
      break;
    }
    case "tool.started": {
      const tool = String(e.payload.tool ?? "");
      const callId = String(e.payload.call_id ?? "");
      if (!tool) break;
      const others = state.stages.filter((s) => s.call_id !== callId);
      next = { ...next, stages: [...others, { call_id: callId, tool, state: "running" }] };
      break;
    }
    case "tool.completed": {
      const callId = String(e.payload.call_id ?? "");
      const ok = e.payload.ok !== false;
      next = {
        ...next,
        stages: state.stages.map((s) => (s.call_id === callId ? { ...s, state: ok ? ("done" as const) : ("failed" as const) } : s)),
      };
      break;
    }
    case "action.proposed":
      next = { ...next, proposals: [...state.proposals, {
        action_id: String(e.payload.action_id ?? ""), kind: String(e.payload.kind ?? ""),
        status: String(e.payload.status ?? "proposed"),
        preview_text: typeof e.payload.preview_text === "string" ? e.payload.preview_text : undefined,
        preview_digest: typeof e.payload.preview_digest === "string" ? e.payload.preview_digest : undefined,
        expires_at: typeof e.payload.expires_at === "string" ? e.payload.expires_at : null,
      }] };
      break;
    case "action.updated":
      next = { ...next, proposals: state.proposals.map((p) => (p.action_id === String(e.payload.action_id ?? "") ? { ...p, status: String(e.payload.status ?? p.status) } : p)) };
      break;
    default:
      break;
  }
  return next;
}

export function assistantReducer(state: AssistantState, action: AssistantReducerAction): AssistantState {
  switch (action.type) {
    case "panel/opened":
      return { ...state, panelOpen: true };
    case "panel/closed":
      return { ...state, panelOpen: false };
    case "conversation/loaded":
      return { ...state, ...conversationPayload(action), panelOpen: state.panelOpen };
    case "conversation/switched":
      return { ...state, ...conversationPayload(action), panelOpen: state.panelOpen };
    case "snapshot/loaded": {
      if (state.conversationId !== action.conversationId) return { ...state, loading: false };
      return {
        ...state,
        conversation: action.snapshot.conversation,
        lastSeq: action.snapshot.lastSeq,
        messages: action.snapshot.messages,
        pendingEvents: [],
        resyncing: false,
        loading: false,
        turnActive: action.snapshot.turns.some((t) => ["queued", "running", "awaiting_confirmation", "executing", "waiting_child"].includes(t.status)),
      };
    }
    case "events/applied": {
      if (state.conversationId !== action.conversationId) return state;
      // Dedupe + order: apply strictly new seqs; buffer gaps.
      const seen = new Set<number>();
      const candidates = [...state.pendingEvents, ...action.events]
        .filter((e) => {
          if (e.conversation_id !== state.conversationId) return false;
          if (e.seq <= state.lastSeq || seen.has(e.seq)) return false;
          seen.add(e.seq);
          return true;
        })
        .sort((a, b) => a.seq - b.seq);
      if (candidates.length === 0) return state;
      let next = state;
      const buffer: AssistantEvent[] = [];
      for (const e of candidates) {
        if (e.seq === next.lastSeq + 1) {
          next = applyEvent(next, e);
        } else {
          buffer.push(e);
        }
      }
      return { ...next, pendingEvents: buffer };
    }
    case "events/resync":
      return { ...state, pendingEvents: [], resyncing: true };
    case "submit/started":
      if (state.conversationId !== action.conversationId) return state;
      return { ...state, sending: true, composerError: null };
    case "submit/failed":
      if (state.conversationId !== action.conversationId) return state;
      return { ...state, sending: false, composerError: action.error };
    case "submit/completed":
      if (state.conversationId !== action.conversationId) return state;
      return { ...state, sending: false, composerError: null };
    default:
      return state;
  }
}
