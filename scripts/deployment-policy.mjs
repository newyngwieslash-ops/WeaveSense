#!/usr/bin/env node
/**
 * T04: deployment-config and packaging-boundary policy.
 *
 * The checks parse `docker-compose.yml` by plain line structure: enough for this
 * template (short service blocks, one key per line) and deliberately not a YAML
 * dependency. If the file is ever restructured so these can't see a setting,
 * the assertions fail loudly rather than silently passing — which is the right
 * direction for a guard about shipped secrets.
 */

/**
 * Paths that must never appear in a source pack or a Docker build context.
 * Matching is by path segment so `config/model.local.json`, a nested
 * `artifacts/...`, or a session file all match regardless of depth.
 */
const EXCLUDED_SEGMENTS = new Set(["artifacts", "attachments", "node_modules", ".git", ".repo", ".worktrees", "screenshots", "__pycache__", ".venv"]);
const EXCLUDED_SUFFIXES = [".local.json", ".session", ".sqlite", ".sqlite-wal", ".sqlite-shm", ".dump", ".key", ".pem", ".env"];

export function packExcluded(path) {
  const normalized = String(path).replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((part) => EXCLUDED_SEGMENTS.has(part))) return true;
  const base = segments.at(-1) ?? "";
  if (base === ".env" || base.startsWith(".env.")) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/** Every `"host:container"` published port in the compose file. */
export function publishedPorts(composeText) {
  const ports = [];
  for (const match of composeText.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)) {
    const value = match[1];
    // A published port is one of: `container`, `hostPort:containerPort`, or
    // `ip:hostPort:containerPort` (optionally /proto). Only the last two publish.
    const withoutProto = value.replace(/\/\w+$/, "");
    if (!/^[0-9a-f.:[\]]+$/.test(withoutProto)) continue;
    if (!withoutProto.includes(":")) continue; // `8080` alone exposes nothing
    ports.push(value);
  }
  return ports;
}

/**
 * Extract the bind address of a published port, or "" when none is given
 * (Docker's default, which is all interfaces).
 *
 * `"8080:8080"`            -> ""            (0.0.0.0 — every interface)
 * `"127.0.0.1:8080:8080"`  -> "127.0.0.1"
 * `"[::1]:8080:8080"`      -> "[::1]"
 */
export function portHost(entry) {
  const value = entry.replace(/\/\w+$/, "");
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? "" : value.slice(0, end + 1);
  }
  const parts = value.split(":");
  if (parts.length >= 3) return parts.slice(0, -2).join(":");
  return parts.length === 2 ? "" : "";
}

/** Report every published port that is not loopback-bound. */
export function assertLoopbackPorts(composeText, onOffender = () => {}, allowed = []) {
  for (const entry of publishedPorts(composeText)) {
    if (allowed.includes(entry)) continue;
    const host = portHost(entry);
    if (host === "127.0.0.1" || host === "[::1]" || host === "::1") continue;
    onOffender(entry);
  }
}

/**
 * Defaults like `${MINIO_ROOT_PASSWORD:-loom-secret-change-me}` publish a
 * credential in a public template: a deployment that forgets to override it
 * ends up with a known password. A required `${VAR:?…}` form is the fix.
 */
export function assertNoWeakCredentialDefaults(composeText, onOffender = () => {}, weakValues = [
  "loom-secret-change-me",
  "loom",
  "postgres",
  "admin",
  "changeme",
  "password",
  "secret",
  "example",
]) {
  for (const match of composeText.matchAll(/^\s*([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*):\s*(.*)$/gm)) {
    const [, name, raw] = match;
    const value = raw.trim();
    const fallback = /\$\{[A-Z0-9_]+:-([^}]*)\}/.exec(value);
    if (fallback && weakValues.includes(fallback[1].trim().toLowerCase())) onOffender(`${name} (default ${fallback[1]})`);
    for (const weak of weakValues) {
      // A bare literal credential, or one directly assigned in the file.
      if (!value.includes("${") && value.replace(/["']/g, "").toLowerCase() === weak) onOffender(`${name} (literal ${weak})`);
    }
  }
}

/**
 * Production must not silently float: `:latest` / a bare major tag makes the
 * deployed software depend on when the image was pulled.
 */
export function assertImagesPinned(composeText, onOffender = () => {}, allowlisted = []) {
  for (const match of composeText.matchAll(/^\s*image:\s*(\S+)\s*$/gm)) {
    const image = match[1].replace(/["']/g, "");
    if (allowlisted.includes(image)) continue;
    if (image.includes("@sha256:")) continue;
    if (/:(?:latest|stable|main|master)$/.test(image)) {
      onOffender(`${image} (floating tag)`);
      continue;
    }
    if (!image.includes(":")) onOffender(`${image} (no tag)`);
  }
}
