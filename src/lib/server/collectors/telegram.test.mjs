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
    server: { middlewareMode: true, watch: null },
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
    for (const [headerSeconds, floodSeconds] of [[60,172800],[172800,60]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({error:'flood_wait',flood_wait:floodSeconds}), {
        status:429,headers:{'Retry-After':String(headerSeconds)},
      });
      const before=Date.now();
      await assert.rejects(()=>fetchTelethonHistory('channel','0'), caught=>{
        const error=/** @type {import('../outbound-policy.ts').CollectionHttpError} */ (caught);
        assert.equal(error.code,'rate_limited');assert.ok(Number(error.retryAt)>=before+172800000);return true;
      });
    }
    globalThis.fetch = async () => json({ error: "membership_required", items: [] }, 400);
    await assert.rejects(() => fetchTelethonHistory("channel", "0"), /membership_required/);
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

test("worker audio history preserves the audio kind and attachment", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  const audio = { external_id: "7", title: "voice", body: "caption", author: "channel", url: "https://t.me/channel/7",
    media_type: "audio", media_urls: ["https://media.example/voice.ogg"], thumbnail_url: "", views: null,
    likes: null, published_at: null, extra: { telegram_id: 7, mime_type: "audio/ogg" } };
  globalThis.fetch = async () => json({ items: [audio, { ...audio, external_id: "8", media_type: "text" }] });
  const { vite } = await loadCollector();
  try {
    const { fetchTelethonHistory } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
    const items = await fetchTelethonHistory("channel", "0");
    assert.equal(items.length, 2);
    assert.equal(items[0].media_type, "audio");
    assert.deepEqual(items[0].media_urls, audio.media_urls);
    assert.equal(items[0].extra.mime_type, "audio/ogg");
    assert.equal(items[0].extra.telegram_id, 7);
    assert.equal(items[0].extra.telethon_media_type, "audio");
    assert.equal(items[1].media_type, "text");
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_WORKER_URL;
  }
});

test("Telegram attachment metadata is validated and canonicalized without media IO", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  const valid = { external_id: "101", title: "attachment", body: "caption", author: "channel", url: "https://t.me/channel/101",
    media_type: "audio", media_urls: [], thumbnail_url: "", views: null, likes: null, published_at: null,
    extra: { forwards: 4, telegram_media: { channel: "Channel", message_id: "101", kind: "audio", size: 6 } } };
  /** @type {any} Deliberately malformed wire fixtures below. */
  let payload = valid;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://telethon:8787/v1/history");
    return json({ items: [payload] });
  };
  const { vite } = await loadCollector();
  try {
    const { fetchTelethonHistory } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
    const [item] = await fetchTelethonHistory("channel", "0");
    assert.equal(item.media_type, "audio");
    assert.deepEqual(item.media_urls, ["telegram://channel/101"]);
    assert.deepEqual(item.extra.telegram_media, { channel: "channel", message_id: "101", kind: "audio", size: 6 });
    assert.equal(item.likes, null); assert.equal(item.extra.forwards, 4);
    for (const extra of [null, {}, { channel: "otherchannel", message_id: "101", kind: "audio", size: 6 },
      { channel: "channel", message_id: "102", kind: "audio", size: 6 },
      { channel: "channel", message_id: "101", kind: "image", size: 6 },
      { channel: "channel", message_id: "101", kind: "audio", size: -1 }]) {
      payload = { ...valid, extra: { ...valid.extra, telegram_media: extra } };
      await assert.rejects(fetchTelethonHistory("channel", "0"), { code: "invalid_response" });
    }
    payload = { ...valid, extra: {}, media_urls: ["telegram://channel/101"] };
    await assert.rejects(fetchTelethonHistory("channel", "0"), { code: "invalid_response" });
  } finally {
    await vite.close(); globalThis.fetch = originalFetch; delete process.env.TELEGRAM_WORKER_URL;
  }
});

test("serialized media leaves history a host permit and cancelled waiters cannot release predecessors", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  process.env.TELEGRAM_MEDIA_TOKEN = "synthetic";
  const originalFetch = globalThis.fetch;
  /** @type {Array<(response: Response) => void>} */
  const releases = [];
  let mediaCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/v1/history")) return json({ items: [] });
    assert.equal(String(input), "http://telethon:8787/v1/media");
    mediaCalls++;
    return new Promise(resolve => releases.push(resolve));
  };
  const { vite } = await loadCollector();
  try {
    const { fetchTelethonMedia, fetchTelethonHistory } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
    const result = { object_key: "telegram/channel/101", content_type: "image/jpeg", bytes: 1, sha256: "a".repeat(64) };
    const first = fetchTelethonMedia("telegram://channel/101");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mediaCalls, 1);
    const controller = new AbortController();
    const cancelled = fetchTelethonMedia("telegram://channel/101", controller.signal);
    const cancellation = assert.rejects(cancelled, { code: "aborted" });
    controller.abort();
    await cancellation;
    const third = fetchTelethonMedia("telegram://channel/101");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mediaCalls, 1);
    assert.equal((await fetchTelethonHistory("channel", "0", 80, AbortSignal.timeout(200))).length, 0);
    releases.shift()?.(json(result));
    await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mediaCalls, 2);
    releases.shift()?.(json({ error: "unavailable" }, 503));
    await assert.rejects(third, { status: 503 });
    const afterError = fetchTelethonMedia("telegram://channel/101");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(mediaCalls, 3);
    releases.shift()?.(json(result));
    assert.deepEqual(await afterError, result);
  } finally {
    for (const release of releases) release(json({}, 503));
    await vite.close(); globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_WORKER_URL; delete process.env.TELEGRAM_MEDIA_TOKEN;
  }
});

