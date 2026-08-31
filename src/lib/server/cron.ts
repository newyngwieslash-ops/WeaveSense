import { timingSafeEqual } from "node:crypto";

const shanghaiClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const MAX_GATEWAY_BODY_BYTES = 1024 * 1024;
const SAFE_SOURCE_ID = /^[A-Za-z0-9._:-]+$/;
const GATEWAY_RECONCILIATION_KEYS = new Set([
  "day", "attempted", "succeeded", "failed", "succeeded_source_ids", "budget_exhausted",
  "deferred", "budget_deferred", "deferred_paid_calls", "outbox_source_ids",
  "pending_details", "completed_details",
]);

export const CRON_SERVER_BUDGET_MS = 720_000;
export const CRON_SOURCE_RESERVE_MS = 100_000;
export const CRON_INGEST_RESERVE_MS = 55_000;
export const CRON_EXTRACT_RESERVE_MS = 460_000;
export const CRON_GATEWAY_RESERVE_MS = 125_000;
export const CRON_SOURCE_CONCURRENCY = 9;
export const WECHAT_GATEWAY_FEED_TIMEOUT_MS = 95_000;

export type CronBatchOptions = {
  deadlineMs?: number;
  reserveMs?: number;
  now?: () => number;
  concurrency?: number;
};

export function cronHasBudget(deadlineMs: number, reserveMs: number, now: () => number = Date.now): boolean {
  return now() + reserveMs <= deadlineMs;
}

// ponytail: fixed worker pools bound fan-out; add adaptive pools only after production measurements.
export async function runCronBatch<Item, Result>(
  items: readonly Item[],
  run: (item: Item) => Promise<Result>,
  { deadlineMs, reserveMs = 0, now = Date.now, concurrency = 1 }: CronBatchOptions = {},
): Promise<{ results: Result[]; deferred: number }> {
  const results: Array<Result | undefined> = [];
  const done: boolean[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (deadlineMs !== undefined && !cronHasBudget(deadlineMs, reserveMs, now)) return;
      const index = cursor++;
      results[index] = await run(items[index]);
      done[index] = true;
    }
  };
  const size = Math.min(items.length,
    Number.isSafeInteger(concurrency) ? Math.min(32, Math.max(1, concurrency)) : 1);
  await Promise.all(Array.from({ length: size }, worker));
  const completed = results.filter((_value, index): _value is Result => done[index] === true);
  return { results: completed, deferred: items.length - completed.length };
}

export function authorizeCron(header: string, secret: string): boolean {
  if (!secret || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function reconciliationDue(now: Date): boolean {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date");
  const parts = Object.fromEntries(shanghaiClock.formatToParts(now)
    .map(({ type, value }) => [type, value]));
  return parts.hour === "23" && Number(parts.minute) >= 30;
}

export function parseCronTickLimit(value: string | number | undefined): number {
  const parsed = typeof value === "string" && !value.trim() ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 200;
}

type GatewayReconciliation = {
  day: string;
  attempted: number;
  succeeded: number;
  failed: number;
  succeeded_source_ids: string[];
  budget_exhausted: boolean;
  deferred?: number;
  budget_deferred?: boolean;
  deferred_paid_calls?: number;
  outbox_source_ids: string[];
  pending_details: number;
  completed_details: number;
};

type ReconciliationRequestResult =
  | { ok: true; value: GatewayReconciliation }
  | { ok: false; error: "wechat_gateway_http_error"; status: number }
  | { ok: false; error: "wechat_gateway_invalid_response" | "wechat_gateway_unavailable" };

type SourceJobResult = { items_found: number; items_new: number; error: string };

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizePayload(payload: unknown): GatewayReconciliation | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some((key) => !GATEWAY_RECONCILIATION_KEYS.has(key))) return null;
  const attempted = count(value.attempted);
  const succeeded = count(value.succeeded);
  const failed = count(value.failed);
  const deferred = value.deferred === undefined ? undefined : count(value.deferred);
  const deferredPaidCalls = value.deferred_paid_calls === undefined
    ? undefined : count(value.deferred_paid_calls);
  const pendingDetails = count(value.pending_details);
  const completedDetails = count(value.completed_details);
  if (!validDay(value.day) || attempted === null || succeeded === null || failed === null
    || attempted !== succeeded + failed || !Array.isArray(value.succeeded_source_ids)
    || value.succeeded_source_ids.length !== succeeded || value.succeeded_source_ids.length > 500
    || typeof value.budget_exhausted !== "boolean"
    || deferred === null || deferredPaidCalls === null || pendingDetails === null || completedDetails === null
    || !Array.isArray(value.outbox_source_ids) || value.outbox_source_ids.length > 500
    || (value.budget_deferred !== undefined && typeof value.budget_deferred !== "boolean")) return null;
  const seen = new Set<string>();
  const sourceIds: string[] = [];
  for (const rawSourceId of value.succeeded_source_ids) {
    if (typeof rawSourceId !== "string") return null;
    const sourceId = rawSourceId.trim();
    if (!sourceId || sourceId.length > 128 || !SAFE_SOURCE_ID.test(sourceId) || seen.has(sourceId)) return null;
    seen.add(sourceId);
    sourceIds.push(sourceId);
  }
  const outboxSeen = new Set<string>();
  const outboxIds: string[] = [];
  for (const rawSourceId of value.outbox_source_ids) {
    if (typeof rawSourceId !== "string") return null;
    const sourceId = rawSourceId.trim();
    if (!sourceId || sourceId.length > 128 || !SAFE_SOURCE_ID.test(sourceId) || outboxSeen.has(sourceId)) return null;
    outboxSeen.add(sourceId);
    outboxIds.push(sourceId);
  }
  return { day: value.day, attempted, succeeded, failed,
    succeeded_source_ids: sourceIds, budget_exhausted: value.budget_exhausted,
    outbox_source_ids: outboxIds, pending_details: pendingDetails, completed_details: completedDetails,
    ...(deferred === undefined ? {} : { deferred }),
    ...(value.budget_deferred === undefined ? {} : { budget_deferred: value.budget_deferred }),
    ...(deferredPaidCalls === undefined ? {} : { deferred_paid_calls: deferredPaidCalls }) };
}

