import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_IDS, INTERVALS } from "./platforms.ts";
import {
  assistantMessageInput,
  actionDecisionInput,
  assistantResultSchema,
  assistantEventSchema,
  actionReceiptSchema,
  ASSISTANT_INTERVALS,
  ASSISTANT_PLATFORMS,
} from "./assistant-contract.ts";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

const base = {
  request_id: UUID,
  expected_revision: 0,
  text: "查看关键词",
  context: { page: "keywords", filters: {}, references: [] },
};

const keywordCreate = {
  ordinal: 0,
  kind: "keyword.create",
  args: {
    keyword: "固态电池",
    platforms: ["rss", "bilibili"],
    interval: 30,
    enabled: true,
  },
};

test("browser cannot select provider or send credentials", () => {
  assert.equal(assistantMessageInput.safeParse(base).success, true);
  assert.equal(assistantMessageInput.safeParse({ ...base, provider: "legacy" }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, apiKey: "forbidden" }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, model: "gpt-x" }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, autoApprove: true }).success, false);
});

test("overlong unicode text and bad context are rejected", () => {
  assert.equal(assistantMessageInput.safeParse({ ...base, text: "好".repeat(4001) }).success, false);
  // code-point semantics: 4001 astral code points exceed the 4000 bound
  assert.equal(assistantMessageInput.safeParse({ ...base, text: "😀".repeat(4001) }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, text: "😀".repeat(2000) }).success, true);
  assert.equal(assistantMessageInput.safeParse({ ...base, text: "   " }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, context: { ...base.context, page: "unknown-page" } }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, context: { ...base.context, references: [{ kind: "item", id: "a".repeat(129) }] } }).success, false);
  assert.equal(assistantMessageInput.safeParse({
    ...base,
    context: { ...base.context, references: Array.from({ length: 9 }, (_, i) => ({ kind: "item", id: `i${i}` })) },
  }).success, false);
  assert.equal(assistantMessageInput.safeParse({
    ...base,
    context: { ...base.context, references: [{ kind: "note", id: "n1" }, { kind: "collection_job", id: "j1" }] },
  }).success, true);
  // references must not become a generic bag: URL / role / key fields are refused
  assert.equal(assistantMessageInput.safeParse({
    ...base,
    context: { ...base.context, references: [{ kind: "item", id: "x", url: "https://evil.example" }] },
  }).success, false);
});

test("model result bounds: citations<=12, actions<=4, clarification xor actions", () => {
  const ok = { version: 1, answer: "答案", citations: [], actions: [] };
  assert.equal(assistantResultSchema.safeParse(ok).success, true);
  assert.equal(assistantResultSchema.safeParse({ ...ok, answer: "字".repeat(12001) }).success, false);
  assert.equal(assistantResultSchema.safeParse({
    ...ok,
    citations: Array.from({ length: 13 }, () => ({ kind: "item", id: "x" })),
  }).success, false);
  assert.equal(assistantResultSchema.safeParse({
    ...ok,
    actions: Array.from({ length: 5 }, (_, i) => ({ ...keywordCreate, ordinal: i })),
  }).success, false);
  assert.equal(assistantResultSchema.safeParse({
    ...ok,
    actions: [keywordCreate],
    clarification: { question: "要哪一个？", options: ["a", "b"] },
  }).success, false);
  const clarified = assistantResultSchema.safeParse({
    version: 1,
    answer: "需要消歧",
    citations: [],
    actions: [],
    clarification: { question: "要哪一个？", options: ["A 关键词", "B 关键词"] },
  });
  assert.equal(clarified.success, true);
});

