import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

const offlineEnv = {
  DATABASE_URL: "", NODE_ENV: "test", LOOM_MODEL_CONFIG: path.resolve(".superpowers/nonexistent-offline-model.json"), XAI_API_KEY: "",
  TELEGRAM_WORKER_URL: "", MINIO_ENDPOINT: "", EXTRACT_AUTO: "false", AUTO_ANALYZE: "false",
  AGENT_ASYNC_RESEARCH_ENABLED: "false", AGENT_WORKER_ENABLED: "false", AGENT_OPENCODE_WORKER_ENABLED: "false",
  AGENT_ASSISTANT_ENABLED: "false", AGENT_ASSISTANT_ACTIONS_ENABLED: "false",
};
Object.assign(process.env, offlineEnv);

test("gateway failure preserves paid attempts without bypassing to the primary feed", async () => {
  process.env.WECHAT_GATEWAY_URL = "https://gateway.example";
  process.env.WECHAT_GATEWAY_TOKEN = "test-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("gateway failed", { status: 503, headers: {
    "X-Loom-Provider": "dajiala", "X-Loom-Attempts": "primary,dajiala", "X-Loom-Paid-Call": "true",
  } });
  const vite = await createServer({ configFile: false, logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } }, server: { middlewareMode: true } });
  try {
    const { collectSource } = await vite.ssrLoadModule("/src/lib/server/collectors/index.ts");
    let rssCalls = 0;
    const io = {
      resolver: { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } },
      transport: async () => { rssCalls += 1; throw new Error("must not bypass gateway"); },
    };
    await assert.rejects(() => collectSource({ id: "wx-source", platform: "wechat", name: "公众号",
      handle: "gh_example", url: "https://mp.weixin.qq.com/s/example",
      feed_url: "https://primary.example/feed.atom", adapter: "wechat_gateway", last_external_id: "" }, io),
    (error) => {
      assert.ok(error instanceof Error && "meta" in error);
      assert.equal(error.message, "wechat_gateway_http_503");
      assert.deepEqual(error.meta, { provider: "dajiala", attempts: ["primary", "dajiala"], paid_call: true });
      return true;
    });
    assert.equal(rssCalls, 0);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    delete process.env.WECHAT_GATEWAY_URL;
    delete process.env.WECHAT_GATEWAY_TOKEN;
  }
});
