import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSettings, upsertModelProfile, activateModelProfile, deleteModelProfile, parseModelConfig, checkModelConnection, readModelConfig, localModelAccess } from "./model-config.ts";

const LEGACY = { baseURL: "http://localhost:10100/v1", model: "first", apiKey: "private-offline-test" };

test("legacy single config, private file, optimistic save, validation and snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-model-")); const path = join(dir, "model.local.json");
  const old = process.env.LOOM_MODEL_CONFIG;
  process.env.LOOM_MODEL_CONFIG = path;
  const config = LEGACY;
  try {
    writeFileSync(path, JSON.stringify(config));
    // Legacy file surfaces as one implicit active profile.
    const before = modelSettings();
    assert.equal(before.activeId, "default"); assert.equal(before.profiles.length, 1);
    assert.equal(before.profiles[0].baseURL, config.baseURL); assert.equal(before.editable, true);
    const snapshot = readModelConfig();
    const unsafe = join(dir, "secret.json"); writeFileSync(unsafe, JSON.stringify(config));
    assert.throws(() => modelSettings(unsafe), /无效/);
    mkdirSync(join(dir, "public")); const publicFile = join(dir, "public", "secret.local.json");
    writeFileSync(publicFile, JSON.stringify(config)); assert.throws(() => modelSettings(publicFile), /无效/);
    assert(!JSON.stringify(before).includes(config.apiKey));
    // Saving through the new upsert path migrates the legacy file: the legacy
    // "default" profile is updated in place (its generated id is preserved), so
    // there is still exactly one profile and the stored key survives.
    const saved = upsertModelProfile({ id: before.profiles[0].id, name: "网关A", baseURL: config.baseURL, model: "next", apiKey: "", revision: before.revision });
    assert.equal(saved.profiles.length, 1); assert.equal(saved.profiles[0].model, "next");
    assert.equal(saved.profiles[0].name, "网关A"); assert.equal(saved.activeId, "default");
    assert.equal(readModelConfig().apiKey, config.apiKey); assert.equal(snapshot.model, "first");
    // Key was kept because the update sent an empty one.
    assert.equal(readModelConfig().model, "next");
    assert.throws(() => upsertModelProfile({ id: "", name: "x", baseURL: config.baseURL, model: "stale", apiKey: "", revision: before.revision }), /刷新/);
    assert.throws(() => upsertModelProfile({ ...config, revision: saved.revision }), /无效/);
    for (const baseURL of ["file:///secret", "http://user:secret@host/v1", "http://host/v1?q=key", "http://host/#key"]) assert.throws(() => parseModelConfig({ ...config, baseURL }));
    for (const model of ["", "a\nb", "x".repeat(201)]) assert.throws(() => parseModelConfig({ ...config, model }));
    writeFileSync(path, "broken PRIVATE"); assert.throws(() => modelSettings(), e => !String(e).includes("PRIVATE"));
    assert.equal(readFileSync(path, "utf8"), "broken PRIVATE");
  } finally { if (old === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = old; rmSync(dir, { recursive: true }); }
});

