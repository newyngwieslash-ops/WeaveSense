import { createHash, timingSafeEqual } from "node:crypto";
import { appendEvidenceReceipt, getRun, hashCanonical } from "./agent-runs.ts";
import { TOOL_CODE_POINT_CAP, codePoints, rankRetrievedItems, selectTextSegments, splitQueryTerms } from "./agent-context.ts";

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

export async function handleAgentData(opts: {
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
  const saved = (run.request_json ?? {}) as Record<string, unknown>;
  const range = (saved.range ?? null) as { from?: string; to?: string } | null;
  if (opts.action === "search_items") {
    const query = String(opts.params.query ?? "").trim();
    const limit = Math.min(8, Math.max(1, Number(opts.params.limit ?? 8) || 8));
    if (Array.from(query).length < 2 || Array.from(query).length > 200) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    const terms = splitQueryTerms(query);
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const term of (terms.length ? terms : [query])) {
      params.push(`%${escapeLike(term)}%`);
      const idx = params.length;
      clauses.push(`(i.title ilike $${idx} escape '\\' or i.body ilike $${idx} escape '\\' or i.author ilike $${idx} escape '\\')`);
    }
    let sql = `select i.id, i.title, i.body, i.author, i.platform, s.name as source_name, i.published_at
      from items i join sources s on s.id = i.source_id
      where ${clauses.join(" or ")}`;
    if (range?.from && range?.to) {
      params.push(range.from, range.to);
      sql += ` and coalesce(i.published_at, i.collected_at) >= $${params.length - 1}::timestamptz and coalesce(i.published_at, i.collected_at) < $${params.length}::timestamptz`;
    }
    sql += ` order by coalesce(i.published_at, i.collected_at) desc, i.id desc limit 40`;
    const rawRows = await opts.sql.query<Record<string, unknown>>(sql, params);
    const ranked = rankRetrievedItems(
      query,
      rawRows.map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ""),
        body: String(row.body ?? ""),
        author: String(row.author ?? ""),
        platform: String(row.platform ?? ""),
        source_name: String(row.source_name ?? ""),
      })),
      limit,
    );
    const rows = ranked;
    const items = [];
    for (const row of rows) {
      const snippet = clip(String(row.body ?? ""), 400);
      const evidenceId = `item:${row.id}:search`;
      const receipt = { type: "evidence", evidence_id: evidenceId, item_id: String(row.id), origin: "internal", text: snippet.text };
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
    const [row] = await opts.sql.query<Record<string, unknown>>(
      `select i.*, s.name as source_name from items i join sources s on s.id = i.source_id where i.id = $1`,
      [itemId],
    );
    if (!row) return { status: 404, body: { error: "not_found" } };
    const start = Math.max(0, Number(opts.params.start ?? 0) || 0);
    const chars = codePoints(String(row.body ?? ""));
    const slice = chars.slice(start, start + TOOL_CODE_POINT_CAP);
    const text = slice.join("");
    const evidenceId = `item:${itemId}:${start}`;
    const appended = await appendEvidenceReceipt(opts.sql, {
      runId: opts.runId,
      receipt: { type: "evidence", evidence_id: evidenceId, item_id: itemId, origin: "internal", text },
    });
    if (appended !== "ok") return { status: 429, body: { error: "budget_exceeded" } };
    return { status: 200, body: { item_id: itemId, evidence_id: evidenceId, start, end: start + slice.length, text, coverage: chars.length > start + TOOL_CODE_POINT_CAP ? "partial" : "full" } };
  }
  if (opts.action === "get_analysis") {
    const itemId = String(opts.params.item_id ?? "");
    const [row] = await opts.sql.query<Record<string, unknown>>(
      `select a.*, r.material_hash as run_material_hash, r.id as source_run_id
       from analyses a left join ai_runs r on r.id = a.run_id
       where a.item_id = $1 order by a.created_at desc limit 1`,
      [itemId],
    );
    if (!row) return { status: 404, body: { error: "not_found" } };
    return { status: 200, body: {
      item_id: itemId, summary: String(row.summary ?? ""), run_id: row.source_run_id ? String(row.source_run_id) : null,
      stale: !row.run_material_hash,
      topics: row.topics, insights: String(row.insights ?? ""),
    } };
  }
  return { status: 400, body: { error: "invalid_action" } };
}

export const agentDataHash = hashCanonical;
