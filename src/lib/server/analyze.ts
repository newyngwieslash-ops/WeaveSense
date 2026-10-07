import { executeLegacyOutput, modelCallFailure, type ChatFailure } from "./legacy-output.ts";
import { mapAgentItem as mapItem } from "./agent-retrieval.ts";
import { retrieveAgentItems } from "./agent-retrieval.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { hashRunToken } from "./agent-data.ts";
import { shortId } from "../utils.ts";
import type { AskResult } from "../types.ts";
import type { PlatformId } from "../platforms.ts";
import type { ExecuteRequest, ExecuteResponse } from "../agent-contract.ts";
import { parseExecuteResponse } from "../agent-contract.ts";
import { AgentClientError, agentClientConfig, executeAgent } from "./agent-client.ts";
import {
  evidenceMap,
  runtimeSources,
  materialFingerprint,
  rankRetrievedItems,
  selectAnalyzeSources,
  selectBriefingSources,
  selectResearchSeeds,
  shanghaiDayRange,
  splitQueryTerms,
  validateCitations,
  type EvidenceSource,
} from "./agent-context.ts";
import { enqueueResearchJob } from "./agent-queue.ts";
import { researchGovernanceFromEnv, researchIntentHash } from "./agent-research-policy.ts";
import { beginRun, failRun, finishAnalyzeAtomically, finishNoteAtomically, getRunByRequest, hashCanonical, receiptsForRun, type AgentProvider } from "./agent-runs.ts";
import type { ItemRow } from "../types.ts";
import { isPlatform } from "../platforms.ts";

import { readModelConfig } from "./model-config.ts";
const POLICY_VERSION = "loom-agent-v1";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type ExecuteFn = (request: ExecuteRequest) => Promise<ExecuteResponse>;

type OpError = { ok: false; error: string; error_code?: string; run_id?: string };

function todayShanghai(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function engineFromEnv(): AgentProvider {
  const value = (process.env.AI_ENGINE ?? "legacy").trim();
  if (value === "eino" || value === "legacy") return value;
  throw new Error("agent_unconfigured");
}

async function chat(system: string, user: string, maxTokens: number, config: ReturnType<typeof readModelConfig>, timeoutMs: number): Promise<
  { ok: true; text: string; model: string; input_tokens: number | null; output_tokens: number | null } | ChatFailure
> {
  const { apiKey, baseURL, model } = config;
  if (!apiKey) return { ok: false, error: "当前环境未启用 AI 分析" };
  let res: Response;
  try { res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature: 0.3,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }); } catch (error) { return { ...modelCallFailure(error, 'request'), model }; }
  if (!res.ok) { await res.body?.cancel(); return { ok: false, model, stage: 'response', code: 'model_http_error', error: `模型网关返回 HTTP ${res.status}` }; }
  let body: unknown;
  try { body = await res.json(); } catch (error) { return { ...modelCallFailure(error, 'response'), model }; }
  const typed = body as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;
  const content = typed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return { ...modelCallFailure(null, 'response'), model };
  const text = content.trim();
  // T21-b: the gateway reports usage on every completion; carry it up so the run
  // ledger records real numbers (it was previously discarded here and the runtime
  // hard-coded null, which made spend unreconcilable).
  const promptTokens = typed?.usage?.prompt_tokens;
  const completionTokens = typed?.usage?.completion_tokens;
  return {
    ok: true, text, model,
    input_tokens: typeof promptTokens === 'number' ? promptTokens : null,
    output_tokens: typeof completionTokens === 'number' ? completionTokens : null,
  };
}

/**
 * How long a single synchronous model call may take.
 *
 * T21 measured the real gateway: successful analyses finished in 31–32 s and
 * three of five attempts hit the old 40 s ceiling, so the limit sat exactly on
 * top of the normal completion time — a coin flip on whether a run produced an
 * answer or a `model_timeout`, with the request already paid for either way.
 *
 * 120 s gives ~4x headroom over the observed success time while still bounding a
 * hung request. This is the native single-call limit; the Agent has separate
 * configured model, execution and HTTP deadlines.
 */
