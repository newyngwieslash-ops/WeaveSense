#!/usr/bin/env node
/**
 * T03: restore-safety guard tests.
 *
 * These cover the rules the recovery script enforces; the script itself proves
 * the real pg_dump/pg_restore round trip on an isolated database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRestoreTargetIsNew, assertTaggedResource, exitStatusFor } from "./restore-policy.mjs";

test("a new restore target is accepted", () => {
  assert.doesNotThrow(() => assertRestoreTargetIsNew(["postgres", "review"], "review_restored"));
});

test("an existing restore target is refused", () => {
  assert.throws(
    () => assertRestoreTargetIsNew(["postgres", "review", "review_restored"], "review_restored"),
    /restore_target_exists/,
  );
});

test("only this batch's labelled resource is accepted", () => {
  assert.doesNotThrow(() => assertTaggedResource("isolated"));
  for (const label of [undefined, "", "production", "other-batch"]) {
    assert.throws(
      () => assertTaggedResource(label),
      /resource_label_mismatch/,
      `expected refusal for label=${JSON.stringify(label)}`,
    );
  }
});

test("a failed or missing verification is a non-zero exit", () => {
  assert.equal(exitStatusFor({ ok: true }), 0);
  assert.equal(exitStatusFor({ ok: false, error: "boom" }), 1);
  assert.equal(exitStatusFor(undefined), 1);
});
