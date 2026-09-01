import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWechatValidation, normalizeReferenceUrl } from "./wechat-validation-lib.mjs";

const WINDOW = { from: "2026-08-28T00:00:00.000Z", to: "2026-08-29T00:00:00.000Z" };
const baseItem = (index, overrides = {}) => ({
  canonical_id: `wx:test:${index}`,
  account_id: `gh_test_${index % 3}`,
  account_name: `测试账号${index % 3}`,
  title: `测试文章 ${index}`,
  published_at: "2026-08-28T10:00:00.000Z",
  collected_at: "2026-08-28T12:00:00.000Z",
  original_url: `https://mp.weixin.qq.com/s/article-${index}`,
  body: "测试正文",
  cover_url: "https://mmbiz.qpic.cn/test/cover.jpg",
  ...overrides,
});
const baseReference = (index, overrides = {}) => ({
  canonical_id: `wx:test:${index}`,
  account_id: `gh_test_${index % 3}`,
  account_name: `测试账号${index % 3}`,
  title: `测试文章 ${index}`,
  published_at: "2026-08-28T10:00:00.000Z",
  original_url: `https://mp.weixin.qq.com/s/article-${index}`,
  provider_known: false,
  ...overrides,
});
const evaluate = (reference, items, overrides = {}) => evaluateWechatValidation({
  reference, items, health: [{ source_id: "wx-source", last_primary_ok_at: WINDOW.to,
    alert_state: "normal" }], usage: { calls: 0, amount: 0, days: [
      { day: "2026-08-28", calls: 0, amount: 0 },
      { day: "2026-08-29", calls: 0, amount: 0 },
    ] },
  limits: { daily_calls: 250, daily_rmb: 20 }, window: WINDOW, ...overrides,
  asOf: overrides.asOf ?? WINDOW.to,
});

test("required fields pass at 99% and fail below it", () => {
  const items = Array.from({ length: 100 }, (_, index) => baseItem(index));
  items[99] = baseItem(99, { title: "" });
  assert.equal(evaluate([baseReference(0)], items).metrics.required_fields.pass, true);
  items[98] = baseItem(98, { original_url: "http://mp.weixin.qq.com/s/invalid" });
  assert.equal(evaluate([baseReference(0)], items).metrics.required_fields.pass, false);
});

test("two-hour discovery passes at 95% including the boundary and fails below it", () => {
  const reference = Array.from({ length: 20 }, (_, index) => baseReference(index));
  const items = reference.map((_, index) => baseItem(index));
  items[19].collected_at = "2026-08-28T12:00:00.001Z";
  assert.equal(evaluate(reference, items).metrics.discovery_within_2h.pass, true);
  items[18].collected_at = "2026-08-28T12:00:00.001Z";
  assert.equal(evaluate(reference, items).metrics.discovery_within_2h.pass, false);
});

test("provider-known missing requires zero and canonical ID wins before URL fallback", () => {
  const sameUrl = "https://mp.weixin.qq.com/s/a?mid=2&scene=1&__biz=x";
  let report = evaluate([baseReference(1, { provider_known: true })], []);
  assert.equal(report.metrics.provider_known_missing.pass, false);
  assert.equal(report.metrics.provider_known_missing.raw.missing, 1);

  report = evaluate([baseReference(1, { provider_known: true, original_url: sameUrl })],
    [baseItem(1, { original_url: sameUrl })]);
  assert.equal(report.metrics.provider_known_missing.pass, true);

  report = evaluate([baseReference(1, { canonical_id: "wx:expected", provider_known: true,
    original_url: sameUrl })], [baseItem(1, { canonical_id: "wx:other", original_url: sameUrl })]);
  assert.equal(report.metrics.provider_known_missing.raw.missing, 1);

  report = evaluate([baseReference(1, { canonical_id: "", provider_known: true,
    original_url: sameUrl })], [baseItem(1, { canonical_id: "",
    original_url: "https://mp.weixin.qq.com/s/a?__biz=x&mid=2&from=timeline#fragment" })]);
  assert.equal(report.metrics.provider_known_missing.raw.missing, 0);

  report = evaluate([baseReference(1, { canonical_id: "", provider_known: true,
    original_url: sameUrl })], [baseItem(1, { canonical_id: "wx:collected-only",
    original_url: "https://mp.weixin.qq.com/s/a?__biz=x&mid=2&from=timeline" })]);
  assert.equal(report.metrics.provider_known_missing.raw.missing, 0);
  assert.equal(report.metrics.discovery_within_2h.raw.within_2h, 1);

  report = evaluate([baseReference(1, { canonical_id: "wx:reference-only", provider_known: true,
    original_url: sameUrl })], [baseItem(1, { canonical_id: "",
    original_url: "https://mp.weixin.qq.com/s/a?__biz=x&mid=2&scene=9" })]);
  assert.equal(report.metrics.provider_known_missing.raw.missing, 0);
  assert.equal(report.metrics.discovery_within_2h.raw.within_2h, 1);
});

