import { getSql } from "@/lib/db";
import { prod, minioConfigured, telethonConfigured } from "./config";
import { minioHealth } from "./storage";
import { telethonHealth } from "./telethon";
import { xaiReady } from "./extract";
import { ingestPending } from "./media";
import { extractPending } from "./extract";
import { cronHasBudget, CRON_EXTRACT_RESERVE_MS, CRON_INGEST_RESERVE_MS } from "./cron";
import { autoAnalyzeConfigFromEnv, claimAiJob, enqueueReadyAnalyses, finishAiJob } from "./agent-queue";
import { analyzeItemWith } from "./analyze";
import { confirmJobNotSent } from "./agent-budget";
import { runStageOnce } from "./stage-windows.ts";

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

/**
 * The heavy production stages (media ingest, OCR/ASR extraction), each gated by
 * its own persistent window.
 *
 * T09: the scheduler wake-up is short (60 s) so collection due-times are honoured
 * promptly, but these stages are expensive — running them per-minute instead of
 * per-30-minutes would multiply 落盘/OCR by 30. `runStageOnce` admits at most one
 * execution per window across processes and restarts (see stage-windows.ts).
 *
 * The stage's own counts are captured inside the window callback; nothing is run
 * twice, and a window that does not admit returns zeros with the reason.
 */
export async function runProductionTick({ deadlineMs, now = Date.now, allowExtract = true }: {
  deadlineMs?: number;
  now?: () => number;
  allowExtract?: boolean;
} = {}): Promise<{
  stored: number;
  extracted: number;
  analyzed: number;
  ingest_errors: number;
  extract_errors: number;
  deferred: number;
  stages: { ingest: string; extract: string };
}> {
  const bounded = deadlineMs !== undefined;
  const nowMs = now();
  const stageSql = await getSql();

  // Admission decides *whether* this tick may run the stage; the budget decides
  // how much fits. Budget refusal is a deferral, not a failure, so it must not
  // consume the window's "done" claim for the next tick.
  let ingest = { stored: 0, errors: 0 };
  const ingestWindow = await runStageOnce(stageSql, "ingest", async () => {
    if (bounded && !cronHasBudget(deadlineMs, CRON_INGEST_RESERVE_MS, now)) {
      return { ok: true, note: "deferred_budget", counts: { stored: 0, errors: 0 } };
    }
    const result = await ingestPending(bounded ? 1 : 8);
    ingest = result;
    return { ok: result.errors === 0, note: `stored=${result.stored} errors=${result.errors}`, counts: result };
  }, nowMs);

  let extract = { ran: 0, errors: 0 };
  const extractEligible = allowExtract && prod.extractAuto;
  const extractWindow = extractEligible
    ? await runStageOnce(stageSql, "extract", async () => {
        if (bounded && !cronHasBudget(deadlineMs, CRON_EXTRACT_RESERVE_MS, now)) {
          return { ok: true, note: "deferred_budget", counts: { ran: 0, errors: 0 } };
        }
        const result = await extractPending(bounded ? 1 : 2);
        extract = result;
        return { ok: result.errors === 0, note: `ran=${result.ran} errors=${result.errors}`, counts: result };
      }, nowMs)
    : null;

  let analyzed = 0;
  const cfg = autoAnalyzeConfigFromEnv();
  if (cfg.autoAnalyze) {
    const sql = await getSql();
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    await enqueueReadyAnalyses(sql, cfg, day);
    const job = await claimAiJob(sql, { worker: "cron", leaseSeconds: 60, kind: "analyze" });
    if (job) {
      const result = await analyzeItemWith({ sql, itemId: job.item_id, job, requestId: `auto:${job.id}` });
      const unknown = !result.ok && (result.error_code === "model_timeout" || result.error_code === "outcome_unknown");
      if (!result.run_id) {
      await confirmJobNotSent(sql, job.id, job.claim_token);
      await finishAiJob(sql, {
        id: job.id,
        claimToken: job.claim_token,
        status: result.ok ? "succeeded" : unknown ? "outcome_unknown" : "failed",
        runId: result.run_id,
        errorCode: result.ok ? "" : result.error_code,
      });
      }
      if (result.ok) analyzed = 1;
    }
  }
  return {
    stored: ingest.stored,
    extracted: extract.ran,
    analyzed,
    ingest_errors: ingest.errors,
    extract_errors: extract.errors,
    // Deferred = a stage this tick wanted to run but could not start, either
    // because the window was taken or because the budget ran out first.
    deferred: Number(!ingestWindow.ran || ingestWindow.result?.note === "deferred_budget")
      + Number(extractEligible && (!extractWindow?.ran || extractWindow.result?.note === "deferred_budget")),
    stages: {
      ingest: ingestWindow.ran ? ingestWindow.result?.note ?? "ran" : ingestWindow.reason ?? "skipped",
      extract: extractWindow
        ? (extractWindow.ran ? extractWindow.result?.note ?? "ran" : extractWindow.reason ?? "skipped")
        : "disabled",
    },
  };
}
