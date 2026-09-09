import { z } from "zod";

export const codePointLength = (value: string) => Array.from(value).length;

const text = (max: number) =>
  z.string().refine((v) => codePointLength(v) <= max, { message: `max_${max}_code_points` });

const labels = z.array(text(80).refine((v) => v.trim().length > 0, { message: "empty_label" })).max(12);

export const analysisSchema = z.object({
  summary: text(1200).refine((v) => v.trim().length > 0, { message: "empty_summary" }),
  topics: labels,
  entities: labels,
  insights: text(1200),
  tags: labels,
}).strict();

export const analyzeInput = z.object({
  id: z.string().trim().min(1).max(128),
  request_id: z.uuid().optional(),
}).strict();

export const askInput = z.object({
  question: z.string().trim().refine((v) => {
    const length = codePointLength(v);
    return length >= 2 && length <= 400;
  }, { message: "invalid_question" }),
  request_id: z.uuid().optional(),
  async: z.boolean().optional(),
}).strict();

export const briefingInput = z.object({
  request_id: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.from === undefined) !== (v.to === undefined) ||
    (v.from !== undefined && v.to !== undefined && Date.parse(v.from) >= Date.parse(v.to))) {
    ctx.addIssue({ code: "custom", message: "invalid_date_range" });
  }
});

const sourceSchema = z.object({
  evidence_id: z.string().trim().min(1).max(128),
  item_id: z.string().trim().min(1).max(128),
  title: text(200),
  platform: z.string().trim().min(1).max(32),
  source_name: text(200),
  url: z.string().max(2000),
  published_at: z.iso.datetime({ offset: true }).nullable(),
  text: z.string(),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  coverage: z.enum(["full", "partial"]),
}).strict().superRefine((v, ctx) => {
  const length = codePointLength(v.text);
  if (v.end < v.start || v.end - v.start !== length) {
    ctx.addIssue({ code: "custom", message: "source_span_mismatch" });
  }
});

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
}).strict().superRefine((v, ctx) => {
  if (Date.parse(v.from) >= Date.parse(v.to)) {
    ctx.addIssue({ code: "custom", message: "invalid_date_range" });
  }
});

const policySchema = z.object({
  version: z.string().trim().min(1).max(64),
  deadline_at: z.iso.datetime({ offset: true }),
  max_model_calls: z.number().int().min(0).max(20),
  max_tool_calls: z.number().int().min(0).max(20),
  max_output_tokens_per_call: z.number().int().min(1).max(8000),
}).strict();

export const executeRequestSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  mode: z.enum(["analyze_item", "briefing", "research"]),
  input: z.object({
    question: z.string(),
    sources: z.array(sourceSchema).max(12),
    range: rangeSchema.nullable(),
  }).strict(),
  policy: policySchema,
  data_access_token: z.string().min(16).max(128).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.mode === "analyze_item") {
    if (v.input.sources.length === 0) {
      ctx.addIssue({ code: "custom", message: "empty_evidence" });
    }
    const ids = new Set(v.input.sources.map((s) => s.item_id));
    if (ids.size > 1) ctx.addIssue({ code: "custom", message: "mixed_items" });
  }
  if (v.mode === "briefing" && v.input.range == null) {
    ctx.addIssue({ code: "custom", message: "range_required" });
  }
  if (v.mode === "research") {
    const length = codePointLength(v.input.question.trim());
    if (length < 2 || length > 400) ctx.addIssue({ code: "custom", message: "invalid_question" });
  }
});

const citationSchema = z.object({
  evidence_id: z.string().trim().min(1).max(128),
  quote: text(500).refine((v) => v.trim().length > 0, { message: "empty_quote" }),
}).strict();

const runtimeEventSchema = z.object({
  type: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(128),
  duration_ms: z.number().int().min(0),
  ok: z.boolean(),
}).strict();

const runtimeSchema = z.object({
  model: z.string().max(128),
  prompt_version: z.string().max(64),
  skill_versions: z.record(z.string(), z.string()),
  input_tokens: z.number().int().min(0).nullable(),
  output_tokens: z.number().int().min(0).nullable(),
  model_calls: z.number().int().min(0),
  tool_calls: z.number().int().min(0),
  events: z.array(runtimeEventSchema).max(64),
}).strict();

