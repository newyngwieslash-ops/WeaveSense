import { mapAgentItem, retrieveAgentItems } from "./agent-retrieval.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { modelCallSchema, recordModelCall, admitGovernedModelCall } from "./agent-budget.ts";
import { z } from "zod";
import { agentTransaction, lockRun, ownsRun } from "./agent-transaction.ts";
import { materialFingerprint } from "./agent-context.ts";
import type { ItemRow } from "../types.ts";
import { appendEvidenceReceipt, getRun, hashCanonical } from "./agent-runs.ts";
import { TOOL_CODE_POINT_CAP, codePoints, evidenceSourceFor, rangePredicate, selectTextSegments } from "./agent-context.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
const toolIntentSchema = z.object({ call_id: z.uuid(), tool: z.enum(["search_items", "get_item"]),
  request_digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const corpusSearchSchema = z.object({ query: z.string().refine(s => Array.from(s).length >= 2 && Array.from(s).length <= 200), limit: z.number().int().min(1).max(8) }).strict();
const corpusGetSchema = z.object({ item_id: z.string().min(1).max(256), start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();

export type AgentDataAction = "search_items" | "get_item" | "get_analysis";

function tokenOk(got: string, want: string): boolean {
  if (!got || !want) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashRunToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function clip(text: string, cap = TOOL_CODE_POINT_CAP) {
  const segs = selectTextSegments(text, cap);
  return segs[0];
}

async function handleAgentDataInner(opts: {
  sql: Queryable;
  serviceToken: string;
  providedServiceToken: string;
  runToken: string;
  runId: string;
  action: string;
  params: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!tokenOk(opts.providedServiceToken, opts.serviceToken)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const run = await getRun(opts.sql, opts.runId);
  if (!run || run.status !== "running" || Date.parse(run.expires_at) <= Date.now()) {
    return { status: 403, body: { error: "run_not_active" } };
  }
  if (!run.data_token_hash || hashRunToken(opts.runToken) !== run.data_token_hash) {
    return { status: 403, body: { error: "unauthorized" } };
  }
  if (opts.action === "model_call") {
    const parsed = modelCallSchema.safeParse(opts.params);
    if (!parsed.success) return { status: 400, body: { error: "invalid_receipt" } };
    if ((run.request_json as Record<string, unknown>)?.governed) {
      const disposition = await admitGovernedModelCall(opts.sql, opts.runId, { role: "producer", tokenHash: hashRunToken(opts.runToken) }, parsed.data);
      return { status: disposition === "denied" ? 409 : 200, body: { ok: disposition !== "denied", disposition } };
    }
    const ok = await recordModelCall(opts.sql, opts.runId, hashRunToken(opts.runToken), parsed.data);
    return { status: ok ? 200 : 409, body: { ok } };
  }
  if (opts.action === "mcp_receipt" || opts.action === "mcp_start") {
    const parsed = z.object({ call_id: z.uuid(), result_index: z.number().int().min(0).max(31),
      tool: z.string().regex(/^mcp_[a-zA-Z0-9_]{1,120}$/), title: z.string().min(1).max(200),
      url: z.string().max(2000), text: z.string().min(1).max(16000),
    }).strict().safeParse(opts.params);
    if (!parsed.success) return { status: 400, body: { error: "invalid_receipt" } };
    const p = parsed.data;
    const allowed = (process.env.AGENT_MCP_ALLOWED_TOOLS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(p.tool)) return { status: 403, body: { error: "tool_denied" } };
    if (opts.action === "mcp_start") {
      const existing = (run.events_json as Record<string, unknown>[]).find(e => e.type === "tool_started" && e.call_id === p.call_id);
      if (existing) return { status: existing.tool === p.tool ? 200 : 409, body: { ok: existing.tool === p.tool } };
      const saved = await appendEvidenceReceipt(opts.sql,{runId:run.id,receipt:{type:"tool_started",call_id:p.call_id,tool:p.tool}});
      return { status:saved === "ok" ? 200 : 429,body:{ok:saved === "ok"} };
    }
    if (p.url) { try { if (!['https:', 'http:'].includes(new URL(p.url).protocol)) throw Error(); } catch { return { status: 400, body: { error: "invalid_url" } }; } }
    const id = `mcp:${hashCanonical({ run: run.id, call: p.call_id, result: p.result_index, text: p.text })}`;
    const receipt = { type: "evidence", evidence_id: id, item_id: null, origin: "mcp", ...p, material_hash: hashCanonical(p.text), received_at: new Date().toISOString() };
    const events = Array.isArray(run.events_json) ? run.events_json as Record<string, unknown>[] : [];
    if (!events.some(e => e.type === "tool_started" && e.call_id === p.call_id && e.tool === p.tool)) return { status: 409, body: { error: "call_not_started" } };
    const existing = events.find(e => e.call_id === p.call_id && e.result_index === p.result_index);
    if (existing) return existing.evidence_id === id && existing.title===p.title && existing.url===p.url && existing.tool===p.tool ? { status: 200, body: { evidence_id: id, text: p.text } } : { status: 409, body: { error: "receipt_conflict" } };
    const saved = await appendEvidenceReceipt(opts.sql, { runId: run.id, receipt });
    return saved === "ok" ? { status: 200, body: { evidence_id: id, text: p.text, title: p.title, url: p.url } } : { status: 429, body: { error: saved } };
  }
  const saved = (run.request_json ?? {}) as Record<string, unknown>;
  const range = (saved.range ?? null) as { from?: string; to?: string } | null;
  if (opts.action === "search_items") {
    const query = String(opts.params.query ?? "").trim();
    const limit = Math.min(8, Math.max(1, Number(opts.params.limit ?? 8) || 8));
    if (Array.from(query).length < 2 || Array.from(query).length > 200) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    const { items: rows } = await retrieveAgentItems(opts.sql, query, range?.from && range.to ? { from: range.from, to: range.to } : null, limit);
    const items = [];
    for (const row of rows) {
      const snippet = clip(String(row.body ?? ""), 400);
      const source = evidenceSourceFor(row, snippet, snippet.end < codePoints(row.body).length ? "partial" : "full", range?.from && range.to ? { from: range.from, to: range.to } : null);
      const receipt = { type: "evidence", origin: "internal", ...source };
      const appended = await appendEvidenceReceipt(opts.sql, { runId: opts.runId, receipt });
      if (appended !== "ok") return { status: 429, body: { error: "budget_exceeded" } };
      items.push({
        item_id: String(row.id), title: String(row.title ?? ""), platform: String(row.platform),
        source_name: String(row.source_name ?? ""), snippet: snippet.text, evidence_id: source.evidence_id,
      });
    }
    return { status: 200, body: { items } };
  }
  if (opts.action === "get_item") {
    const itemId = String(opts.params.item_id ?? "");
    if (!itemId) return { status: 400, body: { error: "invalid_request" } };
    const ranged = rangePredicate(range, 2);
    const [row] = await opts.sql.query<Record<string, unknown>>(
      `select i.*, s.name as source_name from items i join sources s on s.id = i.source_id
       where i.id = $1${ranged.sql}`,
      [itemId, ...ranged.params],
    );
    if (!row) return { status: 403, body: { error: "out_of_range" } };
    const start = opts.params.start ?? 0;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return { status: 400, body: { error: "invalid_request" } };
    const item = mapAgentItem(row);
    const chars = codePoints(item.body);
    if (start > chars.length) return { status: 400, body: { error: "invalid_request" } };
    const slice = chars.slice(start, start + TOOL_CODE_POINT_CAP);
    const text = slice.join("");
    const end = start + slice.length;
    const source = evidenceSourceFor(item, { start, end, text }, start > 0 || chars.length > end ? "partial" : "full", range?.from && range.to ? { from: range.from, to: range.to } : null);
    const appended = await appendEvidenceReceipt(opts.sql, {
      runId: opts.runId,
      receipt: { type: "evidence", origin: "internal", ...source },
    });
    if (appended !== "ok") return { status: 429, body: { error: "budget_exceeded" } };
    return { status: 200, body: { item_id: itemId, evidence_id: source.evidence_id, start, end, text, coverage: source.coverage } };
  }
  if (opts.action === "get_analysis") {
    const itemId = String(opts.params.item_id ?? "");
    const ranged = rangePredicate(range, 2);
    const [row] = await opts.sql.query<Record<string, unknown>>(
      `select a.*, r.material_hash as run_material_hash, r.id as source_run_id
       from analyses a
       join items i on i.id = a.item_id
       left join ai_runs r on r.id = a.run_id
       where a.item_id = $1${ranged.sql}
       order by a.created_at desc limit 1`,
      [itemId, ...ranged.params],
    );
    if (!row) return { status: 404, body: { error: "not_found" } };
    const [current] = await opts.sql.query<Record<string, any>>("select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id=$1", [itemId]);
    const fingerprint = current ? materialFingerprint({ ...current, published_at: current.published_at ? new Date(current.published_at).toISOString() : null } as ItemRow) : null;
    return { status: 200, body: {
      item_id: itemId, summary: String(row.summary ?? ""), run_id: row.source_run_id ? String(row.source_run_id) : null,
      stale: !fingerprint || row.run_material_hash !== fingerprint,
      topics: row.topics, insights: String(row.insights ?? ""),
    } };
  }
  return { status: 400, body: { error: "invalid_action" } };
}

export const agentDataHash = hashCanonical;

export async function handleAgentData(opts: Parameters<typeof handleAgentDataInner>[0]) {
  if (!tokenOk(opts.providedServiceToken, opts.serviceToken)) return { status: 401, body: { error: "unauthorized" } };
  return agentTransaction(opts.sql, async sql => {
    const locked = await lockRun(sql, opts.runId);
    if (!locked.run || locked.run.data_token_hash !== hashRunToken(opts.runToken) || !await ownsRun(sql, locked, locked.run.claim_token)) return { status: 403, body: { error: "run_not_active" } };
    if (locked.run.provider === "opencode") {
      if (!locked.run.request_json?.governed || locked.job?.payload?.cancel_requested) return { status: 403, body: { error: "run_not_active" } };
      if (opts.action === "model_call") return handleAgentDataInner({ ...opts, sql });
      if (opts.action === "tool_start" || opts.action === "tool_complete") {
        const schema = opts.action === "tool_start" ? toolIntentSchema : toolIntentSchema.extend({ result_digest: z.string().regex(/^[a-f0-9]{64}$/).optional() });
        const parsed = schema.safeParse(opts.params);
        if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
        const p = parsed.data;
        const [old] = await sql.query<Record<string, any>>("select * from ai_tool_calls where run_id=$1 and call_id=$2", [opts.runId, p.call_id]);
        if (old) {
          if (old.tool !== p.tool || old.request_digest !== p.request_digest ||
            ("result_digest" in p && p.result_digest !== undefined && p.result_digest !== old.result_digest)) return { status: 409, body: { error: "tool_conflict" } };
          if (opts.action === "tool_complete" && old.state !== "completed") return { status: 409, body: { error: "tool_not_completed" } };
          return { status: 200, body: { ok: true, disposition: old.state === "completed" ? "completed" : "already_started" } };
        }
        if (opts.action !== "tool_start") return { status: 409, body: { error: "tool_not_started" } };
        const [count] = await sql.query<{ n: number }>("select count(*)::int as n from ai_tool_calls where run_id=$1", [opts.runId]);
        if (count.n >= locked.run.request_json.policy.max_tool_calls) return { status: 429, body: { error: "tool_budget_exceeded" } };
        await sql.query("insert into ai_tool_calls(run_id,call_id,tool,request_digest,state) values($1,$2,$3,$4,'started')", [opts.runId, p.call_id, p.tool, p.request_digest]);
        return { status: 200, body: { ok: true, disposition: "send_once" } };
      }
      if (opts.action !== "search_items" && opts.action !== "get_item") return { status: 403, body: { error: "tool_denied" } };
      const { call_id, request_digest, ...params } = opts.params;
      const parsed = (opts.action === "search_items" ? corpusSearchSchema : corpusGetSchema).safeParse(params);
      if (!parsed.success || !z.uuid().safeParse(call_id).success || typeof request_digest !== "string") return { status: 403, body: { error: "tool_not_started" } };
      const [call] = await sql.query<Record<string, any>>("select * from ai_tool_calls where run_id=$1 and call_id=$2", [opts.runId, call_id]);
      if (!call || call.tool !== opts.action || call.request_digest !== request_digest ||
        request_digest !== hashCanonical({ tool: opts.action, params: parsed.data })) return { status: 409, body: { error: "tool_conflict" } };
      if (call.state === "completed") return { status: 200, body: call.result_json };
      const result = await handleAgentDataInner({ ...opts, sql, params: parsed.data });
      if (result.status === 200) {
        if (Buffer.byteLength(JSON.stringify(result.body)) > 2 * 1024 * 1024) throw new Error("tool_result_too_large");
        await sql.query("update ai_tool_calls set state='completed',result_json=$3::jsonb,result_digest=$4,finished_at=clock_timestamp() where run_id=$1 and call_id=$2", [opts.runId, call_id, JSON.stringify(result.body), hashCanonical(result.body)]);
      }
      return result;
    }
    if (opts.action === "tool_start" || opts.action === "tool_complete") return { status: 403, body: { error: "tool_denied" } };
    return handleAgentDataInner({ ...opts, sql });
  });
}
