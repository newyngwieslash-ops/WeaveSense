import { createHash } from "node:crypto";
import type { Sql } from "../db.ts";

type Queryable = Pick<Sql, "query">;

export type AgentMode = "analyze_item" | "briefing" | "research";
export type AgentProvider = "legacy" | "eino";
export type AgentRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export type AgentRunRow = {
  id: string;
  request_id: string;
  mode: AgentMode;
  provider: AgentProvider;
  input_hash: string;
  material_hash: string;
  policy_version: string;
  request_json: unknown;
  status: AgentRunStatus;
  claim_token: string;
  data_token_hash: string;
  expires_at: string;
  response_json: unknown;
  events_json: unknown;
  model: string;
  prompt_version: string;
  skill_versions: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  model_calls: number;
  tool_calls: number;
  error_code: string;
  created_at: string;
  finished_at: string | null;
};

export type BeginRunInput = {
  id: string;
  requestId: string;
  mode: AgentMode;
  provider: AgentProvider;
  inputHash: string;
  materialHash: string;
  policyVersion: string;
  requestJson: unknown;
  claimToken: string;
  expiresAt: string;
  dataTokenHash?: string;
};

export type BeginRunResult =
  | { kind: "won"; run: AgentRunRow }
  | { kind: "in_progress"; run: AgentRunRow }
  | { kind: "replay"; run: AgentRunRow; responseJson: unknown }
  | { kind: "conflict"; run: AgentRunRow }
  | { kind: "failed"; run: AgentRunRow };

function asJson(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function mapRun(row: Record<string, unknown>): AgentRunRow {
  return {
    id: String(row.id),
    request_id: String(row.request_id),
    mode: String(row.mode) as AgentMode,
    provider: String(row.provider) as AgentProvider,
    input_hash: String(row.input_hash),
    material_hash: String(row.material_hash),
    policy_version: String(row.policy_version),
    request_json: asJson(row.request_json),
    status: String(row.status) as AgentRunStatus,
    claim_token: String(row.claim_token),
    data_token_hash: String(row.data_token_hash ?? ""),
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    response_json: asJson(row.response_json),
    events_json: asJson(row.events_json) ?? [],
    model: String(row.model ?? ""),
    prompt_version: String(row.prompt_version ?? ""),
    skill_versions: asJson(row.skill_versions) ?? {},
    input_tokens: row.input_tokens == null ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens == null ? null : Number(row.output_tokens),
    model_calls: Number(row.model_calls ?? 0),
    tool_calls: Number(row.tool_calls ?? 0),
    error_code: String(row.error_code ?? ""),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    finished_at: row.finished_at == null ? null : row.finished_at instanceof Date
      ? row.finished_at.toISOString() : String(row.finished_at),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export async function getRun(sql: Queryable, id: string): Promise<AgentRunRow | null> {
  const [row] = await sql.query<Record<string, unknown>>("select * from ai_runs where id = $1", [id]);
  return row ? mapRun(row) : null;
}

async function getRunByRequest(sql: Queryable, requestId: string): Promise<AgentRunRow | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    "select * from ai_runs where request_id = $1",
    [requestId],
  );
  return row ? mapRun(row) : null;
}

export async function beginRun(sql: Queryable, input: BeginRunInput): Promise<BeginRunResult> {
  const inserted = await sql.query<Record<string, unknown>>(
    `insert into ai_runs (id, request_id, mode, provider, input_hash, material_hash,
      policy_version, request_json, status, claim_token, data_token_hash, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'running',$9,$10,$11)
     on conflict (request_id) do nothing
     returning *`,
    [
      input.id,
      input.requestId,
      input.mode,
      input.provider,
      input.inputHash,
      input.materialHash,
      input.policyVersion,
      JSON.stringify(input.requestJson),
      input.claimToken,
      input.dataTokenHash ?? "",
      input.expiresAt,
    ],
  );
  if (inserted[0]) return { kind: "won", run: mapRun(inserted[0]) };

  const existing = await getRunByRequest(sql, input.requestId);
  if (!existing) throw new Error("run_missing_after_conflict");
  if (existing.input_hash !== input.inputHash) return { kind: "conflict", run: existing };
  if (existing.status === "succeeded") {
    return { kind: "replay", run: existing, responseJson: existing.response_json };
  }
  if (existing.status === "running") return { kind: "in_progress", run: existing };
  return { kind: "failed", run: existing };
}

export async function finishRun(sql: Queryable, input: {
  id: string;
  claimToken: string;
  responseJson: unknown;
  model: string;
  promptVersion: string;
  skillVersions: Record<string, string>;
  inputTokens: number | null;
  outputTokens: number | null;
  modelCalls: number;
  toolCalls: number;
}): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update ai_runs
     set status = 'succeeded',
         response_json = $3::jsonb,
         model = $4,
         prompt_version = $5,
         skill_versions = $6::jsonb,
         input_tokens = $7,
         output_tokens = $8,
         model_calls = $9,
         tool_calls = $10,
         finished_at = now()
     where id = $1
       and status = 'running'
       and claim_token = $2
       and expires_at > now()
     returning id`,
    [
      input.id,
      input.claimToken,
      JSON.stringify(input.responseJson),
      input.model,
      input.promptVersion,
      JSON.stringify(input.skillVersions),
      input.inputTokens,
      input.outputTokens,
      input.modelCalls,
      input.toolCalls,
    ],
  );
  return rows.length === 1;
}

export async function failRun(sql: Queryable, input: {
  id: string;
  claimToken: string;
  errorCode: string;
  status?: Exclude<AgentRunStatus, "running" | "succeeded">;
  responseJson?: unknown;
}): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update ai_runs
     set status = $3,
         error_code = $4,
         response_json = coalesce($5::jsonb, response_json),
         finished_at = now()
     where id = $1
       and status = 'running'
       and claim_token = $2
       and expires_at > now()
     returning id`,
    [
      input.id,
      input.claimToken,
      input.status ?? "failed",
      input.errorCode,
      input.responseJson == null ? null : JSON.stringify(input.responseJson),
    ],
  );
  return rows.length === 1;
}

