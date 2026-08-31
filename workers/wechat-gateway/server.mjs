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
const DEFAULT_RECONCILIATION_BUDGET_MS = 100_000;
const PAID_CALL_RESERVE_MS = 22_000;
const SAFE_SOURCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

class BodyTooLargeError extends Error {}

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
    body_text: String(item?.body_text || bodyText(item?.body_html)),
    body_complete: item?.body_complete === true,
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
  now = () => new Date(), allowedFeedHosts,
  reconciliationBudgetMs = DEFAULT_RECONCILIATION_BUDGET_MS }) {
  if (!store) throw new TypeError("store is required");
  if (typeof primary !== "function") throw new TypeError("primary must be a function");
  const budget = budgetOf(dailyBudget);
  // ponytail: single-process lock; replace with a SQLite claim before running gateway replicas.
  const sourceOperations = new Map();
  const usage = (day) => store.getProviderUsage(day, PROVIDER);
  const reserve = (date, estimate) => store.tryReserveSpend(shanghaiDay(date), PROVIDER,
    estimate, budget.rmb, budget.calls);

  function sourceLock(sourceId, kind, task) {
    const current = sourceOperations.get(sourceId);
    if (current) {
      if (kind === "feed" && current.kind === "feed") return current.promise;
      return current.promise.catch(() => {}).then(() => sourceLock(sourceId, kind, task));
    }
    const promise = Promise.resolve().then(task);
    const operation = { kind, promise };
    sourceOperations.set(sourceId, operation);
    promise.finally(() => {
      if (sourceOperations.get(sourceId) === operation) sourceOperations.delete(sourceId);
    }).catch(() => {});
    return promise;
  }

  function health(source, date) {
    const paidUsage = usage(shanghaiDay(date));
    const paidAt = Date.parse(source.last_paid_check_at ?? "");
    const primaryAt = Date.parse(source.last_primary_ok_at ?? "");
    const nowMs = date.getTime();
    const validPaidAt = Number.isFinite(paidAt) && paidAt <= nowMs;
    const validPrimaryAt = Number.isFinite(primaryAt) && primaryAt <= nowMs;
    const unresolvedPaidError = validPaidAt && (!validPrimaryAt || primaryAt < paidAt);
    const dynamicAlert = alertState(source, date);
    const projectedAlert = dynamicAlert === "alert" ? "alert"
      : unresolvedPaidError && source.last_paid_result === "mapping_error" ? "alert"
      : unresolvedPaidError && source.last_paid_result === "technical_error" ? "degraded"
        : dynamicAlert;
    return {
      source_id: source.source_id,
      alert_state: projectedAlert,
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

  async function runPaid(source, current, reconciliationDay = null, deadlineMs = null) {
    if (!paid) return { response: json(503, { error: "paid_fallback_unavailable" }) };
    const listEstimate = Number(paid.estimatedListCost ?? 0.08);
    const listStarted = current();
    if (deadlineMs !== null && listStarted.getTime() + PAID_CALL_RESERVE_MS > deadlineMs) {
      return { deadlineDeferred: true, deferredPaidCalls: 1, spentDays: [] };
    }
    if (reconciliationDay && shanghaiDay(listStarted) !== reconciliationDay) {
      return { batchExpired: true, spentDays: [] };
    }
    const spentDays = new Set([shanghaiDay(listStarted)]);
    const listReservation = reserve(listStarted, listEstimate);
    if (!listReservation) return { budgetExhausted: true, spentDays: [...spentDays] };
    let listed;
    try {
      listed = await paid.listToday(source);
      store.adjustSpend(listReservation, Number(listed.cost_money ?? listEstimate));
    } catch (error) {
      store.adjustSpend(listReservation, listEstimate);
      const completed = current();
      const result = error?.kind === "mapping_error" ? "mapping_error" : "technical_error";
      const latest = store.getSource(source.source_id);
      const retry = result === "technical_error" ? nextPaidRetry(completed, nextFailureAttempt(latest)) : null;
      store.recordPaidResult(source.source_id, result, retry,
        result === "mapping_error" ? "alert" : "degraded", completed.toISOString());
      return { response: json(503, { error: result === "mapping_error"
        ? "paid_mapping_failed" : "paid_provider_failed" }), spentDays: [...spentDays] };
    }

    const listedAt = current();
    const cached = new Map(store.listGatewayItems(source.source_id, since(listedAt, 30))
      .map((item) => [item.canonical_id, item]));
    const unique = new Map();
    for (const raw of Array.isArray(listed.items) ? listed.items : []) {
      const item = normalizeItem(raw, source, listedAt);
      if (!unique.has(item.canonical_id)) unique.set(item.canonical_id, { raw, item });
    }
    const items = [];
    let deadlineDeferred = false;
    let deferredPaidCalls = 0;
    for (const { raw, item: listedItem } of unique.values()) {
      let item = listedItem;
      const cachedItem = cached.get(listedItem.canonical_id);
      if (!listedItem.body_complete && !Boolean(cachedItem?.body_complete)
        && typeof paid.enrichArticle === "function") {
        const detailEstimate = Number(paid.estimatedDetailCost ?? 0.045);
        const detailStarted = deadlineDeferred ? null : current();
        if (!detailStarted || (deadlineMs !== null
          && detailStarted.getTime() + PAID_CALL_RESERVE_MS > deadlineMs)) {
          deadlineDeferred = true;
          deferredPaidCalls += 1;
          store.enqueueDetail(source.source_id, listedItem, current().toISOString());
          items.push(item);
          continue;
        }
        if (reconciliationDay && shanghaiDay(detailStarted) !== reconciliationDay) {
          store.enqueueDetail(source.source_id, listedItem, detailStarted.toISOString());
          items.push(item);
          continue;
        }
        spentDays.add(shanghaiDay(detailStarted));
        const detailReservation = reserve(detailStarted, detailEstimate);
        if (detailReservation) {
          try {
            const detailed = await paid.enrichArticle(raw);
            store.adjustSpend(detailReservation, Number(detailed.cost_money ?? detailEstimate));
            item = normalizeItem({ ...detailed, body_complete: true }, source, current());
          } catch (error) {
            store.adjustSpend(detailReservation, detailEstimate);
            if (error?.kind !== "mapping_error" && error?.retryable !== false) {
              const failedAt = current();
              store.enqueueDetail(source.source_id, listedItem, failedAt.toISOString(), "technical_error",
                nextPaidRetry(failedAt, 1));
            } else store.removePendingDetail(source.source_id, listedItem.canonical_id);
          }
        } else store.enqueueDetail(source.source_id, listedItem, current().toISOString());
      }
      items.push(item);
    }
    const completed = current();
    store.upsertGatewayItems(source.source_id, items, completed.toISOString());
    store.recordPaidResult(source.source_id, "ok", null, "paid_fallback",
      completed.toISOString(), listStarted.toISOString(), Boolean(reconciliationDay));
    store.deleteGatewayItemsBefore(since(completed, 30));
    return { items: store.listGatewayItems(source.source_id, since(completed, 7)),
      spentDays: [...spentDays], deadlineDeferred, deferredPaidCalls };
  }

  async function feed(source, date) {
    let primaryItems;
    try {
      primaryItems = await primary(source, date, allowedFeedHosts);
    } catch {
      const failedAt = clock(now);
      store.recordPrimaryFailure(source.source_id, failedAt.toISOString());
      const failed = store.getSource(source.source_id);
      if (!paidDecision(failed, failedAt).allowed) return json(503, { error: "primary_feed_failed" });
      const fallback = await runPaid(failed, () => clock(now));
      if (fallback.budgetExhausted) return json(429, { code: "paid_budget_exhausted" });
      return fallback.response ?? atom(failed, fallback.items);
    }
    const completed = clock(now);
    store.upsertGatewayItems(source.source_id,
      primaryItems.map((item) => normalizeItem(item, source, completed, "primary")), completed.toISOString());
    store.recordPrimarySuccess(source.source_id, completed.toISOString());
    store.deleteGatewayItemsBefore(since(completed, 30));
    return atom(source, store.listGatewayItems(source.source_id, since(completed, 7)));
  }

  async function lockedFeed(source, date) {
    const observedPaidAt = source.last_paid_check_at;
    const response = await sourceLock(source.source_id, "feed", async () => {
      const fresh = store.getSource(source.source_id);
      if (fresh.last_paid_result === "ok" && fresh.last_paid_check_at !== observedPaidAt) {
        return atom(fresh, store.listGatewayItems(fresh.source_id, since(clock(now), 7)));
      }
      return feed(fresh, date);
    });
    return response.clone();
  }

  async function reconcile(date) {
    const day = shanghaiDay(date);
    const deadlineMs = date.getTime() + reconciliationBudgetMs;
    const result = { day, attempted: 0, succeeded: 0, failed: 0,
      succeeded_source_ids: [], budget_exhausted: false };
    let completedDetails = 0;
    let deferredDetails = store.pendingDetailCount();
    if (paid && typeof paid.enrichArticle === "function") {
      for (const pending of store.listDueDetails(clock(now).toISOString(), 2)) {
        const detailResult = await sourceLock(pending.source_id, "reconcile", async () => {
          const detailStarted = clock(now);
          if (detailStarted.getTime() + PAID_CALL_RESERVE_MS > deadlineMs) return "deferred";
          if (Boolean(store.getGatewayItem(pending.source_id, pending.canonical_id)?.body_complete)) {
            store.removePendingDetail(pending.source_id, pending.canonical_id);
            return "completed";
          }
          const source = store.getSource(pending.source_id);
          if (!source) return "failed";
          const detailEstimate = Number(paid.estimatedDetailCost ?? 0.045);
          const reservation = reserve(detailStarted, detailEstimate);
          if (!reservation) return "budget";
          let settled = false;
          try {
            const detailed = await paid.enrichArticle(pending.item);
            store.adjustSpend(reservation, Number(detailed.cost_money ?? detailEstimate));
            settled = true;
            const completed = clock(now);
            store.completeDetail(source.source_id, pending.canonical_id,
              normalizeItem({ ...detailed, body_complete: true }, source, completed), completed.toISOString());
            return "completed";
          } catch (error) {
            if (!settled) store.adjustSpend(reservation, detailEstimate);
            if (error?.kind === "mapping_error" || error?.retryable === false) {
              store.removePendingDetail(pending.source_id, pending.canonical_id);
            } else {
              const failedAt = clock(now);
              store.enqueueDetail(pending.source_id, pending.item, failedAt.toISOString(), "technical_error",
                nextPaidRetry(failedAt, Number(pending.attempts) + 1));
            }
            return "failed";
          }
        });
        if (detailResult === "deferred") break;
        if (detailResult === "budget") { result.budget_exhausted = true; break; }
        if (detailResult === "completed") completedDetails += 1;
      }
      deferredDetails = store.pendingDetailCount();
    }
    if (!paid) return { ...result, outbox_source_ids: store.listReconciliationOutbox(),
      pending_details: deferredDetails, completed_details: completedDetails };
    const successTime = (source) => Math.max(Date.parse(source.last_primary_ok_at ?? "") || 0,
      Date.parse(source.last_paid_ok_at ?? "") || 0);
    const candidates = store.listSources().filter((source) => shouldReconcile(source, date))
      .sort((a, b) => a.priority === b.priority ? successTime(a) - successTime(b)
        : a.priority === "high" ? -1 : 1);
    for (let index = 0; index < candidates.length; index += 1) {
      const source = candidates[index];
      let paidResult;
      try {
        paidResult = await sourceLock(source.source_id, "reconcile", async () => {
          const operationNow = clock(now);
          if (shanghaiDay(operationNow) !== day) return { batchExpired: true };
          if (operationNow.getTime() + PAID_CALL_RESERVE_MS > deadlineMs) {
            return { deadlineDeferred: true, deferredPaidCalls: 1 };
          }
          const fresh = store.getSource(source.source_id);
          if (!fresh || !shouldReconcile(fresh, operationNow)) return { skipped: true };
          if (store.getProviderBudgetState(day, PROVIDER, budget.rmb, budget.calls)
            === "budget_exhausted") return { budgetExhausted: true };
          return runPaid(fresh, () => clock(now), day, deadlineMs);
        });
      } catch {
        result.attempted += 1;
        result.failed += 1;
        const failedDay = shanghaiDay(clock(now));
        if ([day, failedDay].some((spentDay) => store.getProviderBudgetState(
          spentDay, PROVIDER, budget.rmb, budget.calls) === "budget_exhausted")) {
          result.budget_exhausted = true;
          break;
        }
        if (failedDay !== day) break;
        continue;
      }
      if (paidResult.batchExpired) break;
      if (paidResult.skipped) continue;
      if (paidResult.deadlineDeferred && !paidResult.items) {
        result.budget_deferred = true;
        result.deferred = candidates.length - index;
        result.deferred_paid_calls = paidResult.deferredPaidCalls ?? 1;
        break;
      }
      if (paidResult.budgetExhausted) {
        result.budget_exhausted = true;
        break;
      }
      result.attempted += 1;
      if (paidResult.items) {
        result.succeeded += 1;
        result.succeeded_source_ids.push(source.source_id);
      } else result.failed += 1;
      if (paidResult.deadlineDeferred) {
        result.budget_deferred = true;
        result.deferred = candidates.length - index - 1;
        result.deferred_paid_calls = paidResult.deferredPaidCalls ?? 0;
        break;
      }
      if ((paidResult.spentDays ?? [day]).some((spentDay) => store.getProviderBudgetState(
        spentDay, PROVIDER, budget.rmb, budget.calls) === "budget_exhausted")) {
        result.budget_exhausted = true;
        break;
      }
    }
    if (store.getProviderBudgetState(day, PROVIDER, budget.rmb, budget.calls)
      === "budget_exhausted") result.budget_exhausted = true;
    return { ...result, outbox_source_ids: store.listReconciliationOutbox(),
      pending_details: store.pendingDetailCount(), completed_details: completedDetails };
  }

  return async function gateway(request) {
    try {
      if (!authorize(request.headers, token)) return json(401, { error: "unauthorized" });
      const url = new URL(request.url);
      let match = url.pathname.match(/^\/v1\/sources\/([^/]+)$/);
      if (request.method === "PUT" && match) {
        let parsed;
        let input;
        try {
          const text = await request.text();
          if (Buffer.byteLength(text) > 1024 * 1024) throw new BodyTooLargeError();
          try { parsed = JSON.parse(text); }
          catch (error) {
            if (error instanceof SyntaxError) return json(422, { error: "invalid JSON" });
            throw error;
          }
          input = validateSourceInput({ ...parsed, id: decodeURIComponent(match[1]) }, allowedFeedHosts);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return json(413, { error: "request body too large" });
          return json(422, { error: error instanceof Error ? error.message : "invalid source input" });
        }
        try {
          await sourceLock(input.id, "put", () => store.upsertSource(input, clock(now).toISOString()));
          return json(200, { ok: true });
        } catch (error) {
          return json(422, { error: error instanceof Error ? error.message : "invalid source input" });
        }
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
      if (request.method === "POST" && url.pathname === "/v1/reconcile/ack") {
        let body;
        try {
          const text = await request.text();
          if (Buffer.byteLength(text) > 1024 * 1024) throw new BodyTooLargeError();
          body = JSON.parse(text);
        } catch (error) {
          if (error instanceof BodyTooLargeError) return json(413, { error: "request body too large" });
          return json(422, { error: "invalid JSON" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 1 || !Array.isArray(body.source_ids)
          || body.source_ids.length > 500 || new Set(body.source_ids).size !== body.source_ids.length
          || body.source_ids.some((id) => typeof id !== "string" || !SAFE_SOURCE_ID.test(id))) {
          return json(422, { error: "invalid source_ids" });
        }
        return json(200, { acked: store.ackReconciliationOutbox(body.source_ids) });
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
    if (size > 1024 * 1024) throw new BodyTooLargeError();
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
    } catch (error) {
      await nodeResponse(res, error instanceof BodyTooLargeError
        ? json(413, { error: "request body too large" })
        : json(500, { error: "internal error" }));
    }
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
