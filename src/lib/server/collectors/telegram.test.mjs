import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

const source = {
  id: "src_tg_durov",
  platform: "telegram",
  name: "Durov's Channel",
  handle: "durov",
  url: "https://t.me/s/durov",
  feed_url: "",
  adapter: "telegram_web",
  last_external_id: "548",
};

/** @param {unknown} body */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function loadCollector() {
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true },
  });
  const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
  return { vite, collectSource };
}

test("authorized Telethon failure does not fall back to t.me/s", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/health")) {
      return json({ ok: true, authorized: true, paused_until: 0 });
    }
    if (url.endsWith("/v1/history")) {
      assert.equal(init?.method, "POST");
      return json({ error: "timeout" }, 400);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const { vite, collectSource } = await loadCollector();
  try {
    await assert.rejects(
      () => collectSource(source),
      (err) => {
        assert.match(String(/** @type {Error} */ (err).message), /timeout/);
        assert.deepEqual(/** @type {Error & {meta: {attempts: string[]}}} */ (err).meta.attempts, ["telethon"]);
        return true;
      },
    );
    assert.equal(urls.some((url) => url.includes("t.me/s")), false);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_WORKER_URL;
  }
});

test("authorized FloodWait pause does not fall back to t.me/s", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return json({ ok: true, authorized: true, paused_until: 12 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const { vite, collectSource } = await loadCollector();
  try {
    await assert.rejects(
      () => collectSource(source),
      (err) => {
        assert.match(String(/** @type {Error} */ (err).message), /FloodWait/);
        assert.deepEqual(/** @type {Error & {meta: {attempts: string[]}}} */ (err).meta.attempts, ["telethon"]);
        return true;
      },
    );
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_WORKER_URL;
  }
});

test("unauthorized node uses t.me/s and records that channel", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return json({ ok: true, authorized: false, paused_until: 0 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const io = {
    resolver: { async lookup() { return [{ address: "149.154.167.99", family: 4 }]; } },
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: new Response(`<div class="tgme_widget_message " data-post="durov/1">
        <time datetime="2026-09-29T00:00:00+00:00"></time>
        <div class="tgme_widget_message_text">hello</div>
        <span class="tgme_widget_message_views">1</span>
      </div>`).body,
    }),
  };
  const { vite, collectSource } = await loadCollector();
  try {
    const result = await collectSource(source, io);
    assert.deepEqual(result.meta.attempts, ["t.me/s"]);
    assert.ok(result.items.length >= 1);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_WORKER_URL;
  }
});

test("Telethon history is capped, shape validated, cancellable, and keeps safe HTTP metadata", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  const { vite } = await loadCollector();
  try {
    const { fetchTelethonHistory } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
    const valid = { external_id: "1", title: "title", body: "body", author: "author", url: "https://t.me/channel/1",
      media_type: "text", media_urls: [], thumbnail_url: "", views: null, likes: null, published_at: null, extra: {} };
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return json({ items: [valid] });
    };
    assert.equal((await fetchTelethonHistory("channel", "0"))[0].extra.collector, "telethon");
    for (const payload of [null, [], {}, { items: "wrong" }, { items: [null] }, { items: [{ ...valid, external_id: 7 }] }, { items: [{ ...valid, media_urls: [false] }] }]) {
      globalThis.fetch = async () => json(payload);
      await assert.rejects(() => fetchTelethonHistory("channel", "0"), { code: "invalid_response" });
    }
    for (const status of [429, 503]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "https://worker/?token=secret" }), {
        status, headers: { "Retry-After": "120" },
      });
      const before = Date.now();
      await assert.rejects(() => fetchTelethonHistory("channel", "0"), (caught) => {
        const error = /** @type {import("../outbound-policy.ts").CollectionHttpError} */ (caught);
        assert.equal(error.status, status);
        assert.equal(error.code, status === 429 ? "rate_limited" : "http_error");
        assert.ok((error.retryAt ?? 0) >= before + 120000);
        assert.ok(!error.message.includes("secret"));
        return true;
      });
    }
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(() => fetchTelethonHistory("channel", "0"), { code: "response_too_large" });
    assert.equal(cancelled, true);
    cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const controller = new AbortController();
    const pending = fetchTelethonHistory("channel", "0", 80, controller.signal);
    setTimeout(() => controller.abort(new Error("secret")), 20);
    await assert.rejects(() => pending, { code: "aborted" });
    assert.equal(cancelled, true);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_WORKER_URL;
  }
});

test("Telethon health rejects truthy authorization and oversized JSON", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  for (const oversized of [false, true]) {
    globalThis.fetch = async () => oversized ? new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    })) : json({ ok: true, authorized: "false" });
    const { vite } = await loadCollector();
    try {
      const { telethonHealth } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
      const health = await telethonHealth();
      assert.equal(health.authorized, false);
      assert.equal(health.error, oversized ? "response_too_large" : "invalid_response");
    } finally { await vite.close(); }
  }
  assert.equal(cancelled, true);
  globalThis.fetch = originalFetch;
  delete process.env.TELEGRAM_WORKER_URL;
});