const MODEL_CALL_TIMEOUT_SECONDS = 120;
const MODEL_CALL_TIMEOUT_MS = MODEL_CALL_TIMEOUT_SECONDS * 1_000;

/**
 * How long a run may stay open before `completeRun` refuses to write it.
 *
 * The lease exists to reap ABANDONED runs, so it must be strictly longer than the
 * work a run is allowed to do — otherwise a slow-but-successful call is thrown
 * away after the money is spent. T21 observed exactly that: two analyses took
 * 58.5 s and 61.7 s against the previous flat 60 s lease and both failed to
 * persist, while the 25 s one succeeded.
 *
 * Derived from the call budget rather than hard-coded, so raising the per-call
 * timeout (or a mode's call count) cannot silently reintroduce the mismatch:
 * `maxModelCalls * MODEL_CALL_TIMEOUT` plus a fixed margin for the write itself.
 */
function runLeaseIso(maxModelCalls: number): string {
  const budget = Math.max(1, maxModelCalls) * MODEL_CALL_TIMEOUT_MS;
  return new Date(Date.now() + budget + 60_000).toISOString();
}

function deadline(seconds = MODEL_CALL_TIMEOUT_SECONDS): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function buildRequest(mode: ExecuteRequest["mode"], sources: EvidenceSource[], extra: {
  question?: string; range?: { from: string; to: string } | null; maxModelCalls: number; maxToolCalls: number; maxOutput: number; dataAccessToken?: string;
}): ExecuteRequest {
  return {
    schema_version: 1,
    run_id: randomUUID(),
    mode,
    input: {
      question: extra.question ?? "",
      sources: runtimeSources(sources),
      range: extra.range ?? null,
    },
    policy: {
      version: POLICY_VERSION,
      deadline_at: deadline(),
      max_model_calls: extra.maxModelCalls,
      max_tool_calls: extra.maxToolCalls,
      max_output_tokens_per_call: extra.maxOutput,
    },
    data_access_token: extra.dataAccessToken ?? randomBytes(32).toString("hex"),
  };
}

async function runEngine(request: ExecuteRequest, engine: AgentProvider, execute?: ExecuteFn): Promise<ExecuteResponse> {
  if (execute) {
    const response = await execute(request);
    const parsed = parseExecuteResponse(JSON.stringify(response), request.mode);
    if (!parsed.ok || parsed.value.run_id !== request.run_id) return { schema_version:1,run_id:request.run_id,ok:false,error:{code:"invalid_output",message:"invalid_output",retryable:false,outcome_unknown:false} };
    return parsed.value;
  }
  if (engine === "legacy") {
    let config: ReturnType<typeof readModelConfig>;
    try { config = readModelConfig(); } catch {
      return { schema_version: 1, run_id: request.run_id, ok: false, error: { code: "agent_unconfigured", message: "模型配置无效，请检查服务端配置文件", retryable: false, outcome_unknown: false } };
    }
    return executeLegacyOutput(request, (system, user, tokens) => chat(system, user, tokens, config,
      Math.max(1, Math.min(MODEL_CALL_TIMEOUT_MS, Date.parse(request.policy.deadline_at) - Date.now()))));
  }
  try {
    return await executeAgent(request, agentClientConfig());
  } catch (error) {
    const code = error instanceof AgentClientError ? error.code : "agent_unavailable";
    return { schema_version: 1, run_id: request.run_id, ok: false, error: { code, message: code, retryable: false, outcome_unknown: code === "model_timeout" } };
  }
}

function fail(error: string, extra: { error_code?: string; run_id?: string } = {}): OpError {
  return { ok: false, error, ...extra };
}

