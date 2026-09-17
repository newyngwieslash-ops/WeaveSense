import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSettings, saveModelSettings, parseModelConfig, checkModelConnection, readModelConfig, localModelAccess } from "./model-config.ts";

test("private config, optimistic save, validation and snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-model-")); const path = join(dir, "model.local.json");
  const old = process.env.LOOM_MODEL_CONFIG;
  process.env.LOOM_MODEL_CONFIG = path;
  const config = { baseURL: "http://localhost:10100/v1", model: "first", apiKey: "private-offline-test" };
  try {
    writeFileSync(path, JSON.stringify(config));
    const before = modelSettings(); const snapshot = readModelConfig();
    const unsafe = join(dir, "secret.json"); writeFileSync(unsafe, JSON.stringify(config));
    assert.throws(() => modelSettings(unsafe), /无效/);
    mkdirSync(join(dir, "public")); const publicFile = join(dir, "public", "secret.local.json");
    writeFileSync(publicFile, JSON.stringify(config)); assert.throws(() => modelSettings(publicFile), /无效/);
    assert(!JSON.stringify(before).includes(config.apiKey));
    const saved = saveModelSettings({ baseURL: config.baseURL, model: "next", revision: before.revision });
    assert.equal(saved.model, "next"); assert.equal(readModelConfig().apiKey, config.apiKey); assert.equal(snapshot.model, "first");
    assert.throws(() => saveModelSettings({ baseURL: config.baseURL, model: "stale", revision: before.revision }), /刷新/);
    assert.equal(readModelConfig().model, "next");
    assert.throws(() => saveModelSettings({ ...config, revision: saved.revision }), /无效/);
    for (const baseURL of ["file:///secret", "http://user:secret@host/v1", "http://host/v1?q=key", "http://host/#key"]) assert.throws(() => parseModelConfig({ ...config, baseURL }));
    for (const model of ["", "a\nb", "x".repeat(201)]) assert.throws(() => parseModelConfig({ ...config, model }));
    writeFileSync(path, "broken PRIVATE"); assert.throws(() => modelSettings(), e => !String(e).includes("PRIVATE"));
    assert.equal(readFileSync(path, "utf8"), "broken PRIVATE");
  } finally { if (old === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = old; rmSync(dir, { recursive: true }); }
});

test("connection check uses only models, refuses redirects and bounds responses", async () => {
  const original = globalThis.fetch;
  const config = { baseURL: "http://offline.invalid/v1", model: "local", apiKey: "offline-only" };
  let count = 0;
  try {
    globalThis.fetch = (async (url, init) => {
      count++; assert.equal(url, `${config.baseURL}/models`); assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-only");
      return Response.json({ data: [{ id: "local" }] });
    }) as typeof fetch;
    assert.equal((await checkModelConnection(config)).ok, true); assert.equal(count, 1);
    assert.equal((await checkModelConnection({ ...config, apiKey: "" })).ok, false); assert.equal(count, 1);
    for (const response of [Response.json({ data: [{ id: "other" }] }), new Response("secret", { status: 401 }), new Response("x".repeat(1024 * 1024 + 1)), new Response("invalid secret")]) {
      globalThis.fetch = async () => response;
      const result = await checkModelConnection(config); assert.equal(result.ok, false); assert(!JSON.stringify(result).includes("secret"));
    }
  } finally { globalThis.fetch = original; }
});

test("local management requires real loopback peer and same-origin writes", () => {
  const old = process.env.LOOM_MODEL_CONFIG; process.env.LOOM_MODEL_CONFIG = "private";
  try {
    const req = (origin: string) => new Request("http://127.0.0.1:8080/api/model-settings", { method: "POST", headers: { origin, "x-forwarded-for": "127.0.0.1" } });
    assert.equal(localModelAccess(req("http://127.0.0.1:8080"), "127.0.0.1"), true);
    for (const peer of [undefined, "192.168.1.2"]) assert.equal(localModelAccess(req("http://127.0.0.1:8080"), peer), false);
    assert.equal(localModelAccess(req("http://evil.test"), "127.0.0.1"), false);
    assert.equal(localModelAccess(new Request("http://evil.test/api/model-settings"), "127.0.0.1"), false);
    const oldBind = process.env.LOOM_MODEL_LOOPBACK_ONLY;
    try {
      process.env.LOOM_MODEL_LOOPBACK_ONLY = "true";
      assert.equal(localModelAccess(req("http://127.0.0.1:8080"), undefined), true);
      assert.equal(localModelAccess(req("http://127.0.0.1:8080"), "192.168.1.2"), false);
      assert.equal(localModelAccess(req("http://evil.test"), undefined), false);
    } finally { if (oldBind === undefined) delete process.env.LOOM_MODEL_LOOPBACK_ONLY; else process.env.LOOM_MODEL_LOOPBACK_ONLY = oldBind; }
  } finally { if (old === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = old; }
});
