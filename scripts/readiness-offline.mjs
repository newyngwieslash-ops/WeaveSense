#!/usr/bin/env node
/**
 * T01: minimal offline-run wrapper for the production-readiness tasks.
 *
 * Every isolation run in this plan needs the same two guarantees, so they live
 * here once instead of being re-typed (and re-forgotten) per script:
 *
 *   1. The child sees a **runtime-key allowlist**, never the parent's real
 *      configuration. Deleting known secrets is not enough — an unknown future
 *      key (a provider key, a gateway token) must be dropped by default. Tests
 *      that need a value pass it explicitly through `overrides`.
 *   2. Offline defaults: AUTO/EXTRACT/worker/async stay off, and no DATABASE_URL
 *      or LOOM_MODEL_CONFIG is inherited — the app must never silently
 *      autodiscover the developer's real model file (`with-app-env.mjs` does
 *      exactly that when LOOM_MODEL_CONFIG is unset, see scripts/with-app-env.mjs:115).
 *
 * Usage:
 *   node scripts/readiness-offline.mjs -- <command> [args…]
 *   import { offlineEnv, offlineChildProcess } from "./readiness-offline.mjs";
 *
 * `offlineEnv` deliberately does not echo dropped values anywhere.
 */
import { spawnSync } from "node:child_process";
import { isMainModule } from "./with-app-env.mjs";

/**
 * Variables a child process genuinely needs to *run* on this platform: the
 * interpreter search path, the Windows system dirs, temp space, and the
 * Windows command processor (npm/`.cmd` shims need `ComSpec`). Everything else
 * is dropped unless the caller overrides it.
 */
const RUNTIME_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TZ",
];

/** Offline defaults: nothing that spends money or reaches out on its own. */
export const OFFLINE_DEFAULTS = Object.freeze({
  AUTO_ANALYZE: "false",
  EXTRACT_AUTO: "false",
  AGENT_WORKER_ENABLED: "false",
  AGENT_ASYNC_RESEARCH_ENABLED: "false",
  XAI_API_KEY: "",
});

/**
 * Build a child environment for an offline run.
 *
 * @param {NodeJS.ProcessEnv} parent   usually `process.env`
 * @param {Record<string, string|undefined>} overrides  explicit test values;
 *        `undefined` **removes** the key so a default cannot reinstate it.
 */
export function offlineEnv(parent, overrides = {}) {
  const env = {};
  for (const key of RUNTIME_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(OFFLINE_DEFAULTS)) {
    if (String(parent[key] ?? "").trim() === "") env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Run a command synchronously in the offline environment. */
export function offlineChildProcess(command, args, parent, overrides = {}) {
  return spawnSync(command, args, {
    env: offlineEnv(parent, overrides),
    encoding: "utf8",
    windowsHide: true,
  });
}

function main(argv) {
  const separator = argv.indexOf("--");
  const [command, ...args] = separator >= 0 ? argv.slice(separator + 1) : argv;
  if (!command) {
    console.error("usage: node scripts/readiness-offline.mjs -- <command> [args…]");
    process.exit(2);
  }
  const result = spawnSync(command, args, {
    env: offlineEnv(process.env, JSON.parse(process.env.LOOM_OFFLINE_OVERRIDES ?? "{}")),
    stdio: "inherit",
    windowsHide: true,
  });
  process.exit(result.status ?? 1);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
