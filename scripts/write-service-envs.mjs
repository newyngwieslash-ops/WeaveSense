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
import { isMainModule } from "./with-app-env.mjs";

const SOURCE = "F:/loom-backups/loom-prod.env";
const OUT_DIR = join(dirname(SOURCE), "env");

/** 每个服务只声明它真正读取的变量。scheduler 只调 HTTP 端点，故仅需 CRON_SECRET。 */
export const SERVICE_VARS = {
  postgres: ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"],
  minio: ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"],
  "minio-init": ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MINIO_BUCKET"],
  telethon: ["MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET", "MINIO_PUBLIC_URL",
    "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION", "TELETHON_CONCURRENCY", "TELEGRAM_MEDIA_TOKEN"],
  "wechat-gateway": ["WECHAT_GATEWAY_TOKEN", "WECHAT_PRIMARY_ALLOWED_HOSTS",
    "DAJIALA_KEY", "DAJIALA_VERIFYCODE", "DAJIALA_BASE_URL", "DAJIALA_DAILY_BUDGET_RMB",
    "DAJIALA_DAILY_CALL_LIMIT", "DAJIALA_LIST_COST_RMB", "DAJIALA_DETAIL_COST_RMB"],
  app: [
    "DATABASE_URL",
    "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET", "MINIO_PUBLIC_URL",
    "CRON_SECRET", "WECHAT_GATEWAY_TOKEN", "TELEGRAM_MEDIA_TOKEN",
    "XAI_API_KEY",
  ],
  scheduler: ["CRON_SECRET"],
};

// Compose starts these infrastructure services by default. Keep their safety
// prerequisites mandatory (notably MinIO must never fall back to default keys).
// Telegram/paid/xAI and app media access remain independently optional.
export const REQUIRED_VARS = ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "DATABASE_URL",
  "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MINIO_BUCKET", "CRON_SECRET",
  "WECHAT_GATEWAY_TOKEN", "WECHAT_PRIMARY_ALLOWED_HOSTS"];

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function serviceEnvs(values) {
  const supplied = (name) => values[name]?.trim() && !/^(""|'')$/.test(values[name].trim());
  const missing = REQUIRED_VARS.filter((name) => !supplied(name));
  if (missing.length) throw new Error(`缺少变量：${missing.join(", ")}`);
  return Object.fromEntries(Object.entries(SERVICE_VARS).map(([service, names]) => [service,
    names.filter(supplied).map((name) => `${name}=${values[name]}`).join("\n") + "\n",
  ]));
}

function main() {
  const values = parseEnv(readFileSync(SOURCE, "utf8"));
  const bodies = serviceEnvs(values);

  const check = process.argv.includes("--check");
  if (!check) mkdirSync(OUT_DIR, { recursive: true });

  for (const [service, body] of Object.entries(bodies)) {
    if (check) {
      console.log(`${service}: ${body.split(/\r?\n/).map((line) => line.split("=")[0]).filter(Boolean).join(" ")}`);
      continue;
    }
    writeFileSync(join(OUT_DIR, `${service}.env`), body, { mode: 0o600 });
  }

  console.log(check
    ? `校验通过：${Object.keys(SERVICE_VARS).length} 个服务，${REQUIRED_VARS.length} 个核心变量齐备；可选能力另行预检`
    : `已写入 ${OUT_DIR}（${Object.keys(SERVICE_VARS).length} 个文件，600 权限）`);
}

// Guarded so the least-privilege test can import SERVICE_VARS without writing files.
if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error?.message?.startsWith("缺少变量：") ? error.message : "服务环境文件处理失败（检查来源和输出目录权限）");
    process.exitCode = 1;
  }
}
