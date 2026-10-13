#!/usr/bin/env node
/**
 * 2026-09-21 加固：把单一凭据源拆成"每个服务只拿到它需要的那几个变量"。
 *
 * 为什么要拆：compose 的 env_file 会把文件里**所有**变量注入引用它的每个服务，
 * 于是 MinIO 容器也会拿到 PostgreSQL 口令与 CRON_SECRET。单机部署里容器彼此同信
 * 任等级不高，但 MinIO 是面向网络的组件，没必要让它持有数据库凭据。
 *
 * 输入（工作树外，600，不入 git）：F:/loom-backups/loom-prod.env
 * 输出（同目录 env/）：<service>.env，只含该服务实际读取的变量。
 *
 * 轮换凭据时：改 loom-prod.env，再跑一次本脚本，然后按 runbook 逐服务
 * `--force-recreate --no-deps`（不要用 `compose up` 批量指定，见 T24 事故）。
 *
 * 用法：node scripts/write-service-envs.mjs [--check]
 *   --check 只校验输入齐备并打印映射，不写文件。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "F:/loom-backups/loom-prod.env";
const OUT_DIR = join(dirname(SOURCE), "env");

/** 每个服务只声明它真正读取的变量。scheduler 只调 HTTP 端点，故仅需 CRON_SECRET。 */
export const SERVICE_VARS = {
  postgres: ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"],
  minio: ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"],
  "minio-init": ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MINIO_BUCKET"],
  telethon: ["MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET", "MINIO_PUBLIC_URL"],
  "wechat-gateway": ["WECHAT_GATEWAY_TOKEN", "WECHAT_PRIMARY_ALLOWED_HOSTS"],
  app: [
    "DATABASE_URL",
    "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET", "MINIO_PUBLIC_URL",
    "CRON_SECRET", "WECHAT_GATEWAY_TOKEN",
  ],
  scheduler: ["CRON_SECRET"],
};

// Optional profile credentials never become mandatory for ordinary env generation.
export const SUBTITLE_SERVICE_VARS = {
  app: ["SUBTITLE_SERVICE_TOKEN"],
  "subtitle-worker": ["SUBTITLE_SERVICE_TOKEN", "SUBTITLE_PROXY_TOKEN"],
  "subtitle-egress": ["SUBTITLE_SERVICE_TOKEN", "SUBTITLE_PROXY_TOKEN"],
};

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function main() {
  const values = parseEnv(readFileSync(SOURCE, "utf8"));
  const services = { ...SERVICE_VARS };
  if (process.argv.includes("--subtitles")) {
    for (const [service, names] of Object.entries(SUBTITLE_SERVICE_VARS)) services[service] = [...(services[service] ?? []), ...names];
    if (values.SUBTITLE_SERVICE_TOKEN === values.SUBTITLE_PROXY_TOKEN ||
        ![values.SUBTITLE_SERVICE_TOKEN, values.SUBTITLE_PROXY_TOKEN].every(value => /^[A-Za-z0-9_-]{24,128}$/.test(value ?? ""))) {
      throw new Error("独立字幕令牌必须为不同的 24–128 位字母数字值");
    }
  }
  const required = [...new Set(Object.values(services).flat())];
  const missing = required.filter((name) => !values[name]);
  if (missing.length) {
    console.error(`缺少变量：${missing.join(", ")}（来源 ${SOURCE}）`);
    process.exit(1);
  }

  const check = process.argv.includes("--check");
  if (!check) mkdirSync(OUT_DIR, { recursive: true });

  for (const [service, names] of Object.entries(services)) {
    const body = names.map((name) => `${name}=${values[name]}`).join("\n") + "\n";
    if (check) {
      console.log(`${service}: ${names.join(" ")}`);
      continue;
    }
    writeFileSync(join(OUT_DIR, `${service}.env`), body, { mode: 0o600 });
  }

  console.log(check
    ? `校验通过：${Object.keys(SERVICE_VARS).length} 个服务，${required.length} 个变量齐备`
    : `已写入 ${OUT_DIR}（${Object.keys(SERVICE_VARS).length} 个文件，600 权限）`);
}

// Guarded so the least-privilege test can import SERVICE_VARS without writing files.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
