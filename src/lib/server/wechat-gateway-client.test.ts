import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWechatGatewayClient } from "./wechat-gateway-client.ts";

const TOKEN = "gateway-test-secret";
const SOURCE = {
  source_id: "wx-0123456789abcdef0123",
  name: "示例号",
  wechat_id: "gh_example",
  sample_url: "https://mp.weixin.qq.com/s/example",
  primary_feed_url: "https://feeds.example.com/example.atom",
  interval_minutes: 60 as const,
  priority: "normal" as const,
};
const HEALTH = {
  as_of: "2026-08-28T12:00:00.000Z",
  sources: [{
    source_id: SOURCE.source_id,
    last_primary_ok_at: "2026-08-28T08:00:00.000Z",
    consecutive_primary_failures: 0,
    recent_error_type: "",
    last_paid_check_at: null,
    last_paid_result: "",
    alert_state: "normal",
    next_retry_at: null,
  }],
  usage: { today: "2026-08-28", day: "2026-08-28", calls: 2, amount: 0.12,
    days: [{ day: "2026-08-28", calls: 2, amount: 0.12 }] },
  limits: { daily_calls: 250, daily_rmb: 20, paid_configured: true },
};

describe("createWechatGatewayClient", () => {
  it("provisions the exact gateway source contract with bearer auth", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const client = createWechatGatewayClient({
      baseUrl: "https://gateway.example/internal/",
      token: TOKEN,
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return Response.json({ ok: true });
      },
    });

    assert.deepEqual(await client.putSource(SOURCE), { ok: true });
    assert.equal(request?.url, "https://gateway.example/internal/v1/sources/wx-0123456789abcdef0123");
    assert.equal(request?.init?.method, "PUT");
    assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(new Headers(request?.init?.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      name: "示例号",
      account_id: "gh_example",
      priority: "normal",
      sample_url: "https://mp.weixin.qq.com/s/example",
      primary_feed_url: "https://feeds.example.com/example.atom",
    });
    assert.ok(request?.init?.signal instanceof AbortSignal);
  });

  it("reads aggregate health with the same auth", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const health = HEALTH;
    const client = createWechatGatewayClient({ baseUrl: "http://gateway:8790", token: TOKEN,
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return Response.json(health);
      } });
    assert.deepEqual(await client.listHealth(), health);
    assert.equal(request?.url, "http://gateway:8790/v1/health");
    assert.equal(request?.init?.method, "GET");
    assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    await client.listHealth({ from: "2026-08-28", to: "2026-08-29" });
    assert.equal(request?.url, "http://gateway:8790/v1/health?from=2026-08-28&to=2026-08-29");
  });

  it("uses 20-second provisioning and 30-second health timeouts", async () => {
    const seen: number[] = [];
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: (milliseconds: number) => {
      seen.push(milliseconds);
      return new AbortController().signal;
    } });
    try {
      const client = createWechatGatewayClient({ baseUrl: "https://gateway.example", token: TOKEN,
        fetchImpl: async () => Response.json({ ok: true }) });
      await client.putSource(SOURCE);
      const healthClient = createWechatGatewayClient({ baseUrl: "https://gateway.example", token: TOKEN,
        fetchImpl: async () => Response.json(HEALTH) });
      await healthClient.listHealth();
      assert.deepEqual(seen, [20_000, 30_000]);
    } finally {
      Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: original });
    }
  });

  it("maps HTTP, invalid JSON, oversized, timeout, and network failures to fixed errors", async () => {
    const cases: Array<[string, () => Promise<Response>, string]> = [
      ["401", async () => new Response(`leak:${TOKEN}`, { status: 401 }), "wechat_gateway_unauthorized"],
      ["422", async () => new Response(`leak:${TOKEN}`, { status: 422 }), "wechat_gateway_source_rejected"],
      ["500", async () => new Response(`leak:${TOKEN}`, { status: 500 }), "wechat_gateway_http_error"],
      ["invalid JSON", async () => new Response(`{"secret":"${TOKEN}"`), "wechat_gateway_invalid_response"],
      ["oversized", async () => new Response("x".repeat(1024 * 1024 + 1)), "wechat_gateway_response_too_large"],
      ["timeout", async () => { throw new DOMException(`leak:${TOKEN}`, "TimeoutError"); }, "wechat_gateway_timeout"],
      ["network", async () => { throw new Error(`leak:${TOKEN}`); }, "wechat_gateway_unavailable"],
    ];
    for (const [label, fetchImpl, error] of cases) {
      const client = createWechatGatewayClient({ baseUrl: "https://gateway.example", token: TOKEN, fetchImpl });
      await assert.rejects(client.putSource(SOURCE), (value: unknown) => {
        assert.equal((value as Error).message, error, label);
        assert.doesNotMatch((value as Error).message, new RegExp(TOKEN));
        return true;
      });
    }
  });

  it("rejects invalid success shapes and any response that echoes the token", async () => {
    for (const body of [{ ok: false }, ["not", "an", "object"], { sources: [], reflected: TOKEN }]) {
      const client = createWechatGatewayClient({ baseUrl: "https://gateway.example", token: TOKEN,
        fetchImpl: async () => Response.json(body) });
      const run = Array.isArray(body) || "ok" in body ? client.putSource(SOURCE) : client.listHealth();
      await assert.rejects(run, /wechat_gateway_invalid_response/);
    }
  });

  it("requires status 200 for source provisioning while health accepts normal 2xx", async () => {
    const created = createWechatGatewayClient({ baseUrl: "https://gateway.example", token: TOKEN,
      fetchImpl: async () => Response.json({ ok: true }, { status: 201 }) });
    await assert.rejects(created.putSource(SOURCE), /wechat_gateway_http_error/);

    const noContentHealth = createWechatGatewayClient({ baseUrl: "https://gateway.example", token: TOKEN,
      fetchImpl: async () => Response.json(HEALTH, { status: 202 }) });
    assert.deepEqual(await noContentHealth.listHealth(), HEALTH);
  });

  it("strictly rejects unsafe, oversized, and malformed aggregate health shapes", async () => {
    const invalid = [
      { ...HEALTH, sources: Array.from({ length: 1_001 }, () => HEALTH.sources[0]) },
      { ...HEALTH, sources: [{ ...HEALTH.sources[0], alert_state: "secret-upstream-state" }] },
      { ...HEALTH, sources: [{ ...HEALTH.sources[0], source_id: "../unsafe" }] },
      { ...HEALTH, sources: [{ ...HEALTH.sources[0], last_primary_ok_at: "2026" }] },
      { ...HEALTH, sources: [{ ...HEALTH.sources[0], last_primary_ok_at: "2026-02-30T08:00:00.000Z" }] },
      { ...HEALTH, usage: { ...HEALTH.usage, calls: -1 } },
      { ...HEALTH, usage: { ...HEALTH.usage, today: "2026-02-30" } },
      { ...HEALTH, as_of: "not-a-time" },
      { ...HEALTH, sources: [{ ...HEALTH.sources[0],
        last_primary_ok_at: "2026-08-28T12:00:00.001Z" }] },
      { ...HEALTH, sources: [{ ...HEALTH.sources[0],
        last_paid_check_at: "2026-08-28T12:00:00.001Z" }] },
      { ...HEALTH, usage: { ...HEALTH.usage, days: [] } },
      { ...HEALTH, usage: { ...HEALTH.usage, days: [HEALTH.usage.days[0], HEALTH.usage.days[0]] } },
      { ...HEALTH, usage: { ...HEALTH.usage, calls: 3 } },
      { ...HEALTH, limits: { ...HEALTH.limits, paid_configured: "yes" } },
    ];
    for (const body of invalid) {
      const client = createWechatGatewayClient({ baseUrl: "https://gateway.example", token: TOKEN,
        fetchImpl: async () => Response.json(body) });
      await assert.rejects(client.listHealth(), /wechat_gateway_invalid_response/);
    }
  });

  it("rejects unsafe base URLs without issuing a request", async () => {
    let calls = 0;
    for (const baseUrl of ["not-a-url", "ftp://gateway.example", "https://user:pass@gateway.example",
      "https://gateway.example/?token=secret", "https://gateway.example/#secret"]) {
      const client = createWechatGatewayClient({ baseUrl, token: TOKEN,
        fetchImpl: async () => { calls += 1; return Response.json({ ok: true }); } });
      await assert.rejects(client.putSource(SOURCE), /wechat_gateway_unavailable/);
    }
    assert.equal(calls, 0);
  });
});