test("action union: create/update/toggle are separate and strictly typed", () => {
  const parse = (args: unknown) => assistantResultSchema.safeParse({
    version: 1, answer: "方案", citations: [], actions: [{ ordinal: 0, kind: "keyword.create", args }],
  });
  assert.equal(parse(keywordCreate.args).success, true);
  // interval is the existing UI option set only
  assert.equal(parse({ ...keywordCreate.args, interval: 45 }).success, false);
  // platforms must be a non-empty, deduplicated, known list
  assert.equal(parse({ ...keywordCreate.args, platforms: [] }).success, false);
  assert.equal(parse({ ...keywordCreate.args, platforms: ["rss", "rss"] }).success, false);
  assert.equal(parse({ ...keywordCreate.args, platforms: ["rss", "netease-cloudmusic"] }).success, false);
  // no generic command / SQL / URL escape hatch
  assert.equal(parse({ ...keywordCreate.args, command: "rm -rf /" }).success, false);
  assert.equal(parse({ ...keywordCreate.args, sql: "delete from keywords" }).success, false);
  // unknown action kind is refused entirely
  assert.equal(assistantResultSchema.safeParse({
    version: 1, answer: "方案", citations: [],
    actions: [{ ordinal: 0, kind: "keyword.delete_everything", args: {} }],
  }).success, false);
  // update takes only interval/platforms; toggle takes enabled
  assert.equal(assistantResultSchema.safeParse({
    version: 1, answer: "方案", citations: [],
    actions: [{ ordinal: 0, kind: "keyword.update", args: { keyword_id: "kw1", interval: 60, enabled: false } }],
  }).success, false, "update must not smuggle a toggle field");
  assert.equal(assistantResultSchema.safeParse({
    version: 1, answer: "方案", citations: [],
    actions: [{ ordinal: 0, kind: "keyword.set_enabled", args: { keyword_id: "kw1", enabled: false } }],
  }).success, true);
});

test("source.create fixes platform/adapter and defaults to disabled; url is bounded", () => {
  const act = (args: unknown) => assistantResultSchema.safeParse({
    version: 1, answer: "方案", citations: [], actions: [{ ordinal: 0, kind: "source.create", args }],
  });
  // platform and adapter are host-fixed for RSS sources: the model does not send them
  assert.equal(act({ url: "https://example.com/feed.xml", enabled: false }).success, true);
  assert.equal(act({ url: "https://example.com/feed.xml" }).success, true, "enabled defaults to false");
  assert.equal(act({ url: "https://example.com/feed.xml", adapter: "telegram_web" }).success, false, "adapter is host-fixed");
  assert.equal(act({ url: "https://example.com/feed.xml", platform: "rss" }).success, false, "platform is not model-visible config");
  assert.equal(act({ url: "http://127.0.0.1/feed.xml" }).success, false, "loopback url refused by contract shape");
});

test("collect_once and research actions carry explicit targets only", () => {
  const parse = (kind: string, args: unknown) => assistantResultSchema.safeParse({
    version: 1, answer: "方案", citations: [], actions: [{ ordinal: 0, kind, args }],
  });
  assert.equal(parse("keyword.collect_once", { keyword_id: "kw1" }).success, true);
  assert.equal(parse("keyword.collect_once", {}).success, false);
  assert.equal(parse("source.collect_once", { source_id: "s1" }).success, true);
  assert.equal(parse("research.start", { question: "深入研究量产瓶颈的争论" }).success, true);
  assert.equal(parse("research.start", { question: "短" }).success, false);
  assert.equal(parse("research.cancel", { job_id: UUID2 }).success, true);
  assert.equal(parse("research.cancel", { job_id: "not-a-uuid" }).success, false);
});

test("cross-action references point backward to a created object", () => {
  const result = assistantResultSchema.safeParse({
    version: 1,
    answer: "创建并采集",
    citations: [],
    actions: [
      keywordCreate,
      { ordinal: 1, kind: "keyword.collect_once", args: { keyword: { from_action: 0, type: "keyword" } } },
    ],
  });
  assert.equal(result.success, true);
  // forward or looped references are refused
  assert.equal(assistantResultSchema.safeParse({
    version: 1, answer: "方案", citations: [],
    actions: [
      { ordinal: 0, kind: "keyword.collect_once", args: { keyword: { from_action: 1, type: "keyword" } } },
      keywordCreate,
    ],
  }).success, false);
});

