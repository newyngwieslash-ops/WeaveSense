import type { Sql } from "@/lib/db";

/**
 * T09: persistent admission for the heavy production stages.
 *
 * ## Why this exists
 *
 * The scheduler wake-up is being shortened (30 min → 60 s) so that a source's
 * own due time is honoured promptly. But a tick runs several stages, and only
 * some of them should follow that cadence:
 *
 *   - **collection** — cheap-ish discovery; runs on the tick, and each source
 *     still observes its own `interval_minutes`. Shortening the wake-up does not
 *     change any source's frequency.
 *   - **production** (media ingest, OCR/ASR extraction, paid reconciliation) —
 *     expensive and, for the paid path, billable. These must keep their own,
 *     much slower cadence. Running them per-minute would multiply落盘/OCR/付费
 *     对账 by 30×, which is the exact regression this guards against.
 *
 * ## Why the database and not a timestamp in memory
 *
 * A restart, an HMR reload, or a second replica must not be able to re-run a
 * stage in a window that already ran. Admission is therefore a row keyed by
 * `(stage, window_key)` with the window derived from the stage's own interval:
 * re-entering the same period always collides, no matter which process asks.
 *
 * ## Failure handling
 *
 * - A stage that fails is recorded as `failed` and **is not retried within the
 *   same window** — retrying immediately is how a failing paid stage turns into
 *   a spend loop. The next window tries again.
 * - A stage killed mid-run leaves `claimed`; after `STAGE_CLAIM_TIMEOUT_MINUTES`
 *   the row may be reclaimed, because the process that held it is gone.
 *
 * Timing notes are written to `note` as counts/codes only — never raw provider
 * text or secrets.
 */

/** Stage ids are a closed set: an unknown stage can never be claimed. */
export const PRODUCTION_STAGES = ["ingest", "extract", "reconcile"] as const;
export type ProductionStage = (typeof PRODUCTION_STAGES)[number];

/**
 * Each stage's own cadence, in minutes. These are the frequencies the plan
 * requires to stay unchanged; the tick interval is a separate, faster knob.
 */
export const STAGE_INTERVAL_MINUTES: Record<ProductionStage, number> = {
  ingest: 30,
  extract: 30,
  // The WeChat reconciliation window is the 23:30 Shanghai half-hour and is
  // additionally gated by `reconciliationDue`; this is a safety net only.
  reconcile: 1440,
};

/** How long a `claimed` row may be held before another process may reclaim it. */
export const STAGE_CLAIM_TIMEOUT_MINUTES = 30;

/**
 * The window key for a stage at a given instant: the start of the period the
 * stage's interval defines. Times are floored in UTC epoch terms so the key is
 * identical across processes and timezones.
 */
export function stageWindowKey(stage: ProductionStage, nowMs: number): string {
  const intervalMs = STAGE_INTERVAL_MINUTES[stage] * 60_000;
  const start = Math.floor(nowMs / intervalMs) * intervalMs;
  return `${stage}:${new Date(start).toISOString()}`;
}

/**
 * Claim admission to run `stage` now.
 *
 * Returns `{ admitted: false }` when the window is already taken (by this or any
 * other process) or when a previous claim is still fresh. Only `admitted: true`
 * lets the caller do the expensive work.
 */
export async function claimStageWindow(
  sql: Pick<Sql, "query">,
  stage: ProductionStage,
  nowMs: number = Date.now(),
): Promise<{ admitted: boolean; windowKey: string; reason?: "already_ran" | "in_flight" | "already_failed" }> {
  if (!PRODUCTION_STAGES.includes(stage)) throw new Error("invalid_stage");
  const windowKey = stageWindowKey(stage, nowMs);

  // One clock only: the caller's `nowMs` is written as `claimed_at` AND used for
  // the stale-claim comparison. Reading the database clock instead would mix two
  // time sources (a container with a skewed clock, or a test with an injected
  // time, would then disagree about whether a claim is fresh).
  const rows = await sql.query<{ stage: string }>(
    `insert into stage_windows (stage, window_key, status, claimed_at)
     values ($1, $2, 'claimed', to_timestamp($3::double precision / 1000))
     on conflict (stage, window_key) do update
       set status = 'claimed',
           claimed_at = to_timestamp($3::double precision / 1000),
           finished_at = null,
           note = ''
       where stage_windows.status = 'claimed'
         and stage_windows.claimed_at <= to_timestamp($3::double precision / 1000)
             - ($4::integer * interval '1 minute')
     returning stage`,
    [stage, windowKey, nowMs, STAGE_CLAIM_TIMEOUT_MINUTES],
  );

  if (rows.length) return { admitted: true, windowKey };

  // Not admitted: report why, so the caller can log a useful reason.
  const [existing] = await sql.query<{ status: string }>(
    "select status from stage_windows where stage = $1 and window_key = $2",
    [stage, windowKey],
  );
  const reason = existing?.status === "failed" ? "already_failed"
    : existing?.status === "claimed" ? "in_flight" : "already_ran";
  return { admitted: false, windowKey, reason };
}

/**
 * Record the outcome of an admitted stage. Counts and codes only.
 */
export async function finishStageWindow(
  sql: Pick<Sql, "query">,
  stage: ProductionStage,
  windowKey: string,
  outcome: { ok: boolean; note?: string },
  nowMs: number = Date.now(),
): Promise<void> {
  await sql.query(
    `update stage_windows
        set status = $3, finished_at = to_timestamp($5::double precision / 1000), note = $4
      where stage = $1 and window_key = $2`,
    [stage, windowKey, outcome.ok ? "done" : "failed", (outcome.note ?? "").slice(0, 400), nowMs],
  );
}

/**
 * Run `stage` at most once per its own window.
 *
 * `run` is only invoked when admission is granted; its result is summarized into
 * the window row so an operator can see what the last occurrence did.
 */
export async function runStageOnce(
  sql: Pick<Sql, "query">,
  stage: ProductionStage,
  run: () => Promise<{ ok: boolean; note?: string }>,
  nowMs: number = Date.now(),
): Promise<{ ran: boolean; windowKey: string; reason?: string; result?: { ok: boolean; note?: string } }> {
  const claim = await claimStageWindow(sql, stage, nowMs);
  if (!claim.admitted) return { ran: false, windowKey: claim.windowKey, reason: claim.reason };
  let result: { ok: boolean; note?: string };
  try {
    result = await run();
  } catch (error) {
    // A thrown stage is a failed stage; it must not be silently forgotten, and
    // it must not be retried inside this window either.
    result = { ok: false, note: error instanceof Error ? error.message.slice(0, 200) : "stage_threw" };
  }
  await finishStageWindow(sql, stage, claim.windowKey, result, nowMs);
  return { ran: true, windowKey: claim.windowKey, result };
}
