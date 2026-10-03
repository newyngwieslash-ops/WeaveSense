const PROVIDER = "dajiala";
const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MIN_TIMESTAMP = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 7 * 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const WECHAT_HOSTS = new Set(["mp.weixin.qq.com"]);
const COVER_HOSTS = new Set(["mmbiz.qpic.cn", "mmbiz.qlogo.cn"]);

/**
 * T13: the safe sub-codes a failed paid call may carry.
 *
 * `technical_error` on its own cannot tell an operator whether to retry, raise a
 * price bound, or treat a charge as possible. These codes are stable and contain
 * nothing sensitive: no URL, no query string, no provider body, no key.
 */
const TECH_CODES = new Set(["timeout", "network", "rate_limited", "provider_5xx", "invalid_response"]);

/** A usable cost bound, or null. Zero, negatives and non-numbers are refused. */
function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

class DajialaError extends Error {
  constructor(kind, operation, httpStatus = null, code = null) {
    const subCode = kind === "technical_error"
      ? (TECH_CODES.has(code) ? code : "network")
      : null;
    super(`Dajiala ${operation} failed: ${kind}${subCode ? `:${subCode}` : ""}`);
    this.name = "DajialaError";
    this.kind = kind;
    // Stable machine-readable reason; never derived from provider text.
    this.code = subCode ?? (kind === "mapping_error" ? "invalid_response" : "network");
    this.retryable = kind === "technical_error";
    this.attempt = {
      provider: PROVIDER,
      operation,
      status: "error",
      error_type: kind,
      error_code: this.code,
      http_status: httpStatus,
    };
  }
}

function required(value, operation, httpStatus = null) {
  if (value == null || String(value).trim() === "") {
    throw new DajialaError("mapping_error", operation, httpStatus);
  }
  return String(value).trim();
}

function isoTimestamp(value, operation, httpStatus) {
  const raw = required(value, operation, httpStatus);
  let milliseconds;
  if ((typeof value === "number" && Number.isSafeInteger(value))
    || (typeof value === "string" && /^-?\d+$/.test(raw))) {
    const integer = Number(raw);
    if (!Number.isSafeInteger(integer)) throw new DajialaError("mapping_error", operation, httpStatus);
    milliseconds = Math.abs(integer) >= MIN_TIMESTAMP ? integer : integer * 1_000;
  } else if (typeof value === "string" && ISO_TIMESTAMP.test(raw)) {
    milliseconds = Date.parse(raw);
  } else {
    throw new DajialaError("mapping_error", operation, httpStatus);
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())
    || date.getTime() < MIN_TIMESTAMP
    || date.getTime() > Date.now() + MAX_FUTURE_MS) {
    throw new DajialaError("mapping_error", operation, httpStatus);
  }
  return date.toISOString();
}

function cost(value, fallback) {
  const amount = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : fallback;
}

function hasExplicitPort(raw) {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  return /:\d*$/.test(authority.slice(authority.lastIndexOf("@") + 1));
}

function safeUrl(value, operation, httpStatus, allowedHosts, optional = false) {
  if (optional && (value == null || String(value).trim() === "")) return "";
  const raw = required(value, operation, httpStatus);
  let url;
  try { url = new URL(raw); } catch { throw new DajialaError("mapping_error", operation, httpStatus); }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || hasExplicitPort(raw)
    || !allowedHosts.has(url.hostname)) {
    throw new DajialaError("mapping_error", operation, httpStatus);
  }
  return raw;
}

function wechatUrl(value, operation, httpStatus = null) {
  return safeUrl(value, operation, httpStatus, WECHAT_HOSTS);
}

function providerWechatUrl(value, operation, httpStatus) {
  const raw = required(value, operation, httpStatus);
  let url;
  try { url = new URL(raw); } catch { throw new DajialaError("mapping_error", operation, httpStatus); }
  if (hasExplicitPort(raw)) throw new DajialaError("mapping_error", operation, httpStatus);
  if (url.protocol === "http:") url.protocol = "https:";
  return safeUrl(url.toString(), operation, httpStatus, WECHAT_HOSTS);
}

function coverUrl(value, operation, httpStatus) {
  return safeUrl(value, operation, httpStatus, COVER_HOSTS, true);
}

