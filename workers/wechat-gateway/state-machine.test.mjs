import assert from "node:assert/strict";
import test from "node:test";
import {
  alertState,
  freshnessState,
  nextPaidRetry,
  paidDecision,
  PAID_RETRY_MINUTES,
  PRIMARY_FAILURE_THRESHOLD,
  shanghaiDay,
  shanghaiHourMinute,
  shouldReconcile,
} from "./state-machine.mjs";

const now = new Date("2026-08-28T15:35:00Z"); // Shanghai 23:35

test("freshness requires content evidence and an explicit expected interval", () => {
  const date = new Date("2026-10-02T01:00:00Z");
  const source = { last_primary_ok_at: "2026-10-02T00:00:00Z",
    last_primary_content_at: "2026-09-01T00:00:00Z", expected_update_hours: 24 };
  assert.equal(freshnessState(source, date), "suspected_stale");
  assert.equal(freshnessState({ ...source, expected_update_hours: null }, date), "unknown");
  for (const value of [null, "invalid", "2026-10-03T00:00:00Z"]) {
    assert.equal(freshnessState({ ...source, last_primary_content_at: value }, date), "unknown");
  }
  assert.equal(freshnessState(source, new Date("2026-09-04T00:00:00Z")), "fresh");
  assert.equal(freshnessState(source, new Date("2026-09-04T00:00:00.001Z")), "suspected_stale");
  assert.equal(paidDecision(source, date).allowed, false);
  assert.equal(alertState(source, date), "normal");
  assert.throws(() => freshnessState(source, new Date("invalid")), /valid Date/);
});

test("uses Shanghai calendar time", () => {
  assert.equal(shanghaiDay(now), "2026-08-28");
  assert.equal(shanghaiHourMinute(now), "23:35");
  assert.equal(shanghaiDay(new Date("2026-08-28T16:00:00Z")), "2026-08-29");
});

test("allows paid fallback at the second consecutive primary failure", () => {
  assert.equal(PRIMARY_FAILURE_THRESHOLD, 2);
  assert.deepEqual(paidDecision({ consecutive_primary_failures: 1 }, now), {
    allowed: false,
    reason: "primary_healthy",
  });
  assert.deepEqual(paidDecision({ consecutive_primary_failures: 2 }, now), {
    allowed: true,
    reason: "primary_failed",
  });
});

test("allows paid fallback at six hours without primary success", () => {
  assert.equal(paidDecision({
    consecutive_primary_failures: 1,
    last_primary_ok_at: "2026-08-28T09:35:01Z",
    created_at: "2026-08-28T08:00:00Z",
  }, now).allowed, false);
  assert.deepEqual(paidDecision({
    consecutive_primary_failures: 1,
    last_primary_ok_at: "2026-08-28T09:35:00Z",
    created_at: "2026-08-28T08:00:00Z",
  }, now), { allowed: true, reason: "primary_stale" });
  assert.deepEqual(paidDecision({
    consecutive_primary_failures: 0,
    last_primary_ok_at: null,
    created_at: "2026-08-28T09:35:00Z",
  }, now), { allowed: true, reason: "primary_stale" });
});

test("respects paid retry backoff and allows retry at the boundary", () => {
  assert.deepEqual(paidDecision({
    consecutive_primary_failures: 4,
    next_retry_at: "2026-08-28T15:35:01Z",
  }, now), { allowed: false, reason: "retry_backoff" });
  assert.deepEqual(paidDecision({
    consecutive_primary_failures: 4,
    next_retry_at: "2026-08-28T15:35:00Z",
  }, now), { allowed: true, reason: "primary_failed" });
});

test("fails closed for mapping errors and malformed retry timestamps", () => {
  assert.deepEqual(paidDecision({
    consecutive_primary_failures: 4,
    last_paid_result: "mapping_error",
  }, now), { allowed: false, reason: "mapping_error" });
  assert.deepEqual(paidDecision({
    consecutive_primary_failures: 4,
    next_retry_at: "not-a-date",
  }, now), { allowed: false, reason: "invalid_retry_at" });
});

test("schedules paid retries at 5, 15, then 60 minutes", () => {
  assert.deepEqual(PAID_RETRY_MINUTES, [5, 15, 60]);
  assert.equal(nextPaidRetry(now, 1), "2026-08-28T15:40:00.000Z");
  assert.equal(nextPaidRetry(now, 2), "2026-08-28T15:50:00.000Z");
  assert.equal(nextPaidRetry(now, 3), "2026-08-28T16:35:00.000Z");
  assert.equal(nextPaidRetry(now, 8), "2026-08-28T16:35:00.000Z");
});

test("reconciles once after 23:30 Shanghai", () => {
  const neverChecked = { last_paid_check_at: null, last_paid_result: "" };
  assert.equal(shouldReconcile(neverChecked, new Date("2026-08-28T15:29:59Z")), false);
  assert.equal(shouldReconcile(neverChecked, new Date("2026-08-28T15:30:00Z")), true);
  assert.equal(shouldReconcile({
    last_paid_check_at: "2026-08-27T15:40:00Z",
    last_paid_result: "ok",
  }, now), true);
  assert.equal(shouldReconcile({
    last_paid_check_at: "2026-08-28T14:00:00Z",
    last_paid_result: "ok",
  }, now), false);
  assert.equal(shouldReconcile({
    last_paid_check_at: "2026-08-28T14:00:00Z",
    last_paid_result: "mapping_error",
  }, now), false);
});