test("structured intent grants limited pre-authorization, never a generic flag", () => {
  const withIntent = { ...base, intent: { type: "keyword.collect_once", keyword_id: "kw1" } };
  assert.equal(assistantMessageInput.safeParse(withIntent).success, true);
  assert.equal(assistantMessageInput.safeParse({ ...base, intent: { type: "keyword.collect_once" } }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, intent: { type: "keywords.wipe", keyword_id: "kw1" } }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, intent: { type: "source.collect_once", source_id: "s1", extra: true } }).success, false);
  assert.equal(assistantMessageInput.safeParse({ ...base, intent: { type: "keyword.set_enabled", keyword_id: "kw1", enabled: true } }).success, true);
  assert.equal(assistantMessageInput.safeParse({ ...base, intent: { type: "keyword.set_enabled", keyword_id: "kw1" } }).success, false);
});

test("decision input takes digest + revision only, never new parameters", () => {
  const decision = { request_id: UUID, decision: "approve", preview_digest: "a".repeat(64), expected_revision: 3 };
  assert.equal(actionDecisionInput.safeParse(decision).success, true);
  assert.equal(actionDecisionInput.safeParse({ ...decision, args: { interval: 5 } }).success, false);
  assert.equal(actionDecisionInput.safeParse({ ...decision, preview_digest: "xyz" }).success, false);
  assert.equal(actionDecisionInput.safeParse({ ...decision, decision: "auto" }).success, false);
});

test("events are a fixed whitelist with bounded payloads", () => {
  const ev = (type: string, payload: unknown) => assistantEventSchema.safeParse({
    schema_version: 1, conversation_id: UUID, turn_id: UUID2, seq: 1, type, created_at: new Date().toISOString(), payload,
  });
  assert.equal(ev("turn.queued", { status: "queued" }).success, true);
  assert.equal(ev("tool.started", { call_id: "c1", tool: "list_keywords" }).success, true);
  assert.equal(ev("tool.completed", { call_id: "c1", tool: "list_keywords", ok: true }).success, true);
  assert.equal(ev("action.proposed", { action_id: UUID2, kind: "keyword.create", status: "proposed" }).success, true);
  assert.equal(ev("entity.changed", { domain: "keywords", entity_id: "kw1" }).success, true);
  assert.equal(ev("runtime.raw_event", { blob: "leak" }).success, false);
  assert.equal(ev("tool.started", { call_id: "c1", tool: "drop_table" }).success, false);
  assert.equal(ev("entity.changed", { domain: "secrets" }).success, false);
});

test("action receipts are host facts with typed refs and honest statuses", () => {
  const receipt = {
    action_id: UUID,
    status: "succeeded",
    effect: "created",
    result_refs: [{ type: "keyword", id: "kw1" }],
    counts: { inserted: 1 },
    warnings: [],
    changed_domains: ["keywords"],
  };
  assert.equal(actionReceiptSchema.safeParse(receipt).success, true);
  assert.equal(actionReceiptSchema.safeParse({ ...receipt, status: "accepted", effect: "created" }).success, true);
  assert.equal(actionReceiptSchema.safeParse({ ...receipt, extra: true }).success, false);
  assert.equal(actionReceiptSchema.safeParse({ ...receipt, status: "ok" }).success, false);
  assert.equal(actionReceiptSchema.safeParse({ ...receipt, result_refs: [{ type: "keyword", id: "kw1", url: "javascript:alert(1)" }] }).success, false);
  assert.equal(actionReceiptSchema.safeParse({ ...receipt, counts: { inserted: -1 } }).success, false);
  assert.equal(actionReceiptSchema.safeParse({ ...receipt, changed_domains: ["keywords", "unknown-domain"] }).success, false);
});

test("contract platform/interval sets match the product enum", () => {
  assert.deepEqual([...ASSISTANT_PLATFORMS].sort(), [...PLATFORM_IDS].sort());
  assert.deepEqual([...ASSISTANT_INTERVALS], INTERVALS.map((i) => i.value).sort((a, b) => a - b));
});
