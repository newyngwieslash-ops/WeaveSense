import type { WechatHealthLimits, WechatHealthRow, WechatHealthUsage } from "../types.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HEALTH_SOURCES = 1_000;
const SAFE_SOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type WechatGatewaySource = {
  source_id: string;
  name: string;
  wechat_id: string;
  sample_url: string;
  primary_feed_url: string;
  interval_minutes: 60;
  priority: "normal" | "high";
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function fail(code: string): never {
  throw new Error(code);
}

function endpoint(baseUrl: string, path: string): string {
  try {
    const url = new URL(baseUrl);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) fail("wechat_gateway_unavailable");
    const [pathname, search = ""] = path.split("?", 2);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
    url.search = search ? `?${search}` : "";
    return url.toString();
  } catch {
    return fail("wechat_gateway_unavailable");
  }
}

async function readJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    fail("wechat_gateway_response_too_large");
  }
  if (!response.body) fail("wechat_gateway_invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail("wechat_gateway_response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    try { await reader.cancel(); } catch { /* already closed */ }
    if (error instanceof Error && error.message === "wechat_gateway_response_too_large") throw error;
    return fail("wechat_gateway_invalid_response");
  }
}

function httpError(status: number): never {
  if (status === 401) fail("wechat_gateway_unauthorized");
  if (status === 422) fail("wechat_gateway_source_rejected");
  return fail("wechat_gateway_http_error");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("wechat_gateway_invalid_response");
  return value as Record<string, unknown>;
}

function day(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail("wechat_gateway_invalid_response");
  }
  return value;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("wechat_gateway_invalid_response");
  }
  day(value.slice(0, 10));
  return value;
}

function nonNegative(value: unknown, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    (integer && !Number.isSafeInteger(value))) fail("wechat_gateway_invalid_response");
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("wechat_gateway_invalid_response");
  return value as T;
}

function healthOverview(value: unknown): {
  as_of: string; sources: WechatHealthRow[]; usage: WechatHealthUsage; limits: WechatHealthLimits;
} {
  const root = record(value);
  const asOf = timestamp(root.as_of);
  if (asOf === null) fail("wechat_gateway_invalid_response");
  if (!Array.isArray(root.sources) || root.sources.length > MAX_HEALTH_SOURCES) {
    fail("wechat_gateway_invalid_response");
  }
  const sources = root.sources.map((raw): WechatHealthRow => {
    const source = record(raw);
    if (typeof source.source_id !== "string" || !SAFE_SOURCE_ID.test(source.source_id)) {
      fail("wechat_gateway_invalid_response");
    }
    const lastPrimaryOkAt = timestamp(source.last_primary_ok_at);
    const lastPaidCheckAt = timestamp(source.last_paid_check_at);
    if ([lastPrimaryOkAt, lastPaidCheckAt].some((value) => value !== null &&
      Date.parse(value) > Date.parse(asOf))) fail("wechat_gateway_invalid_response");
    return {
      source_id: source.source_id,
      last_primary_ok_at: lastPrimaryOkAt,
      consecutive_primary_failures: nonNegative(source.consecutive_primary_failures, true),
      recent_error_type: oneOf(source.recent_error_type,
        ["", "primary_feed_failed", "technical_error", "mapping_error"] as const),
      last_paid_check_at: lastPaidCheckAt,
      last_paid_result: oneOf(source.last_paid_result,
        ["", "ok", "technical_error", "mapping_error"] as const),
      alert_state: oneOf(source.alert_state,
        ["normal", "degraded", "paid_fallback", "alert"] as const),
      next_retry_at: timestamp(source.next_retry_at),
    };
  });
  const usage = record(root.usage);
  if (!Array.isArray(usage.days) || usage.days.length < 1 || usage.days.length > 31) {
    fail("wechat_gateway_invalid_response");
  }
  const seenDays = new Set<string>();
  const days = usage.days.map((raw) => {
    const row = record(raw);
    const value = day(row.day);
    if (seenDays.has(value)) fail("wechat_gateway_invalid_response");
    seenDays.add(value);
    return { day: value, calls: nonNegative(row.calls, true), amount: nonNegative(row.amount) };
  });
  for (let index = 1; index < days.length; index += 1) {
    const expected = new Date(Date.parse(`${days[index - 1].day}T00:00:00.000Z`) + 86_400_000)
      .toISOString().slice(0, 10);
    if (days[index].day !== expected) fail("wechat_gateway_invalid_response");
  }
  const limits = record(root.limits);
  if (typeof limits.paid_configured !== "boolean") fail("wechat_gateway_invalid_response");
  const calls = nonNegative(usage.calls, true);
  const amount = nonNegative(usage.amount);
  if (calls !== days.reduce((sum, row) => sum + row.calls, 0) ||
    Math.abs(amount - days.reduce((sum, row) => sum + row.amount, 0)) > 1e-9) {
    fail("wechat_gateway_invalid_response");
  }
  return {
    as_of: asOf,
    sources,
    usage: { today: day(usage.today), day: day(usage.day),
      calls, amount, days },
    limits: { daily_calls: nonNegative(limits.daily_calls, true),
      daily_rmb: nonNegative(limits.daily_rmb), paid_configured: limits.paid_configured },
  };
}

export function createWechatGatewayClient({ baseUrl, token, fetchImpl = fetch }: {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}) {
  const request = async (path: string, timeoutMs: number, init: RequestInit,
    exactStatus?: number): Promise<unknown> => {
    if (!token) fail("wechat_gateway_unavailable");
    const url = endpoint(baseUrl, path);
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
        fail("wechat_gateway_timeout");
      }
      return fail("wechat_gateway_unavailable");
    }
    if (!response.ok || (exactStatus !== undefined && response.status !== exactStatus)) {
      try { await response.body?.cancel(); } catch { /* response is already classified */ }
      return httpError(response.status);
    }
    const value = await readJson(response);
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string" && serialized.includes(token)) {
      fail("wechat_gateway_invalid_response");
    }
    return value;
  };

  return {
    async putSource(source: WechatGatewaySource): Promise<{ ok: true }> {
      const value = await request(`/v1/sources/${encodeURIComponent(source.source_id)}`, 20_000, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: source.name,
          account_id: source.wechat_id,
          priority: source.priority,
          sample_url: source.sample_url,
          primary_feed_url: source.primary_feed_url,
        }),
      }, 200);
      if (!value || typeof value !== "object" || Array.isArray(value) ||
        (value as Record<string, unknown>).ok !== true) fail("wechat_gateway_invalid_response");
      return { ok: true };
    },

    async listHealth(range?: { from: string; to: string }): Promise<{
      as_of: string; sources: WechatHealthRow[]; usage: WechatHealthUsage; limits: WechatHealthLimits;
    }> {
      let path = "/v1/health";
      if (range) {
        const from = day(range.from);
        const to = day(range.to);
        path += `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      }
      const value = await request(path, 30_000, { method: "GET" });
      return healthOverview(value);
    },
  };
}

export async function createProductionWechatGatewayClient() {
  const { prod } = await import("./config.ts");
  return createWechatGatewayClient({
    baseUrl: prod.wechatGatewayUrl,
    token: prod.wechatGatewayToken,
  });
}
