import { z } from "zod";
import { INTERVALS, PLATFORM_IDS } from "./platforms.ts";

/**
 * Browser↔host assistant contract (plan §5.2/§5.5).
 *
 * Frozen on 2026-10-08: the browser may never pick a provider, model, key,
 * permission mode, SQL or budget; every write is a discriminated action the
 * host previews and executes. Assistant schema v1.
 */

export const ASSISTANT_SCHEMA_VERSION = 1;

export const ASSISTANT_INTERVALS = INTERVALS.map((i) => i.value).sort((a, b) => a - b) as [number, ...number[]];

export const ASSISTANT_PLATFORMS = PLATFORM_IDS;

export const codePointLength = (value: string) => Array.from(value).length;

const boundedText = (min: number, max: number) =>
  z.string().trim().refine((v) => {
    const n = codePointLength(v);
    return n >= min && n <= max;
  }, { message: `invalid_text_length_${min}_${max}` });

export const reference = z.object({
  kind: z.enum(["item", "source", "keyword", "note", "collection_job", "research_job"]),
  id: z.string().trim().min(1).max(128),
}).strict();

export type AssistantReference = z.infer<typeof reference>;

/** Known search-validation pages the panel can freeze as context. */
export const ASSISTANT_PAGES = [
  "overview",
  "keywords",
  "sources",
  "inbox",
  "item",
  "knowledge",
  "jobs",
  "nodes",
  "model-settings",
  "pipeline",
  "guide",
  "prd",
] as const;

const contextInput = z.object({
  page: z.enum(ASSISTANT_PAGES),
  filters: z.object({
    platform: z.string().max(32).optional(),
    q: boundedText(0, 200).optional(),
    media: z.string().max(32).optional(),
    keyword: boundedText(0, 80).optional(),
  }).strict(),
  references: z.array(reference).max(8),
}).strict();

/**
 * Limited pre-authorization built from explicit UI affordances (§6.1b):
 * the user clicked a concrete button targeting a concrete entity. Never a
 * generic autoApprove flag. Absent intent ⇒ every action needs a preview.
 */
// Members are already .strict(); in zod 4 a discriminated union cannot take
// .strict() itself, but it still refuses unknown keys end to end.
export const assistantIntentInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("keyword.collect_once"), keyword_id: z.string().trim().min(1).max(128) }).strict(),
  z.object({ type: z.literal("source.collect_once"), source_id: z.string().trim().min(1).max(128) }).strict(),
  z.object({
    type: z.literal("keyword.set_enabled"),
    keyword_id: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("source.set_enabled"),
    source_id: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
  }).strict(),
]);

export const assistantMessageInput = z.object({
  request_id: z.uuid(),
  expected_revision: z.number().int().nonnegative(),
  text: boundedText(1, 4000),
  context: contextInput,
  intent: assistantIntentInput.optional(),
}).strict();

export const actionDecisionInput = z.object({
  request_id: z.uuid(),
  decision: z.enum(["approve", "reject"]),
  preview_digest: z.string().regex(/^[a-f0-9]{64}$/),
  expected_revision: z.number().int().nonnegative(),
}).strict();

// --- Model-facing result (validated strictly; unknown fields refused) -------

const keywordIdArgs = z.object({ keyword_id: z.string().trim().min(1).max(128) }).strict();
const sourceIdArgs = z.object({ source_id: z.string().trim().min(1).max(128) }).strict();
const jobIdArgs = z.object({ job_id: z.uuid() }).strict();

const platformList = z.array(z.enum(PLATFORM_IDS)).min(1).max(PLATFORM_IDS.length)
  .refine((list) => new Set(list).size === list.length, { message: "duplicate_platform" });

/**
 * Host-resolved handle for cross-action references: only a business object a
 * strictly earlier action in the same batch created. No templates, no URLs.
 */
const createdHandle = z.object({
  from_action: z.number().int().min(0),
  type: z.enum(["keyword", "source"]),
}).strict();

const keywordCreateArgs = z.object({
  keyword: boundedText(2, 40),
  platforms: platformList,
  interval: z.literal(ASSISTANT_INTERVALS),
  enabled: z.boolean().optional().default(false),
}).strict();

const keywordUpdateArgs = z.object({
  keyword_id: z.string().trim().min(1).max(128),
  interval: z.literal(ASSISTANT_INTERVALS).optional(),
  platforms: platformList.optional(),
}).strict().refine((v) => v.interval !== undefined || v.platforms !== undefined, { message: "empty_update" });

const keywordToggleArgs = z.object({
  keyword_id: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
}).strict();

