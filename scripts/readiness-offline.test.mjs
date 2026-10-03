#!/usr/bin/env node
/**
 * T01: the offline-run wrapper must not leak the parent's real configuration
 * into a test child.
 *
 * The guarantee is a runtime-key allowlist, not "delete the keys we happen to
 * know about": an unknown future secret (WECHAT_GATEWAY_TOKEN, CRON_SECRET, a
 * provider key) must be dropped by default too. Anything a test genuinely
 * needs is passed explicitly through `overrides`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { offlineEnv, offlineChildProcess } from "./readiness-offline.mjs";

const parent = {
  PATH: "/usr/bin",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
  TMP: "C:\\Temp",
  // Real-ish configuration that must never reach an offline child:
  DATABASE_URL: "postgresql://loom:realpw@prod.example.com:5432/loom",
  XAI_API_KEY: "xai-real-key",
  LOOM_MODEL_CONFIG: "C:\\secret\\model.local.json",
  WECHAT_GATEWAY_TOKEN: "gateway-secret",
  CRON_SECRET: "cron-secret",
  SOME_FUTURE_UNKNOWN_SECRET: "unknown-secret",
};

test("keeps only runtime-necessary variables", () => {
  const env = offlineEnv(parent);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.TEMP, "C:\\Temp");
});

test("drops known real configuration and unknown secrets alike", () => {
  const env = offlineEnv(parent);
  for (const key of [
    "DATABASE_URL",
    "XAI_API_KEY",
    "LOOM_MODEL_CONFIG",
    "WECHAT_GATEWAY_TOKEN",
    "CRON_SECRET",
    "SOME_FUTURE_UNKNOWN_SECRET",
  ]) {
    assert.equal(env[key], undefined, `${key} leaked into the offline env`);
  }
});

test("applies offline-safe defaults", () => {
  const env = offlineEnv(parent);
  assert.equal(env.AUTO_ANALYZE, "false");
  assert.equal(env.EXTRACT_AUTO, "false");
  assert.equal(env.AGENT_WORKER_ENABLED, "false");
  assert.equal(env.AGENT_ASYNC_RESEARCH_ENABLED, "false");
  // Explicitly unset rather than inherited: the app must not autodiscover the
  // developer's real model file when none is passed.
  assert.equal(env.LOOM_MODEL_CONFIG, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("an explicit override is visible and wins over the default", () => {
  const env = offlineEnv(parent, {
    DATABASE_URL: "postgresql://postgres:review-only@127.0.0.1:54176/review",
    AGENT_WORKER_ENABLED: "true",
    LOOM_MODEL_CONFIG: "artifacts/model-settings-qa/model.local.json",
  });
  assert.equal(env.DATABASE_URL, "postgresql://postgres:review-only@127.0.0.1:54176/review");
  assert.equal(env.AGENT_WORKER_ENABLED, "true");
  assert.equal(env.LOOM_MODEL_CONFIG, "artifacts/model-settings-qa/model.local.json");
});

test("a child process never sees the parent's real configuration", () => {
  const probe = offlineChildProcess(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({db:process.env.DATABASE_URL??null,key:process.env.XAI_API_KEY??null,auto:process.env.AUTO_ANALYZE??null}))"],
    parent,
  );
  assert.equal(probe.status, 0, probe.stderr);
  const seen = JSON.parse(probe.stdout);
  assert.equal(seen.db, null);
  assert.equal(seen.key, null);
  assert.equal(seen.auto, "false");
});

test("the wrapper never echoes values it drops", () => {
  // A failure message may name a variable, but must not print its value.
  const env = offlineEnv(parent);
  const rendered = JSON.stringify(env);
  for (const secret of ["realpw", "xai-real-key", "gateway-secret", "cron-secret", "unknown-secret"]) {
    assert.ok(!rendered.includes(secret), `value leaked: ${secret}`);
  }
});