export async function analyzeItemWith(opts: {
  sql: Queryable; itemId: string; requestId?: string; engine?: AgentProvider; execute?: ExecuteFn;
  job?: { id: string; claim_token: string; material_hash: string };
}): Promise<{ ok: true; id: string; run_id?: string } | OpError> {
  const engine = opts.engine ?? engineFromEnv();
  const requestId = opts.requestId ?? randomUUID();
  const inputHash = hashCanonical({ mode: "analyze_item", item_id: opts.itemId });
  const existing = await getRunByRequest(opts.sql, requestId);
  if (existing) {
    const begun = await beginRun(opts.sql, {
      id: existing.id, requestId, mode: "analyze_item", provider: engine,
      inputHash, materialHash: existing.material_hash, policyVersion: POLICY_VERSION,
      requestJson: existing.request_json, claimToken: existing.claim_token, expiresAt: existing.expires_at,
    });
    if (begun.kind === "replay") {
      const saved = begun.responseJson as { analysis_id?: string };
      return { ok: true, id: String(saved.analysis_id ?? begun.run.id), run_id: begun.run.id };
    }
    if (begun.kind === "in_progress") return fail("任务仍在执行", { error_code: "run_in_progress", run_id: begun.run.id });
    if (begun.kind === "conflict") return fail("请求冲突", { error_code: "request_conflict", run_id: begun.run.id });
    if (begun.kind === "failed") return fail("上次执行已失败，请重新分析", { error_code: begun.run.error_code || "failed", run_id: begun.run.id });
  }
  const [raw] = await opts.sql.query<Record<string, unknown>>(
    `select i.*, s.name as source_name,
      exists(select 1 from extract_jobs e where e.item_id=i.id and e.status<>'ok') as extraction_pending
      from items i join sources s on s.id = i.source_id where i.id = $1`,
    [opts.itemId],
  );
  if (!raw) return fail("内容不存在", { error_code: "invalid_request" });
  const item = mapItem(raw);
  if (raw.extraction_pending || (item.pipeline_status === "ingested" && !["article","text"].includes(item.media_type))) return fail("材料提取尚未完成", { error_code:"material_incomplete" });
  const selected = selectAnalyzeSources(item);
  if (opts.job && selected.materialHash !== opts.job.material_hash) return fail("原文已变化", { error_code: "input_changed" });
  if (selected.sources.length === 0) return fail("没有可分析的正文", { error_code: "invalid_request" });
  const request = buildRequest("analyze_item", selected.sources, { maxModelCalls: 2, maxToolCalls: 1, maxOutput: 1200 });
  const begun = await beginRun(opts.sql, {
    id: request.run_id, requestId, mode: "analyze_item", provider: engine,
    inputHash, materialHash: selected.materialHash, policyVersion: POLICY_VERSION,
    requestJson: { mode: "analyze_item", item_id: item.id, sources: selected.sources, warnings: selected.warnings, provider: engine, policy: request.policy, range: null },
    jobId: opts.job?.id,
    dataTokenHash: hashRunToken(request.data_access_token!),
    claimToken: opts.job?.claim_token ?? randomUUID(),
    // Lease follows the call budget: a 2-call analysis may legitimately take up to
    // 2 x 120 s, and the row must survive long enough to be written.
    expiresAt: runLeaseIso(request.policy.max_model_calls),
  });
  if (begun.kind === "replay") {
    const saved = begun.responseJson as { analysis_id?: string };
    return { ok: true, id: String(saved.analysis_id ?? begun.run.id), run_id: begun.run.id };
  }
  if (begun.kind === "in_progress") return fail("任务仍在执行", { error_code: "run_in_progress", run_id: begun.run.id });
  if (begun.kind === "conflict") return fail("请求冲突", { error_code: "request_conflict", run_id: begun.run.id });
  if (begun.kind === "failed") return fail("上次执行已失败，请重新分析", { error_code: begun.run.error_code || "failed", run_id: begun.run.id });

  let executed: ExecuteResponse;
  try {
    executed = await runEngine(request, engine, opts.execute);
  } catch {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "outcome_unknown" });
    return fail("分析失败", { error_code: "outcome_unknown", run_id: begun.run.id });
  }
  if (!executed.ok || !executed.result?.analysis) {
    const code = executed.ok ? "invalid_output" : executed.error.code;
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: code, responseJson: executed, ...(!executed.ok && executed.error.outcome_unknown ? { status: "outcome_unknown" as const } : {}) });
    return fail(executed.ok ? "模型输出无效" : executed.error.message, { error_code: code, run_id: begun.run.id });
  }
  const citations = validateCitations(executed.result.citations, evidenceMap(selected.sources));
  if (!citations.ok) {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "invalid_citation" });
    return fail("引用无效", { error_code: "invalid_citation", run_id: begun.run.id });
  }
  const analysisId = shortId();
  const persist = await finishAnalyzeAtomically(opts.sql, {
    runId: begun.run.id, claimToken: begun.run.claim_token, itemId: item.id,
    title: item.title, body: item.body, author: item.author, url: item.url, platform: item.platform,
    sourceName: item.source_name ?? "", publishedAt: item.published_at, materialHash: selected.materialHash,
    analysisId, summary: executed.result.analysis.summary, topics: executed.result.analysis.topics,
    entities: executed.result.analysis.entities, insights: executed.result.analysis.insights,
    tags: executed.result.analysis.tags, model: executed.runtime.model,
    promptVersion: executed.runtime.prompt_version, skillVersions: executed.runtime.skill_versions,
    responseJson: { ...executed, analysis_id: analysisId, verified_evidence: [...evidenceMap(selected.sources).values()] },
    inputTokens: executed.runtime.input_tokens, outputTokens: executed.runtime.output_tokens,
    modelCalls: executed.runtime.model_calls, toolCalls: executed.runtime.tool_calls,
  });
  if (persist === "input_changed") {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "input_changed" });
    return fail("原文已变化", { error_code: "input_changed", run_id: begun.run.id });
  }
  if (persist !== "ok") {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "persist_failed" });
    return fail("结果未保存", { error_code: "persist_failed", run_id: begun.run.id });
  }
  return { ok: true, id: analysisId, run_id: begun.run.id };
}