function normalizedBaseUrl(value) {
  let url;
  try { url = new URL(String(value ?? "")); } catch { throw new Error("Dajiala baseUrl must be an HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Dajiala baseUrl must be an HTTPS URL without credentials, query, or hash");
  }
  return url.toString().replace(/\/+$/, "");
}

async function cancel(body) {
  try { await body?.cancel(); } catch { /* cancellation is best effort */ }
}

async function readLimited(response, operation) {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader == null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await cancel(response.body);
    throw new DajialaError("mapping_error", operation, response.status);
  }
  if (!response.body) return "";

  let reader;
  try { reader = response.body.getReader(); } catch {
    throw new DajialaError("technical_error", operation, response.status, "invalid_response");
  }
  const chunks = [];
  let size = 0;
  while (true) {
    let part;
    try {
      part = await reader.read();
    } catch {
      try { await reader.cancel(); } catch { /* cancellation is best effort */ }
      throw new DajialaError("technical_error", operation, response.status, "network");
    }
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* cancellation is best effort */ }
      throw new DajialaError("mapping_error", operation, response.status);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export function createDajialaClient({ key, verifycode = "", baseUrl, fetchImpl = fetch,
  estimatedListCost = null, estimatedDetailCost = null }) {
  if (!key || !String(key).trim()) throw new Error("Dajiala key is required");
  const endpoint = normalizedBaseUrl(baseUrl);
  const apiKey = String(key).trim();
  const verificationCode = String(verifycode ?? "");

  async function postJson(path, body, operation) {
    let response;
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, key: apiKey, verifycode: verificationCode }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      // Distinguish a timeout from a connection-level failure: both are unknown
      // outcomes, but they call for different operator responses.
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new DajialaError("technical_error", operation, null, timeout ? "timeout" : "network");
    }

    if (!response.ok) {
      await cancel(response.body);
      if (response.status === 429) throw new DajialaError("technical_error", operation, response.status, "rate_limited");
      if (response.status >= 500) throw new DajialaError("technical_error", operation, response.status, "provider_5xx");
      throw new DajialaError("mapping_error", operation, response.status);
    }

    const text = await readLimited(response, operation);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DajialaError("mapping_error", operation, response.status);
    }
    if (!payload || typeof payload !== "object" || payload.code !== 0) {
      throw new DajialaError("mapping_error", operation, response.status);
    }
    return { payload, status: response.status };
  }

  return {
    // T13: the estimate is a RESERVATION, not a cap and not a price claim. It is
    // operator-supplied and must be a verified upper bound for this account's
    // real per-call cost; the adapter no longer asserts a hardcoded 0.08, which
    // the incident history shows was below the real charge (0.14). Withholding it
    // is safe: the gateway then refuses paid admission instead of guessing.
    estimatedListCost: positiveOrNull(estimatedListCost),
    estimatedDetailCost: positiveOrNull(estimatedDetailCost),

    async listToday(source) {
      const operation = "list_today";
      const { payload, status } = await postJson("/post_condition", {
        url: wechatUrl(source.sample_url, operation),
        page: 1,
      }, operation);
      if (!Array.isArray(payload.data)) throw new DajialaError("mapping_error", operation, status);
      const items = payload.data.map((item) => ({
        account_id: required(source.account_id, operation, status),
        account_name: required(source.name, operation, status),
        title: required(item?.title, operation, status),
        published_at: isoTimestamp(item?.post_time, operation, status),
        original_url: providerWechatUrl(item?.url, operation, status),
        cover_url: coverUrl(item?.cover_url, operation, status),
        provider: PROVIDER,
      }));
      return {
        items,
        cost_money: cost(payload.cost_money, 0.08),
        attempt: { provider: PROVIDER, operation, status: "ok", http_status: status },
      };
    },

    async enrichArticle(item) {
      const operation = "article_detail";
      const { payload, status } = await postJson("/article_detail", {
        url: wechatUrl(item?.original_url, operation),
      }, operation);
      return {
        ...item,
        account_name: required(payload.nickname, operation, status),
        title: required(payload.title, operation, status),
        published_at: isoTimestamp(payload.post_time, operation, status),
        original_url: providerWechatUrl(payload.article_url, operation, status),
        cover_url: coverUrl(payload.cover_url, operation, status),
        body_html: required(payload.content, operation, status),
        cost_money: cost(payload.cost_money, 0.045),
        attempt: { provider: PROVIDER, operation, status: "ok", http_status: status },
      };
    },
  };
}
