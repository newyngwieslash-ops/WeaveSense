import assert from "node:assert/strict";
import test from "node:test";

Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
const { mapJob } = await import("./queries.ts");
delete (globalThis as unknown as { window?: unknown }).window;

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