export async function generateBriefingWith(opts: {
  sql: Queryable; requestId?: string; from?: string; to?: string; engine?: AgentProvider; execute?: ExecuteFn;
}): Promise<{ ok: true; id: string; title: string; run_id?: string } | OpError> {
  const engine = opts.engine ?? engineFromEnv();
  const requestId = opts.requestId ?? randomUUID();
  if (opts.requestId) {
    const existing = await getRunByRequest(opts.sql, requestId);
    if (existing) {
      const savedRange = existing.request_json && typeof existing.request_json === "object"
        ? (existing.request_json as { range?: { from?: string; to?: string } }).range
        : undefined;
      const inputHash = hashCanonical({ mode: "briefing", intent: opts.from ? { from: opts.from, to: opts.to } : "today" });
      const begun = await beginRun(opts.sql, {
        id: existing.id, requestId, mode: "briefing", provider: engine,
        inputHash, materialHash: existing.material_hash, policyVersion: POLICY_VERSION,
        requestJson: existing.request_json, claimToken: existing.claim_token, expiresAt: existing.expires_at,
      });
      if (begun.kind === "replay") {
        const saved = begun.responseJson as { note_id?: string; title?: string };
        return { ok: true, id: String(saved.note_id ?? begun.run.id), title: String(saved.title ?? ""), run_id: begun.run.id };
      }
      if (begun.kind === "in_progress") return fail("任务仍在执行", { error_code: "run_in_progress", run_id: begun.run.id });
      if (begun.kind === "conflict") return fail("请求冲突", { error_code: "request_conflict", run_id: begun.run.id });
      if (begun.kind === "failed") return fail("上次执行已失败", { error_code: begun.run.error_code || "failed", run_id: begun.run.id });
      void savedRange;
    }
  }
  const range = opts.from && opts.to ? { from: opts.from, to: opts.to } : shanghaiDayRange(todayShanghai());
  const rows = await opts.sql.query<Record<string, unknown>>(
    `select i.*, s.name as source_name from items i join sources s on s.id = i.source_id
     where coalesce(i.published_at, i.collected_at) >= $1::timestamptz
       and coalesce(i.published_at, i.collected_at) < $2::timestamptz
     order by coalesce(i.published_at, i.collected_at) desc limit 12`,
    [range.from, range.to],
  );
  const selected = selectBriefingSources(rows.map(mapItem), range);
  if (!selected.ok) return fail("日期范围无效", { error_code: selected.error });
  if (selected.sources.length === 0) return fail("该时间范围暂无材料", { error_code: "insufficient_evidence" });
  const inputHash = hashCanonical({ mode: "briefing", intent: opts.from ? { from: opts.from, to: opts.to } : "today" });
  const request = buildRequest("briefing", selected.sources, { range, maxModelCalls: 2, maxToolCalls: 1, maxOutput: 1800 });
  const begun = await beginRun(opts.sql, {
    id: request.run_id, requestId, mode: "briefing", provider: engine,
    inputHash, materialHash: selected.materialHash, policyVersion: POLICY_VERSION,
    requestJson: { mode: "briefing", range, sources: selected.sources, provider: engine, policy: request.policy, intent: opts.from ? { from: opts.from, to: opts.to } : "today" },
    dataTokenHash: hashRunToken(request.data_access_token!),
    claimToken: randomUUID(), expiresAt: runLeaseIso(request.policy.max_model_calls),
  });
  if (begun.kind === "replay") {
    const saved = begun.responseJson as { note_id?: string; title?: string };
    return { ok: true, id: String(saved.note_id ?? begun.run.id), title: String(saved.title ?? ""), run_id: begun.run.id };
  }
  if (begun.kind !== "won") return fail("无法开始简报", { error_code: begun.kind, run_id: begun.run.id });
  let executed: ExecuteResponse;
  try {
    executed = await runEngine(request, engine, opts.execute);
  } catch {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "outcome_unknown" });
    return fail("简报生成失败", { error_code: "outcome_unknown", run_id: begun.run.id });
  }
  if (!executed.ok || !executed.result?.content) {
    const code = executed.ok ? "invalid_output" : executed.error.code;
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: code, responseJson: executed, ...(!executed.ok && executed.error.outcome_unknown ? { status: "outcome_unknown" as const } : {}) });
    return fail("简报生成失败", { error_code: code, run_id: begun.run.id });
  }
  const citations = validateCitations(executed.result.citations, evidenceMap(selected.sources));
  if (!citations.ok) {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "invalid_citation" });
    return fail("引用无效", { error_code: "invalid_citation", run_id: begun.run.id });
  }
  const noteId = shortId();
  const title = executed.result.title || `行业简报 · ${todayShanghai()}`;
  const saved = await finishNoteAtomically(opts.sql, {
    runId: begun.run.id, claimToken: begun.run.claim_token, noteId, title, content: executed.result.content,
    kind: "briefing", itemIds: [...new Set(executed.result.citations.map((c) => {
      const src = selected.sources.find((s) => s.evidence_id === c.evidence_id);
      return src?.item_id ?? "";
    }).filter(Boolean))],
    model: executed.runtime.model, promptVersion: executed.runtime.prompt_version, skillVersions: executed.runtime.skill_versions,
    responseJson: { ...executed, note_id: noteId, title, verified_evidence: [...evidenceMap(selected.sources).values()] },
    inputTokens: executed.runtime.input_tokens, outputTokens: executed.runtime.output_tokens,
    modelCalls: executed.runtime.model_calls, toolCalls: executed.runtime.tool_calls,
  });
  if (!saved) return fail("结果未保存", { error_code: "persist_failed", run_id: begun.run.id });
  return { ok: true, id: noteId, title, run_id: begun.run.id };
}

