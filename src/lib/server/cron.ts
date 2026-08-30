import { timingSafeEqual } from "node:crypto";

const shanghaiClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const MAX_GATEWAY_BODY_BYTES = 1024 * 1024;
const SAFE_SOURCE_ID = /^[A-Za-z0-9._:-]+$/;

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
  const attempted = count(value.attempted);
  const succeeded = count(value.succeeded);
  const failed = count(value.failed);
  if (!validDay(value.day) || attempted === null || succeeded === null || failed === null
    || attempted !== succeeded + failed || !Array.isArray(value.succeeded_source_ids)
    || value.succeeded_source_ids.length !== succeeded || value.succeeded_source_ids.length > 500
    || typeof value.budget_exhausted !== "boolean") return null;
  const seen = new Set<string>();
  const sourceIds: string[] = [];
  for (const rawSourceId of value.succeeded_source_ids) {
    if (typeof rawSourceId !== "string") return null;
    const sourceId = rawSourceId.trim();
    if (!sourceId || sourceId.length > 128 || !SAFE_SOURCE_ID.test(sourceId) || seen.has(sourceId)) return null;
    seen.add(sourceId);
    sourceIds.push(sourceId);
  }
  return { day: value.day, attempted, succeeded, failed,
    succeeded_source_ids: sourceIds, budget_exhausted: value.budget_exhausted };
}

function reconciliationUrl(base: string): string | null {
  try {
    const url = new URL(base);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)
      || url.username || url.password || url.search || url.hash) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/reconcile`;
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
  const endpoint = reconciliationUrl(url);
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

export async function runReconciledSourceJobs(
  sourceIds: readonly unknown[],
  run: (sourceId: string) => Promise<SourceJobResult>,
): Promise<Array<SourceJobResult & { source_id: string }>> {
  const seen = new Set<string>();
  const results: Array<SourceJobResult & { source_id: string }> = [];
  for (const rawSourceId of sourceIds) {
    if (typeof rawSourceId !== "string") continue;
    const sourceId = rawSourceId.trim();
    if (!sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);
    try {
      const result = await run(sourceId);
      if (result.error !== "" || count(result.items_found) === null || count(result.items_new) === null) {
        throw new TypeError("invalid source job result");
      }
      results.push({ source_id: sourceId, ...result });
    } catch {
      results.push({ source_id: sourceId, items_found: 0, items_new: 0, error: "reconcile_scan_failed" });
    }
  }
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
