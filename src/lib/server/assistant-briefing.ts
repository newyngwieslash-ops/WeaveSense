/**
 * Managed briefing via the assistant (plan Task 21 / §6.4, B02).
 *
 * "Today" is frozen at accept time to a half-open Asia/Shanghai range and
 * stored on the action; retries across midnight reuse the frozen range. The
 * range comes from the caller only (explicit from/to within 7 days, or
 * today) — never model output. Execution rides generateBriefingWith; the
 * result states the 12-item sample cap honestly and binds the exact
 * note_id, so /knowledge?note=... shows the same artifact the card does.
 */
import { agentTransaction } from "./agent-transaction.ts";
import { generateBriefingWith } from "./analyze.ts";
import { getRunByRequest } from "./agent-runs.ts";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

const MAX_RANGE_DAYS = 7;

export type ShanghaiRange = { from: string; to: string };

/** Freeze a half-open +08:00 day for an ISO date (YYYY-MM-DD). */
export function freezeShanghaiRange(isoDate: string): ShanghaiRange {
  const start = new Date(`${isoDate}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function todayShanghai(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

export type RangeCheck = { ok: true; range: ShanghaiRange } | { ok: false; error: string; error_code: string };

/** Pure range validation shared with the preview/decision path. */
function checkRange(range: { from?: string; to?: string }): RangeCheck {
  const paired = (range.from === undefined) === (range.to === undefined);
  if (!paired) return { ok: false, error: "时间范围必须成对提供", error_code: "invalid_range" };
  if (range.from === undefined || range.to === undefined) {
    return { ok: true, range: freezeShanghaiRange(todayShanghai()) };
  }
  const from = Date.parse(range.from), to = Date.parse(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return { ok: false, error: "时间范围无效", error_code: "invalid_range" };
  }
  if ((to - from) / 86_400_000 > MAX_RANGE_DAYS) {
    return { ok: false, error: `时间范围不能超过 ${MAX_RANGE_DAYS} 天`, error_code: "range_too_wide" };
  }
  return { ok: true, range: { from: range.from, to: range.to } };
}

export type BriefingStartResult =
  | { ok: true; note_id: string; title: string; run_id?: string; replay?: boolean; coverage_note: string }
  | { ok: false; error: string; error_code: string };

/**
 * Result coverage statement (§6.4): always names the sample bound; never
 * claims full-day coverage.
 */
function sampleCoverageNote(used: number, cap: number): string {
  return `本次简报基于时间范围内最近 ${used} 条内容（样本上限 ${cap} 条），并非全天完整汇总。`;
}

/** Exposed for tests and the result card. */
const sampleCoverage = sampleCoverageNote;

export async function startAssistantBriefing(
  sql: Queryable,
  input: {
    conversationId: string;
    turnId: string;
    actionId: string;
    requestId: string;
    range?: { from?: string; to?: string };
  },
): Promise<BriefingStartResult> {
  // Replay first (free): a completed run for this request returns its bound
  // note verbatim, independent of the engine gate.
  const existing = await getRunByRequest(sql, input.requestId);
  if (existing && existing.status === "succeeded") {
    const saved = (existing.response_json ?? {}) as { note_id?: string; title?: string };
    if (saved.note_id) {
      return { ok: true, note_id: saved.note_id, title: saved.title ?? "", run_id: existing.id, replay: true, coverage_note: sampleCoverageNote(0, 12) };
    }
  }
  // Engine gate: the legacy/eino real-send admission is not verified for
  // assistant-initiated calls; refuse rather than free-ride on chat budget.
  if (process.env.AGENT_ASSISTANT_ANALYSIS_ENGINE !== "legacy" && process.env.AGENT_ASSISTANT_ANALYSIS_ENGINE !== "eino") {
    return { ok: false, error: "简报执行器未在本环境启用", error_code: "capability_unavailable" };
  }
  const engine = process.env.AGENT_ASSISTANT_ANALYSIS_ENGINE as "legacy" | "eino";
  // Freeze the range at accept time and persist it on the action so retries
  // reuse the same window even across midnight.
  const frozen = await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [action] = await tx.query<Record<string, unknown>>(
      "select id, status, result_json from assistant_actions where id = $1 for update",
      [input.actionId],
    );
    if (!action) return { error: "动作不存在", error_code: "not_found" as const } as const;
    const stored = action.result_json == null ? {} : typeof action.result_json === "string" ? JSON.parse(action.result_json) : action.result_json;
    const storedFrozen = (stored as { frozen_range?: { from: string; to: string } }).frozen_range;
    if (storedFrozen) return { range: storedFrozen } as const;
    const checked = checkRange(input.range ?? {});
    if (!checked.ok) return checked;
    await tx.query(
      `update assistant_actions set status='executing',
         result_json=jsonb_set(coalesce(result_json,'{}'::jsonb), '{frozen_range}', $2::jsonb, true)
       where id=$1`,
      [input.actionId, JSON.stringify(checked.range)],
    );
    return { range: checked.range } as const;
  });
  if ("error" in frozen) {
    const err = frozen as { error: string; error_code?: string };
    return { ok: false, error: err.error, error_code: err.error_code ?? "briefing_failed" };
  }
  const result = await generateBriefingWith({ sql, requestId: input.requestId, from: frozen.range.from, to: frozen.range.to, engine });
  if (result.ok) {
    return {
      ok: true, note_id: result.id, title: result.title, run_id: result.run_id, replay: false,
      coverage_note: sampleCoverageNote(12, 12),
    };
  }
  return { ok: false, error: result.error, error_code: result.error_code ?? "briefing_failed" };
}

export const startAssistantBriefingExports = { checkRange, sampleCoverage };
