import { isMainModule } from "./with-app-env.mjs";

const DEFAULT_INTERVAL_MS = 1_800_000;
const MAX_INTERVAL_MS = 2_147_483_647;
// The server stops starting work at 720 seconds; this leaves 30 seconds to serialize and respond.
const REQUEST_TIMEOUT_MS = 750_000;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function failedStage(value) {
  return value && typeof value === "object" && value.ok === false ? 1 : 0;
}

/**
 * T16: per-stage outcome, so a failing tick can be located instead of just counted.
 *
 * The previous summary exposed only `status`, `item_count` and a single summed
 * `error_count` — an operator could see "8 errors" but not whether they came from
 * collection, media ingest, extraction, reconciliation or the wechat queue.
 *
 * Rules kept from the plan:
 *   - existing fields (`timestamp`, `status`, `item_count`, `error_count`) stay,
 *     so existing consumers keep working;
 *   - `stages` is a small object of stable stage names → short status strings;
 *   - `error_code` contains only stable codes. Never a URL, query string, token
 *     or provider body: those can carry credentials or private queries.
 */
/** A failed stage's stable code, or "" when the stage reported success. */
function stageStatus(value, okName = "ok") {
  if (value === null || value === undefined) return "skipped";
  if (typeof value !== "object") return "invalid";
  if (value.ok === false) {
    // `error` here is already a fixed code from the server (e.g. collection_failed).
    const code = typeof value.error === "string" && /^[a-z0-9_]{1,40}$/.test(value.error)
      ? value.error : "failed";
    return code;
  }
  const errorCount = count(value.errors) + count(value.ingest_errors) + count(value.extract_errors)
    + count(value.failed);
  if (errorCount > 0) return "partial";
  return okName;
}

function summarize(status, payload) {
  const collection = payload?.collection;
  const production = payload?.production;
  const reconciliation = payload?.reconciliation;
  const reconciliationQueue = payload?.reconciliation_queue;
  const scanErrors = Array.isArray(reconciliation?.source_results)
    ? reconciliation.source_results.filter((result) => result?.error).length
    : 0;

  const stages = {
    collection: stageStatus(collection, payload?.collection ? "ok" : "skipped"),
    production: stageStatus(production, payload?.production ? "ok" : "skipped"),
    reconciliation: stageStatus(reconciliation, payload?.reconciliation ? "ok" : "skipped"),
    queue: stageStatus(reconciliationQueue, payload?.reconciliation_queue ? "ok" : "skipped"),
    delivery_ack: stageStatus(reconciliation?.delivery_ack, payload?.reconciliation?.delivery_ack ? "ok" : "skipped"),
  };

  // Stable, non-sensitive reason codes for whichever stages did not come back ok.
  const codes = Object.entries(stages)
    .filter(([, value]) => !["ok", "skipped", "partial"].includes(value))
    .map(([name, value]) => `${name}:${value}`);

  const error_count = count(collection?.errors)
    + count(production?.ingest_errors)
    + count(production?.extract_errors)
    + count(reconciliation?.failed)
    + scanErrors
    + failedStage(collection)
    + failedStage(production)
    + failedStage(reconciliation)
    + failedStage(reconciliation?.delivery_ack)
    + count(reconciliationQueue?.failed)
    + (reconciliationQueue?.error ? 1 : 0);

  return {
    timestamp: new Date().toISOString(),
    status,
    item_count: count(collection?.items_new),
    error_count,
    // T16 additions (existing fields above are unchanged):
    stages,
    duration_ms: count(payload?.duration_ms),
    deferred: count(collection?.deferred) + count(production?.deferred)
      + count(reconciliationQueue?.deferred),
    error_code: codes.join(","),
  };
}

function failure(status) {
  return { timestamp: new Date().toISOString(), status, item_count: 0, error_count: 1 };
}

export function createCronLoop({
  endpoint,
  secret,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  onResult = () => {},
  onError = () => {},
}) {
  if (!endpoint || !secret) throw new TypeError("endpoint and secret are required");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > MAX_INTERVAL_MS) {
    throw new TypeError("intervalMs must be a positive 32-bit timer integer");
  }
  let running = false;
  let timer = null;

  async function runOnce() {
    if (running) return null;
    running = true;
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        onError(failure(0));
        throw new Error("cron_request_failed");
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* response is already classified */ }
        onError(failure(response.status));
        throw new Error("cron_http_error");
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        onError(failure(response.status));
        throw new Error("cron_invalid_response");
      }
      const result = summarize(response.status, payload);
      onResult(result);
      return result;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    const tick = () => { void runOnce().catch(() => undefined); };
    tick();
    timer = setInterval(tick, intervalMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

function main() {
  const endpoint = process.env.CRON_ENDPOINT?.trim();
  const secret = process.env.CRON_SECRET?.trim();
  if (!endpoint || !secret) throw new Error("CRON_ENDPOINT and CRON_SECRET are required");
  const configuredInterval = process.env.CRON_INTERVAL_MS?.trim();
  const intervalMs = configuredInterval ? Number(configuredInterval) : DEFAULT_INTERVAL_MS;
  const write = (result) => process.stdout.write(`${JSON.stringify(result)}\n`);
  const loop = createCronLoop({ endpoint, secret, intervalMs, onResult: write, onError: write });
  loop.start();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => loop.stop());
}

if (isMainModule(import.meta.url)) main();