test("one collected row can satisfy at most one distinct canonical reference", () => {
  const url = "https://mp.weixin.qq.com/s/shared?__biz=x&mid=1";
  const report = evaluate([
    baseReference(1, { canonical_id: "wx:a", original_url: url, provider_known: true }),
    baseReference(2, { canonical_id: "wx:b", original_url: url, provider_known: true }),
  ], [baseItem(3, { canonical_id: "", original_url: `${url}&scene=1` })]);
  assert.equal(report.metrics.discovery_within_2h.raw.within_2h, 1);
  assert.equal(report.metrics.provider_known_missing.raw.missing, 1);
});

test("canonical references consume exact matches before URL-only references in stable order", () => {
  const urlA = "https://mp.weixin.qq.com/s/a?__biz=x&mid=1";
  const urlB = "https://mp.weixin.qq.com/s/b?__biz=x&mid=2";
  const references = [
    baseReference(1, { canonical_id: "", original_url: urlB, provider_known: true }),
    baseReference(2, { canonical_id: "wx:exact", original_url: urlA, provider_known: true }),
  ];
  const items = [
    baseItem(1, { canonical_id: "wx:exact", original_url: urlB }),
    baseItem(2, { canonical_id: "", original_url: `${urlB}&scene=1` }),
  ];
  const report = evaluate(references, items);
  assert.equal(report.metrics.discovery_within_2h.raw.within_2h, 2);
  assert.equal(report.metrics.provider_known_missing.raw.missing, 0);

  const shared = "https://mp.weixin.qq.com/s/stable?__biz=x&mid=3";
  const stable = evaluate([
    baseReference(3, { canonical_id: "wx:z-first", original_url: shared,
      published_at: "2026-08-28T10:00:00.000Z" }),
    baseReference(4, { canonical_id: "wx:a-second", original_url: shared,
      published_at: "2026-08-28T12:00:00.000Z" }),
  ], [
    baseItem(3, { canonical_id: "", original_url: shared,
      collected_at: "2026-08-28T11:00:00.000Z" }),
    baseItem(4, { canonical_id: "", original_url: `${shared}&scene=1`,
      collected_at: "2026-08-28T13:00:00.000Z" }),
  ]);
  assert.equal(stable.metrics.discovery_within_2h.raw.within_2h, 2);
});

test("duplicate rate is strict below 0.1%", () => {
  const passing = Array.from({ length: 1_001 }, (_, index) => baseItem(index));
  passing[1000] = { ...passing[999] };
  assert.equal(evaluate([baseReference(0)], passing).metrics.duplicate_rate.pass, true);
  const failing = passing.slice(0, 1_000);
  failing[999] = { ...failing[998] };
  assert.equal(evaluate([baseReference(0)], failing).metrics.duplicate_rate.value, 0.001);
  assert.equal(evaluate([baseReference(0)], failing).metrics.duplicate_rate.pass, false);
});