test("reconciliation retries a same-day technical error only after backoff", () => {
  assert.equal(shouldReconcile({
    last_paid_check_at: "2026-08-28T14:00:00Z",
    last_paid_result: "technical_error",
    next_retry_at: "2026-08-28T15:36:00Z",
  }, now), false);
  assert.equal(shouldReconcile({
    last_paid_check_at: "2026-08-28T14:00:00Z",
    last_paid_result: "technical_error",
    next_retry_at: "2026-08-28T15:35:00Z",
  }, now), true);
});

test("technical-error backoff applies when the persisted check is in the future", () => {
  const source = {
    last_paid_check_at: "2026-08-29T00:00:00Z",
    last_paid_result: "technical_error",
    next_retry_at: "2026-08-28T15:36:00Z",
  };
  assert.equal(shouldReconcile(source, now), false);
  assert.equal(shouldReconcile(source, new Date("2026-08-28T15:36:00Z")), true);
});

test("technical-error backoff applies when the persisted check is from yesterday", () => {
  const source = {
    last_paid_check_at: "2026-08-27T14:00:00Z",
    last_paid_result: "technical_error",
    next_retry_at: "2026-08-28T15:36:00Z",
  };
  assert.equal(shouldReconcile(source, now), false);
  assert.equal(shouldReconcile(source, new Date("2026-08-28T15:36:00Z")), true);
});

test("mapping errors never reconcile automatically, even on another day", () => {
  const mappingError = {
    last_paid_check_at: "2026-08-27T14:00:00Z",
    last_paid_result: "mapping_error",
  };
  assert.equal(shouldReconcile(mappingError, now), false);
  assert.equal(shouldReconcile(mappingError, new Date("2026-08-29T15:35:00Z")), false);
  assert.equal(shouldReconcile({
    last_paid_check_at: "2026-08-28T14:00:00Z",
    last_paid_result: "technical_error",
    next_retry_at: "not-a-date",
  }, now), false);
});

test("reports normal, degraded, paid fallback, and alert states", () => {
  assert.equal(alertState({
    created_at: "2026-08-28T14:00:00Z",
    last_primary_ok_at: "2026-08-28T15:30:00Z",
    consecutive_primary_failures: 0,
  }, now), "normal");
  assert.equal(alertState({
    created_at: "2026-08-28T10:00:00Z",
    last_primary_ok_at: "2026-08-28T15:30:00Z",
    consecutive_primary_failures: 1,
  }, now), "degraded");
  assert.equal(alertState({
    created_at: "2026-08-27T10:00:00Z",
    last_primary_ok_at: "2026-08-28T12:00:00Z",
    consecutive_primary_failures: 2,
    last_paid_check_at: "2026-08-28T15:00:00Z",
    last_paid_result: "ok",
  }, now), "paid_fallback");
  assert.equal(alertState({
    created_at: "2026-08-27T10:00:00Z",
    last_primary_ok_at: "2026-08-27T14:00:00Z",
    last_paid_check_at: "2026-08-27T13:00:00Z",
    last_paid_result: "technical_error",
  }, now), "alert");
});

test("alerts at 24 hours without a success and clears on recovery", () => {
  const exactDayAgo = "2026-08-27T15:35:00Z";
  assert.equal(alertState({ created_at: exactDayAgo }, now), "alert");
  assert.equal(alertState({
    created_at: "2026-08-26T00:00:00Z",
    last_primary_ok_at: "2026-08-28T15:35:00Z",
    consecutive_primary_failures: 0,
    last_paid_check_at: "2026-08-27T00:00:00Z",
    last_paid_result: "ok",
  }, now), "normal");
});

test("tracks the last paid success separately from a newer failed attempt", () => {
  const source = {
    created_at: "2026-08-27T00:00:00Z",
    last_primary_ok_at: "2026-08-27T14:00:00Z",
    last_paid_ok_at: "2026-08-28T15:30:00Z",
    last_paid_check_at: "2026-08-28T15:34:00Z",
    last_paid_result: "technical_error",
  };
  assert.equal(alertState(source, now), "paid_fallback");
  assert.equal(alertState(source, new Date("2026-08-29T15:29:59Z")), "paid_fallback");
  assert.equal(alertState(source, new Date("2026-08-29T15:30:00Z")), "alert");
});

test("ignores future persisted events when making time decisions", () => {
  assert.deepEqual(paidDecision({
    consecutive_primary_failures: 0,
    created_at: "2026-08-28T09:35:00Z",
    last_primary_ok_at: "2026-08-29T00:00:00Z",
  }, now), { allowed: true, reason: "primary_stale" });
  assert.equal(shouldReconcile({
    last_paid_check_at: "2026-08-29T00:00:00Z",
    last_paid_result: "ok",
  }, now), true);
  assert.equal(alertState({
    created_at: "2026-08-27T15:35:00Z",
    last_primary_ok_at: "2026-08-29T00:00:00Z",
    last_paid_ok_at: "2026-08-29T00:00:00Z",
  }, now), "alert");
});

test("all exported time decisions reject an invalid current time", () => {
  const invalid = new Date(Number.NaN);
  const calls = [
    () => shanghaiDay(invalid),
    () => shanghaiHourMinute(invalid),
    () => paidDecision({}, invalid),
    () => shouldReconcile({}, invalid),
    () => nextPaidRetry(invalid, 1),
    () => alertState({}, invalid),
  ];
  for (const call of calls) assert.throws(call, TypeError);
});
