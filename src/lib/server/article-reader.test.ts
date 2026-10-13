import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { readArticle } from "./article-reader.ts";
import type { FetchIo } from "./http.ts";

Object.assign(process.env, {
  DATABASE_URL: "", NODE_ENV: "test", LOOM_MODEL_CONFIG: path.resolve(".superpowers/nonexistent-offline-model.json"),
  XAI_API_KEY: "", AGENT_MODEL_API_KEY: "", TELEGRAM_WORKER_URL: "", MINIO_ENDPOINT: "",
  EXTRACT_AUTO: "false", AUTO_ANALYZE: "false", AGENT_ASYNC_RESEARCH_ENABLED: "false",
  AGENT_WORKER_ENABLED: "false", AGENT_OPENCODE_WORKER_ENABLED: "false",
  AGENT_ASSISTANT_ENABLED: "false", AGENT_ASSISTANT_ACTIONS_ENABLED: "false", LOOM_EGRESS_CIDRS: "",
});
const allowedHosts = new Set(["example.com", "mp.weixin.qq.com", "private.example", "127.0.0.1", "[::ffff:7f00:1]", "[fe90::1]"]);
// Documented JSON-mode envelope; anonymous live access returned the 401 below.
const sample = { code: 200, status: 20000, data: {
  title: "Example Domain", url: "https://example.com/", content: " Example Domain\n\nPublic article. ",
} };
function ioFor(payload: unknown = sample): FetchIo {
  return {
    resolver: { async lookup(host) { return [{ address: host === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4 }]; } },
    transport: async (url, options) => {
      assert.equal(url.href, "https://r.jina.ai/https://example.com/");
      assert.deepEqual(options.headers, { Accept: "application/json", "x-retain-images": "none" });
      assert.equal(options.timeoutMs, 20000);
      assert.ok(options.signal);
      return { status: 200, headers: { "content-type": "application/json" }, body: new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload))); controller.close(); },
      }) };
    },
  };
}
test("reader uses fixed publicFetch transport and returns a bounded candidate with provenance", async () => {
  const value = await readArticle("https://example.com/", { allowedHosts, io: ioFor() });
  assert.equal(value.body, sample.data.content.trim());
  assert.equal(value.sourceUrl, sample.data.url);
  assert.equal(value.title, sample.data.title);
  assert.equal(value.provider, "jina");
  assert.equal(value.digest, createHash("sha256").update(value.sourceUrl).update("\0").update(value.body).digest("hex"));
  assert.ok(Number.isFinite(Date.parse(value.fetchedAt)));
  assert.equal("body_complete" in value, false);
});
test("untrusted input is rejected before any proxy request", async () => {
  for (const url of ["https://127.0.0.1/", "https://private.example/", "https://user:secret@example.com/",
    "https://other.example/", "https://example.com/?token=secret", "https://example.com/#secret",
    "https://example.com/?", "https://example.com/#", "http://example.com/", "https://example.com:444/",
    "https://mp.weixin.qq.com/s/article", "https://[::ffff:127.0.0.1]/", "https://[fe90::1]/"]) {
    const io = ioFor();
    io.transport = async () => { assert.fail("invalid target reached proxy"); };
    await assert.rejects(() => readArticle(url, { allowedHosts, io }));
  }
  await assert.rejects(() => readArticle("https://example.com/", { allowedHosts: new Set(["*.com"]), io: ioFor() }));
});

test("the same 20s reader deadline covers initial DNS, proxy IO and returned-source DNS", async () => {
  const originalTimeout = AbortSignal.timeout;
  const requested: number[] = [];
  AbortSignal.timeout = milliseconds => { requested.push(milliseconds); return originalTimeout(80); };
  let targetResolves = 0;
  const io = ioFor();
  io.resolver = { async lookup(host) {
    if (host === "example.com") { targetResolves += 1; await new Promise(resolve => setTimeout(resolve, targetResolves === 1 ? 30 : 50)); }
    return [{ address: "93.184.216.34", family: 4 }];
  } };
  const transport = io.transport!;
  io.transport = async (url, options) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return transport(url, options);
  };
  const started = Date.now();
  try {
    await assert.rejects(() => readArticle("https://example.com/", { allowedHosts, io }), /timeout|aborted/i);
    assert.deepEqual(requested, [20000, 20000]);
    assert.equal(targetResolves, 2);
    assert.ok(Date.now() - started < 130, "returned DNS must use the original deadline");
  } finally { AbortSignal.timeout = originalTimeout; }
});
test("malformed, blank, oversized and login/challenge responses never become candidates", async () => {
  for (const payload of ["not json", { data: { ...sample.data, content: "  " } },
    { data: { ...sample.data, content: 3 } }, { data: { ...sample.data, content: "大".repeat(1024 * 1024) } },
    ...["Sign in to continue", "Verify you are human", "Access denied", "请登录后查看", "安全验证"].map(content => ({ data: { ...sample.data, content } })),
    { data: { ...sample.data, title: "Just a moment..." } }, { data: { ...sample.data, title: "Login" } },
    // Actual anonymous public JSON response, 2026-10-13; no key retry.
    { data: null, code: 401, name: "AuthenticationRequiredError", status: 40103,
      message: "You have been blocked from performing anonymous queries due to bad IP reputation. Please authenticate.",
      readableMessage: "AuthenticationRequiredError: You have been blocked from performing anonymous queries due to bad IP reputation. Please authenticate." }]) {
    await assert.rejects(() => readArticle("https://example.com/", { allowedHosts, io: ioFor(payload) }));
  }
});

test("a missing optional title is an empty title, not a schema failure", async () => {
  const value = await readArticle("https://example.com/", { allowedHosts, io: ioFor({ data: { url: sample.data.url, content: sample.data.content } }) });
  assert.equal(value.title, "");
});
test("returned source URL goes through the same allowlist and public DNS validation", async () => {
  for (const url of ["https://private.example/", "https://127.0.0.1/", "https://r.jina.ai/https://example.com/",
    "https://other.example/", "https://example.com/?token=x", "https://user:pass@example.com/", "https://mp.weixin.qq.com/s/article"]) {
    await assert.rejects(() => readArticle("https://example.com/", { allowedHosts, io: ioFor({ data: { ...sample.data, url } }) }));
  }
});
test("proxy redirects and HTTP failures are rejected", async () => {
  for (const status of [302, 403, 500]) {
    const io = ioFor();
    io.transport = async () => ({ status, headers: { location: "https://example.com/" }, body: new ReadableStream({ start(c) { c.close(); } }) });
    await assert.rejects(() => readArticle("https://example.com/", { allowedHosts, io }), /too_many_redirects|HTTP/);
  }
});
