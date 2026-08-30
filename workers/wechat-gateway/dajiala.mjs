const PROVIDER = "dajiala";
const TIMEOUT_MS = 20_000;

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

function required(value, operation) {
  if (value == null || String(value).trim() === "") throw new DajialaError("mapping_error", operation, 200);
  return String(value).trim();
}

function isoTimestamp(value, operation) {
  const raw = required(value, operation);
  const numeric = Number(raw);
  const milliseconds = Number.isFinite(numeric)
    ? numeric * (Math.abs(numeric) < 1e12 ? 1_000 : 1)
    : Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new DajialaError("mapping_error", operation, 200);
  return new Date(milliseconds).toISOString();
}

function cost(value, fallback) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : fallback;
}

export function createDajialaClient({ key, verifycode = "", baseUrl, fetchImpl = fetch }) {
  if (!key || !String(key).trim()) throw new Error("Dajiala key is required");
  const endpoint = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!endpoint) throw new Error("Dajiala baseUrl is required");

  async function postJson(path, body, operation) {
    let response;
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, key, verifycode }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new DajialaError("technical_error", operation);
    }

    if (!response.ok) {
      const technical = response.status === 429 || response.status >= 500;
      throw new DajialaError(technical ? "technical_error" : "mapping_error", operation, response.status);
    }

    let payload;
    try {
      payload = await response.json();
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
        url: source.sample_url,
        page: 1,
      }, operation);
      if (!Array.isArray(payload.data)) throw new DajialaError("mapping_error", operation, status);
      const items = payload.data.map((item) => ({
        account_id: required(source.account_id, operation),
        account_name: required(source.name, operation),
        title: required(item?.title, operation),
        published_at: isoTimestamp(item?.post_time, operation),
        original_url: required(item?.url, operation),
        cover_url: item?.cover_url == null ? "" : String(item.cover_url).trim(),
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
        url: required(item?.original_url, operation),
      }, operation);
      return {
        ...item,
        account_name: required(payload.nickname, operation),
        title: required(payload.title, operation),
        published_at: isoTimestamp(payload.post_time, operation),
        original_url: required(payload.article_url, operation),
        cover_url: payload.cover_url == null ? "" : String(payload.cover_url).trim(),
        body_html: required(payload.content, operation),
        cost_money: cost(payload.cost_money, 0.045),
        attempt: { provider: PROVIDER, operation, status: "ok", http_status: status },
      };
    },
  };
}
