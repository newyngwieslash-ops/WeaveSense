import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("feed collectors expose rejection counts and window-only coverage", async () => {
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    const io = { resolver: { async lookup() { return [{ address: "1.1.1.1", family: 4 }]; } },
      transport: async () => ({ status: 200, headers: {}, body: new Response('<rss><channel><item/><item><guid>1</guid><title>ok</title></item></channel></rss>').body }) };
    for (const adapter of ["rss", "telegram_web", "youtube", "bilibili", "rsshub"]) {
      const result = await collectSource({ id: "s", platform: "rss", name: "s", handle: "", url: "",
        feed_url: "https://feed.example/feed", adapter }, io);
      assert.equal(result.items.length, 1);
      assert.equal(result.rejected_entries, 1);
      assert.equal(result.coverage.complete, false);
      assert.equal(result.coverage.window_only, true);
    }
    io.transport = async () => ({ status: 200, headers: {}, body: new Response(`<rss><channel><item><guid>${"g".repeat(321)}</guid><title>overlong</title></item><item><guid>supported</guid><title>ok</title></item></channel></rss>`).body });
    const mixed = await collectSource({ id: "s", platform: "rss", name: "s", handle: "", url: "",
      feed_url: "https://feed.example/feed", adapter: "rss" }, io);
    assert.deepEqual(mixed.items.map((/** @type {{ external_id: string }} */ item) => item.external_id), ["supported"]);
    assert.equal(mixed.rejected_entries, 1);
    io.transport = async () => ({ status: 200, headers: {}, body: new Response('<html>verify</html>').body });
    await assert.rejects(() => collectSource({ id: "s", platform: "rss", name: "s", handle: "", url: "",
      feed_url: "https://feed.example/feed", adapter: "rss" }, io), { code: "feed_unknown_root" });
  } finally { await vite.close(); }
});

/** @param {unknown} error */
function httpFailure(error) {
  assert.ok(error instanceof Error);
  return /** @type {import("../outbound-policy.ts").CollectionHttpError & {meta: import("./types.ts").CollectorMeta}} */ (error);
}

