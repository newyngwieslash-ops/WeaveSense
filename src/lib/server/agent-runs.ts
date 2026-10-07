import { completeRun } from "./agent-completion.ts";
import { agentTransaction } from "./agent-transaction.ts";
import { codePoints, evidenceIdFor, materialFingerprint, type EvidenceReceipt } from "./agent-context.ts";
import { mapAgentItem } from "./agent-retrieval.ts";
import type { ItemRow } from "../types.ts";
import { createHash } from "node:crypto";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export type AgentMode = "analyze_item" | "briefing" | "research";
export type AgentProvider = "legacy" | "eino" | "opencode";
export type AgentRunStatus = "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "outcome_unknown";

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
  jobId?: string;
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
  const response = asJson(row.response_json);
  if (response && typeof response === "object") delete (response as Record<string, unknown>)._completion;
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
    response_json: response,
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

export async function getRunByRequest(sql: Queryable, requestId: string): Promise<AgentRunRow | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    "select * from ai_runs where request_id = $1",
    [requestId],
  );
  return row ? mapRun(row) : null;
}

export async function convergeExpiredRun(sql: Queryable, id: string): Promise<AgentRunRow | null> {
  const run = await getRun(sql,id);
  if (!run || run.status !== "running") return run;
  await completeRun(sql,{runId:id,claimToken:run.claim_token,status:"timed_out",expired:true});
  return getRun(sql,id);
}

function classifyExisting(run: AgentRunRow, inputHash: string, input?: BeginRunInput): BeginRunResult {
  if (run.input_hash !== inputHash || (input && (run.mode !== input.mode || run.provider !== input.provider))) return { kind: "conflict", run };
  const requested = input?.requestJson as Record<string,unknown> | undefined;
  if (requested && ["scope","range","intent"].some(k => requested[k] !== undefined && hashCanonical(requested[k]) !== hashCanonical((run.request_json as Record<string,unknown>)?.[k] ?? null))) return {kind:"conflict",run};
  if (run.status === "succeeded") return { kind: "replay", run, responseJson: run.response_json };
  if (run.status === "running") return { kind: "in_progress", run };
  return { kind: "failed", run };
}

export async function beginRun(sql: Queryable, input: BeginRunInput): Promise<BeginRunResult> {
  if (input.jobId) return agentTransaction(sql, async tx => {
    const [job] = await tx.query<Record<string, any>>("select * from ai_jobs where id=$1 for update", [input.jobId]);
    const [clock] = await tx.query<{ now: Date }>("select clock_timestamp() as now");
    if (!job || job.status !== "running" || job.claim_token !== input.claimToken || !job.lease_until || new Date(job.lease_until) <= new Date(clock.now)
      || job.material_hash !== input.materialHash) throw new Error("stale_job");
    const begun = await beginRun(tx, { ...input, jobId: undefined });
    if (begun.kind !== "won") throw new Error("job_run_conflict");
    await tx.query("update ai_jobs set run_id=$2 where id=$1", [job.id,begun.run.id]);
    return begun;
  });
  const existingFirst = await getRunByRequest(sql, input.requestId);
  if (existingFirst) {
    if (existingFirst.status === "running" && Date.parse(existingFirst.expires_at) <= Date.now()) {
      const expired = await convergeExpiredRun(sql, existingFirst.id);
      return classifyExisting(expired ?? existingFirst, input.inputHash, input);
    }
    return classifyExisting(existingFirst, input.inputHash, input);
  }

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
  if (existing.status === "running" && Date.parse(existing.expires_at) <= Date.now()) {
    const expired = await convergeExpiredRun(sql, existing.id);
    return classifyExisting(expired ?? existing, input.inputHash, input);
  }
  return classifyExisting(existing, input.inputHash, input);
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
  return (await completeRun(sql, { ...input, runId: input.id, status: "succeeded" })).ok;
}

