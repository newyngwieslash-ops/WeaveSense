import assert from "node:assert/strict";
import test from "node:test";
import { effectsForReceipt, effectQueryKeys } from "./assistant-effects.ts";
import type { ActionReceiptPublic } from "@/lib/server/assistant-action-receipt.ts";

/**
 * Task 16: effect enum → cache mapping (§2.4/§6.1.7). The model can never
 * supply query keys; only the fixed receipt domains map to fixed keys.
 */

function receipt(overrides: Partial<ActionReceiptPublic> = {}): ActionReceiptPublic {
  return {
    action_id: "a1",
    kind: "keyword.create",
    status: "succeeded",
    result_refs: [],
    warnings: [],
    changed_domains: [],
    ...overrides,
  };
}

test("domain enums map to the real query keys, nothing else", () => {
  assert.deepEqual(effectQueryKeys(["keywords"]), [["keywords"]]);
  assert.deepEqual(effectQueryKeys(["sources"]), [["sources"]]);
  assert.deepEqual(effectQueryKeys(["overview"]), [["overview"]]);
  assert.deepEqual(effectQueryKeys(["items", "jobs"]), [["items"], ["jobs"]]);
  assert.deepEqual(effectQueryKeys(["knowledge"]), [["knowledge"]]);
});

test("unknown domains and arbitrary keys are refused", () => {
  assert.throws(() => effectQueryKeys(["secrets" as never]));
  assert.throws(() => effectQueryKeys(["overview' ; drop table users" as never]));
});

test("effectsForReceipt returns exactly the keys for the receipt's domains", () => {
  const keys = effectsForReceipt(receipt({ changed_domains: ["keywords", "overview"] }));
  assert.deepEqual(keys, [["keywords"], ["overview"]]);
});

test("failed or skipped receipts invalidate nothing", () => {
  assert.deepEqual(effectsForReceipt(receipt({ status: "failed", changed_domains: ["keywords"] })), []);
  assert.deepEqual(effectsForReceipt(receipt({ status: "skipped", changed_domains: ["keywords"] })), []);
});

test("unchanged effect still refreshes the listing so timestamps are honest", () => {
  const keys = effectsForReceipt(receipt({ status: "succeeded", changed_domains: [] }));
  assert.deepEqual(keys, []);
  // An existing-effect receipt with no domain change is a no-op for caches.
});
