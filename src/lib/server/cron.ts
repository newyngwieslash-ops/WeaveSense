import { timingSafeEqual } from "node:crypto";

const shanghaiClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

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

function normalizePayload(payload: unknown): GatewayReconciliation | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const attempted = count(value.attempted);
  const succeeded = count(value.succeeded);
  const failed = count(value.failed);
  if (typeof value.day !== "string" || attempted === null || succeeded === null || failed === null
    || !Array.isArray(value.succeeded_source_ids) || typeof value.budget_exhausted !== "boolean") return null;
  const seen = new Set<string>();
  const sourceIds = value.succeeded_source_ids.filter((sourceId): sourceId is string => {
    if (typeof sourceId !== "string" || !sourceId || seen.has(sourceId)) return false;
    seen.add(sourceId);
    return true;
  });
  return { day: value.day, attempted, succeeded, failed,
    succeeded_source_ids: sourceIds, budget_exhausted: value.budget_exhausted };
}

export async function requestWechatReconciliation({ url, token, fetchImpl = fetch }: {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ReconciliationRequestResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${url.replace(/\/$/, "")}/v1/reconcile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { ok: false, error: "wechat_gateway_unavailable" };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* response is already classified */ }
    return { ok: false, error: "wechat_gateway_http_error", status: response.status };
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return { ok: false, error: "wechat_gateway_invalid_response" }; }
  const value = normalizePayload(payload);
  return value ? { ok: true, value } : { ok: false, error: "wechat_gateway_invalid_response" };
}

export async function runReconciledSourceJobs(
  sourceIds: readonly unknown[],
  run: (sourceId: string) => Promise<SourceJobResult>,
): Promise<Array<SourceJobResult & { source_id: string }>> {
  const seen = new Set<string>();
  const results: Array<SourceJobResult & { source_id: string }> = [];
  for (const sourceId of sourceIds) {
    if (typeof sourceId !== "string" || !sourceId || seen.has(sourceId)) continue;
    seen.add(sourceId);
    try {
      results.push({ source_id: sourceId, ...await run(sourceId) });
    } catch {
      results.push({ source_id: sourceId, items_found: 0, items_new: 0, error: "reconcile_scan_failed" });
    }
  }
  return results;
}