test("Telethon health and history never wait for stalled cancellation cleanup", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { status: 503 });
  const { vite } = await loadCollector();
  try {
    const { telethonHealth, fetchTelethonHistory } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    const result = await Promise.race([telethonHealth(controller.signal).then((/** @type {import("../telethon.ts").TelethonHealth} */ health) => health.error, (/** @type {{code:string}} */ error) => error.code),
      new Promise((resolve) => setTimeout(() => resolve("still_waiting"), 150))]);
    clearTimeout(timer);
    assert.notEqual(result, "still_waiting");
    assert.ok(["worker HTTP 503", "aborted"].includes(String(result)));
    assert.equal(cancelled, 1);
    for (const oversized of [true, false]) {
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(stream) { if (oversized) stream.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
        cancel() { cancelled++; return new Promise(() => {}); },
      }));
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 20);
      const errorCode = await Promise.race([fetchTelethonHistory("channel", "0", 80, abort.signal).then(() => "unexpected_success", (/** @type {{code:string}} */ error) => error.code),
        new Promise((resolve) => setTimeout(() => resolve("still_waiting"), 150))]);
      clearTimeout(timeout);
      assert.equal(errorCode, oversized ? "response_too_large" : "aborted");
    }
    assert.equal(cancelled, 3);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.TELEGRAM_WORKER_URL;
  }
});


test("unavailable worker never falls back to t.me/s", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  /** @type {string[]} */
  const urls = [];
  globalThis.fetch = async (input) => { urls.push(String(input)); return new Response('{}', { status: 503 }); };
  let publicRequests = 0;
  const { vite, collectSource } = await loadCollector();
  try {
    await assert.rejects(() => collectSource(source, {
      resolver: { async lookup() { publicRequests++; throw new Error("unexpected public fallback"); } },
    }), /unavailable/);
    assert.deepEqual(urls, ["http://telethon:8787/health"]);
    assert.equal(urls.some(url => url.includes("t.me/s")), false);
    assert.equal(publicRequests, 0);
  } finally {
    await vite.close(); globalThis.fetch = originalFetch; delete process.env.TELEGRAM_WORKER_URL;
  }
});


test("explicit connecting and unavailable states keep retry metadata and never use the public adapter", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ["connecting", "unavailable"]) {
      const urls = /** @type {string[]} */ ([]);
      globalThis.fetch = async (input) => {
        urls.push(String(input));
        return json({ ok: false, authorized: false, state, retry_after_seconds: 15 });
      };
      const { vite, collectSource } = await loadCollector();
      try {
        const before = Date.now();
        await assert.rejects(() => collectSource(source, { resolver: { async lookup() { throw new Error("unexpected public fallback"); } } }), (/** @type {any} */ err) => {
          assert.match(err.message, /unavailable/);
          assert.deepEqual(err.meta.attempts, ["telethon"]);
          assert.ok(err.retryAt >= before + 15000);
          return true;
        });
        assert.deepEqual(urls, ["http://telethon:8787/health"]);
      } finally { await vite.close(); }
    }
  } finally { globalThis.fetch = originalFetch; delete process.env.TELEGRAM_WORKER_URL; }
});

test("worker health preserves all explicit states, rejects malformed states, and retains HTTP retry timing", async () => {
  process.env.TELEGRAM_WORKER_URL = "http://telethon:8787";
  const originalFetch = globalThis.fetch;
  try {
    for (const state of ["ready", "cooldown", "unauthorized", "unconfigured", "connecting", "unavailable", "invalid"]) {
      const authorized = ["ready", "cooldown"].includes(state);
      globalThis.fetch = async () => json({ ok: !["connecting", "unavailable"].includes(state), authorized, state, retry_after_seconds: 12 });
      const { vite } = await loadCollector();
      try {
        const { telethonHealth } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
        const h = await telethonHealth();
        assert.equal(h.state, state === "invalid" ? "unavailable" : state);
        assert.equal(h.authorized, authorized);
        if (state === "invalid") assert.equal(h.error, "invalid_response");
        else assert.equal(h.retry_after_seconds, 12);
      } finally { await vite.close(); }
    }
    globalThis.fetch = async () => new Response('{}', { status: 503, headers: { "Retry-After": "60" } });
    const { vite } = await loadCollector();
    try {
      const { telethonHealth } = await vite.ssrLoadModule("/src/lib/server/telethon.ts");
      const h = await telethonHealth();
      assert.equal(h.state, "unavailable"); assert.equal(h.status, 503); assert.equal(h.retry_after_seconds, 60);
    } finally { await vite.close(); }
  } finally { globalThis.fetch = originalFetch; delete process.env.TELEGRAM_WORKER_URL; }
});


test("explicit backfill never substitutes a finite public or RSS window", async () => {
  delete process.env.TELEGRAM_WORKER_URL;
  const {vite,collectSource}=await loadCollector();
  try {
    let calls=0;
    const io={transport:async()=>{calls++;throw new Error('unexpected public fetch');}};
    const backfill={...source,scan_state:{bootstrap:'backfill',boundary:'100'}};
    await assert.rejects(()=>collectSource(backfill,io),/backfill_requires_authorized_worker/);
    await assert.rejects(()=>collectSource({...backfill,feed_url:'https://example.invalid/feed'},io),/backfill_requires_authorized_worker/);
    assert.equal(calls,0);
  } finally {await vite.close();}
});