test("multi-profile document: create, activate, keep-key, delete and limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-model-")); const path = join(dir, "model.local.json");
  const old = process.env.LOOM_MODEL_CONFIG;
  process.env.LOOM_MODEL_CONFIG = path;
  try {
    writeFileSync(path, JSON.stringify(LEGACY));
    let settings = modelSettings();
    // Create profile B with its own key; active stays on default.
    settings = upsertModelProfile({ id: "", name: "网关B", baseURL: "http://localhost:8317/v1", model: "xai/grok-4.5", apiKey: "key-b", revision: settings.revision });
    assert.equal(settings.profiles.length, 2); assert.equal(settings.activeId, "default");
    const b = settings.profiles.find(p => p.name === "网关B")!;
    assert.equal(b.keyConfigured, true); assert.ok(b.id);
    // Activate B; readModelConfig now returns B's config including its key.
    settings = activateModelProfile({ id: b.id, revision: settings.revision });
    assert.equal(settings.activeId, b.id);
    const config = readModelConfig();
    assert.equal(config.model, "xai/grok-4.5"); assert.equal(config.apiKey, "key-b");
    // Update B with empty key -> key preserved; update with new key -> replaced.
    settings = upsertModelProfile({ id: b.id, name: "网关B2", baseURL: "http://localhost:8317/v1", model: "xai/grok-4.5", apiKey: "", revision: settings.revision });
    assert.equal(readModelConfig().apiKey, "key-b");
    settings = upsertModelProfile({ id: b.id, name: "网关B2", baseURL: "http://localhost:8317/v1", model: "xai/grok-4.5", apiKey: "key-b2", revision: settings.revision });
    assert.equal(readModelConfig().apiKey, "key-b2");
    assert(!JSON.stringify(settings).includes("key-b2"));
    // Create profile C, then delete the active B -> active falls back to first remaining.
    settings = upsertModelProfile({ id: "", name: "网关C", baseURL: "http://localhost:7863/v1", model: "m", apiKey: "", revision: settings.revision });
    const c = settings.profiles.find(p => p.name === "网关C")!;
    settings = deleteModelProfile({ id: b.id, revision: settings.revision });
    assert.equal(settings.profiles.length, 2); assert.equal(settings.activeId, "default");
    // Deleting the last profile is refused.
    settings = deleteModelProfile({ id: c.id, revision: settings.revision });
    assert.throws(() => deleteModelProfile({ id: "default", revision: settings.revision }), /至少保留/);
    // Unknown id refused.
    assert.throws(() => activateModelProfile({ id: "nope", revision: settings.revision }), /不存在/);
    // Profile id format is validated.
    assert.throws(() => upsertModelProfile({ id: "bad id!", name: "x", baseURL: "http://h/v1", model: "m", apiKey: "", revision: settings.revision }), /无效/);
    // Duplicate names are allowed; upserting an existing id updates it in place.
    const first = upsertModelProfile({ id: "", name: "同名", baseURL: "http://h1/v1", model: "m1", apiKey: "", revision: settings.revision });
    const targetId = first.profiles[first.profiles.length - 1].id;
    const updated = upsertModelProfile({ id: targetId, name: "同名", baseURL: "http://h2/v1", model: "m2", apiKey: "", revision: first.revision });
    assert.equal(updated.profiles.length, first.profiles.length);
    assert.equal(updated.profiles.find(p => p.id === targetId)?.model, "m2");
    // Round-trip: the written document uses the new format and stays readable.
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(Object.keys(raw).sort().join(","), "active,profiles");
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
    const oldManage = process.env.LOOM_MODEL_MANAGE_ALLOWED;
    try {
      process.env.LOOM_MODEL_LOOPBACK_ONLY = "true";
      assert.equal(localModelAccess(req("http://127.0.0.1:8080"), undefined), true);
      assert.equal(localModelAccess(req("http://127.0.0.1:8080"), "192.168.1.2"), false);
      assert.equal(localModelAccess(req("http://evil.test"), undefined), false);
      // Explicit deployment opt-in: container peer (docker bridge IP) is accepted,
      // but the hostname and same-origin write checks still apply.
      process.env.LOOM_MODEL_MANAGE_ALLOWED = "true";
      assert.equal(localModelAccess(req("http://127.0.0.1:8080"), "172.19.0.1"), true);
      assert.equal(localModelAccess(req("http://evil.test"), "172.19.0.1"), false);
      assert.equal(localModelAccess(new Request("http://evil.test/api/model-settings", { method: "POST", headers: { origin: "http://evil.test" } }), "172.19.0.1"), false);
      process.env.VERCEL = "1";
      assert.equal(localModelAccess(req("http://127.0.0.1:8080"), "127.0.0.1"), false);
    } finally {
      if (oldBind === undefined) delete process.env.LOOM_MODEL_LOOPBACK_ONLY; else process.env.LOOM_MODEL_LOOPBACK_ONLY = oldBind;
      if (oldManage === undefined) delete process.env.LOOM_MODEL_MANAGE_ALLOWED; else process.env.LOOM_MODEL_MANAGE_ALLOWED = oldManage;
      delete process.env.VERCEL;
    }
  } finally { if (old === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = old; }
});
