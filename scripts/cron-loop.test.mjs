import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCronLoop } from "./cron-loop.mjs";

test("runOnce posts the protected cron request with response margin over the server budget", async () => {
  const originalTimeout = AbortSignal.timeout;
  const signal = new AbortController().signal;
  AbortSignal.timeout = (milliseconds) => {
    assert.equal(milliseconds, 630_000);
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
  assert.match(compose, /\n  app:[\s\S]*?\n    healthcheck:/);
  assert.match(compose, /\n  scheduler:[\s\S]*?app:\s*\n\s+condition: service_healthy/);
});
