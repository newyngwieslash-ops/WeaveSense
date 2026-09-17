import { retrieveAgentItems } from "./agent-retrieval.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { modelCallSchema, recordModelCall } from "./agent-budget.ts";
import { z } from "zod";
import { agentTransaction, lockRun, ownsRun } from "./agent-transaction.ts";
import { materialFingerprint } from "./agent-context.ts";
import type { ItemRow } from "../types.ts";
import { appendEvidenceReceipt, getRun, hashCanonical } from "./agent-runs.ts";
import { TOOL_CODE_POINT_CAP, codePoints, evidenceIdFor, rankRetrievedItems, rangePredicate, selectTextSegments, splitQueryTerms } from "./agent-context.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
      const evidenceId = evidenceIdFor({
        id: String(row.id), title: String(row.title ?? ""), body: String(row.body ?? ""),
        author: String(row.author ?? ""), url: String(row.url ?? ""), platform: String(row.platform ?? ""),
        source_name: String(row.source_name ?? ""), published_at: row.published_at ? String(row.published_at) : null,
      }, snippet.start, snippet.end);
      const receipt = { type: "evidence", evidence_id: evidenceId, item_id: String(row.id), origin: "internal", text: snippet.text, title: row.title, url: row.url, platform: row.platform, source_name: row.source_name, published_at: row.published_at, start: snippet.start, end: snippet.end };
      const appended = await appendEvidenceReceipt(opts.sql, { runId: opts.runId, receipt });
      if (appended !== "ok") return { status: 429, body: { error: "budget_exceeded" } };
      items.push({
        item_id: String(row.id), title: String(row.title ?? ""), platform: String(row.platform),
        source_name: String(row.source_name ?? ""), snippet: snippet.text, evidence_id: evidenceId,
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
    const start = Math.max(0, Number(opts.params.start ?? 0) || 0);
    const chars = codePoints(String(row.body ?? ""));
    const slice = chars.slice(start, start + TOOL_CODE_POINT_CAP);
    const text = slice.join("");
    const end = start + slice.length;
    const evidenceId = evidenceIdFor({
      id: itemId, title: String(row.title ?? ""), body: String(row.body ?? ""),
      author: String(row.author ?? ""), url: String(row.url ?? ""), platform: String(row.platform ?? ""),
      source_name: String(row.source_name ?? ""), published_at: row.published_at ? String(row.published_at) : null,
    }, start, end);
    const appended = await appendEvidenceReceipt(opts.sql, {
      runId: opts.runId,
      receipt: { type: "evidence", evidence_id: evidenceId, item_id: itemId, origin: "internal", text, title: row.title, url: row.url, platform: row.platform, source_name: row.source_name, published_at: row.published_at, start, end },
    });
    if (appended !== "ok") return { status: 429, body: { error: "budget_exceeded" } };
    return { status: 200, body: { item_id: itemId, evidence_id: evidenceId, start, end, text, coverage: start > 0 || chars.length > end ? "partial" : "full" } };
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
    return handleAgentDataInner({ ...opts, sql });
  });
}