/** A naked Feed must never bypass the gateway's provider/budget boundary. */
test("gateway failure retains paid attempts and never bypasses the gateway via naked feed", async () => {
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
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");

    let publicCalls = 0;
    const io = {
      resolver: { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } },
      transport: async () => { publicCalls++; throw new Error("unexpected_naked_feed"); },
    };
    await assert.rejects(() => collectSource({ id: "wx-source", platform: "wechat", name: "公众号",
      handle: "gh_example", url: "https://mp.weixin.qq.com/s/example",
      feed_url: "https://fallback.example/feed.atom", adapter: "wechat_gateway",
      last_external_id: "" }, io), (caught) => {
      const error = httpFailure(caught);
      assert.equal(error.status, 503);
      assert.equal(error.code, "http_error");
      assert.deepEqual(error.meta, { provider: "", attempts: ["primary", "dajiala"], paid_call: true });
      return true;
    });
    assert.equal(publicCalls, 0);
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
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
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
    const io = { signal: controller.signal, transport: async (url) => {
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

test("public and gateway failures retain their own classification and paid metadata", async () => {
  process.env.WECHAT_GATEWAY_URL = "https://gateway.example";
  process.env.WECHAT_GATEWAY_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("failed", { status: 503, headers: {
    "X-Loom-Provider": "", "X-Loom-Attempts": "primary,dajiala", "X-Loom-Paid-Call": "true",
  } });
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    const io = { resolver: { async lookup() { return [{ address: "1.1.1.1", family: 4 }]; } },
      transport: async () => ({ status: 429, headers: { "retry-after": "120" }, body: new Response("secret").body }) };
    for (const gateway of [false, true]) {
      const before = Date.now();
      await assert.rejects(() => collectSource({ id: "source", platform: gateway ? "wechat" : "rss", name: "source",
        handle: "", url: "", feed_url: "https://fallback.example/?token=secret", adapter: gateway ? "wechat_gateway" : "rss" }, io), (caught) => {
        const error = httpFailure(caught);
        assert.equal(error.code, gateway ? "http_error" : "rate_limited");
        assert.equal(error.status, gateway ? 503 : 429);
        if (!gateway) assert.ok((error.retryAt ?? 0) >= before + 120000);
        assert.deepEqual(error.meta.attempts, gateway ? ["primary", "dajiala"] : ["rss"]);
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

test("unknown adapters fail before any request, including prototype names", async () => {
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    for (const adapter of ["unknown", "constructor", "toString"]) await assert.rejects(() => collectSource({
      id: "legacy", platform: "rss", name: "legacy", handle: "", url: "", feed_url: "https://feed.example/", adapter,
    }, { transport: async () => { throw new Error("unexpected request"); } }), { message: "unsupported_adapter", code: "config_error" });
  } finally { await vite.close(); }
});

test("adapters using an explicit RSS URL do not replay its failed request", async () => {
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    for (const adapter of ["rss", "telegram_web", "bilibili", "youtube", "rsshub"]) {
      /** @type {string[]} */
      const urls = [];
      await assert.rejects(() => collectSource({ id: "source", platform: "rss", name: "source", handle: "", url: "",
        feed_url: "https://feed.example/", adapter }, {
        resolver: { async lookup() { return [{ address: "1.1.1.1", family: 4 }]; } },
        transport: async (url) => { urls.push(url.href); return { status: 503, headers: {}, body: new Response("failed").body }; },
      }), { code: "http_error", status: 503 });
      assert.deepEqual(urls, ["https://feed.example/"], adapter);
    }
  } finally { await vite.close(); }
});

test("gateway HTTP failures do not wait for stalled cancellation cleanup", async () => {
  process.env.WECHAT_GATEWAY_URL = "https://gateway.example";
  process.env.WECHAT_GATEWAY_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { status: 503, headers: { "X-Loom-Provider": "primary", "X-Loom-Attempts": "primary", "X-Loom-Paid-Call": "false" } });
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    const outcome = await Promise.race([collectSource({ id: "source", platform: "wechat", name: "source", handle: "", url: "",
      feed_url: "", adapter: "wechat_gateway" }, { signal: controller.signal }).then(() => "unexpected_success", (/** @type {{code:string}} */ error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("still_waiting"), 150))]);
    clearTimeout(timer);
    assert.notEqual(outcome, "still_waiting");
    assert.ok(["http_error", "aborted"].includes(String(outcome)));
    assert.equal(cancelled, true);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.WECHAT_GATEWAY_URL;
    delete process.env.WECHAT_GATEWAY_TOKEN;
  }
});

test('gateway cooldown cannot be hidden by RSS fallback success', async () => {
  process.env.WECHAT_GATEWAY_URL='https://gateway.example';process.env.WECHAT_GATEWAY_TOKEN='test';
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response('',{status:429,headers:{'retry-after':'172800','X-Loom-Provider':'primary','X-Loom-Attempts':'primary','X-Loom-Paid-Call':'false'}});
  const vite=await createServer({configFile:false,logLevel:'silent',resolve:{alias:{'@':path.resolve('src')}},server:{middlewareMode:true,watch:null}});
  try {
    const {collectSource}=await vite.ssrLoadModule('/src/lib/server/collectors/index.ts');
    let fallback=0;
    await assert.rejects(()=>collectSource({id:'s',platform:'wechat',name:'s',handle:'',url:'',feed_url:'https://feed.example/',adapter:'wechat_gateway'}, {
      resolver:{async lookup(){fallback++;return [{address:'1.1.1.1',family:4}];}},
      transport:async()=>({status:200,headers:{},body:new Response('<rss><channel/></rss>').body}),
    }),/** @param {unknown} error */ error=>{const failure=httpFailure(error);assert.equal(failure.code,'rate_limited');assert.ok(Number(failure.retryAt)>Date.now()+47*3600000);return true;});
    assert.equal(fallback,0);
  } finally {await vite.close();globalThis.fetch=original;delete process.env.WECHAT_GATEWAY_URL;delete process.env.WECHAT_GATEWAY_TOKEN;}
});

test("validated Feed normalization selects only the configured public feed", async (t) => {
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true, watch: null } });
  const originalFetch = globalThis.fetch;
  let directCalls = 0;
  globalThis.fetch = async () => { directCalls++; throw new Error("unexpected_native_gateway_or_worker_fetch"); };
  try {
    const { validateSourceInput } = await vite.ssrLoadModule("/src/lib/server/source-validation.ts");
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    /** @type {Array<{ label: string, platform: string, handle?: string, url?: string, feed_url?: string }>} */
    const cases = [];
    for (const protocol of ["HTTPS", "hTtPs"]) {
      for (const platform of ["rss", "telegram", "bilibili", "youtube", "xhs", "douyin", "xigua"]) {
        cases.push({ label: `${platform} ${protocol} explicit Feed`, platform,
          handle: platform === "telegram" ? "offline_channel" : platform === "bilibili" ? "12345" : "",
          feed_url: `${protocol}://FEED.example:443/Configured.xml?source=${platform}` });
      }
      for (const field of ["handle", "url"]) cases.push({ label: `RSS ${protocol} ${field} fallback`,
        platform: "rss", [field]: `${protocol}://FEED.example:443/Configured.xml?legacy=${field}` });
      cases.push({ label: `YouTube ${protocol} Feed in handle`, platform: "youtube",
        handle: `${protocol}://WWW.YouTube.com:443/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv` });
    }
    for (const { label, ...input } of cases) await t.test(label, async () => {
      const validated = validateSourceInput({ name: "offline Feed normalization", interval_minutes: 30, ...input });
      assert.ok(validated.ok);
      const expected = new URL(input.feed_url || input.handle || input.url || "").href;
      const requests = /** @type {string[]} */ ([]), hosts = /** @type {string[]} */ ([]);
      const result = await collectSource(validated.value, {
        resolver: { async lookup(/** @type {string} */ host) { hosts.push(host); assert.equal(host, new URL(expected).hostname);
          return [{ address: "1.1.1.1", family: 4 }]; } },
        transport: async (/** @type {URL} */ url) => { requests.push(url.href); assert.equal(url.href, expected);
          return { status: 200, headers: {}, body: new Response('<rss><channel><item><guid>offline</guid><title>offline Feed</title></item></channel></rss>').body }; },
      });
      assert.equal(validated.value.feed_url, expected);
      assert.deepEqual(requests, [expected]); assert.deepEqual(hosts, [new URL(expected).hostname]);
      assert.equal(result.items.length, 1); assert.equal(directCalls, 0);
    });
    assert.equal(directCalls, 0);
  } finally { globalThis.fetch = originalFetch; await vite.close(); }
});
