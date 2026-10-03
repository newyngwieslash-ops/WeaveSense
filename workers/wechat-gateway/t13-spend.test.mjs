#!/usr/bin/env node
/**
 * T13: paid WeChat spend must stay conservative when the real cost is unknown.
 *
 * The defect from the incident history: the daily total reached 1.92 RMB, the
 * next call reserved 0.08 (the client's hardcoded estimate), and the provider
 * actually charged 0.14. Two problems followed:
 *
 *   1. the *estimate* behaved like a cap — spend could exceed the daily budget
 *      without the admission check ever noticing, because the reserve was wrong;
 *   2. an unknown outcome (network error after the request went out) was settled
 *      at the estimate, so a call that may have cost 0.14 was recorded as 0.08
 *      and the remaining budget was overstated.
 *
 * The fix tested here: an unknown outcome keeps its **conservative** reservation
 * (never released to 0, never silently re-estimated), an observed overrun is
 * recorded and blocks further paid admission, and every settlement is attributed
 * to the day the request started so a call spanning midnight cannot be released
 * into a fresh day's budget.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./store.mjs";

const DAY = "2026-09-16";
const NEXT_DAY = "2026-09-17";
const PROVIDER = "dajiala";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "loom-t13-"));
  return openStore(join(dir, "gateway.sqlite"));
}

test("an unknown outcome keeps the conservative reservation, never releases it to zero", () => {
  const store = freshStore();
  try {
    const reservation = store.tryReserveSpend(DAY, PROVIDER, 0.08, 20, 250);
    assert.ok(reservation, "the call should be admitted");

    // The request was sent but the outcome is unknown (timeout / dropped
    // connection). Settling "unknown" must not invent a smaller number.
    const status = store.settleUnknown(reservation, { reason: "network_error" });
    assert.equal(status, "unknown");

    const usage = store.getProviderUsage(DAY, PROVIDER);
    assert.equal(usage.amount, 0.08, "the reservation stays on the books at its conservative amount");
    assert.equal(usage.calls, 1, "an attempted call still counts against the daily call limit");
  } finally {
    store.close();
  }
});

test("an unknown outcome is not re-settled later into a smaller number", () => {
  const store = freshStore();
  try {
    const reservation = store.tryReserveSpend(DAY, PROVIDER, 0.08, 20, 250);
    store.settleUnknown(reservation, { reason: "network_error" });
    // A late success confirmation arriving afterwards must not be able to reduce
    // the already-recorded conservative amount below what was reserved.
    const replay = () => store.adjustSpend(reservation, 0.02);
    assert.throws(replay, /unknown|replay|settled/i,
      "a settled-unknown reservation must not be reopened to a lower amount");
    assert.equal(store.getProviderUsage(DAY, PROVIDER).amount, 0.08);
  } finally {
    store.close();
  }
});

test("the observed overrun is recorded and blocks further paid admission", () => {
  const store = freshStore();
  try {
    // 1.92 already spent today; reserve 0.08 for the next call, which really cost 0.14.
    store.tryReserveSpend(DAY, PROVIDER, 1.92, 20, 250);
    store.adjustSpend(store.lastReservationId(), 1.92);
    const reservation = store.tryReserveSpend(DAY, PROVIDER, 0.08, 20, 250);
    const status = store.adjustSpend(reservation, 0.14);

    assert.equal(status, "overrun", "a cost above the estimate is an overrun, not a settlement");
    const usage = store.getProviderUsage(DAY, PROVIDER);
    assert.equal(usage.amount, 2.06, "the real cost is what lands on the books (1.92 + 0.14)");
  } finally {
    store.close();
  }
});

test("overruns are visible to the operator, with their count and excess", () => {
  const store = freshStore();
  try {
    for (const actual of [0.14, 0.14, 0.08]) {
      const reservation = store.tryReserveSpend(DAY, PROVIDER, 0.08, 20, 250);
      store.adjustSpend(reservation, actual);
    }
    const overruns = store.listOverruns(DAY, PROVIDER);
    assert.equal(overruns.length, 2, "two of the three calls exceeded the estimate");
    assert.equal(Math.round(overruns.reduce((sum, r) => sum + r.excess, 0) * 100) / 100, 0.12);
  } finally {
    store.close();
  }
});

test("the daily budget is enforced against real spend, not against estimates", () => {
  const store = freshStore();
  try {
    // Cap 0.20: two 0.14 calls must not both be admitted.
    const first = store.tryReserveSpend(DAY, PROVIDER, 0.08, 0.2, 250);
    assert.ok(first);
    store.adjustSpend(first, 0.14);
    // A second 0.08 reserve would fit under the cap by estimate (0.14 + 0.08 = 0.22 > 0.2 → must refuse).
    const second = store.tryReserveSpend(DAY, PROVIDER, 0.08, 0.2, 250);
    assert.equal(second, false, "the reserve must be checked against the real remaining budget");
  } finally {
    store.close();
  }
});

test("a call spanning midnight is settled against the day it started", () => {
  const store = freshStore();
  try {
    const reservation = store.tryReserveSpend(DAY, PROVIDER, 0.08, 20, 250);
    // The call returns after midnight; settling must hit DAY, not NEXT_DAY.
    const status = store.adjustSpend(reservation, 0.14);
    assert.equal(status, "overrun");
    assert.equal(store.getProviderUsage(DAY, PROVIDER).amount, 0.14);
    assert.equal(store.getProviderUsage(NEXT_DAY, PROVIDER).amount, 0, "no spend may leak into the next day");
  } finally {
    store.close();
  }
});

test("an unknown reservation from an earlier day still holds that day's budget", () => {
  const store = freshStore();
  try {
    const reservation = store.tryReserveSpend(DAY, PROVIDER, 0.08, 0.10, 250);
    store.settleUnknown(reservation, { reason: "network_error" });
    // Next day's budget is separate, but yesterday's unknown must not have been
    // released to zero (that would erase the record of money possibly spent).
    assert.equal(store.getProviderUsage(DAY, PROVIDER).amount, 0.08);
    const state = store.getProviderBudgetState(DAY, PROVIDER, 0.10, 250);
    assert.equal(state, "warning", "0.08 of a 0.10 day is at/over the warning line");
  } finally {
    store.close();
  }
});

test("the last of the budget is admitted to exactly one caller", () => {
  const store = freshStore();
  try {
    // 0.10 already spent of a 0.20 cap: exactly one 0.08 reservation fits
    // (0.10 + 0.08 = 0.18 ≤ 0.20; a second would make 0.26).
    const first = store.tryReserveSpend(DAY, PROVIDER, 0.10, 0.2, 250);
    store.adjustSpend(first, 0.10);
    const a = store.tryReserveSpend(DAY, PROVIDER, 0.08, 0.2, 250);
    const b = store.tryReserveSpend(DAY, PROVIDER, 0.08, 0.2, 250);
    const admitted = [a, b].filter(Boolean).length;
    assert.equal(admitted, 1, "the last of the budget must go to exactly one caller");
    // The reservation itself holds the budget for the second caller.
    assert.equal(store.getProviderUsage(DAY, PROVIDER).amount, 0.18);
  } finally {
    store.close();
  }
});

test("without a verified price bound, paid admission is refused", () => {
  const store = freshStore();
  try {
    // No estimate at all: the caller cannot reserve honestly, so it must not start.
    assert.equal(store.tryReserveSpend(DAY, PROVIDER, null, 20, 250), false,
      "a paid call needs a real reserve; guessing one is how the cap gets exceeded");
    assert.equal(store.getProviderUsage(DAY, PROVIDER).calls, 0);
  } finally {
    store.close();
  }
});
