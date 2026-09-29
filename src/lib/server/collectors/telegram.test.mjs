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
        assert.match(String(err.message), /timeout/);
        assert.deepEqual(err.meta.attempts, ["telethon"]);
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
