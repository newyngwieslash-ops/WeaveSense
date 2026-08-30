import { parseCronTickLimit } from "./cron";

function read(name: string, fallback = ""): string {
  const raw = typeof process !== "undefined" ? process.env[name] : undefined;
  return (raw ?? fallback).trim();
}

export const prod = {
  telegramWorkerUrl: read("TELEGRAM_WORKER_URL").replace(/\/$/, ""),
  wechatGatewayUrl: read("WECHAT_GATEWAY_URL").replace(/\/$/, ""),
  wechatGatewayToken: read("WECHAT_GATEWAY_TOKEN"),
  cronSecret: read("CRON_SECRET"),
  cronTickLimit: parseCronTickLimit(read("CRON_TICK_LIMIT", "200")),
  minioEndpoint: read("MINIO_ENDPOINT").replace(/\/$/, ""),
  minioAccessKey: read("MINIO_ACCESS_KEY") || read("MINIO_ROOT_USER"),
  minioSecretKey: read("MINIO_SECRET_KEY") || read("MINIO_ROOT_PASSWORD"),
  minioBucket: read("MINIO_BUCKET", "loom"),
  minioRegion: read("MINIO_REGION", "us-east-1"),
  minioPublicUrl: read("MINIO_PUBLIC_URL").replace(/\/$/, ""),
  minioForcePathStyle: read("MINIO_FORCE_PATH_STYLE", "true") !== "false",
  tickLimit: Math.min(40, Math.max(1, Number(read("TICK_LIMIT", "5")) || 5)),
  extractAuto: read("EXTRACT_AUTO", "false") === "true",
};

export function minioConfigured(): boolean {
  return Boolean(prod.minioEndpoint && prod.minioAccessKey && prod.minioSecretKey);
}

export function telethonConfigured(): boolean {
  return Boolean(prod.telegramWorkerUrl);
}

export function wechatGatewayConfigured(): boolean {
  return Boolean(prod.wechatGatewayUrl && prod.wechatGatewayToken);
}