export async function askKnowledgeWith(opts: {
  sql: Queryable; question: string; requestId?: string; engine?: AgentProvider; execute?: ExecuteFn; async?: boolean;
}): Promise<AskResult & { error_code?: string; run_id?: string }> {
  const engine = opts.engine ?? engineFromEnv();
  const q = opts.question.trim();
  if (Array.from(q).length < 2) return { ok: false, error: "请输入问题", error_code: "invalid_request" };
  const requestId = opts.requestId ?? randomUUID();
  const inputHash = hashCanonical({ mode: "research", question: q });
  if (opts.requestId) {
    const existing = await getRunByRequest(opts.sql, requestId);
    if (existing) {
      const snapshot = existing.request_json as Record<string, unknown>;
      const begun = await beginRun(opts.sql, {
        id: existing.id, requestId, mode: "research", provider: opts.async && snapshot.governed ? existing.provider : engine,
        inputHash: researchIntentHash(snapshot, q), materialHash: existing.material_hash, policyVersion: POLICY_VERSION,
        requestJson: existing.request_json, claimToken: existing.claim_token, expiresAt: existing.expires_at,
      });
      if (begun.kind === "replay") {
        const saved = begun.responseJson as { note_id?: string; answer?: string; citations?: AskResult["citations"]; external_citations?: AskResult["external_citations"] };
        return { ok: true, answer: saved.answer, note_id: saved.note_id, citations: saved.citations, external_citations: saved.external_citations, run_id: begun.run.id };
      }
      if (begun.kind === "in_progress") return { ok: false, error: "任务仍在执行", error_code: "run_in_progress", run_id: begun.run.id, citations: [] };
      if (begun.kind === "conflict") return { ok: false, error: "请求冲突", error_code: "request_conflict", run_id: begun.run.id, citations: [] };
      if (begun.kind === "failed") {
        return { ok: false, error: "上次执行已失败", error_code: begun.run.error_code || "failed", run_id: begun.run.id, citations: [] };
      }
    }
  }
  if (opts.async && opts.requestId) {
    const [queued] = await opts.sql.query<{ id: string; payload: Record<string, unknown>; status: string }>("select id,payload,status from ai_jobs where request_id=$1",[requestId]);
    if (queued) {
      if (queued.payload.question !== q || (!queued.payload.governed && queued.payload.provider !== engine)) return { ok:false,error:"请求冲突",error_code:"request_conflict" };
      return { ok:true,pending:true,job_id:queued.id,citations:[] };
    }
  }
  const retrieved = await retrieveAgentItems(opts.sql, q);
  const selected = selectResearchSeeds(retrieved.items, q);
  if (selected.sources.length === 0) {
    return { ok: false, error: "材料不足", error_code: "insufficient_evidence", citations: [] };
  }
  if (opts.async) {
    let governance: ReturnType<typeof researchGovernanceFromEnv>;
    try { governance = researchGovernanceFromEnv(q); }
    catch { return { ok: false, error: "深入研究的模型定价或规则快照尚未配置", error_code: "capability_unavailable", citations: [] }; }
    const job = await enqueueResearchJob(opts.sql, {
      question: q, requestId, materialHash: selected.materialHash,
      snapshot: { ...governance, sources: selected.sources, range: null, scope: "corpus" },
    });
    if (!job) return { ok: false, error: "无法排队问答", error_code: "persist_failed" };
    if (job.kind === "conflict") return { ok: false, error: "请求冲突", error_code: "request_conflict", citations: [] };
    if (job.kind === "replay" && job.status === "running") return { ok: false, error: "任务仍在执行", error_code: "run_in_progress", citations: [] };
    return { ok: true, pending: true, job_id: job.id, error_code: "queued", citations: [] };
  }
  const dataAccessToken = randomBytes(32).toString("hex");
  const request = buildRequest("research", selected.sources, {
    question: q, maxModelCalls: 6, maxToolCalls: 4, maxOutput: 1800, dataAccessToken,
  });
  const begun = await beginRun(opts.sql, {
    id: request.run_id, requestId, mode: "research", provider: engine,
    inputHash, materialHash: selected.materialHash, policyVersion: POLICY_VERSION,
    requestJson: { mode: "research", question: q, sources: selected.sources, provider: engine, policy: request.policy, range: null, scope: "corpus" },
    claimToken: randomUUID(), expiresAt: runLeaseIso(request.policy.max_model_calls),
    dataTokenHash: hashRunToken(dataAccessToken),
  });
  if (begun.kind === "replay") {
    const saved = begun.responseJson as { note_id?: string; answer?: string; citations?: AskResult["citations"]; external_citations?: AskResult["external_citations"] };
    return { ok: true, answer: saved.answer, note_id: saved.note_id, citations: saved.citations, external_citations: saved.external_citations, run_id: begun.run.id };
  }
  if (begun.kind !== "won") return { ok: false, error: "无法开始问答", error_code: begun.kind, run_id: begun.run.id };
  let executed: ExecuteResponse;
  try {
    executed = await runEngine(request, engine, opts.execute);
  } catch {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "outcome_unknown" });
    return { ok: false, error: "问答失败", error_code: "outcome_unknown", run_id: begun.run.id, citations: [] };
  }
  if (!executed.ok || !executed.result?.content) {
    const code = executed.ok ? "invalid_output" : executed.error.code;
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: code, responseJson: executed, ...(!executed.ok && executed.error.outcome_unknown ? { status: "outcome_unknown" as const } : {}) });
    return { ok: false, error: "问答失败", error_code: code, run_id: begun.run.id, citations: [] };
  }
  const receipts = await receiptsForRun(opts.sql, begun.run.id);
  const allowed = new Map([...evidenceMap(selected.sources), ...receipts]);
  const citations = validateCitations(executed.result.citations, allowed);
  if (!citations.ok) {
    await failRun(opts.sql, { id: begun.run.id, claimToken: begun.run.claim_token, errorCode: "invalid_citation" });
    return { ok: false, error: "引用无效", error_code: "invalid_citation", run_id: begun.run.id, citations: [] };
  }
  const citationItems = citations.citations.flatMap((c) => {
    const src = selected.sources.find((s) => s.evidence_id === c.evidence_id);
    if (src) return [{ id: src.item_id, title: src.title, platform: src.platform as PlatformId }];
    const receipt = receipts.get(c.evidence_id);
    return receipt?.item_id ? [{ id: receipt.item_id, title: receipt.title ?? "来源", platform: (isPlatform(receipt.platform ?? "") ? receipt.platform : "rss") as PlatformId }] : [];
  });
  const publicCitations = [...new Map(citationItems.map(c=>[c.id,c])).values()];
  const noteId = shortId();
  const saved = await finishNoteAtomically(opts.sql, {
    runId: begun.run.id, claimToken: begun.run.claim_token, noteId, title: q.slice(0, 80),
    content: executed.result.content, kind: "answer",
    itemIds: [...new Set(publicCitations.map((c) => c.id))],
    model: executed.runtime.model, promptVersion: executed.runtime.prompt_version, skillVersions: executed.runtime.skill_versions,
    responseJson: { ...executed, note_id: noteId, answer: executed.result.content, citations: publicCitations,
      external_citations: citations.citations.flatMap(c => { const r=receipts.get(c.evidence_id); return r?.origin === 'mcp' ? [{title:r.title??'外部服务',url:r.url??'',quote:c.quote}] : []; }), verified_evidence: [...allowed.values()] },
    inputTokens: executed.runtime.input_tokens, outputTokens: executed.runtime.output_tokens,
    modelCalls: executed.runtime.model_calls, toolCalls: executed.runtime.tool_calls,
  });
  if (!saved) return { ok: false, error: "结果未保存", error_code: "persist_failed", run_id: begun.run.id };
  return { ok: true, answer: executed.result.content, note_id: noteId, citations: publicCitations,
    external_citations: citations.citations.flatMap(c => { const r=receipts.get(c.evidence_id); return r?.origin === 'mcp' ? [{title:r.title??'外部服务',url:r.url??'',quote:c.quote}] : []; }), run_id: begun.run.id };
}

export const materialHashForTests = materialFingerprint;