test("duplicate equivalence is order-independent without collapsing different canonical IDs", () => {
  const url = "https://mp.weixin.qq.com/s/equivalent?mid=2&__biz=x";
  const canonical = baseItem(1, { canonical_id: "wx:canonical-a", original_url: url });
  const urlOnly = baseItem(2, { canonical_id: "",
    original_url: "https://mp.weixin.qq.com/s/equivalent?__biz=x&mid=2&scene=8" });
  for (const items of [[canonical, urlOnly], [urlOnly, canonical]]) {
    const duplicate = evaluate([baseReference(0)], items).metrics.duplicate_rate.raw;
    assert.deepEqual(duplicate, { duplicate_rows: 1, total: 2, unique: 1 });
  }

  const differentCanonical = evaluate([baseReference(0)], [canonical,
    baseItem(2, { canonical_id: "wx:canonical-b", original_url: url })]).metrics.duplicate_rate.raw;
  assert.deepEqual(differentCanonical, { duplicate_rows: 0, total: 2, unique: 2 });
});

test("body and cover coverage include their exact boundaries", () => {
  const items = Array.from({ length: 10 }, (_, index) => baseItem(index, {
    body: index < 8 ? "正文" : " ", cover_url: index < 9 ? "https://cdn.example/cover.jpg" : "",
  }));
  let report = evaluate([baseReference(0)], items);
  assert.equal(report.metrics.body_coverage.pass, true);
  assert.equal(report.metrics.cover_coverage.pass, true);
  items[7].body = "";
  items[8].cover_url = "http://cdn.example/cover.jpg";
  report = evaluate([baseReference(0)], items);
  assert.equal(report.metrics.body_coverage.pass, false);
  assert.equal(report.metrics.cover_coverage.pass, false);
});

test("health is a live as-of snapshot with an inclusive 24-hour alert boundary", () => {
  const asOf = "2026-08-29T01:00:00.000Z";
  const recent = { source_id: "wx-recent", last_primary_ok_at: "2026-08-29T00:30:00.000Z",
    last_paid_check_at: "2026-08-29T00:45:00.000Z", alert_state: "normal" };
  let report = evaluate([baseReference(0)], [baseItem(0)], { health: [recent], asOf });
  assert.equal(report.metrics.outage_alerts.raw.overdue, 0);
  assert.equal(report.metrics.outage_alerts.raw.as_of, asOf);

  const overdue = { source_id: "wx-overdue", last_primary_ok_at: "2026-08-28T01:00:00.000Z",
    alert_state: "normal" };
  report = evaluate([baseReference(0)], [baseItem(0)], { health: [overdue], asOf });
  assert.equal(report.metrics.outage_alerts.pass, false);
  overdue.alert_state = "alert";
  report = evaluate([baseReference(0)], [baseItem(0)], { health: [overdue], asOf });
  assert.equal(report.metrics.outage_alerts.pass, true);
  assert.throws(() => evaluate([baseReference(0)], [baseItem(0)], { health: [{ ...recent,
    last_primary_ok_at: "2026-08-29T01:00:00.001Z" }], asOf }), /validation_invalid_input/);
  assert.throws(() => evaluate([baseReference(0)], [baseItem(0)], { health: [{ ...recent,
    last_paid_check_at: "2026-08-29T01:00:00.001Z" }], asOf }), /validation_invalid_input/);
});

test("paid budgets pass at equality and fail above either limit", () => {
  let report = evaluate([baseReference(0)], [baseItem(0)], {
    usage: { calls: 250, amount: 20, days: [
      { day: "2026-08-28", calls: 250, amount: 20 },
      { day: "2026-08-29", calls: 0, amount: 0 },
    ] }, limits: { daily_calls: 250, daily_rmb: 20 },
  });
  assert.equal(report.metrics.paid_calls.pass, true);
  assert.equal(report.metrics.paid_amount.pass, true);
  report = evaluate([baseReference(0)], [baseItem(0)], {
    usage: { calls: 251, amount: 20, days: [
      { day: "2026-08-28", calls: 251, amount: 20 },
      { day: "2026-08-29", calls: 0, amount: 0 },
    ] }, limits: { daily_calls: 250, daily_rmb: 20 },
  });
  assert.equal(report.metrics.paid_calls.pass, false);
  assert.equal(report.metrics.paid_amount.pass, true);
  report = evaluate([baseReference(0)], [baseItem(0)], {
    usage: { calls: 250, amount: 20.01, days: [
      { day: "2026-08-28", calls: 250, amount: 20.01 },
      { day: "2026-08-29", calls: 0, amount: 0 },
    ] }, limits: { daily_calls: 250, daily_rmb: 20 },
  });
  assert.equal(report.metrics.paid_calls.pass, true);
  assert.equal(report.metrics.paid_amount.pass, false);
});

