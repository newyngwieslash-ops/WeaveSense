#!/usr/bin/env node
/**
 * T04: deployment-config and packaging-boundary guard tests.
 *
 * These encode the rules that keep secrets out of shipped artifacts and stop a
 * template from silently deploying with published default credentials. They
 * check the real repository files, so a regression in the template fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import {
  packExcluded,
  publishedPorts,
  portHost,
  assertLoopbackPorts,
  assertNoWeakCredentialDefaults,
  assertImagesPinned,
} from "./deployment-policy.mjs";

const root = join(import.meta.dirname, "..");
const composeText = readFileSync(join(root, "docker-compose.yml"), "utf8");
const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");

test("secrets and runtime state are excluded from the source pack", () => {
  for (const path of [
    "config/model.local.json",
    "config/anything.local.json",
    ".env",
    ".env.production",
    "workers/telethon/loom.session",
    "workers/wechat-gateway/wechat-gateway.sqlite",
    "wechat-gateway.sqlite-wal",
    "artifacts/production-readiness/pr-1/source.dump",
    "node_modules/left-pad/index.js",
    ".git/config",
    ".repo/HEAD",
    ".worktrees/local-model-settings/src/routes/prd.tsx",
    "screenshots/desktop.png",
    "attachments/a.pdf",
  ]) {
    assert.equal(packExcluded(path), true, `should be excluded: ${path}`);
  }
});

test("real source is not over-excluded", () => {
  for (const path of [
    "src/routes/prd.tsx",
    "src/lib/server/scheduler.ts",
    "migrations/0002_schema.sql",
    "workers/telethon/server.py",
    "config/model.example.json",
    "env.example",
    "scripts/migrate.mjs",
    "docs/使用指南.md",
  ]) {
    assert.equal(packExcluded(path), false, `must stay packable: ${path}`);
  }
});

test("the docker build context carries the same exclusion rules", () => {
  for (const pattern of [".env", "*.local.json", "artifacts", "node_modules"]) {
    assert.ok(
      dockerignore.includes(pattern),
      `.dockerignore must exclude ${pattern} (it is uploaded to the builder)`,
    );
  }
});

test("postgres and minio never ship default weak credentials", () => {
  const found = [];
  assertNoWeakCredentialDefaults(composeText, (name) => found.push(name));
  assert.deepEqual(found, [], `weak defaults present: ${found.join(", ")}`);
});

test("published ports bind loopback unless explicitly allowlisted", () => {
  const ports = publishedPorts(composeText);
  assert.ok(ports.length > 0, "expected at least one published port to check");
  const offenders = [];
  assertLoopbackPorts(composeText, (entry) => offenders.push(entry));
  assert.deepEqual(offenders, [], `publicly bound: ${offenders.join(", ")}`);
});

test("service images are pinned to a digest", () => {
  const offenders = [];
  assertImagesPinned(composeText, (entry) => offenders.push(entry));
  assert.deepEqual(offenders, [], `unpinned images: ${offenders.join(", ")}`);
});

// --- positive controls: each guard must be able to fail -------------------

test("the port guard detects a host-wide bind (control)", () => {
  assert.equal(portHost("8080:8080"), "", "no bind address means every interface");
  assert.equal(portHost("127.0.0.1:8080:8080"), "127.0.0.1");
  assert.equal(portHost("[::1]:8080:8080"), "[::1]");

  const offenders = [];
  assertLoopbackPorts('    ports:\n      - "8080:8080"\n', (e) => offenders.push(e));
  assert.deepEqual(offenders, ["8080:8080"]);

  // ...and an explicit allowlist is the only way past it.
  const allowed = [];
  assertLoopbackPorts('    ports:\n      - "8080:8080"\n', (e) => allowed.push(e), ["8080:8080"]);
  assert.deepEqual(allowed, []);
});

test("the credential guard detects a template default (control)", () => {
  const offenders = [];
  assertNoWeakCredentialDefaults(
    "    environment:\n      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-loom}\n",
    (e) => offenders.push(e),
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /POSTGRES_PASSWORD/);

  const required = [];
  assertNoWeakCredentialDefaults(
    "    environment:\n      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}\n",
    (e) => required.push(e),
  );
  assert.deepEqual(required, []);
});

test("the image guard detects a floating tag (control)", () => {
  const offenders = [];
  assertImagesPinned("    image: minio/minio:latest\n", (e) => offenders.push(e));
  assert.equal(offenders.length, 1);

  const pinned = [];
  assertImagesPinned("    image: minio/minio:latest@sha256:" + "0".repeat(64) + "\n", (e) => pinned.push(e));
  assert.deepEqual(pinned, []);
});

test("the pack guard detects a session file and permits real source (control)", () => {
  assert.equal(packExcluded("workers/telethon/loom.session"), true);
  assert.equal(packExcluded("src/lib/server/scheduler.ts"), false);
});
