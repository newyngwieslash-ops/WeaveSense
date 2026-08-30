const PROVIDER = "dajiala";
const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MIN_TIMESTAMP = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 7 * 24 * 60 * 60 * 1_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const WECHAT_HOSTS = new Set(["mp.weixin.qq.com"]);
const COVER_HOSTS = new Set(["mmbiz.qpic.cn", "mmbiz.qlogo.cn"]);

class DajialaError extends Error {
  constructor(kind, operation, httpStatus = null) {
    super(`Dajiala ${operation} failed: ${kind}`);
    this.name = "DajialaError";
    this.kind = kind;
    this.retryable = kind === "technical_error";
    this.attempt = {
      provider: PROVIDER,
      operation,
      status: "error",
      error_type: kind,
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

function safeUrl(value, operation, httpStatus, allowedHosts, optional = false) {
  if (optional && (value == null || String(value).trim() === "")) return "";
  const raw = required(value, operation, httpStatus);
  let url;
  try { url = new URL(raw); } catch { throw new DajialaError("mapping_error", operation, httpStatus); }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !allowedHosts.has(url.hostname)) {
    throw new DajialaError("mapping_error", operation, httpStatus);
  }
  return raw;
}

function wechatUrl(value, operation, httpStatus = null) {
  return safeUrl(value, operation, httpStatus, WECHAT_HOSTS);
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
    throw new DajialaError("technical_error", operation, response.status);
  }
  const chunks = [];
  let size = 0;
  while (true) {
    let part;
    try {
      part = await reader.read();
    } catch {
      try { await reader.cancel(); } catch { /* cancellation is best effort */ }
      throw new DajialaError("technical_error", operation, response.status);
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

export function createDajialaClient({ key, verifycode = "", baseUrl, fetchImpl = fetch }) {
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
    } catch {
      throw new DajialaError("technical_error", operation);
    }

    if (!response.ok) {
      await cancel(response.body);
      const technical = response.status === 429 || response.status >= 500;
      throw new DajialaError(technical ? "technical_error" : "mapping_error", operation, response.status);
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
    estimatedListCost: 0.08,
    estimatedDetailCost: 0.045,

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
        original_url: wechatUrl(item?.url, operation, status),
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
        original_url: wechatUrl(payload.article_url, operation, status),
        cover_url: coverUrl(payload.cover_url, operation, status),
        body_html: required(payload.content, operation, status),
        cost_money: cost(payload.cost_money, 0.045),
        attempt: { provider: PROVIDER, operation, status: "ok", http_status: status },
      };
    },
  };
}
