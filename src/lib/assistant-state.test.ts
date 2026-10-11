import assert from "node:assert/strict";
import test from "node:test";
import { assistantReducer, initialAssistantState } from "./assistant-state.ts";

/**
 * Task 15 client state (§2.2): duplicate events dedupe by seq, stale
 * responses from a switched conversation are dropped, revision conflicts
 * surface, and closing the panel never cancels the running turn.
 */

const conv = () => ({ id: "c1", title: "对话", revision: 0, status: "open" });

function event(seq: number, type: string, payload: Record<string, unknown> = {}, conversationId = "c1") {
  return { seq, type, turn_id: "t1", payload, conversation_id: conversationId, created_at: new Date().toISOString() };
}

test("snapshot loads conversation and watermark; later events dedupe by seq", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 4, events: [], messages: [], turns: [] });
  assert.equal(state.conversationId, "c1");
  assert.equal(state.lastSeq, 4);
  state = assistantReducer(state, { type: "events/applied", events: [event(5, "turn.started")], conversationId: "c1" });
  state = assistantReducer(state, { type: "events/applied", events: [event(5, "turn.started", { n: "dup" })], conversationId: "c1" });
  assert.equal(state.lastSeq, 5, "duplicate seq does not advance or duplicate");
  assert.equal(state.pendingEvents.length, 0);
});

test("events from another conversation are dropped", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 0, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "events/applied", events: [event(1, "turn.started", {}, "c2")], conversationId: "c1" });
  assert.equal(state.lastSeq, 0, "foreign event not applied");
});

test("events out of order are buffered until the gap fills", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 4, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "events/applied", events: [event(7, "tool.started", { call_id: "x" })], conversationId: "c1" });
  assert.equal(state.pendingEvents.length, 1, "seq 7 buffered at gap 5");
  assert.equal(state.lastSeq, 4);
  state = assistantReducer(state, { type: "events/applied", events: [event(5, "turn.started"), event(6, "tool.started", { call_id: "y" })], conversationId: "c1" });
  assert.equal(state.lastSeq, 7, "gap fill advances through the buffer");
  assert.equal(state.pendingEvents.length, 0);
});

test("switching conversations drops stale in-flight responses", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 0, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "conversation/switched", conversation: { id: "c2", title: "二", revision: 0, status: "open" }, lastSeq: 0, events: [], messages: [], turns: [] });
  // A response for the old conversation arrives.
  state = assistantReducer(state, { type: "snapshot/loaded", conversationId: "c1", snapshot: { conversation: conv(), lastSeq: 9, events: [], turns: [], messages: [] } });
  assert.equal(state.conversationId, "c2", "stale snapshot must not switch back");
  assert.equal(state.loading, false);
});

test("revision conflict from submit surfaces without killing the session", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 0, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "submit/failed", conversationId: "c1", error: "conflict" });
  assert.equal(state.composerError, "conflict");
  assert.equal(state.sending, false);
});

test("closing the panel keeps the running turn alive", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 1, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "events/applied", events: [event(2, "turn.started")], conversationId: "c1" });
  assert.equal(state.turnActive, true);
  state = assistantReducer(state, { type: "panel/closed" });
  assert.equal(state.panelOpen, false);
  assert.equal(state.turnActive, true, "turn continues while hidden");
});

test("turn.finished releases the active turn", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 1, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "events/applied", events: [event(2, "turn.started")], conversationId: "c1" });
  state = assistantReducer(state, { type: "events/applied", events: [event(3, "turn.finished", { status: "completed" })], conversationId: "c1" });
  assert.equal(state.turnActive, false);
});

test("tool and action events record visible stage markers", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 0, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "events/applied", events: [event(1, "tool.started", { call_id: "c1", tool: "list_keywords" })], conversationId: "c1" });
  assert.equal(state.stages.some((s) => s.tool === "list_keywords" && s.state === "running"), true);
  state = assistantReducer(state, { type: "events/applied", events: [event(2, "tool.completed", { call_id: "c1", tool: "list_keywords", ok: true })], conversationId: "c1" });
  assert.equal(state.stages.find((s) => s.tool === "list_keywords")?.state, "done");
  state = assistantReducer(state, { type: "events/applied", events: [event(3, "action.proposed", { action_id: "a1", kind: "keyword.create", status: "proposed" })], conversationId: "c1" });
  assert.equal(state.proposals.length, 1);
});

test("resync flag from the events API clears local buffers", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 4, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "events/applied", events: [event(9, "turn.started")], conversationId: "c1" });
  state = assistantReducer(state, { type: "events/resync" });
  assert.equal(state.pendingEvents.length, 0);
  assert.equal(state.resyncing, true);
});

test("assistant.progress maps tool states and carries the reasoning tail; finished clears", () => {
  let state = assistantReducer(initialAssistantState(), { type: "conversation/loaded", conversation: conv(), lastSeq: 0, events: [], messages: [], turns: [] });
  state = assistantReducer(state, { type: "events/applied", events: [event(1, "assistant.progress", {
    tools: [
      { call_id: "c1", tool: "corpus_project_overview", state: "completed" },
      { call_id: "c2", tool: "corpus_list_keywords", state: "running" },
    ],
    reason_tail: "先查概览再列关键词…",
  })], conversationId: "c1" });
  assert.equal(state.stages.length, 2);
  assert.equal(state.stages[0].state, "done");
  assert.equal(state.stages[1].state, "running");
  assert.equal(state.reasonTail, "先查概览再列关键词…");
  state = assistantReducer(state, { type: "events/applied", events: [event(2, "turn.finished", { status: "completed" })], conversationId: "c1" });
  assert.equal(state.stages.length, 0);
  assert.equal(state.reasonTail, undefined);
});
