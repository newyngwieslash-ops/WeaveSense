import assert from "node:assert/strict";
import test from "node:test";
import { assistantCapabilities } from "./assistant-capabilities.ts";
import { prod } from "./config.ts";

/**
 * Task 17: assistant switches default OFF; a research-only deployment (no
 * assistant env) reports assistant unavailable with an explicit reason; the
 * flags are read from the trusted prod config, never from client input.
 */

test("assistant flags default off in prod config", () => {
  assert.equal(prod.assistantEnabled, false, "AGENT_ASSISTANT_ENABLED defaults false");
  assert.equal(prod.assistantActionsEnabled, false, "AGENT_ASSISTANT_ACTIONS_ENABLED defaults false");
});

test("capabilities are honest for a research-only environment", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.AGENT_ASSISTANT_ENABLED;
    delete process.env.VERCEL;
    delete process.env.LOOM_MODEL_CONFIG;
    const caps = await assistantCapabilities();
    assert.equal(caps.enabled, false);
    assert.equal(caps.reason, "model_config_missing");
  } finally {
    process.env = saved;
  }
});

test("enabled requires governance pricing; actions gate separately", async () => {
  const saved = { ...process.env };
  try {
    process.env.AGENT_ASSISTANT_ENABLED = "true";
    process.env.AGENT_ASSISTANT_ACTIONS_ENABLED = "false";
    process.env.LOOM_MODEL_CONFIG = "/tmp/c.json";
    process.env.AGENT_MODEL_NAME = "fake-model";
    process.env.AGENT_SKILL_SNAPSHOT_DIGEST = "a".repeat(64);
    process.env.AGENT_PRICE_INPUT_RMB_PER_MILLION = "2";
    process.env.AGENT_PRICE_OUTPUT_RMB_PER_MILLION = "4";
    const caps = await assistantCapabilities();
    assert.equal(caps.enabled, true);
    assert.equal(caps.actions_enabled, false, "actions stay off behind their own switch");
  } finally {
    process.env = saved;
  }
});

test("assistant sub-limits are bounded in config", () => {
  assert.ok(prod.assistantMaxModelCalls >= 1 && prod.assistantMaxModelCalls <= 20);
  assert.ok(prod.assistantMaxToolCalls >= 0 && prod.assistantMaxToolCalls <= 40);
  assert.ok(prod.assistantDailyLimit >= 0);
  assert.ok(prod.assistantDailyBudgetRmb >= 0);
});
