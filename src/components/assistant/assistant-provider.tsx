"use client";

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  assistantReducer, initialAssistantState,
  type AssistantConversationMeta, type AssistantEvent,
} from "@/lib/assistant-state";
import { effectQueryKeys } from "@/lib/assistant-effects";
import { createConversation, fetchCapabilities, fetchEvents, fetchSnapshot, submitMessage, type Capabilities } from "@/lib/assistant-client";

/**
 * Global assistant provider (plan Task 15 / §2.2). One instance mounts at
 * the app root; the panel survives route changes, closing it never cancels
 * the running turn, and all server interaction flows through the reducer.
 * Local preferences (panel open) read localStorage inside effects only.
 */

type AssistantContextValue = {
  state: import("@/lib/assistant-state").AssistantState;
  capabilities: Capabilities | null;
  openPanel: () => void;
  closePanel: () => void;
  startNewConversation: () => Promise<void>;
  switchConversation: (id: string) => Promise<void>;
  send: (text: string, page: string, references: Array<{ kind: string; id: string }>) => Promise<void>;
  refresh: () => Promise<void>;
};

const AssistantContext = createContext<AssistantContextValue | null>(null);

const ACTIVE_TURN = ["queued", "running", "awaiting_confirmation", "executing", "waiting_child"];

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(assistantReducer, undefined, initialAssistantState);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();
  const stateRef = useRef(state);
  stateRef.current = state;

  // Capabilities: read once when the panel opens (A01: no model calls).
  useEffect(() => {
    if (!state.panelOpen || capabilities) return;
    let cancelled = false;
    fetchCapabilities().then((caps) => { if (!cancelled) setCapabilities(caps); }).catch(() => { if (!cancelled) setCapabilities({ enabled: false, reason: "model_config_missing", actions_enabled: false, profile: "assistant" }); });
    return () => { cancelled = true; };
  }, [state.panelOpen, capabilities]);

  // Ensure a conversation exists when the panel first opens.
  useEffect(() => {
    if (!state.panelOpen || state.conversationId || !capabilities?.enabled) return;
    let cancelled = false;
    (async () => {
      try {
        const created = await createConversation();
        if (cancelled) return;
        const snapshot = await fetchSnapshot(created.id);
        if (cancelled) return;
        dispatch({
          type: "conversation/loaded",
          conversation: snapshot.conversation as AssistantConversationMeta,
          lastSeq: snapshot.lastSeq,
          events: snapshot.events as AssistantEvent[],
          messages: snapshot.messages,
          turns: snapshot.turns,
        });
      } catch { /* capabilities disabled or network error; panel shows the reason */ }
    })();
    return () => { cancelled = true; };
  }, [state.panelOpen, state.conversationId, capabilities?.enabled]);

  // Incremental event poll (2s fallback per §5.4) while the panel is open
  // and a conversation exists. Runs regardless of panel visibility after a
  // turn started, so task state keeps moving while hidden.
  const poll = useCallback(async () => {
    const current = stateRef.current;
    if (!current.conversationId || !current.panelOpen) return;
    try {
      const page = await fetchEvents(current.conversationId, current.lastSeq);
      if (page.resync_required) {
        dispatch({ type: "events/resync" });
        const snapshot = await fetchSnapshot(current.conversationId);
        dispatch({ type: "snapshot/loaded", conversationId: current.conversationId, snapshot });
        // A resync means we may have missed entity changes: refresh every
        // mapped domain once rather than guessing.
        for (const key of [["keywords"], ["sources"], ["items"], ["jobs"], ["knowledge"], ["overview"]]) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
        return;
      }
      if (page.events.length > 0) {
        dispatch({ type: "events/applied", events: page.events as AssistantEvent[], conversationId: current.conversationId });
        // entity.changed → fixed domain → fixed query key (§6.1.7).
        for (const e of page.events) {
          if (e.type !== "entity.changed") continue;
          const domain = (e.payload as { domain?: unknown }).domain;
          if (typeof domain !== "string") continue;
          try {
            for (const key of effectQueryKeys([domain])) {
              void queryClient.invalidateQueries({ queryKey: key });
            }
          } catch { /* unknown domain: contract violation, ignore */ }
        }
      }
      // Pull messages when a turn finished so the answer renders.
      if (page.events.some((e) => e.type === "turn.finished")) {
        const snapshot = await fetchSnapshot(current.conversationId);
        dispatch({ type: "snapshot/loaded", conversationId: current.conversationId, snapshot });
      }
    } catch { /* transient network failure; next tick retries */ }
  }, []);

  useEffect(() => {
    if (!state.panelOpen) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    // Backoff while idle: 2s during an active turn, 8s otherwise. The timer
    // is recreated on turnActive transitions so latency recovery keeps the
    // task badge responsive (§5.4 fallback).
    if (!pollRef.current) {
      const schedule = () => {
        const period = stateRef.current.turnActive ? 2000 : 8000;
        pollRef.current = setInterval(() => { void poll(); }, period);
      };
      schedule();
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [state.panelOpen, state.turnActive, poll]);

  const openPanel = useCallback(() => dispatch({ type: "panel/opened" }), []);
  const closePanel = useCallback(() => dispatch({ type: "panel/closed" }), []);

  const startNewConversation = useCallback(async () => {
    const created = await createConversation();
    const snapshot = await fetchSnapshot(created.id);
    dispatch({
      type: "conversation/switched",
      conversation: snapshot.conversation as AssistantConversationMeta,
      lastSeq: snapshot.lastSeq,
      events: snapshot.events as AssistantEvent[],
      messages: snapshot.messages,
      turns: snapshot.turns,
    });
  }, []);

  const switchConversation = useCallback(async (id: string) => {
    const snapshot = await fetchSnapshot(id);
    dispatch({
      type: "conversation/switched",
      conversation: snapshot.conversation as AssistantConversationMeta,
      lastSeq: snapshot.lastSeq,
      events: snapshot.events as AssistantEvent[],
      messages: snapshot.messages,
      turns: snapshot.turns,
    });
  }, []);

  const send = useCallback(async (text: string, page: string, references: Array<{ kind: string; id: string }>) => {
    const current = stateRef.current;
    if (!current.conversationId || !current.conversation) return;
    const conversationId = current.conversationId;
    dispatch({ type: "submit/started", conversationId });
    try {
      await submitMessage({
        conversationId,
        requestId: globalThis.crypto.randomUUID(),
        expectedRevision: current.conversation.revision,
        text,
        context: { page, filters: {}, references },
      });
      dispatch({ type: "submit/completed", conversationId });
      // The user message is persisted server-side at submit time; render it
      // immediately instead of waiting for a turn event (which may be far
      // away while the model claim is queued or the engine is unavailable).
      await refresh();
    } catch (error) {
      dispatch({ type: "submit/failed", conversationId, error: error instanceof Error ? error.message : "send_failed" });
    }
  }, []);

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    if (!current.conversationId) return;
    const snapshot = await fetchSnapshot(current.conversationId);
    dispatch({ type: "snapshot/loaded", conversationId: current.conversationId, snapshot });
  }, []);

  return (
    <AssistantContext.Provider value={{ state, capabilities, openPanel, closePanel, startNewConversation, switchConversation, send, refresh }}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant outside provider");
  return ctx;
}
