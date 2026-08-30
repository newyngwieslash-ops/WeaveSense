import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeCron,
  reconciliationDue,
  requestWechatReconciliation,
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
    url: "https://gateway.internal",
    token: "gateway-test",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://gateway.internal/v1/reconcile");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gateway-test");
      assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ day: "2026-08-28", attempted: 4, succeeded: 2, failed: 2,
        succeeded_source_ids: ["wx-2", "", 7, "wx-1", "wx-2"], budget_exhausted: false });
    },
  });
  assert.deepEqual(result, { ok: true, value: { day: "2026-08-28", attempted: 4,
    succeeded: 2, failed: 2, succeeded_source_ids: ["wx-2", "wx-1"], budget_exhausted: false } });
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
  const results = await runReconciledSourceJobs(["wx-2", 7, "wx-1", "wx-2", ""], async (sourceId) => {
    called.push(sourceId);
    if (sourceId === "wx-2") throw new Error("sensitive scan failure");
    return { items_found: 3, items_new: 2, error: "" };
  });
  assert.deepEqual(called, ["wx-2", "wx-1"]);
  assert.deepEqual(results, [
    { source_id: "wx-2", items_found: 0, items_new: 0, error: "reconcile_scan_failed" },
    { source_id: "wx-1", items_found: 3, items_new: 2, error: "" },
  ]);
});