function gatewayUrl(base: string, path: string): string | null {
  try {
    const url = new URL(base);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)
      || url.username || url.password || url.search || url.hash) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    return url.toString();
  } catch {
    return null;
  }
}

async function readGatewayJson(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_GATEWAY_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    try { await reader.cancel(); } catch { /* response is already invalid */ }
    return null;
  }
}

export async function requestWechatReconciliation({ url, token, fetchImpl = fetch }: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ReconciliationRequestResult> {
  const endpoint = gatewayUrl(url, "/v1/reconcile");
  if (!endpoint) return { ok: false, error: "wechat_gateway_unavailable" };
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
  } catch {
    return { ok: false, error: "wechat_gateway_unavailable" };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* response is already classified */ }
    return { ok: false, error: "wechat_gateway_http_error", status: response.status };
  }
  const value = normalizePayload(await readGatewayJson(response));
  return value ? { ok: true, value } : { ok: false, error: "wechat_gateway_invalid_response" };
}

export async function requestWechatReconciliationAck({ url, token, sourceIds, fetchImpl = fetch }: {
  url: string;
  token: string;
  sourceIds: string[];
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; acked: number } | { ok: false; error: "wechat_gateway_ack_failed" }> {
  const endpoint = gatewayUrl(url, "/v1/reconcile/ack");
  if (!endpoint) return { ok: false, error: "wechat_gateway_ack_failed" };
  try {
    const response = await fetchImpl(endpoint, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ source_ids: sourceIds }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); return { ok: false, error: "wechat_gateway_ack_failed" }; }
    const body = await readGatewayJson(response);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || count((body as Record<string, unknown>).acked) === null
      || Number((body as Record<string, unknown>).acked) > sourceIds.length) {
      return { ok: false, error: "wechat_gateway_ack_failed" };
    }
    return { ok: true, acked: Number((body as Record<string, unknown>).acked) };
  } catch {
    return { ok: false, error: "wechat_gateway_ack_failed" };
  }
}

export function cronWorkSlot(now: Date): "collect" | "extract" {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("now must be a valid Date");
  return Math.floor(now.getTime() / 1_800_000) % 4 === 3 ? "extract" : "collect";
}

export function cronDueQuotas(limit: number): { sources: number; keywords: 1 } {
  return { sources: Math.min(34, Math.max(1, Number.isSafeInteger(limit) ? limit - 1 : 1)), keywords: 1 };
}

export async function runReconciledSourceJobs(
  sourceIds: readonly unknown[],
  run: (sourceId: string) => Promise<SourceJobResult>,
  budget: CronBatchOptions = {},
): Promise<Array<SourceJobResult & { source_id: string }>> {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawSourceId of sourceIds) {
    if (typeof rawSourceId !== "string") continue;
    const sourceId = rawSourceId.trim();
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);
    normalized.push(sourceId);
  }
  const { results } = await runCronBatch(normalized, async (sourceId) => {
    try {
      const result = await run(sourceId);
      if (result.error !== "" || count(result.items_found) === null || count(result.items_new) === null) {
        throw new TypeError("invalid source job result");
      }
      return { source_id: sourceId, ...result };
    } catch {
      return { source_id: sourceId, items_found: 0, items_new: 0, error: "reconcile_scan_failed" };
    }
  }, budget);
  return results;
}

type StageFailure<E extends string> = { ok: false; error: E };

async function runStage<T, E extends string>(run: () => Promise<T>, error: E): Promise<T | StageFailure<E>> {
  try { return await run(); }
  catch { return { ok: false, error }; }
}

export async function runCronStages<Collection, Production, Reconciliation>({
  collection,
  production,
  reconciliation,
}: {
  collection: () => Promise<Collection>;
  production: () => Promise<Production>;
  reconciliation?: () => Promise<Reconciliation>;
}): Promise<{
  collection: Collection | StageFailure<"collection_failed">;
  production: Production | StageFailure<"production_failed">;
  reconciliation: Reconciliation | StageFailure<"reconciliation_failed"> | null;
}> {
  const collectionResult = await runStage(collection, "collection_failed");
  const productionResult = await runStage(production, "production_failed");
  const reconciliationResult = reconciliation
    ? await runStage(reconciliation, "reconciliation_failed")
    : null;
  return {
    collection: collectionResult,
    production: productionResult,
    reconciliation: reconciliationResult,
  };
}
