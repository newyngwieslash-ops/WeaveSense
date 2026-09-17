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
