import assert from "node:assert/strict";
import test from "node:test";
import { assistantAccessFromRequest } from "./assistant-access.ts";

/**
 * Task 4 access gate: reuse the localModelAccess boundary (trusted local
 * single-operator), never a new auth framework. Assistant must stay OFF on
 * Vercel and when no model config exists, exactly like research access.
 */

function fakeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

test("assistant access requires trusted local operator conditions", () => {
  const env = { LOOM_MODEL_CONFIG: "/tmp/config.json" };
  // Local peer + loopback host + same-origin POST.
  const ok = assistantAccessFromRequest(
    fakeRequest("http://127.0.0.1:8080/api/assistant/capabilities", { origin: "http://127.0.0.1:8080" }),
    "127.0.0.1",
    env,
  );
  assert.equal(ok.allowed, true);
  // Cross-origin POST is refused (origin mismatches host).
  assert.equal(assistantAccessFromRequest(
    fakeRequest("http://127.0.0.1:8080/api/assistant/x", { origin: "http://evil.example" }),
    "127.0.0.1", env,
  ).allowed, false);
  // Non-local peer is refused.
  assert.equal(assistantAccessFromRequest(
    fakeRequest("http://127.0.0.1:8080/api/assistant/x", { origin: "http://127.0.0.1:8080" }),
    "10.1.2.3", env,
  ).allowed, false);
  // External host header is refused even with a local peer.
  assert.equal(assistantAccessFromRequest(
    fakeRequest("http://attacker.example/api/assistant/x", { origin: "http://attacker.example" }),
    "127.0.0.1", env,
  ).allowed, false);
});

test("assistant access is off on Vercel or without model config", () => {
  assert.equal(assistantAccessFromRequest(
    fakeRequest("http://127.0.0.1:8080/x", { origin: "http://127.0.0.1:8080" }), "127.0.0.1", { VERCEL: "1", LOOM_MODEL_CONFIG: "/c" },
  ).allowed, false);
  assert.equal(assistantAccessFromRequest(
    fakeRequest("http://127.0.0.1:8080/x", { origin: "http://127.0.0.1:8080" }), "127.0.0.1", {},
  ).allowed, false);
  // Explicit opt-out still wins (deployed loopback-only binding).
  assert.equal(assistantAccessFromRequest(
    fakeRequest("http://127.0.0.1:8080/x", { origin: "http://127.0.0.1:8080" }),
    undefined, { LOOM_MODEL_CONFIG: "/c", LOOM_MODEL_LOOPBACK_ONLY: "true" },
  ).allowed, true);
});

test("GET requests skip the origin check; non-GET require it", () => {
  const env = { LOOM_MODEL_CONFIG: "/c" };
  const get = new Request("http://127.0.0.1:8080/api/assistant/capabilities");
  assert.equal(assistantAccessFromRequest(get, "127.0.0.1", env).allowed, true);
  const post = new Request("http://127.0.0.1:8080/api/assistant/x", { method: "POST" });
  assert.equal(assistantAccessFromRequest(post, "127.0.0.1", env).allowed, false, "POST without same-origin is refused");
});
