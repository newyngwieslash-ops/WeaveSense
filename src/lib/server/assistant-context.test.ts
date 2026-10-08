import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantContext } from "./assistant-context.ts";
import { ASSISTANT_CONTEXT_MAX_BYTES } from "./assistant-context.ts";
import type { AssistantMessageInput } from "../assistant-contract.ts";

const base = (overrides: Partial<AssistantMessageInput> = {}): AssistantMessageInput => ({
  request_id: "11111111-1111-4111-8111-111111111111",
  expected_revision: 0,
  text: "问题",
  context: { page: "overview", filters: {}, references: [] },
  ...overrides,
});

test("context freezes page, filters and references with explicit omitted markers", () => {
  const ctx = buildAssistantContext(base({
    text: "第一条",
    context: { page: "keywords", filters: { q: "固态电池" }, references: [{ kind: "keyword", id: "kw1" }] },
  }));
  assert.equal(ctx.page, "keywords");
  assert.deepEqual(ctx.filters, { q: "固态电池" });
  assert.equal(ctx.references.length, 1);
  assert.ok((ctx.context_json as string).length <= ASSISTANT_CONTEXT_MAX_BYTES);
});

test("oversized context is rejected, not silently truncated", () => {
  // A 64KiB cap on serialized context: only a genuinely huge payload trips it.
  const huge = base({ context: { page: "overview", filters: { q: "长".repeat(40_000) }, references: [] } });
  assert.throws(() => buildAssistantContext(huge), /context_too_large/);
});

test("recent-history window is bounded to 12 completed messages", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content_json: { text: `消息 ${i}` },
  }));
  const ctx = buildAssistantContext(base({ text: "追问" }), history as never[]);
  const window = (ctx as { history: { text: string }[] }).history;
  assert.ok(window.length <= 12, "history window must be bounded");
  // The window keeps the MOST RECENT messages (highest ordinals).
  assert.equal(window[window.length - 1].text, "消息 19");
});

test("unicode-safe truncation marks omitted content explicitly", () => {
  const history = [{ role: "assistant", content_json: { text: "长".repeat(5000) } }];
  const ctx = buildAssistantContext(base({ text: "继续" }), history as never[]);
  const [first] = (ctx as { history: { text: string; omitted: boolean }[] }).history;
  assert.ok(first.omitted === true, "truncated history must be marked");
  assert.ok(Array.from(first.text).length < 5000, "content must be cut on code points");
});
