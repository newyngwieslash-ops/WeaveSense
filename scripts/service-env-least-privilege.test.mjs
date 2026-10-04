#!/usr/bin/env node
/**
 * 2026-09-21 加固的守护测试：确认"每个服务只拿到它需要的凭据"这条性质不会
 * 在后续编辑里被悄悄破坏。
 *
 * 背景：加固时最初给所有服务挂了同一个 env 文件，实测发现 MinIO 容器因此也
 * 拿到了 PostgreSQL 口令与 CRON_SECRET。`env_file` 会把文件里**全部**变量注入
 * 引用它的服务，所以"最小权限"必须靠**每服务一个文件**来保证，而这很容易被
 * 下一次图省事的编辑合并回去。
 *
 * 这里断言两件事：
 *   1. compose 里每个服务的 env_file 指向它自己的 env/<service>.env；
 *   2. 每个文件只含该服务真正读取的变量（白名单来自 write-service-envs.mjs）。
 *
 * 纯文本断言，不读凭据内容，不连任何服务。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SERVICE_VARS, REQUIRED_VARS, serviceEnvs } from "./write-service-envs.mjs";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");

/** Split the compose text into service blocks keyed by name. */
function serviceBlocks(text) {
  const blocks = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const top = /^  ([a-z-]+):\s*$/.exec(line);
    if (top) {
      current = top[1];
      blocks[current] = [];
      continue;
    }
    if (current) blocks[current].push(line);
  }
  return blocks;
}

test("each service reads its own least-privilege env file", () => {
  const blocks = serviceBlocks(compose);
  for (const service of Object.keys(SERVICE_VARS)) {
    const body = blocks[service];
    assert.ok(body, `${service} must exist in docker-compose.yml`);
    const expected = `env/${service}.env`;
    // env_file 列表项带缩进，所以按子串匹配，不做整行相等比较。
    assert.ok(
      body.some((line) => line.includes(expected)),
      `${service} must read F:/loom-backups/env/${service}.env ` +
        "(a shared file would leak every other service's secrets)",
    );
  }
});

test("no service reads a single shared credentials file", () => {
  // env_file 会注入文件里的全部变量；合并的凭据文件正是最小权限的反面。
  // 只看真正生效的配置行，跳过解释它为什么被禁止的注释。
  const effective = compose.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  assert.ok(
    !effective.some((line) => line.includes("loom-prod.env")),
    "compose must not reference the combined loom-prod.env outside of comments",
  );
});

test("per-service variables are not overridden by Compose environment interpolation", () => {
  // Interpolated credentials are what caused the T24 incident: `compose up` injects
  // command-line variables into every related service. They must come from env_file.
  const blocks = serviceBlocks(compose);
  for (const [service, names] of Object.entries(SERVICE_VARS)) {
    for (const name of names) assert.ok(!blocks[service].some((line) => new RegExp(`^      ${name}:`).test(line)), `${service}:${name} must come only from its env_file`);
  }
});

test("synthetic service env files declare only that service's variables", () => {
  const values = Object.fromEntries(Object.values(SERVICE_VARS).flat().map((name) => [name, "SYNTHETIC_ONLY"]));
  values.UNRELATED_SECRET = "MUST_NOT_BE_ROUTED";
  const files = serviceEnvs(values);
  for (const [service, names] of Object.entries(SERVICE_VARS)) {
    const text = files[service];
    const declared = text.split(/\r?\n/)
      .map((line) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter(Boolean);
    assert.deepEqual(
      [...declared].sort(),
      [...names].sort(),
      `${service}.env must declare exactly ${names.join(", ")}`,
    );
  }
});

test("optional provider absence only disables its capability and app depends only on the database", () => {
  const files = serviceEnvs({ ...Object.fromEntries(REQUIRED_VARS.map((name) => [name, "SYNTHETIC_ONLY"])), TELEGRAM_API_HASH: '""', XAI_API_KEY: "''" });
  assert.ok(!files.telethon.includes("TELEGRAM_API_HASH"));
  assert.ok(!files["wechat-gateway"].includes("DAJIALA_KEY"));
  assert.ok(!files.app.includes("MINIO_SECRET_KEY"));
  assert.ok(!files.app.includes("XAI_API_KEY"));
  const app = serviceBlocks(compose).app.join("\n");
  const dependencies = app.split("    depends_on:")[1]?.split("    healthcheck:")[0];
  assert.match(dependencies, /postgres:\s*\n\s*condition: service_healthy/);
  for (const service of ["telethon", "minio", "wechat-gateway"]) assert.ok(!dependencies.includes(`${service}:`));
  assert.ok(!compose.includes("${XAI_API_KEY"), "the optional agent profile also must not implicitly borrow the app provider key");
});

test("writer fails missing core variables before emitting files, without disclosing values", () => {
  assert.throws(() => serviceEnvs({ DATABASE_URL: "SECRET_TEST" }), (error) => error.message.includes("POSTGRES_PASSWORD") && !error.message.includes("SECRET_TEST"));
  assert.throws(() => serviceEnvs(Object.fromEntries(REQUIRED_VARS.map((name) => [name, name === "POSTGRES_PASSWORD" ? '""' : "SYNTHETIC_ONLY"]))), /POSTGRES_PASSWORD/);
  assert.throws(() => serviceEnvs(Object.fromEntries(REQUIRED_VARS.map((name) => [name, name === "MINIO_ROOT_PASSWORD" ? "" : "SYNTHETIC_ONLY"]))), /MINIO_ROOT_PASSWORD/);
});

test("no credential appears in the repository tree", () => {
  // 凭据必须留在 F:/loom-backups。这里只看 compose 是否引用了仓库内路径，
  // 不扫描文件内容（避免把一次性误读变成常态）。
  const repoLocal = /- \.\/[^:\n]*\.env/.exec(compose);
  assert.equal(repoLocal, null, `compose must not reference a repo-local env file: ${repoLocal?.[0]}`);
});