export async function finishAnalyzeAtomically(sql: Queryable, input: {
  runId: string;
  claimToken: string;
  itemId: string;
  title: string;
  body: string;
  author: string;
  url: string;
  platform: string;
  analysisId: string;
  summary: string;
  topics: string[];
  entities: string[];
  insights: string;
  tags: string[];
  model: string;
  promptVersion: string;
  skillVersions: Record<string, string>;
  responseJson: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  modelCalls: number;
  toolCalls: number;
}): Promise<"ok" | "input_changed" | "persist_failed"> {
  const rows = await sql.query<{ analysis_id: string }>(
    `with claimed as (
       select id from ai_runs
       where id = $1 and status = 'running' and claim_token = $2 and expires_at > now()
     ), matched as (
       select id from items
       where id = $3 and title = $4 and body = $5 and author = $6 and url = $7 and platform = $8
     ), updated as (
       update ai_runs r
       set status = 'succeeded',
           response_json = $9::jsonb,
           model = $10,
           prompt_version = $11,
           skill_versions = $12::jsonb,
           input_tokens = $13,
           output_tokens = $14,
           model_calls = $15,
           tool_calls = $16,
           finished_at = now()
       from claimed c, matched m
       where r.id = c.id
       returning r.id
     ), ins as (
       insert into analyses (id, item_id, summary, topics, entities, insights, tags, model, run_id)
       select $17, $3, $18, $19::jsonb, $20::jsonb, $21, $22::jsonb, $10, updated.id
       from updated
       returning id
     )
     update items set pipeline_status = 'analyzed'
     where id = $3 and exists (select 1 from ins)
     returning (select id from ins) as analysis_id`,
    [
      input.runId, input.claimToken, input.itemId, input.title, input.body, input.author, input.url, input.platform,
      JSON.stringify(input.responseJson), input.model, input.promptVersion, JSON.stringify(input.skillVersions),
      input.inputTokens, input.outputTokens, input.modelCalls, input.toolCalls,
      input.analysisId, input.summary, JSON.stringify(input.topics), JSON.stringify(input.entities),
      input.insights, JSON.stringify(input.tags),
    ],
  );
  if (rows.length === 1) return "ok";
  const [run] = await sql.query<{ status: string }>("select status from ai_runs where id = $1", [input.runId]);
  if (run?.status === "running") return "input_changed";
  return "persist_failed";
}

export async function finishNoteAtomically(sql: Queryable, input: {
  runId: string;
  claimToken: string;
  noteId: string;
  title: string;
  content: string;
  kind: "briefing" | "answer";
  itemIds: string[];
  model: string;
  promptVersion: string;
  skillVersions: Record<string, string>;
  responseJson: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  modelCalls: number;
  toolCalls: number;
}): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `with claimed as (
       select id from ai_runs
       where id = $1 and status = 'running' and claim_token = $2 and expires_at > now()
     ), updated as (
       update ai_runs r
       set status = 'succeeded',
           response_json = $3::jsonb,
           model = $4,
           prompt_version = $5,
           skill_versions = $6::jsonb,
           input_tokens = $7,
           output_tokens = $8,
           model_calls = $9,
           tool_calls = $10,
           finished_at = now()
       from claimed c
       where r.id = c.id
       returning r.id
     )
     insert into knowledge_notes (id, title, content, kind, item_ids, run_id)
     select $11, $12, $13, $14, $15::jsonb, updated.id
     from updated
     returning id`,
    [
      input.runId, input.claimToken, JSON.stringify(input.responseJson), input.model, input.promptVersion,
      JSON.stringify(input.skillVersions), input.inputTokens, input.outputTokens, input.modelCalls, input.toolCalls,
      input.noteId, input.title, input.content, input.kind, JSON.stringify(input.itemIds),
    ],
  );
  return rows.length === 1;
}
