import { getSql } from "@/lib/db";
import { prod, minioConfigured, telethonConfigured } from "./config";
import { minioHealth } from "./storage";
import { telethonHealth } from "./telethon";
import { xaiReady } from "./extract";
import { ingestPending } from "./media";
import { extractPending } from "./extract";
import { cronHasBudget, CRON_EXTRACT_RESERVE_MS, CRON_INGEST_RESERVE_MS } from "./cron";

export type NodeCard = {
  id: string;
  title: string;
  role: string;
  status: "live" | "wait" | "off";
  detail: string;
};

export async function getNodesStatus(): Promise<{
  nodes: NodeCard[];
  media: { total: number; remote: number; stored: number; error: number };
  extracts: { total: number; ok: number; pending: number; error: number };
  tick_limit: number;
  extract_auto: boolean;
}> {
  const [tg, minio] = await Promise.all([telethonHealth(), minioHealth()]);
  const sql = await getSql();
  let media = { total: 0, remote: 0, stored: 0, error: 0 };
  let extracts = { total: 0, ok: 0, pending: 0, error: 0 };
  try {
    const [m] = await sql.query<Record<string, unknown>>(
      `select count(*)::int as total,
              count(*) filter (where status = 'remote')::int as remote,
              count(*) filter (where status = 'stored')::int as stored,
              count(*) filter (where status = 'error')::int as error
       from media_objects`,
    );
    media = {
      total: Number(m?.total ?? 0),
      remote: Number(m?.remote ?? 0),
      stored: Number(m?.stored ?? 0),
      error: Number(m?.error ?? 0),
    };
    const [e] = await sql.query<Record<string, unknown>>(
      `select count(*)::int as total,
              count(*) filter (where status = 'ok')::int as ok,
              count(*) filter (where status in ('pending','running'))::int as pending,
              count(*) filter (where status = 'error')::int as error
       from extract_jobs`,
    );
    extracts = {
      total: Number(e?.total ?? 0),
      ok: Number(e?.ok ?? 0),
      pending: Number(e?.pending ?? 0),
      error: Number(e?.error ?? 0),
    };
  } catch {
    /* migration not applied yet */
  }

  const nodes: NodeCard[] = [
    {
      id: "telethon",
      title: "Telethon",
      role: "100–1000 频道增量 · GetHistory",
      status: tg.ok && tg.authorized ? "live" : telethonConfigured() ? "wait" : "off",
      detail: tg.ok && tg.authorized
        ? `已登录 ${tg.me || "session"}`
        : tg.error || "Docker 中配置 TELEGRAM_API_ID / HASH 并登录会话",
    },
    {
      id: "minio",
      title: "MinIO",
      role: "图片 / 视频 / 文件落盘",
      status: minio.ok ? "live" : minioConfigured() ? "wait" : "off",
      detail: minio.ok ? `bucket ${prod.minioBucket}` : minio.error || "Docker 中启动 MinIO 并设置 MINIO_ENDPOINT",
    },
    {
      id: "extract",
      title: "ASR / OCR",
      role: "Grok STT + 视觉识别",
      status: xaiReady() ? "live" : "off",
      detail: xaiReady() ? "按键提取，不预热调用" : "需要 XAI_API_KEY",
    },
    {
      id: "postgres",
      title: "PostgreSQL",
      role: "信源 / 游标 / 条目 / 任务",
      status: "live",
      detail: process.env.DATABASE_URL ? "DATABASE_URL 已连接" : "预览用内嵌 PGLite；Docker 用 Postgres",
    },
  ];

  return {
    nodes,
    media,
    extracts,
    tick_limit: prod.tickLimit,
    extract_auto: prod.extractAuto,
  };
}

export async function runProductionTick({ deadlineMs, now = Date.now }: {
  deadlineMs?: number;
  now?: () => number;
} = {}): Promise<{
  stored: number;
  extracted: number;
  ingest_errors: number;
  extract_errors: number;
  deferred: number;
}> {
  const bounded = deadlineMs !== undefined;
  const runIngest = !bounded || cronHasBudget(deadlineMs, CRON_INGEST_RESERVE_MS, now);
  const ingest = runIngest ? await ingestPending(bounded ? 1 : 8) : { stored: 0, errors: 0 };
  const runExtract = prod.extractAuto
    && (!bounded || cronHasBudget(deadlineMs, CRON_EXTRACT_RESERVE_MS, now));
  const extract = runExtract ? await extractPending(bounded ? 1 : 2, bounded ? 1 : 4) : { ran: 0, errors: 0 };
  return {
    stored: ingest.stored,
    extracted: extract.ran,
    ingest_errors: ingest.errors,
    extract_errors: extract.errors,
    deferred: Number(!runIngest) + Number(prod.extractAuto && !runExtract),
  };
}
