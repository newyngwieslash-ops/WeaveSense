import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { toAtom } from "./atom.mjs";
import { createDajialaClient } from "./dajiala.mjs";
import { canonicalWechatId, fetchPrimary } from "./primary.mjs";
import { alertState, nextPaidRetry, paidDecision, PAID_RETRY_MINUTES, shanghaiDay,
  shouldReconcile } from "./state-machine.mjs";
import { openStore } from "./store.mjs";

const PROVIDER = "dajiala";
const DAY_MS = 86_400_000;

export function authorize(headers, token) {
  const actual = headers.get("authorization");
  if (!token || !actual?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function validateSourceInput(input, allowedFeedHosts) {
  for (const field of ["id", "name", "sample_url", "primary_feed_url", "account_id"]) {
    if (typeof input?.[field] !== "string" || !input[field].trim()) throw new Error(`${field} is required`);
  }
  let sample;
  let feed;
  try { sample = new URL(input.sample_url); } catch { throw new Error("sample_url must be a WeChat URL"); }
  try { feed = new URL(input.primary_feed_url); } catch { throw new Error("primary_feed_url must be HTTP(S)"); }
  if (sample.protocol !== "https:" || sample.hostname !== "mp.weixin.qq.com") {
    throw new Error("sample_url must be an HTTPS WeChat URL");
  }
  if (!["http:", "https:"].includes(feed.protocol)) throw new Error("primary_feed_url must be HTTP(S)");
  if (allowedFeedHosts && !new Set([...allowedFeedHosts].map((host) => String(host).trim().toLowerCase()))
    .has(feed.hostname.toLowerCase())) throw new Error("primary_feed_url must use an allowed host");
  const priority = input.priority ?? "normal";
  if (!["normal", "high"].includes(priority)) throw new Error("priority must be normal or high");
  return { id: input.id.trim(), name: input.name.trim(), account_id: input.account_id.trim(), priority,
    sample_url: sample.toString(), primary_feed_url: feed.toString() };
}

const json = (status, body) => Response.json(body, { status });
const since = (date, days) => new Date(date.getTime() - days * DAY_MS).toISOString();

function clock(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must return a valid Date");
  return date;
}

function budgetOf(value = {}) {
  const configured = typeof value === "number" ? { rmb: value } : value;
  const rmb = Number(configured.rmb ?? configured.amount ?? configured.dailyRmbCap ?? 20);
  const calls = Number(configured.calls ?? configured.callLimit ?? configured.dailyCallCap ?? 250);
  if (!Number.isFinite(rmb) || rmb < 0 || !Number.isSafeInteger(calls) || calls < 0) {
    throw new TypeError("dailyBudget is invalid");
  }
  return { rmb, calls };
}

function bodyText(html) {
  return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function nextFailureAttempt(source) {
  if (source.last_paid_result !== "technical_error") return 1;
  const delay = (Date.parse(source.next_retry_at ?? "") - Date.parse(source.last_paid_check_at ?? "")) / 60_000;
  const previous = PAID_RETRY_MINUTES.indexOf(delay);
  return previous < 0 ? 1 : previous + 2;
}

function normalizeItem(item, source, date, provider = item?.provider ?? PROVIDER) {
  const publishedAt = String(item?.published_at ?? "");
  const originalUrl = String(item?.original_url ?? "");
  const title = String(item?.title ?? "");
  return {
    canonical_id: canonicalWechatId(originalUrl, source.account_id, title, publishedAt),
    account_id: source.account_id,
    account_name: String(item?.account_name ?? source.name),
    title,
    published_at: publishedAt,
    original_url: originalUrl,
    body_text: String(item?.body_text ?? bodyText(item?.body_html)),
    cover_url: String(item?.cover_url ?? ""),
    provider,
    discovered_at: String(item?.discovered_at ?? date.toISOString()),
  };
}

function atom(source, items) {
  return new Response(toAtom(source.source_id, source.name, items), {
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
}

export function createGateway({ store, primary = fetchPrimary, paid = null, token, dailyBudget,
  now = () => new Date(), allowedFeedHosts }) {
  if (!store) throw new TypeError("store is required");
  if (typeof primary !== "function") throw new TypeError("primary must be a function");
  const budget = budgetOf(dailyBudget);
  const inFlight = new Map();
  const usage = (day) => store.getProviderUsage(day, PROVIDER);
  const reserve = (date, estimate) => store.tryReserveSpend(shanghaiDay(date), PROVIDER,
    estimate, budget.rmb, budget.calls);

  function health(source, date) {
    const paidUsage = usage(shanghaiDay(date));
    return {
      source_id: source.source_id,
      alert_state: alertState(source, date),
      last_primary_ok_at: source.last_primary_ok_at,
      consecutive_primary_failures: source.consecutive_primary_failures,
      last_paid_check_at: source.last_paid_check_at,
      last_paid_result: source.last_paid_result,
      next_retry_at: source.next_retry_at,
      paid_configured: Boolean(paid),
      paid_day_amount: paidUsage.amount,
      paid_daily_budget: budget.rmb,
      paid_day_calls: paidUsage.calls,
      paid_daily_call_limit: budget.calls,
    };
  }

  async function runPaid(source, date) {
    if (!paid) return { response: json(503, { error: "paid_fallback_unavailable" }) };
    const listEstimate = Number(paid.estimatedListCost ?? 0.08);
    const listReservation = reserve(date, listEstimate);
    if (!listReservation) return { budgetExhausted: true };
    let listed;
    try {
      listed = await paid.listToday(source);
      store.adjustSpend(listReservation, Number(listed.cost_money ?? listEstimate));
    } catch (error) {
      store.adjustSpend(listReservation, listEstimate);
      const result = error?.kind === "mapping_error" ? "mapping_error" : "technical_error";
      const latest = store.getSource(source.source_id);
      const retry = result === "technical_error" ? nextPaidRetry(date, nextFailureAttempt(latest)) : null;
      store.recordPaidResult(source.source_id, result, retry,
        result === "mapping_error" ? "alert" : "degraded", date.toISOString());
      return { response: json(503, { error: result === "mapping_error"
        ? "paid_mapping_failed" : "paid_provider_failed" }) };
    }

    const cached = new Map(store.listGatewayItems(source.source_id, since(date, 30))
      .map((item) => [item.canonical_id, item]));
    const items = [];
    for (const raw of Array.isArray(listed.items) ? listed.items : []) {
      const listedItem = normalizeItem(raw, source, date);
      let item = listedItem;
      if (!cached.has(listedItem.canonical_id) && !listedItem.body_text
        && typeof paid.enrichArticle === "function") {
        const detailEstimate = Number(paid.estimatedDetailCost ?? 0.045);
        const detailReservation = reserve(date, detailEstimate);
        if (detailReservation) {
          try {
            const detailed = await paid.enrichArticle(raw);
            store.adjustSpend(detailReservation, Number(detailed.cost_money ?? detailEstimate));
            item = normalizeItem(detailed, source, date);
          } catch {
            store.adjustSpend(detailReservation, detailEstimate);
          }
        }
      }
      items.push(item);
    }
    store.upsertGatewayItems(source.source_id, items, date.toISOString());
    store.recordPaidResult(source.source_id, "ok", null, "paid_fallback", date.toISOString());
    store.deleteGatewayItemsBefore(since(date, 30));
    return { items: store.listGatewayItems(source.source_id, since(date, 7)) };
  }

  async function feed(source, date) {
    let primaryItems;
    try {
      primaryItems = await primary(source, date, allowedFeedHosts);
    } catch {
      store.recordPrimaryFailure(source.source_id, date.toISOString());
      const failed = store.getSource(source.source_id);
      if (!paidDecision(failed, date).allowed) return json(503, { error: "primary_feed_failed" });
      const fallback = await runPaid(failed, date);
      if (fallback.budgetExhausted) return json(429, { code: "paid_budget_exhausted" });
      return fallback.response ?? atom(failed, fallback.items);
    }
    store.upsertGatewayItems(source.source_id,
      primaryItems.map((item) => normalizeItem(item, source, date, "primary")), date.toISOString());
    store.recordPrimarySuccess(source.source_id, date.toISOString());
    store.deleteGatewayItemsBefore(since(date, 30));
    return atom(source, store.listGatewayItems(source.source_id, since(date, 7)));
  }

  async function lockedFeed(source, date) {
    let promise = inFlight.get(source.source_id);
    if (!promise) {
      promise = feed(source, date);
      inFlight.set(source.source_id, promise);
      promise.finally(() => {
        if (inFlight.get(source.source_id) === promise) inFlight.delete(source.source_id);
      }).catch(() => {});
    }
    return (await promise).clone();
  }

  async function reconcile(date) {
    const day = shanghaiDay(date);
    const result = { day, attempted: 0, succeeded: 0, failed: 0,
      succeeded_source_ids: [], budget_exhausted: false };
    if (!paid) return result;
    const successTime = (source) => Math.max(Date.parse(source.last_primary_ok_at ?? "") || 0,
      Date.parse(source.last_paid_ok_at ?? "") || 0);
    const candidates = store.listSources().filter((source) => shouldReconcile(source, date))
      .sort((a, b) => a.priority === b.priority ? successTime(a) - successTime(b)
        : a.priority === "high" ? -1 : 1);
    for (const source of candidates) {
      if (store.getProviderBudgetState(day, PROVIDER, budget.rmb, budget.calls) === "budget_exhausted") {
        result.budget_exhausted = true;
        break;
      }
      const paidResult = await runPaid(source, date);
      if (paidResult.budgetExhausted) {
        result.budget_exhausted = true;
        break;
      }
      result.attempted += 1;
      if (paidResult.items) {
        result.succeeded += 1;
        result.succeeded_source_ids.push(source.source_id);
      } else result.failed += 1;
    }
    return result;
  }

  return async function gateway(request) {
    try {
      if (!authorize(request.headers, token)) return json(401, { error: "unauthorized" });
      const url = new URL(request.url);
      let match = url.pathname.match(/^\/v1\/sources\/([^/]+)$/);
      if (request.method === "PUT" && match) {
        let input;
        try {
          const text = await request.text();
          if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("request body too large");
          input = validateSourceInput({ ...JSON.parse(text), id: decodeURIComponent(match[1]) }, allowedFeedHosts);
        } catch (error) {
          return json(422, { error: error instanceof Error ? error.message : "invalid source input" });
        }
        store.upsertSource(input, clock(now).toISOString());
        return json(200, { ok: true });
      }
      match = url.pathname.match(/^\/v1\/sources\/([^/]+)\/health$/);
      if (request.method === "GET" && match) {
        const source = store.getSource(decodeURIComponent(match[1]));
        return source ? json(200, health(source, clock(now))) : json(404, { error: "source not found" });
      }
      match = url.pathname.match(/^\/v1\/feeds\/([^/]+)\.atom$/);
      if (request.method === "GET" && match) {
        const source = store.getSource(decodeURIComponent(match[1]));
        return source ? await lockedFeed(source, clock(now)) : json(404, { error: "source not found" });
      }
      if (request.method === "POST" && url.pathname === "/v1/reconcile") {
        return json(200, await reconcile(clock(now)));
      }
      return json(404, { error: "not found" });
    } catch {
      return json(500, { error: "internal error" });
    }
  };
}

async function nodeRequest(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://gateway.local${req.url}`, {
    method: req.method, headers: req.headers, ...(body ? { body } : {}),
  });
}

async function nodeResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

export function createGatewayServer(options) {
  if (!options.allowedFeedHosts?.size) throw new Error("allowedFeedHosts is required");
  const gateway = createGateway(options);
  return createServer(async (req, res) => {
    try {
      if (!authorize(new Headers(req.headers), options.token)) {
        return await nodeResponse(res, json(401, { error: "unauthorized" }));
      }
      await nodeResponse(res, await gateway(await nodeRequest(req)));
    } catch { await nodeResponse(res, json(500, { error: "internal error" })); }
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = requiredEnv("WECHAT_GATEWAY_TOKEN");
  const dbPath = requiredEnv("GATEWAY_DB_PATH");
  const port = Number(requiredEnv("PORT"));
  const allowedFeedHosts = new Set(requiredEnv("WECHAT_PRIMARY_ALLOWED_HOSTS")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (!allowedFeedHosts.size) throw new Error("WECHAT_PRIMARY_ALLOWED_HOSTS is required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid port");
  const key = process.env.DAJIALA_KEY?.trim();
  const paid = key ? createDajialaClient({ key,
    verifycode: process.env.DAJIALA_VERIFYCODE ?? "",
    baseUrl: process.env.DAJIALA_BASE_URL ?? "https://www.dajiala.com/fbmain/monitor/v3" }) : null;
  const store = openStore(dbPath);
  const server = createGatewayServer({ store, token, paid, allowedFeedHosts, dailyBudget: {
    rmb: positiveNumber("DAJIALA_DAILY_BUDGET_RMB", 20),
    calls: positiveNumber("DAJIALA_DAILY_CALL_LIMIT", 250),
  } }).listen(port, "0.0.0.0");
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => { store.close(); process.exit(0); });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
