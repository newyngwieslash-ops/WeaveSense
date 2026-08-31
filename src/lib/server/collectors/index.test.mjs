import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

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
    : new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
        <title>Fallback</title><entry><id>article-1</id><title>Fallback article</title>
        <link href="https://mp.weixin.qq.com/s/a"/><updated>2026-08-31T00:00:00Z</updated>
        <content type="html">body</content></entry></feed>`, {
        headers: { "content-type": "application/atom+xml" },
      });
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    const result = await collectSource({ id: "wx-source", platform: "wechat", name: "公众号",
      handle: "gh_example", url: "https://mp.weixin.qq.com/s/example",
      feed_url: "https://fallback.example/feed.atom", adapter: "wechat_gateway",
      last_external_id: "" });
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
