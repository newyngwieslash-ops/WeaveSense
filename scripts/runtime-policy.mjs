#!/usr/bin/env node
/**
 * T02: production runtime database policy.
 *
 * A production start without `DATABASE_URL` must fail loudly, because the
 * fallback is an in-memory PGLite: writes succeed and disappear on restart.
 * `NODE_ENV` cannot gate this (a built preview also runs in production mode),
 * so the mode is explicit and the default is permissive-on-purpose: only
 * `LOOM_RUNTIME_MODE=production` demands a database.
 *
 * Shared by the app's first database access (`src/lib/db.ts`) and the container
 * entry (`scripts/migrate.mjs` runs before the server listens, via `npm start`),
 * so the check is one function, not one per entry point.
 */

export const RUNTIME_MODES = ["development", "test", "production"];

/**
 * The declared runtime mode, defaulting to `development`.
 * @param {Record<string, string | undefined>} env
 */
export function runtimeMode(env) {
  return env.LOOM_RUNTIME_MODE ?? "development";
}

/**
 * Throw unless this runtime can safely start with its database configuration.
 * Messages carry stable codes only — never the DSN (it contains a password).
 * @param {Record<string, string | undefined>} env
 */
export function assertRuntimeDatabase(env) {
  const mode = runtimeMode(env);
  if (!RUNTIME_MODES.includes(mode)) throw new Error("invalid_runtime_mode");
  if (mode === "production" && !String(env.DATABASE_URL ?? "").trim()) {
    throw new Error("production_database_required");
  }
}
