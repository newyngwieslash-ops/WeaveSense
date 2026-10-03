import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCronLoop } from "./cron-loop.mjs";

test("runOnce posts the protected cron request with response margin over the server budget", async () => {
  const originalTimeout = AbortSignal.timeout;
  const signal = new AbortController().signal;
  AbortSignal.timeout = (milliseconds) => {
    assert.equal(milliseconds, 750_000);
    return signal;
  };
  try {
    const results = [];
    const loop = createCronLoop({
      endpoint: "http://app:8080/api/cron/tick",
      secret: "cron-test",
      intervalMs: 1_800_000,
      fetchImpl: async (url, init) => {
        assert.equal(url, "http://app:8080/api/cron/tick");
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cron-test");
        assert.equal(init?.signal, signal);
        return Response.json({
          collection: { items_new: 3, errors: 1 },
          production: { ingest_errors: 2, extract_errors: 1 },
          reconciliation: { failed: 4 },
        });
      },
      onResult: (result) => results.push(result),
    });
    const result = await loop.runOnce();
    assert.equal(result.status, 200);
    assert.equal(result.item_count, 3);
    assert.equal(result.error_count, 8);
    assert.match(result.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(results, [result]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

test("runOnce rejects non-2xx without exposing response data", async () => {
  const errors = [];
  const loop = createCronLoop({
    endpoint: "http://app:8080/api/cron/tick",
    secret: "cron-test",
    intervalMs: 1_800_000,
    fetchImpl: async () => new Response("sensitive upstream body", { status: 503 }),
    onError: (result) => errors.push(result),
  });
  await assert.rejects(loop.runOnce(), { message: "cron_http_error" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 503);
  assert.equal(errors[0].item_count, 0);
  assert.equal(errors[0].error_count, 1);
  assert.equal(JSON.stringify(errors).includes("cron-test"), false);
  assert.equal(JSON.stringify(errors).includes("sensitive upstream body"), false);
});

test("network errors invoke a sanitized error callback", async () => {
  const errors = [];
  const loop = createCronLoop({
    endpoint: "http://app:8080/api/cron/tick",
    secret: "cron-test",
    intervalMs: 1_800_000,
    fetchImpl: async () => { throw new Error("cron-test sensitive network error"); },
    onError: (result) => errors.push(result),
  });
  await assert.rejects(loop.runOnce(), { message: "cron_request_failed" });
  assert.equal(errors[0].status, 0);
  assert.equal(errors[0].error_count, 1);
  assert.equal(JSON.stringify(errors).includes("cron-test"), false);
});

test("runOnce skips an overlapping invocation", async () => {
  let calls = 0;
  let release = () => {};
  const pending = new Promise((resolve) => { release = resolve; });
  const loop = createCronLoop({
    endpoint: "http://app:8080/api/cron/tick",
    secret: "cron-test",
    intervalMs: 1_800_000,
    fetchImpl: async () => {
      calls += 1;
      await pending;
      return Response.json({ collection: { items_new: 0, errors: 0 } });
    },
  });
  const first = loop.runOnce();
  assert.equal(await loop.runOnce(), null);
  assert.equal(calls, 1);
  release();
  await first;
});

test("interval accepts only Node's safe timer range", () => {
  const options = { endpoint: "http://app/api/cron/tick", secret: "cron-test",
    fetchImpl: async () => Response.json({}) };
  assert.doesNotThrow(() => createCronLoop({ ...options, intervalMs: 2_147_483_647 }));
  assert.throws(() => createCronLoop({ ...options, intervalMs: 2_147_483_648 }), /intervalMs/);
});

test("Compose waits for an app healthcheck before the immediate tick", () => {
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /\n {2}app:[\s\S]*?\n {4}healthcheck:/);
  assert.match(compose, /\n {2}scheduler:[\s\S]*?app:\s*\n\s+condition: service_healthy/);
});

// --- T16: per-stage visibility ---------------------------------------------

test("a tick reports each stage separately, not one summed error count", async () => {
  const results = [];
  const loop = createCronLoop({
    endpoint: "http://app:8080/api/cron/tick",
    secret: "cron-test",
    intervalMs: 60_000,
    fetchImpl: async () => Response.json({
      collection: { items_new: 3, errors: 0, deferred: 1 },
      production: { ok: false, error: "production_failed" },
      reconciliation: { failed: 2 },
      reconciliation_queue: { failed: 0, deferred: 4 },
      duration_ms: 1234,
    }),
    onResult: (r) => results.push(r),
  });
  const result = await loop.runOnce();
  // T16: the stage that broke is named; the others are distinguishable.
  assert.equal(result.stages.production, "production_failed");
  assert.equal(result.stages.collection, "ok");
  assert.equal(result.stages.reconciliation, "partial");
  assert.equal(result.stages.queue, "ok");
  assert.equal(result.stages.delivery_ack, "skipped");
  assert.match(result.error_code, /production:production_failed/);
  assert.equal(result.duration_ms, 1234);
  assert.equal(result.deferred, 5);
  // Pre-existing fields still present and unchanged in meaning.
  assert.equal(result.item_count, 3);
  assert.ok(result.error_count > 0);
  assert.match(result.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("a healthy tick reports every stage ok and no error code", async () => {
  const loop = createCronLoop({
    endpoint: "http://app:8080/api/cron/tick",
    secret: "cron-test",
    intervalMs: 60_000,
    fetchImpl: async () => Response.json({
      collection: { items_new: 1, errors: 0 },
      production: { ingest_errors: 0, extract_errors: 0 },
      reconciliation: { failed: 0 },
      reconciliation_queue: { failed: 0 },
      duration_ms: 500,
    }),
    onResult: () => {},
  });
  const result = await loop.runOnce();
  assert.deepEqual(result.stages,
    { collection: "ok", production: "ok", reconciliation: "ok", queue: "ok", delivery_ack: "skipped" });
  assert.equal(result.error_code, "");
  assert.equal(result.error_count, 0);
});

test("stage codes never carry a URL, token or provider text", async () => {
  const results = [];
  const loop = createCronLoop({
    endpoint: "http://app:8080/api/cron/tick",
    secret: "cron-test",
    intervalMs: 60_000,
    // A server that echoes something sensitive-looking in the error field.
    fetchImpl: async () => Response.json({
      collection: { ok: false, error: "https://secret.example.com/hook?token=abc123" },
      production: { ok: false, error: "gateway said: Bearer sk-live-999" },
      duration_ms: 1,
    }),
    onResult: (r) => results.push(r),
  });
  const result = await loop.runOnce();
  const rendered = JSON.stringify(result);
  for (const secret of ["secret.example.com", "abc123", "sk-live-999", "Bearer"]) {
    assert.ok(!rendered.includes(secret), `summary leaked: ${secret}`);
  }
  // Unrecognized text degrades to a fixed code rather than being passed through.
  assert.equal(result.stages.collection, "failed");
  assert.equal(result.stages.production, "failed");
});
