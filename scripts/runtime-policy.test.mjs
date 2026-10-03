#!/usr/bin/env node
/**
 * T02: a production runtime must refuse to start without a database.
 *
 * The failure this prevents: an operator runs the production entry with an
 * unset/blank `DATABASE_URL` and the app silently falls back to the embedded
 * in-memory PGLite — every write looks fine and vanishes on restart. `NODE_ENV`
 * is not a trustworthy signal here (a built preview also runs in production
 * mode), so the gate keys off an explicit `LOOM_RUNTIME_MODE`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRuntimeDatabase, runtimeMode } from "./runtime-policy.mjs";

test("development with no database is allowed", () => {
  assert.doesNotThrow(() => assertRuntimeDatabase({ LOOM_RUNTIME_MODE: "development" }));
  assert.doesNotThrow(() => assertRuntimeDatabase({ DATABASE_URL: "" }));
});

test("test mode without a database is allowed", () => {
  assert.doesNotThrow(() =>
    assertRuntimeDatabase({ LOOM_RUNTIME_MODE: "test", DATABASE_URL: "" }),
  );
});

test("production with a missing or blank DSN is rejected", () => {
  for (const value of [undefined, "", "   ", "\t\n"]) {
    assert.throws(
      () => assertRuntimeDatabase({ LOOM_RUNTIME_MODE: "production", DATABASE_URL: value }),
      /production_database_required/,
      `expected rejection for DATABASE_URL=${JSON.stringify(value)}`,
    );
  }
});

test("production with a Postgres DSN is allowed", () => {
  assert.doesNotThrow(() =>
    assertRuntimeDatabase({
      LOOM_RUNTIME_MODE: "production",
      DATABASE_URL: "postgresql://loom:secret@postgres:5432/loom",
    }),
  );
});

test("an unrecognized mode is rejected rather than defaulted", () => {
  for (const mode of ["prod", "Production", "staging", "1", " "]) {
    assert.throws(
      () => assertRuntimeDatabase({ LOOM_RUNTIME_MODE: mode, DATABASE_URL: "postgresql://x/y" }),
      /invalid_runtime_mode/,
      `expected rejection for mode=${JSON.stringify(mode)}`,
    );
  }
});

test("an unset mode behaves as development (a built preview is not production)", () => {
  assert.equal(runtimeMode({}), "development");
  assert.doesNotThrow(() => assertRuntimeDatabase({}));
});

test("the error never echoes the DSN", () => {
  try {
    assertRuntimeDatabase({
      LOOM_RUNTIME_MODE: "production",
      DATABASE_URL: " ",
      PATH: "/usr/bin",
    });
  } catch (err) {
    assert.ok(!String(err.message).includes("/usr/bin"));
  }
  // A rejected *mode* must not leak the DSN either.
  try {
    assertRuntimeDatabase({
      LOOM_RUNTIME_MODE: "nope",
      DATABASE_URL: "postgresql://user:supersecret@db:5432/app",
    });
  } catch (err) {
    assert.ok(!String(err.message).includes("supersecret"));
  }
});