test("daily budgets cannot be hidden by a multi-day total and require every Shanghai day", () => {
  const report = evaluate([baseReference(0)], [baseItem(0)], {
    usage: { calls: 251, amount: 20.01, days: [
      { day: "2026-08-28", calls: 251, amount: 20.01 },
      { day: "2026-08-29", calls: 0, amount: 0 },
    ] }, limits: { daily_calls: 250, daily_rmb: 20 },
  });
  assert.equal(report.metrics.paid_calls.pass, false);
  assert.equal(report.metrics.paid_amount.pass, false);
  assert.equal(report.paid.calls, 251);
  assert.equal(report.paid.days.length, 2);
  assert.throws(() => evaluate([baseReference(0)], [baseItem(0)], {
    usage: { calls: 0, amount: 0, days: [{ day: "2026-08-28", calls: 0, amount: 0 }] },
  }), /validation_invalid_input/);
});

test("reference identities must be unique under the same canonical-first equivalence", () => {
  assert.throws(() => evaluate([baseReference(1), baseReference(2, {
    canonical_id: "wx:test:1",
  })], [baseItem(1)]), /validation_invalid_input/);
  const url = "https://mp.weixin.qq.com/s/reference-equivalent?__biz=x&mid=1";
  for (const reference of [
    [baseReference(1, { canonical_id: "", original_url: url }),
      baseReference(2, { canonical_id: "wx:canonical", original_url: `${url}&scene=1` })],
    [baseReference(1, { canonical_id: "wx:canonical", original_url: url }),
      baseReference(2, { canonical_id: "", original_url: `${url}&scene=1` })],
  ]) assert.throws(() => evaluate(reference, [baseItem(1, { original_url: url })]),
    /validation_invalid_input/);
  assert.doesNotThrow(() => evaluate([
    baseReference(1, { canonical_id: "wx:a", original_url: url }),
    baseReference(2, { canonical_id: "wx:b", original_url: url }),
  ], [baseItem(1)]));
});

test("URL normalization is deterministic and validation rejects invalid time and zero denominators", () => {
  assert.equal(normalizeReferenceUrl("https://mp.weixin.qq.com/s/a?mid=2&scene=1&__biz=x#fragment"),
    "https://mp.weixin.qq.com/s/a?__biz=x&mid=2");
  assert.throws(() => evaluate([baseReference(0)], [baseItem(0, {
    collected_at: "2026-08-29T00:00:00.001Z",
  })]), /validation_invalid_input/);
  assert.throws(() => evaluate([baseReference(0)], [baseItem(0, {
    collected_at: WINDOW.to,
  })]), /validation_invalid_input/);
  assert.throws(() => evaluate([baseReference(0, {
    published_at: WINDOW.to,
  })], [baseItem(0)]), /validation_invalid_input/);
  assert.throws(() => evaluate([baseReference(0, {
    published_at: "2026-02-30T10:00:00.000Z",
  })], [baseItem(0)]), /validation_invalid_input/);
  const invalidPublished = evaluate([baseReference(0)], [baseItem(0, { published_at: "not-a-date" })]);
  assert.equal(invalidPublished.metrics.required_fields.raw.valid, 0);
  assert.throws(() => evaluate([baseReference(0)], [baseItem(0)], {
    asOf: "2026-08-29T02:00:00.001Z",
  }), /validation_invalid_input/);
  const empty = evaluate([], []);
  assert.equal(empty.metrics.required_fields.available, false);
  assert.equal(empty.metrics.discovery_within_2h.available, false);
  assert.equal(empty.overall, false);
});
