import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
const { mapJob, mapItem } = await import("./queries.ts");
delete (globalThis as unknown as { window?: unknown }).window;

test("old imported entities display decoded without changing stored evidence", () => {
  const row = { id: 'old', title: '&#036;222', body: '正文&#33;', author: 'A &amp; B' };
  const item = mapItem(row);
  assert.equal(item.title, '$222'); assert.equal(item.body, '正文!'); assert.equal(item.author, 'A & B');
  assert.equal(row.body, '正文&#33;');
});

test("mapJob exposes ordered attempts and paid attribution", () => {
  const job = mapJob({ id: "job-1", source_id: "wx-1", platform: "wechat",
    provider: "mixed", attempts: '["primary","dajiala"]', paid_call: true });
  assert.equal(job.provider, "mixed");
  assert.deepEqual(job.attempts, ["primary", "dajiala"]);
  assert.equal(job.paid_call, true);
});

test("mapJob isolates jobs whose attempts JSON root is not an array", () => {
  for (const attempts of [{ primary: true }, 42, "primary", '"primary"', '{"primary":true}', "{bad json"]) {
    const job = mapJob({ id: "damaged-job", source_id: "wx-1", platform: "wechat", attempts });
    assert.deepEqual(job.attempts, []);
  }
});

test("mapJob validates optional collection coverage fields and supports old rows", () => {
  assert.deepEqual(mapJob({ coverage: '{"complete":false,"window_only":true,"note":"window_gap"}' }).coverage,
    { complete: false, window_only: true, note: "window_gap" });
  for (const coverage of [undefined, {}, null, [], 1, true, '"bad"', "{broken", { complete: "true", window_only: 1, note: false }]) {
    assert.deepEqual(mapJob({ coverage }).coverage, {});
  }
  assert.deepEqual(mapJob({ coverage: { complete: true, window_only: false, note: "boundary", extra: "discard" } }).coverage,
    { complete: true, window_only: false, note: "boundary" });
});

test("item projection validates versions and exposes candidate only in explicit detail", () => {
  const extra = { article_state: "candidate", article_candidate: "正文候选", article_previous_body: "旧正文",
    article_claim_token: "private-token", article_claimed_at: new Date().toISOString(), article_digest: "digest" };
  const row = { material_version: "7", extra };
  assert.equal(mapItem(row).material_version, 7);
  assert.deepEqual(mapItem(row).extra, { article_state: "candidate", article_digest: "digest" });
  assert.deepEqual(mapItem(row, { articleDetail: true }).extra,
    { article_state: "candidate", article_digest: "digest", article_candidate: "正文候选" });
  for (const material_version of [undefined, null, "", true, -1, 1.5, "9007199254740993", "bad"]) {
    assert.equal(mapItem({ material_version }).material_version, undefined);
  }
  assert.equal(mapItem({ material_version: 0n }).material_version, 0);
  assert.equal(extra.article_previous_body, "旧正文");
});

test("subtitle private fields never appear in list or detail", () => {
  const extra = { transcript_language: "en", transcript_kind: "manual", transcript_state: "ok", transcript_digest: "hash",
    transcript_object_key: "private/key", transcript_raw_json3: "private", transcript_claim_token: "private", transcript_object_url: "private" };
  for (const opts of [{}, { articleDetail: true }]) assert.deepEqual(mapItem({ extra }, opts).extra,
    { transcript_language: "en", transcript_kind: "manual", transcript_state: "ok", transcript_digest: "hash" });
});
