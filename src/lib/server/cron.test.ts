import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeCron,
  parseCronTickLimit,
  reconciliationDue,
  requestWechatReconciliation,
  runCronBatch,
  runCronStages,
  runReconciledSourceJobs,
} from "./cron.ts";

test("requires an exact non-empty bearer token", () => {
  assert.equal(authorizeCron("Bearer cron-test", "cron-test"), true);
  for (const [header, secret] of [["Bearer wrong", "cron-test"], ["bearer cron-test", "cron-test"],
    ["Bearer cron-test ", "cron-test"], ["cron-test", "cron-test"], ["Bearer cron-test", ""]]) {
    assert.equal(authorizeCron(header, secret), false);
  }
});

test("reconciliation is due only from 23:30 through 23:59 Shanghai", () => {
  assert.equal(reconciliationDue(new Date("2026-08-28T15:29:59Z")), false);
  assert.equal(reconciliationDue(new Date("2026-08-28T15:30:00Z")), true);
  assert.equal(reconciliationDue(new Date("2026-08-28T15:59:59Z")), true);
  assert.equal(reconciliationDue(new Date("2026-08-28T16:00:00Z")), false);
  assert.throws(() => reconciliationDue(new Date("invalid")), /valid Date/);
});

test("normalizes successful reconciliation IDs in first-seen order", async () => {
  const result = await requestWechatReconciliation({
    url: "https://gateway.internal/base/",
    token: "gateway-test",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://gateway.internal/base/v1/reconcile");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gateway-test");
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ day: "2026-08-28", attempted: 4, succeeded: 2, failed: 2,
        succeeded_source_ids: [" wx-2 ", "wx-1"], budget_exhausted: false });
    },
  });
  assert.deepEqual(result, { ok: true, value: { day: "2026-08-28", attempted: 4,
    succeeded: 2, failed: 2, succeeded_source_ids: ["wx-2", "wx-1"], budget_exhausted: false } });
});

test("rejects unsafe gateway URLs before fetch", async () => {
  let calls = 0;
  for (const url of ["ftp://gateway.internal", "https://user:pass@gateway.internal",
    "https://gateway.internal?secret=1", "https://gateway.internal#fragment"]) {
    const result = await requestWechatReconciliation({ url, token: "gateway-test",
      fetchImpl: async () => { calls += 1; return Response.json({}); } });
    assert.deepEqual(result, { ok: false, error: "wechat_gateway_unavailable" });
  }
  assert.equal(calls, 0);
});

test("rejects inconsistent, invalid-day, whitespace, and ghost gateway results", async () => {
  const payloads = [
    { day: "2026-02-30", attempted: 1, succeeded: 1, failed: 0,
      succeeded_source_ids: ["wx-1"], budget_exhausted: false },
    { day: "2026-08-28", attempted: 1, succeeded: 1, failed: 0,
      succeeded_source_ids: ["   "], budget_exhausted: false },
    { day: "2026-08-28", attempted: 2, succeeded: 2, failed: 0,
      succeeded_source_ids: ["wx-1"], budget_exhausted: false },
    { day: "2026-08-28", attempted: 2, succeeded: 2, failed: 0,
      succeeded_source_ids: ["wx-1", " wx-1 "], budget_exhausted: false },
  ];
  for (const payload of payloads) {
    const result = await requestWechatReconciliation({ url: "https://gateway.internal", token: "token",
      fetchImpl: async () => Response.json(payload) });
    assert.deepEqual(result, { ok: false, error: "wechat_gateway_invalid_response" });
  }
});

test("cancels gateway responses larger than one MiB", async () => {
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return;
      sent = true;
      controller.enqueue(new Uint8Array(Math.ceil(2.1 * 1024 * 1024)));
    },
    cancel() { cancelled = true; },
  });
  const result = await requestWechatReconciliation({ url: "https://gateway.internal", token: "token",
    fetchImpl: async () => new Response(body) });
  assert.deepEqual(result, { ok: false, error: "wechat_gateway_invalid_response" });
  assert.equal(cancelled, true);
});