const evidenceSchema = z.object({
  evidence_id: z.string().trim().min(1).max(128),
  item_id: z.string().min(1).max(128).nullable(),
  title: text(200),
  url: z.string().max(2000),
  text: z.string(),
  origin: z.enum(["internal", "mcp"]),
}).strict();

export const agentResultSchema = z.object({
  analysis: analysisSchema.optional(),
  title: text(200).optional(),
  content: text(12000).optional(),
  citations: z.array(citationSchema).max(20),
  insufficient_evidence: z.boolean(),
  coverage: z.enum(["full", "partial"]),
  warnings: z.array(z.string().max(200)).max(12),
}).strict();

const successResponseSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  ok: z.literal(true),
  result: agentResultSchema,
  runtime: runtimeSchema,
  evidence: z.array(evidenceSchema).max(32),
}).strict();

const errorResponseSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.uuid(),
  ok: z.literal(false),
  runtime: runtimeSchema.optional(),
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    outcome_unknown: z.boolean(),
  }).strict(),
}).strict();

export const executeResponseSchema = z.discriminatedUnion("ok", [
  successResponseSchema,
  errorResponseSchema,
]);

export const completeJobSchema = z.object({
  action: z.literal("complete").optional(),
  job_id: z.uuid(), run_id: z.uuid(), claim_token: z.string().min(1).max(128),
  status: z.enum(["succeeded", "failed", "outcome_unknown"]),
  response: executeResponseSchema.optional(), error_code: z.string().min(1).max(64).optional(),
  // Known claim metadata can be echoed. It never overrides the saved request.
  question: text(400).optional(), mode: z.enum(["research", "briefing", "analyze_item"]).optional(),
  data_access_token: z.string().max(128).optional(), item_id: z.string().max(128).optional(),
  input: executeRequestSchema.shape.input.optional(), policy: policySchema.optional(),
  resume: z.boolean().optional(), sequence: z.number().int().min(0).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.status === "succeeded" && (!v.response || !v.response.ok)) ctx.addIssue({ code: "custom", message: "missing_response" });
});

export const checkpointActionSchema = z.object({
  action: z.enum(["save_checkpoint", "get_checkpoint"]).optional(),
  run_id: z.uuid(), claim_token: z.string().min(1).max(128), check_point_id: z.string().min(1).max(128),
  runtime_version: z.string().min(1).max(64), schema_version: z.literal("1").optional(),
  sequence: z.number().int().min(0).optional(), payload: z.string().max(350000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
}).strict();
export const renewJobSchema = z.object({
  action: z.literal("renew").optional(), job_id: z.uuid(), run_id: z.uuid(), claim_token: z.string().min(1).max(128),
}).strict();
export const claimJobSchema = z.object({ action: z.literal("claim").optional() }).strict();

export type ExecuteMode = "analyze_item" | "briefing" | "research";
export type ExecuteRequest = z.infer<typeof executeRequestSchema>;
export type ExecuteResponse = z.infer<typeof executeResponseSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJsonObject(raw: string): ParseResult<unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "empty_json" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

export function parseExecuteRequest(raw: string): ParseResult<ExecuteRequest> {
  const json = parseJsonObject(raw);
  if (!json.ok) return json;
  const parsed = executeRequestSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_request" };
  return { ok: true, value: parsed.data };
}

function resultMatchesMode(result: AgentResult, mode: ExecuteMode): boolean {
  if (mode === "analyze_item") {
    return result.analysis != null && result.content == null && result.title == null;
  }
  return result.analysis == null && result.content != null && result.content.trim().length > 0;
}

export function parseExecuteResponse(raw: string, mode: ExecuteMode): ParseResult<ExecuteResponse> {
  const json = parseJsonObject(raw);
  if (!json.ok) return json;
  const parsed = executeResponseSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid_output" };
  if (parsed.data.ok && !resultMatchesMode(parsed.data.result, mode)) {
    return { ok: false, error: "cross_mode_output" };
  }
  return { ok: true, value: parsed.data };
}
