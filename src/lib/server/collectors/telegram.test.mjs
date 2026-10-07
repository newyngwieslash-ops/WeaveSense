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
        const error = /** @type {Error & { meta: { attempts: string[] } }} */ (err);
        assert.match(String(error.message), /timeout/);
        assert.deepEqual(error.meta.attempts, ["telethon"]);
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
        const error = /** @type {Error & { meta: { attempts: string[] } }} */ (err);
        assert.match(String(error.message), /FloodWait/);
        assert.deepEqual(error.meta.attempts, ["telethon"]);
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