test("gateway failures are fixed and never expose credentials or upstream bodies", async () => {
  const secret = "gateway-secret";
  const upstream = "sensitive upstream body";
  const http = await requestWechatReconciliation({ url: "https://gateway.internal", token: secret,
    fetchImpl: async () => new Response(upstream, { status: 503 }) });
  const invalid = await requestWechatReconciliation({ url: "https://gateway.internal", token: secret,
    fetchImpl: async () => new Response(upstream, { status: 200 }) });
  const network = await requestWechatReconciliation({ url: "https://gateway.internal", token: secret,
    fetchImpl: async () => { throw new Error(`${secret} ${upstream}`); } });
  assert.deepEqual(http, { ok: false, error: "wechat_gateway_http_error", status: 503 });
  assert.deepEqual(invalid, { ok: false, error: "wechat_gateway_invalid_response" });
  assert.deepEqual(network, { ok: false, error: "wechat_gateway_unavailable" });
  for (const result of [http, invalid, network]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(upstream), false);
  }
});

test("reconciled source scans are ordered, deduplicated, and failure-isolated", async () => {
  const called: string[] = [];
  const results = await runReconciledSourceJobs(["wx-2", 7, "wx-3", "wx-1", "wx-2", ""], async (sourceId) => {
    called.push(sourceId);
    if (sourceId === "wx-2") return { items_found: 3, items_new: 2, error: "sensitive scan failure" };
    if (sourceId === "wx-3") return { items_found: -1, items_new: 0, error: "" };
    return { items_found: 3, items_new: 2, error: "" };
  });
  assert.deepEqual(called, ["wx-2", "wx-3", "wx-1"]);
  assert.deepEqual(results, [
    { source_id: "wx-2", items_found: 0, items_new: 0, error: "reconcile_scan_failed" },
    { source_id: "wx-3", items_found: 0, items_new: 0, error: "reconcile_scan_failed" },
    { source_id: "wx-1", items_found: 3, items_new: 2, error: "" },
  ]);
});

test("reconciled source scans defer IDs that cannot safely finish in the server budget", async () => {
  let now = 75;
  const called: string[] = [];
  const results = await runReconciledSourceJobs(["wx-1", "wx-2"], async (sourceId) => {
    called.push(sourceId);
    now += 20;
    return { items_found: 1, items_new: 1, error: "" };
  }, { deadlineMs: 100, reserveMs: 20, now: () => now });
  assert.deepEqual(called, ["wx-1"]);
  assert.deepEqual(results.map((result) => result.source_id), ["wx-1"]);
});

test("cron stage failures are isolated and sanitized", async () => {
  const called: string[] = [];
  const result = await runCronStages({
    collection: async () => { called.push("collection"); throw new Error("collection secret"); },
    production: async () => { called.push("production"); throw new Error("production secret"); },
    reconciliation: async () => { called.push("reconciliation"); return { attempted: 1 }; },
  });
  assert.deepEqual(called, ["collection", "production", "reconciliation"]);
  assert.deepEqual(result, {
    collection: { ok: false, error: "collection_failed" },
    production: { ok: false, error: "production_failed" },
    reconciliation: { attempted: 1 },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("reconciliation stage failures are sanitized", async () => {
  const result = await runCronStages({
    collection: async () => ({ ran: 1 }),
    production: async () => ({ stored: 1 }),
    reconciliation: async () => { throw new Error("gateway secret"); },
  });
  assert.deepEqual(result.reconciliation, { ok: false, error: "reconciliation_failed" });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("cron tick limit accepts only safe integers from 1 through 500", () => {
  for (const value of ["1", "200", "500"]) assert.equal(parseCronTickLimit(value), Number(value));
  for (const value of [undefined, "", "0", "-1", "1.5", "Infinity", "501", "9007199254740992"]) {
    assert.equal(parseCronTickLimit(value), 200);
  }
});

test("bounded cron batches stop before an unsafe start and leave work for the next batch", async () => {
  let now = 0;
  const first = await runCronBatch(["one", "two", "three"], async (item) => {
    now += 40;
    return item;
  }, { deadlineMs: 100, reserveMs: 30, now: () => now });
  assert.deepEqual(first, { results: ["one", "two"], deferred: 1 });

  const second = await runCronBatch(["three"], async (item) => item,
    { deadlineMs: 140, reserveMs: 30, now: () => now });
  assert.deepEqual(second, { results: ["three"], deferred: 0 });
});
