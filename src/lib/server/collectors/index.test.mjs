import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

/** @param {unknown} error */
function httpFailure(error) {
  assert.ok(error instanceof Error);
  return /** @type {import("../outbound-policy.ts").CollectionHttpError & {meta: import("./types.ts").CollectorMeta}} */ (error);
}

/**
 * The RSS fallback must preserve the paid-gateway attempt metadata.
 *
 * The gateway leg is still stubbed on `globalThis.fetch` (it is an internal
 * service with its own transport). The RSS fallback leg goes through the real
 * outbound policy, so it is driven by the `io` seam: a stub transport supplies
 * the feed and a stub resolver keeps the suite offline. Stubbing only `fetch`
 * would leave the fallback unable to resolve — that is the policy working, not
 * the product failing.
 */
test("RSS fallback preserves paid gateway attempts in batch metadata", async () => {
  process.env.WECHAT_GATEWAY_URL = "https://gateway.example";
  process.env.WECHAT_GATEWAY_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).startsWith("https://gateway.example/")
    ? new Response("gateway failed", { status: 503, headers: {
      "X-Loom-Provider": "",
      "X-Loom-Attempts": "primary,dajiala",
      "X-Loom-Paid-Call": "true",
    } })
    : new Response("unexpected direct fetch", { status: 500 });
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");

    // Offline seam for the RSS fallback: a stub resolver plus the feed body.
    const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
        <title>Fallback</title><entry><id>article-1</id><title>Fallback article</title>
        <link href="https://mp.weixin.qq.com/s/a"/><updated>2026-08-31T00:00:00Z</updated>
        <content type="html">body</content></entry></feed>`;
    const io = {
      resolver: { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } },
      transport: async () => ({
        status: 200,
        headers: { "content-type": "application/atom+xml" },
        body: new Response(feed).body,
      }),
    };

    const result = await collectSource({ id: "wx-source", platform: "wechat", name: "公众号",
      handle: "gh_example", url: "https://mp.weixin.qq.com/s/example",
      feed_url: "https://fallback.example/feed.atom", adapter: "wechat_gateway",
      last_external_id: "" }, io);
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.meta, { provider: "", attempts: ["primary", "dajiala", "rss"],
      paid_call: true });
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.WECHAT_GATEWAY_URL;
    delete process.env.WECHAT_GATEWAY_TOKEN;
  }
});

test("gateway byte caps and cancellation retain collector errors without replaying paid requests", async () => {
  process.env.WECHAT_GATEWAY_URL = "https://gateway.example";
  process.env.WECHAT_GATEWAY_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  const headers = { "X-Loom-Provider": "dajiala", "X-Loom-Attempts": "primary,dajiala", "X-Loom-Paid-Call": "true" };
  const source = { id: "wx-source", platform: "wechat", name: "公众号", handle: "gh_example", url: "",
    feed_url: "", adapter: "wechat_gateway", last_external_id: "" };
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    let calls = 0;
    let cancelled = false;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      return new Response(new ReadableStream({
        // Under 8 MiB in UTF-16 characters, over 8 MiB on the wire.
        start(controller) { controller.enqueue(new TextEncoder().encode("中".repeat(3 * 1024 * 1024))); },
        cancel() { cancelled = true; },
      }), { headers });
    };
    await assert.rejects(() => collectSource(source), (caught) => {
      const error = httpFailure(caught);
      assert.equal(error.code, "response_too_large");
      assert.equal(error.meta.paid_call, true);
      assert.deepEqual(error.meta.attempts, ["primary", "dajiala"]);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
    for (const status of [429, 503]) {
      globalThis.fetch = async () => { calls++; return new Response("secret", { status, headers: { ...headers, "Retry-After": "120" } }); };
      const before = Date.now();
      await assert.rejects(() => collectSource(source), (caught) => {
        const error = httpFailure(caught);
        assert.equal(error.status, status);
        assert.equal(error.code, status === 429 ? "rate_limited" : "http_error");
        assert.ok((error.retryAt ?? 0) >= before + 120000);
        assert.equal(error.meta.paid_call, true);
        assert.ok(!error.message.includes("secret"));
        return true;
      });
    }
    assert.equal(calls, 3);
    cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers });
    const controller = new AbortController();
    /** @type {string[]} */
    const fallbackUrls = [];
    const io = { signal: controller.signal, transport: async (/** @type {URL} */ url) => {
      fallbackUrls.push(url.href);
      return { status: 200, headers: {}, body: new Response("").body };
    } };
    const pending = collectSource({ ...source, feed_url: "https://fallback.example/" }, io);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => pending, { code: "aborted" });
    assert.equal(cancelled, true);
    assert.deepEqual(fallbackUrls, []);
    globalThis.fetch = async () => { throw new DOMException("token=secret", "TimeoutError"); };
    await assert.rejects(() => collectSource({ ...source, feed_url: "https://fallback.example/" }, { transport: io.transport }), { code: "timeout" });
    assert.deepEqual(fallbackUrls, []);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.WECHAT_GATEWAY_URL;
    delete process.env.WECHAT_GATEWAY_TOKEN;
  }
});

test("public and failed RSS fallback wrappers preserve HTTP status, retry time and paid metadata", async () => {
  process.env.WECHAT_GATEWAY_URL = "https://gateway.example";
  process.env.WECHAT_GATEWAY_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("failed", { status: 503, headers: {
    "X-Loom-Provider": "", "X-Loom-Attempts": "primary,dajiala", "X-Loom-Paid-Call": "true",
  } });
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    const io = { resolver: { async lookup() { return [{ address: "1.1.1.1", family: 4 }]; } },
      transport: async () => ({ status: 429, headers: { "retry-after": "120" }, body: new Response("secret").body }) };
    for (const gateway of [false, true]) {
      const before = Date.now();
      await assert.rejects(() => collectSource({ id: "source", platform: gateway ? "wechat" : "rss", name: "source",
        handle: "", url: "", feed_url: "https://fallback.example/?token=secret", adapter: gateway ? "wechat_gateway" : "rss" }, io), (caught) => {
        const error = httpFailure(caught);
        assert.equal(error.code, "rate_limited");
        assert.equal(error.status, 429);
        assert.ok((error.retryAt ?? 0) >= before + 120000);
        assert.deepEqual(error.meta.attempts, gateway ? ["primary", "dajiala", "rss"] : ["rss"]);
        assert.equal(error.meta.paid_call, gateway);
        assert.ok(!error.message.includes("secret"));
        return true;
      });
    }
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.WECHAT_GATEWAY_URL;
    delete process.env.WECHAT_GATEWAY_TOKEN;
  }
});

test("adapters using an explicit RSS URL do not replay its failed request", async () => {
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    for (const adapter of ["rss", "telegram_web", "bilibili", "youtube", "rsshub"]) {
      /** @type {string[]} */
      const urls = [];
      await assert.rejects(() => collectSource({ id: "source", platform: "rss", name: "source", handle: "", url: "",
        feed_url: "https://feed.example/", adapter }, {
        resolver: { async lookup() { return [{ address: "1.1.1.1", family: 4 }]; } },
        transport: async (/** @type {URL} */ url) => { urls.push(url.href); return { status: 503, headers: {}, body: new Response("failed").body }; },
      }), { code: "http_error", status: 503 });
      assert.deepEqual(urls, ["https://feed.example/"], adapter);
    }
  } finally { await vite.close(); }
});