const sourceCreateArgs = z.object({
  url: z.string().trim().max(2000)
    .refine((v) => /^https:\/\//i.test(v), { message: "https_url_required" }),
  enabled: z.boolean().optional().default(false),
}).strict();

const sourceToggleArgs = z.object({
  source_id: z.string().trim().min(1).max(128),
  enabled: z.boolean(),
}).strict();

const collectOnceArgs = z.object({
  keyword_id: z.string().trim().min(1).max(128).optional(),
  source_id: z.string().trim().min(1).max(128).optional(),
  keyword: createdHandle.optional(),
  source: createdHandle.optional(),
}).strict().refine((v) => {
  const targets = [v.keyword_id, v.source_id, v.keyword, v.source].filter((x) => x !== undefined);
  return targets.length === 1;
}, { message: "single_collect_target" });

const researchStartArgs = z.object({ question: boundedText(2, 400) }).strict();

const itemIdArgs = z.object({ item_id: z.string().trim().min(1).max(128) }).strict();

/** Briefing range: optional, but from/to must be paired (§6.4). */
const briefingArgs = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).strict().refine((v) => (v.from === undefined) === (v.to === undefined), { message: "date_range_paired" });

export type AssistantActionKind =
  | "keyword.create" | "keyword.update" | "keyword.set_enabled" | "keyword.collect_once"
  | "source.create" | "source.set_enabled" | "source.collect_once"
  | "research.start" | "research.cancel"
  | "item.analyze" | "knowledge.briefing";

// Members carry no top-level .strict(): args schemas are already strict, and
// the proposal envelope adds `ordinal`, which a member-level strict would
// reject. Envelope unknown keys are refused by actionProposalSchema instead.
export const actionArgsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keyword.create"), args: keywordCreateArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("keyword.update"), args: keywordUpdateArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("keyword.set_enabled"), args: keywordToggleArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("keyword.collect_once"), args: collectOnceArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("source.create"), args: sourceCreateArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("source.set_enabled"), args: sourceToggleArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("source.collect_once"), args: collectOnceArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("research.start"), args: researchStartArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("research.cancel"), args: jobIdArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  // Second-phase actions (plan Task 20/21): the model may propose them once
  // the host gates open the capability; execution stays host-managed.
  z.object({ kind: z.literal("item.analyze"), args: itemIdArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ kind: z.literal("knowledge.briefing"), args: briefingArgs, ordinal: z.number().int().min(0).max(3).optional() }).strict(),
]);
export const ASSISTANT_ACTION_KINDS = actionArgsSchema.options.map((o) => o.shape.kind.value) as [
  AssistantActionKind,
  ...AssistantActionKind[],
];
export type AssistantActionProposal = AssistantAction & { ordinal?: number };

/** Wire shape with required ordinal; result validation demands one per action. */
export const actionProposalSchema = actionArgsSchema.superRefine((v, ctx) => {
  if (typeof v.ordinal !== "number" || !Number.isInteger(v.ordinal) || v.ordinal < 0 || v.ordinal > 3) {
    ctx.addIssue({ code: "custom", message: "invalid_ordinal" });
  }
});

export const ASSISTANT_ACTION_KINDS_ORIGINAL = ASSISTANT_ACTION_KINDS;

export const clarificationSchema = z.object({
  question: boundedText(1, 500),
  options: z.array(boundedText(1, 120)).min(2).max(6),
}).strict();

export const assistantResultSchema = z.object({
  version: z.literal(ASSISTANT_SCHEMA_VERSION),
  answer: boundedText(1, 12000),
  citations: z.array(reference).max(12),
  actions: z.array(actionArgsSchema).max(4),
  clarification: clarificationSchema.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.clarification !== undefined && v.actions.length > 0) {
    ctx.addIssue({ code: "custom", message: "clarification_xor_actions" });
  }
  // Cross-action handles must point strictly backward at a matching creator.
  const creators = new Map<number, "keyword" | "source">();
  v.actions.forEach((a, index) => {
    const handles: Array<{ from_action: number; type: "keyword" | "source" }> = [];
    if (a.kind === "keyword.collect_once" || a.kind === "source.collect_once") {
      if (a.args.keyword) handles.push(a.args.keyword);
      if (a.args.source) handles.push(a.args.source);
    }
    for (const h of handles) {
      if (h.from_action >= index || creators.get(h.from_action) !== h.type) {
        ctx.addIssue({ code: "custom", message: "invalid_action_reference" });
        return;
      }
    }
    if (a.kind === "keyword.create") creators.set(index, "keyword");
    if (a.kind === "source.create") creators.set(index, "source");
  });
});

// --- Host-emitted events and receipts (§5.4/§5.5) ---------------------------

