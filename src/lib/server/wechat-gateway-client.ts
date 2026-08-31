const MAX_RESPONSE_BYTES = 1024 * 1024;

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
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
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

    async listHealth(): Promise<Record<string, unknown>> {
      const value = await request("/v1/health", 30_000, { method: "GET" });
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("wechat_gateway_invalid_response");
      }
      return value as Record<string, unknown>;
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
