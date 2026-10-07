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
import { SERVICE_VARS } from "./write-service-envs.mjs";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");

/** Split the compose text into service blocks keyed by name. */
function serviceBlocks(text) {
  const blocks = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^[a-z-]+:/.test(line) && line !== "services:") break;
    const top = /^ {2}([a-z-]+):\s*$/.exec(line);
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

test("credential variables are not interpolated from the command line", () => {
  // Interpolated credentials are what caused the T24 incident: `compose up` injects
  // command-line variables into every related service. They must come from env_file.
  for (const name of ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD", "CRON_SECRET", "WECHAT_GATEWAY_TOKEN"]) {
    assert.ok(
      !new RegExp(`\\$\\{${name}[:?]`).test(compose),
      `${name} must not be interpolated (use env_file)`,
    );
  }
});

test("each service env file declares only that service's variables", () => {
  // 文件由 write-service-envs.mjs 生成；这里只校验**变量名集合**，不读值。
  for (const [service, names] of Object.entries(SERVICE_VARS)) {
    let text;
    try {
      text = readFileSync(`F:/loom-backups/env/${service}.env`, "utf8");
    } catch {
      // 凭据文件在工作树外、可能不在（如新开发机）。守护测试只在它存在时校验内容，
      // 上面的 compose 断言仍会强制"每服务一个文件"的结构。
      continue;
    }
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

test("no credential appears in the repository tree", () => {
  // 凭据必须留在 F:/loom-backups。这里只看 compose 是否引用了仓库内路径，
  // 不扫描文件内容（避免把一次性误读变成常态）。
  const repoLocal = /- \.\/[^:\n]*\.env/.exec(compose);
  assert.equal(repoLocal, null, `compose must not reference a repo-local env file: ${repoLocal?.[0]}`);
});

test("optional OpenCode runtime has only task credentials and an isolated network", () => {
  const blocks = serviceBlocks(compose);
  const runtime = blocks["opencode-runtime"].join("\n");
  for (const text of ['profiles: ["opencode"]', 'networks: ["opencode-runtime"]', 'user: "1000:1000"', "read_only: true", 'cap_drop: ["ALL"]', 'security_opt: ["no-new-privileges:true"]', "pids_limit: 64", "mem_limit: 768m"]) {
    assert.ok(runtime.includes(text), `runtime requires ${text}`);
  }
  assert.ok(!/^\s+(?:ports|volumes|env_file|extra_hosts):/m.test(runtime));
  for (const secret of ["AGENT_MODEL_API_KEY", "XAI_API_KEY", "AGENT_DATA_TOKEN", "AGENT_SERVICE_TOKEN", "OPENCODE_WORKER_TOKEN", "OPENCODE_BRIDGE_CONTROL_TOKEN", "DATABASE_URL"]) {
    assert.ok(!runtime.includes(secret), `runtime must not receive ${secret}`);
  }
  const names = [...runtime.matchAll(/^ {6}([A-Z_]+):/gm)].map(match => match[1]);
  assert.deepEqual(names.sort(), ["OPENCODE_RUNTIME_TOKEN", "OPENCODE_BRIDGE_URL", "OPENCODE_MODEL_NAME"].sort());
  assert.match(compose, /networks:\s*\n {2}opencode-runtime:\s*\n {4}internal: true\s*\n {4}driver_opts:\s*\n {6}com\.docker\.network\.bridge\.gateway_mode_ipv4: isolated/);
});

test("trusted OpenCode controls hold no supplier key and services stay disabled by default", () => {
  const blocks = serviceBlocks(compose);
  for (const service of ["agent-bridge", "opencode-worker"]) {
    const body = blocks[service].join("\n");
    assert.ok(body.includes('profiles: ["opencode"]'));
    assert.ok(!/^\s+(?:ports|volumes|env_file):/m.test(body));
    assert.ok(body.includes('networks: ["default", "opencode-runtime"]'));
    assert.ok(body.includes("read_only: true"));
  }
  const worker = blocks["opencode-worker"].join("\n");
  for (const secret of ["AGENT_MODEL_API_KEY", "XAI_API_KEY", "AGENT_DATA_TOKEN", "DATABASE_URL"]) assert.ok(!worker.includes(secret));
  const app = blocks.app.join("\n");
  assert.ok(app.includes("AGENT_RESEARCH_RUNTIME: ${AGENT_RESEARCH_RUNTIME:-eino}"));
  assert.ok(app.includes("AGENT_OPENCODE_WORKER_ENABLED: ${AGENT_OPENCODE_WORKER_ENABLED:-false}"));
  assert.ok(app.includes("AGENT_ASYNC_RESEARCH_ENABLED: ${AGENT_ASYNC_RESEARCH_ENABLED:-false}"));
});