export const ASSISTANT_EVENT_TYPES = [
  "turn.queued",
  "turn.started",
  "tool.started",
  "tool.completed",
  "message.completed",
  "action.proposed",
  "action.updated",
  "child.updated",
  "entity.changed",
  "turn.finished",
] as const;

export type AssistantEventType = (typeof ASSISTANT_EVENT_TYPES)[number];

export const ASSISTANT_DOMAINS = ["sources", "keywords", "items", "jobs", "knowledge", "overview"] as const;

const toolPayload = z.object({
  call_id: z.string().trim().min(1).max(128),
  tool: z.enum([
    "project_overview", "list_keywords", "list_sources", "search_items", "get_item",
    "list_notes", "get_note", "list_collection_jobs", "get_collection_job",
    "get_research_status", "get_operation", "get_service_status",
  ]),
  ok: z.boolean().optional(),
  summary: z.string().max(200).optional(),
}).strict();

const entityPayload = z.object({
  domain: z.enum(ASSISTANT_DOMAINS),
  entity_id: z.string().trim().min(1).max(128),
}).strict();

const turnPayload = z.object({
  status: z.enum([
    "queued", "running", "awaiting_confirmation", "executing", "waiting_child",
    "completed", "failed", "cancelled", "outcome_unknown",
  ]),
  reason: z.string().max(200).optional(),
}).strict();

const actionPayload = z.object({
  action_id: z.string().trim().min(1).max(128),
  kind: z.enum(ASSISTANT_ACTION_KINDS),
  status: z.enum([
    "proposed", "approved", "executing", "succeeded", "failed",
    "rejected", "expired", "conflict", "cancelled", "outcome_unknown",
  ]),
}).strict();

const childPayload = z.object({
  job_id: z.string().trim().min(1).max(128),
  status: z.enum(["queued", "running", "succeeded", "failed", "outcome_unknown", "cancelled"]),
}).strict();

const messagePayload = z.object({
  message_id: z.string().trim().min(1).max(128),
  ordinal: z.number().int().min(0),
}).strict();

export const assistantEventSchema = z.object({
  schema_version: z.literal(ASSISTANT_SCHEMA_VERSION),
  conversation_id: z.string().trim().min(1).max(128),
  turn_id: z.string().trim().min(1).max(128),
  seq: z.number().int().min(0),
  type: z.enum(ASSISTANT_EVENT_TYPES),
  created_at: z.iso.datetime({ offset: true }),
  // Members are .strict(); the union itself rejects unknown keys as none of
  // the members match an extra-field object.
  payload: z.union([toolPayload, entityPayload, turnPayload, actionPayload, childPayload, messagePayload]),
}).strict();

export const ASSISTANT_RECEIPT_STATUSES = [
  "accepted", "running", "succeeded", "failed", "conflict", "cancelled", "outcome_unknown",
] as const;

export const ASSISTANT_EFFECTS = ["created", "updated", "existing", "unchanged", "skipped"] as const;

const receiptRef = z.object({
  type: z.enum(["source", "keyword", "item", "job", "ai_job", "ai_run", "note", "analysis"]),
  id: z.string().trim().min(1).max(128),
}).strict();

export const actionReceiptSchema = z.object({
  action_id: z.string().trim().min(1).max(128),
  status: z.enum(ASSISTANT_RECEIPT_STATUSES),
  effect: z.enum(ASSISTANT_EFFECTS).optional(),
  result_refs: z.array(receiptRef).max(12),
  counts: z.object({
    inserted: z.number().int().min(0),
    matched: z.number().int().min(0).optional(),
  }).strict().optional(),
  warnings: z.array(z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(300),
    platform: z.string().max(32).optional(),
  }).strict()).max(12),
  error_code: z.string().min(1).max(64).optional(),
  partial_effects_possible: z.boolean().optional(),
  changed_domains: z.array(z.enum(ASSISTANT_DOMAINS)).max(ASSISTANT_DOMAINS.length),
}).strict();

export type AssistantMessageInput = z.infer<typeof assistantMessageInput>;
export type AssistantIntent = z.infer<typeof assistantIntentInput>;
export type AssistantAction = z.infer<typeof actionArgsSchema>;
export type AssistantResult = z.infer<typeof assistantResultSchema>;
export type AssistantEvent = z.infer<typeof assistantEventSchema>;
export type ActionReceipt = z.infer<typeof actionReceiptSchema>;
export type ActionDecisionInput = z.infer<typeof actionDecisionInput>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseAssistantMessageInput(raw: unknown): ParseResult<AssistantMessageInput> {
  const parsed = assistantMessageInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_request" };
  return { ok: true, value: parsed.data };
}
