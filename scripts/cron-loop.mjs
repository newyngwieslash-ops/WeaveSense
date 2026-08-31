import { isMainModule } from "./with-app-env.mjs";

const DEFAULT_INTERVAL_MS = 1_800_000;
const MAX_INTERVAL_MS = 2_147_483_647;
// The server stops starting work at 600 seconds; this leaves 30 seconds to serialize and respond.
const REQUEST_TIMEOUT_MS = 630_000;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function failedStage(value) {
  return value && typeof value === "object" && value.ok === false ? 1 : 0;
}

function summarize(status, payload) {
  const collection = payload?.collection;
  const production = payload?.production;
  const reconciliation = payload?.reconciliation;
  const reconciliationQueue = payload?.reconciliation_queue;
  const scanErrors = Array.isArray(reconciliation?.source_results)
    ? reconciliation.source_results.filter((result) => result?.error).length
    : 0;
  return {
    timestamp: new Date().toISOString(),
    status,
    item_count: count(collection?.items_new),
    error_count: count(collection?.errors)
      + count(production?.ingest_errors)
      + count(production?.extract_errors)
      + count(reconciliation?.failed)
      + scanErrors
      + failedStage(collection)
      + failedStage(production)
      + failedStage(reconciliation)
      + count(reconciliationQueue?.failed)
      + (reconciliationQueue?.error ? 1 : 0),
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