export async function failRun(sql: Queryable, input: {
  id: string;
  claimToken: string;
  errorCode: string;
  status?: Exclude<AgentRunStatus, "running" | "succeeded">;
  responseJson?: unknown;
}): Promise<boolean> {
  const runtime = (input.responseJson as { runtime?: Record<string, any> } | undefined)?.runtime;
  return (await completeRun(sql, { ...input, runId: input.id,
    model: runtime?.model, promptVersion: runtime?.prompt_version, skillVersions: runtime?.skill_versions,
    inputTokens: runtime?.input_tokens, outputTokens: runtime?.output_tokens, modelCalls: runtime?.model_calls, toolCalls: runtime?.tool_calls,
    status: input.status ?? (["outcome_unknown", "model_timeout"].includes(input.errorCode) ? "outcome_unknown" : "failed") })).ok;
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
  sourceName: string;
  publishedAt?: string | null;
  materialHash?: string;
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
  const result = await completeRun(sql, {
    ...input, status: "succeeded",
    validate: async tx => {
      const [item] = await tx.query<Record<string, any>>("select * from items where id=$1 for update", [input.itemId]);
      if (!item) return "input_changed";
      const [source] = await tx.query<{ name: string }>("select name from sources where id=$1 for update", [item.source_id]);
      const current = { ...item, source_name: source?.name ?? "", published_at: item.published_at ? new Date(item.published_at).toISOString() : null } as ItemRow;
      if (input.materialHash) return materialFingerprint(current) === input.materialHash ? null : "input_changed";
      return item.title === input.title && item.body === input.body && item.author === input.author && item.url === input.url
        && item.platform === input.platform && source?.name === input.sourceName
        && (input.publishedAt === undefined || current.published_at === input.publishedAt) ? null : "input_changed";
    },
    write: async tx => {
      await tx.query(`insert into analyses (id,item_id,summary,topics,entities,insights,tags,model,run_id)
        values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9)`,
        [input.analysisId,input.itemId,input.summary,JSON.stringify(input.topics),JSON.stringify(input.entities),input.insights,JSON.stringify(input.tags),input.model,input.runId]);
      await tx.query("update items set pipeline_status='analyzed' where id=$1", [input.itemId]);
      return { analysis_id: input.analysisId };
    },
  });
  return result.ok ? "ok" : result.error === "input_changed" ? "input_changed" : "persist_failed";
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
  return (await completeRun(sql, { ...input, status: "succeeded", write: async tx => {
    await tx.query(`insert into knowledge_notes (id,title,content,kind,item_ids,run_id) values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [input.noteId,input.title,input.content,input.kind,JSON.stringify(input.itemIds),input.runId]);
    return { note_id: input.noteId };
  } })).ok;
}

export async function receiptsForRun(sql: Queryable, runId: string): Promise<Map<string, EvidenceReceipt>> {
  const [run] = await sql.query<{ events_json: unknown }>("select events_json from ai_runs where id = $1", [runId]);
  const events = Array.isArray(run?.events_json) ? run.events_json as Record<string, unknown>[] : [];
  const map = new Map<string, EvidenceReceipt>();
  for (const event of events) {
    if (event.type !== "evidence") continue;
    const id = String(event.evidence_id ?? "");
    if (!id) continue;
    const receipt: EvidenceReceipt = {
      evidence_id: id,
      item_id: event.item_id == null ? null : String(event.item_id),
      text: String(event.text ?? ""),
      origin: event.origin === "mcp" ? "mcp" : "internal",
      title: String(event.title ?? event.tool ?? "来源"), url: String(event.url ?? ""), platform: String(event.platform ?? ""), source_name: String(event.source_name ?? ""),
    };
    // Historical receipts stay historical: never invent a revision or scope.
    for (const key of ["published_at", "start", "end", "coverage", "material_fingerprint", "material_version", "authorized_range"] as const) {
      if (Object.hasOwn(event, key)) Object.assign(receipt, { [key]: event[key] });
    }
    map.set(id, receipt);
  }
  return map;
}

/** Call inside the publication transaction, after locking the job/run. */
export async function validateEvidenceSnapshot(sql: Queryable, evidence: readonly EvidenceReceipt[]): Promise<{ ok: true } | { ok: false; error: string }> {
  if (new Set(evidence.map(row => row.evidence_id)).size !== evidence.length) return { ok: false, error: "invalid_evidence_snapshot" };
  for (const row of evidence) {
    if (row.origin !== "internal" || typeof row.item_id !== "string" || !row.item_id || typeof row.text !== "string" ||
      typeof row.material_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.material_fingerprint) ||
      !Number.isSafeInteger(row.material_version) || row.material_version! < 0 ||
      !Number.isSafeInteger(row.start) || row.start! < 0 || !Number.isSafeInteger(row.end) || row.end! < row.start! ||
      !["full", "partial"].includes(row.coverage ?? "") ||
      [row.title, row.url, row.platform, row.source_name].some(value => typeof value !== "string") ||
      !Object.hasOwn(row, "published_at") || (row.published_at !== null && (typeof row.published_at !== "string" || !Number.isFinite(Date.parse(row.published_at)))) ||
      !Object.hasOwn(row, "authorized_range")) return { ok: false, error: "incomplete_evidence_metadata" };
    const range = row.authorized_range;
    if (range !== null && (!range || typeof range.from !== "string" || typeof range.to !== "string" ||
      !Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(range.to)) || Date.parse(range.from) >= Date.parse(range.to))) {
      return { ok: false, error: "incomplete_evidence_metadata" };
    }
  }
  if (evidence.length === 0) return { ok: true };
  // Keep one lock order across both synchronous and asynchronous publication.
  const itemIds = [...new Set(evidence.map(row => row.item_id!))].sort();
  const items = await sql.query<Record<string, unknown>>("select * from items where id=any($1::text[]) order by id for update", [itemIds]);
  if (items.length !== itemIds.length) return { ok: false, error: "input_changed" };
  const sourceIds = [...new Set(items.map(row => String(row.source_id)))].sort();
  const sources = await sql.query<{ id: string; name: string }>("select id,name from sources where id=any($1::text[]) order by id for update", [sourceIds]);
  if (sources.length !== sourceIds.length) return { ok: false, error: "input_changed" };
  const sourceNames = new Map(sources.map(row => [row.id, row.name]));
  const material = new Map(items.map(row => [String(row.id), mapAgentItem({ ...row, source_name: sourceNames.get(String(row.source_id)) })]));
  for (const row of evidence) {
    const item = material.get(row.item_id!)!;
    const chars = codePoints(item.body);
    const range = row.authorized_range;
    const at = Date.parse(item.published_at ?? item.collected_at);
    if (range && (!Number.isFinite(at) || at < Date.parse(range.from) || at >= Date.parse(range.to))) return { ok: false, error: "out_of_range" };
    if (row.material_fingerprint !== materialFingerprint(item) || row.material_version !== Number(item.material_version) ||
      row.end! > chars.length || row.text !== chars.slice(row.start, row.end).join("") ||
      row.coverage !== (row.start === 0 && row.end === chars.length ? "full" : "partial") ||
      row.evidence_id !== evidenceIdFor(item, row.start!, row.end!) ||
      row.title !== item.title || row.url !== item.url || row.platform !== item.platform ||
      row.source_name !== item.source_name || row.published_at !== item.published_at) return { ok: false, error: "input_changed" };
  }
  return { ok: true };
}

export async function appendEvidenceReceipt(sql: Queryable, input: {
  runId: string;
  receipt: Record<string, unknown>;
  maxEvents?: number;
}): Promise<"ok" | "budget_exceeded" | "not_running"> {
  const maxEvents = input.maxEvents ?? 64;
  const rows = await sql.query<{ n: number }>(
    `update ai_runs
     set events_json = coalesce(events_json, '[]'::jsonb) || $2::jsonb
     where id = $1
       and status = 'running'
       and expires_at > now()
       and jsonb_array_length(coalesce(events_json, '[]'::jsonb)) < $3
     returning jsonb_array_length(events_json) as n`,
    [input.runId, JSON.stringify([input.receipt]), maxEvents],
  );
  if (rows.length === 1) return "ok";
  const [run] = await sql.query<{ status: string; n: number }>(
    `select status, jsonb_array_length(coalesce(events_json, '[]'::jsonb)) as n from ai_runs where id = $1`,
    [input.runId],
  );
  if (!run || run.status !== "running") return "not_running";
  return "budget_exceeded";
}
