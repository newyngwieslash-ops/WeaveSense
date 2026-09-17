import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AgentClientError, executeAgent, type AgentClientConfig } from "./agent-client.ts";
import type { ExecuteRequest } from "../agent-contract.ts";

const fixture = JSON.parse(readFileSync(new URL("../../../validation/agent/contracts/analyze-valid.json", import.meta.url), "utf8"));
const request = fixture.request as ExecuteRequest;
const response = fixture.response;

function cfg(over: Partial<AgentClientConfig> = {}): AgentClientConfig {
  return { engine: "eino", serviceUrl: "http://agent.internal", serviceToken: "secret-token", ...over };
}

test("legacy engine never calls the agent URL", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("should not fetch"); };
  await assert.rejects(() => executeAgent(request, cfg({ engine: "legacy", fetchImpl })));
  assert.equal(calls, 0);
});

test("eino without url or token fails closed", async () => {
  await assert.rejects(
    () => executeAgent(request, cfg({ serviceUrl: "", fetchImpl: async () => new Response("{}") })),
    /agent_unconfigured/,
  );
  await assert.rejects(
    () => executeAgent(request, cfg({ serviceToken: "", fetchImpl: async () => new Response("{}") })),
    /agent_unconfigured/,
  );
});

test("unknown engine fails before fetch", async () => {
  let calls = 0;
  await assert.rejects(
    () => executeAgent(request, cfg({ engine: "other" as "eino", fetchImpl: async () => { calls += 1; return new Response("{}"); } })),
    (error: unknown) => error instanceof AgentClientError && error.code === "agent_unconfigured" && calls === 0,
  );
});

test("mismatched run_id is rejected", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ ...response, run_id: "00000000-0000-4000-8000-000000000000" }), {
      headers: { "content-type": "application/json" },
    });
  };
  await assert.rejects(() => executeAgent(request, cfg({ fetchImpl })), (error: unknown) =>
    error instanceof AgentClientError && error.code === "invalid_output");
  assert.equal(calls, 1);
});

test("html error pages and oversized bodies are rejected", async () => {
  const html: typeof fetch = async () => new Response("<html>error</html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(() => executeAgent(request, cfg({ fetchImpl: html })), (error: unknown) =>
    error instanceof AgentClientError && error.code === "invalid_output");
  const big: typeof fetch = async () => new Response("x".repeat(256 * 1024 + 8), {
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(() => executeAgent(request, cfg({ fetchImpl: big })), (error: unknown) =>
    error instanceof AgentClientError && error.code === "invalid_output");
});

test("timeout does not call legacy and hides the service token", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls += 1;
    const err = new Error("aborted");
    err.name = "TimeoutError";
    if (init?.signal?.aborted) throw err;
    throw err;
  };
  await assert.rejects(async () => {
    try {
      await executeAgent(request, cfg({ fetchImpl, timeoutMs: 1 }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes("secret-token"), false);
      throw error;
    }
  }, (error: unknown) => error instanceof AgentClientError &&
    (error.code === "model_timeout" || error.code === "agent_unavailable"));
  assert.equal(calls, 1);
});

test("timeout covers a delayed response body after headers", async () => {
  const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(response)));
        controller.close();
      }, 80);
    },
  }), { headers: { "content-type": "application/json" } });
  await assert.rejects(
    () => executeAgent(request, cfg({ fetchImpl, timeoutMs: 10 })),
    (error: unknown) => error instanceof AgentClientError && (error.code === "model_timeout" || error.code === "agent_unavailable"),
  );
});

test("successful eino response is parsed", async () => {
  const fetchImpl: typeof fetch = async (url, init) => {
    assert.equal(String(url), "http://agent.internal/v1/execute");
    assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer secret-token");
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  const result = await executeAgent(request, cfg({ fetchImpl }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.run_id, request.run_id);
});
