import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readAgentJson, tokenOk } from "./agent-internal-http.ts";

function streamed(chunks: Uint8Array[], headers?: HeadersInit) {
  let cancelled = false;
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request("http://internal/agent", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
  return { request, reads: () => reads, cancelled: () => cancelled };
}

test("bounded JSON accepts UTF-8 split across every byte without a length header", async () => {
  const text = JSON.stringify({ question: "中文🙂", number: 1 });
  const bytes = new TextEncoder().encode(text);
  const input = streamed(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  const result = await readAgentJson(input.request, bytes.length);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, JSON.parse(text));
});

test("declared oversize returns 413 before reading the stream", async () => {
  const input = streamed([new Uint8Array(16)], { "content-length": "100" });
  const result = await readAgentJson(input.request, 32);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 413);
  assert.equal(input.reads(), 0);
});

test("actual bytes cap a missing or dishonest length and cancel unread data", async () => {
  for (const headers of [undefined, { "content-length": "1" }]) {
    const input = streamed([new Uint8Array(16), new Uint8Array(17), new Uint8Array(100)], headers);
    const result = await readAgentJson(input.request, 32);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 413);
    assert.equal(input.reads(), 2);
    assert.equal(input.cancelled(), true);
  }
});

test("malformed JSON, invalid UTF-8, arrays, and primitives fail with 400", async () => {
  for (const body of ["", "{", "[]", "null", "1", '"string"', "{} {}", Uint8Array.of(0xff)]) {
    const request = new Request("http://internal/agent", { method: "POST", body });
    const result = await readAgentJson(request, 64);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 400);
  }
});

test("tokens compare exact bytes and missing configured credentials deny", () => {
  assert.equal(tokenOk("secret", "secret"), true);
  for (const [got, want] of [["", ""], ["secret", ""], ["", "secret"], ["SECRET", "secret"], ["秘密", "secret"]]) {
    assert.equal(tokenOk(got, want), false);
  }
});

test("all internal routes authenticate before body reads and database access", () => {
  for (const name of ["agent-jobs", "agent-data", "agent-review", "opencode-jobs"]) {
    const source = readFileSync(new URL(`../../routes/api/internal/${name}.ts`, import.meta.url), "utf8");
    const authenticate = source.indexOf("if (!tokenOk(");
    assert.ok(authenticate > 0, `${name} must reject unauthorized requests`);
    assert.ok(authenticate < source.indexOf("await readAgentJson("));
    assert.ok(authenticate < source.indexOf("await getSql("));
    assert.ok(!source.includes("request.json()") && !source.includes("request.text()"));
  }
  const jobs = readFileSync(new URL("../../routes/api/internal/agent-jobs.ts", import.meta.url), "utf8");
  assert.ok(!jobs.includes("agentAsyncAvailable") && !jobs.includes("cancelQueuedResearchJobs") && !jobs.includes("agentResearchRuntime"));
});
