/**
 * Managed single-item analysis via the assistant (plan Task 20 / §6.4, B01).
 *
 * The assistant proposes an item.analyze action; the host freezes the item
 * and its material_version at prepare time, then dispatches through the
 * existing professional executor (analyzeItemWith) — never writing analyses
 * directly from chat. Three hard guarantees:
 *   1. replay: a stable request_id returns exactly the bound analysis_id;
 *   2. conflict: a material_version bump between prepare and execute
 *      refuses instead of silently re-reading the new text;
 *   3. honesty: when the legacy/eino engine cannot provide verified budget
 *      admission for the assistant path, the action refuses with
 *      capability_unavailable rather than faking success.
 */
import { randomUUID } from "node:crypto";
import { agentTransaction } from "./agent-transaction.ts";
import { analyzeItemWith } from "./analyze.ts";
import { getRunByRequest } from "./agent-runs.ts";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

export type AnalysisPrepare =
  | { kind: "prepared"; actionId: string; itemId: string; materialVersion: number }
  | { kind: "conflict"; actionId: string; itemId: string }
  | { kind: "not_found"; actionId: string; itemId: string };

export type AnalysisStartResult =
  | { ok: true; analysis_id: string; run_id?: string; replay?: boolean }
  | { ok: false; error: string; error_code: string };

/**
 * Prepare/freeze step: observe the item's material version and arbitrate
 * prepare-vs-conflict inside one transaction. An already-executing action
 * re-observes; a version change after the first prepare is a conflict (B01).
 */
export async function assistantAnalysisPrepare(
  sql: Queryable,
  input: { conversationId: string; turnId: string; actionId: string; kind: string; targetId: string },
): Promise<AnalysisPrepare> {
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [action] = await tx.query<Record<string, unknown>>(
      "select id, status, result_json from assistant_actions where id = $1 for update",
      [input.actionId],
    );
    if (!action) return { kind: "not_found", actionId: input.actionId, itemId: input.targetId };
    const [item] = await tx.query<{ material_version: number }>(
      "select material_version from items where id = $1",
      [input.targetId],
    );
    if (!item) return { kind: "not_found", actionId: input.actionId, itemId: input.targetId };
    const version = Number(item.material_version);
    if (action.status === "executing") {
      const stored = action.result_json == null ? null : typeof action.result_json === "string" ? JSON.parse(action.result_json) : action.result_json;
      const frozenVersion = stored && typeof stored === "object" ? Number((stored as Record<string, unknown>).material_version) : null;
      if (frozenVersion != null && frozenVersion !== version) {
        return { kind: "conflict", actionId: input.actionId, itemId: input.targetId };
      }
    }
    await tx.query(
      `update assistant_actions set status='executing',
         result_json=jsonb_set(coalesce(result_json,'{}'::jsonb), '{material_version}', to_jsonb($2::bigint), true)
       where id=$1`,
      [input.actionId, version],
    );
    return { kind: "prepared", actionId: input.actionId, itemId: input.targetId, materialVersion: version };
  });
}

/**
 * Execute the analysis through the managed executor. `startAssistantAnalysis`
 * is idempotent by requestId: once a run exists for the request, its bound
 * analysis_id is returned verbatim — a second analysis of the same item
 * under a NEW request id will have its own identity (B01: 详情页按 ID+item
 * 双重校验，不拿最新分析冒充).
 */
export async function startAssistantAnalysis(
  sql: Queryable,
  input: { conversationId: string; turnId: string; actionId: string; requestId: string; itemId: string },
): Promise<AnalysisStartResult> {
  // Replay first (free — no send): a previously completed run for this
  // request returns its bound analysis verbatim regardless of the current
  // engine gate.
  const existing = await getRunByRequest(sql, input.requestId);
  if (existing && existing.status === "succeeded") {
    const saved = (existing.response_json ?? {}) as { analysis_id?: string };
    if (saved.analysis_id) {
      return { ok: true, analysis_id: saved.analysis_id, run_id: existing.id, replay: true };
    }
  }
  // Budget admission for the professional path: the legacy/eino engine's
  // real-send admission is not verified for assistant-initiated calls, so
  // without an explicit allow flag this refuses rather than free-riding on
  // the assistant conversation budget (§6.4/Task 20 step 2).
  if (process.env.AGENT_ASSISTANT_ANALYSIS_ENGINE !== "legacy" && process.env.AGENT_ASSISTANT_ANALYSIS_ENGINE !== "eino") {
    return { ok: false, error: "单篇分析执行器未在本环境启用", error_code: "capability_unavailable" };
  }
  const engine = process.env.AGENT_ASSISTANT_ANALYSIS_ENGINE as "legacy" | "eino";
  const prepare = await assistantAnalysisPrepare(sql, {
    conversationId: input.conversationId, turnId: input.turnId, actionId: input.actionId,
    kind: "item.analyze", targetId: input.itemId,
  });
  if (prepare.kind === "conflict") {
    return { ok: false, error: "原文在确认后已变化，请重新分析", error_code: "input_changed" };
  }
  if (prepare.kind === "not_found") {
    return { ok: false, error: "内容不存在", error_code: "not_found" };
  }
  const result = await analyzeItemWith({ sql, itemId: input.itemId, requestId: input.requestId, engine });
  if (result.ok) {
    return { ok: true, analysis_id: result.id, run_id: result.run_id, replay: false };
  }
  return { ok: false, error: result.error, error_code: result.error_code ?? "analysis_failed" };
}

/**
 * Exact lookup for the result card / detail page (B01): the analysis must
 * match BOTH the id and the item. Never "the item's latest analysis".
 */
export async function getAnalysisByIdForItem(
  sql: Queryable,
  analysisId: string,
  itemId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    "select id, item_id, summary, topics, entities, insights, tags, model, created_at from analyses where id = $1 and item_id = $2",
    [analysisId, itemId],
  );
  return row ?? null;
}

export const analysisRequestIdSeed = randomUUID;
