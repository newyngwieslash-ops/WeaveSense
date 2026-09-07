import { randomUUID } from "node:crypto";
import { materialFingerprint } from "./agent-context.ts";
import type { ItemRow } from "../types.ts";
import { isPlatform } from "../platforms.ts";

export const POLICY_VERSION = "loom-agent-v1";

export type AutoAnalyzeConfig = {
  autoAnalyze: boolean;
  dailyLimit: number;
  dailyBudgetRmb: number;
  priceVersion: string;
  worstCostRmb: number;
};

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export type AiJob = {
  id: string;
  item_id: string;
  material_hash: string;
  policy_version: string;
  status: string;
  claim_token: string;
  payload: Record<string, unknown>;
};

function mapJob(row: Record<string, unknown>): AiJob {
  const raw = row.payload;
  const payload = typeof raw === "string"
    ? (JSON.parse(raw) as Record<string, unknown>)
    : raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    id: String(row.id),
    item_id: String(row.item_id),
    material_hash: String(row.material_hash),
    policy_version: String(row.policy_version),
    status: String(row.status),
    claim_token: String(row.claim_token),
    payload,
  };
}

function mapItem(row: Record<string, unknown>): ItemRow {
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    platform: isPlatform(String(row.platform)) ? String(row.platform) as ItemRow["platform"] : "rss",
    external_id: String(row.external_id),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    author: String(row.author ?? ""),
    url: String(row.url ?? ""),
    media_type: (row.media_type as ItemRow["media_type"]) ?? "article",
    media_urls: [],
    thumbnail_url: "",
    views: null,
    likes: null,
    published_at: row.published_at ? new Date(String(row.published_at)).toISOString() : null,
    collected_at: row.collected_at ? new Date(String(row.collected_at)).toISOString() : new Date().toISOString(),
    pipeline_status: (row.pipeline_status as ItemRow["pipeline_status"]) ?? "ingested",
    extra: {},
    matched_keywords: [],
    source_name: row.source_name ? String(row.source_name) : undefined,
  };
}

function ready(row: Record<string, unknown>): boolean {
  const body = String(row.body ?? "").trim();
  if (!body) return false;
  const pending = Number(row.pending_extracts ?? 0);
  const failed = Number(row.failed_extracts ?? 0);
  if (pending > 0 || failed > 0) return false;
  if (row.has_valid_analysis === true || row.has_valid_analysis === "t" || Number(row.has_valid_analysis) === 1) {
    return false;
  }
  return true;
}

export async function enqueueReadyAnalyses(
  sql: Queryable,
  cfg: AutoAnalyzeConfig,
  day: string,
): Promise<{ enqueued: number }> {
  if (!cfg.autoAnalyze) return { enqueued: 0 };
  const rows = await sql.query<Record<string, unknown>>(
    `select i.*,
            (select count(*)::int from extract_jobs e where e.item_id = i.id and e.status in ('pending','running')) as pending_extracts,
            (select count(*)::int from extract_jobs e where e.item_id = i.id and e.status = 'error') as failed_extracts,
            exists (
              select 1 from analyses a
              left join ai_runs r on r.id = a.run_id
              where a.item_id = i.id and a.run_id is not null and r.status = 'succeeded'
            ) as has_valid_analysis
     from items i
     where i.pipeline_status in ('extracted','ingested')
     order by coalesce(i.published_at, i.collected_at) desc, i.id
     limit 40`,
  );
  let enqueued = 0;
  for (const row of rows) {
    if (!ready(row)) continue;
    const item = mapItem(row);
    const hash = materialFingerprint(item);
    const reserved = await reserveBudget(sql, {
      day, priceVersion: cfg.priceVersion, worstCostRmb: cfg.worstCostRmb,
      dailyLimit: cfg.dailyLimit, dailyBudgetRmb: cfg.dailyBudgetRmb,
    });
    if (!reserved) break;
    const inserted = await sql.query<{ id: string }>(
      `insert into ai_jobs (id, item_id, material_hash, policy_version, status)
       values ($1,$2,$3,$4,'queued')
       on conflict (item_id, material_hash, policy_version) do nothing
       returning id`,
      [randomUUID(), item.id, hash, POLICY_VERSION],
    );
    if (inserted.length === 1) enqueued += 1;
    else await releaseBudget(sql, { day, priceVersion: cfg.priceVersion, worstCostRmb: cfg.worstCostRmb });
  }
  return { enqueued };
}

async function reserveBudget(sql: Queryable, input: {
  day: string; priceVersion: string; worstCostRmb: number; dailyLimit: number; dailyBudgetRmb: number;
}): Promise<boolean> {
  // ponytail: row lock on ai_budget_days is the daily ceiling; sharded counters if multiple regions share one quota.
  const rows = await sql.query<{ day: string }>(
    `insert into ai_budget_days (day, price_version, reserved_count, reserved_rmb)
     values ($1,$2,1,$3)
     on conflict (day, price_version) do update
       set reserved_count = ai_budget_days.reserved_count + 1,
           reserved_rmb = ai_budget_days.reserved_rmb + excluded.reserved_rmb
     where ai_budget_days.reserved_count < $4
       and ai_budget_days.reserved_rmb + excluded.reserved_rmb <= $5
     returning day`,
    [input.day, input.priceVersion, input.worstCostRmb, input.dailyLimit, input.dailyBudgetRmb],
  );
  return rows.length === 1;
}

async function releaseBudget(sql: Queryable, input: { day: string; priceVersion: string; worstCostRmb: number }) {
  await sql.query(
    `update ai_budget_days
     set reserved_count = greatest(reserved_count - 1, 0),
         reserved_rmb = greatest(reserved_rmb - $3, 0)
     where day = $1 and price_version = $2`,
    [input.day, input.priceVersion, input.worstCostRmb],
  );
}

export async function claimAiJob(sql: Queryable, opts: {
  worker: string;
  leaseSeconds: number;
  kind?: "analyze" | "research";
}): Promise<AiJob | null> {
  const claimToken = randomUUID();
  const kind = opts.kind ?? "analyze";
  const [row] = await sql.query<Record<string, unknown>>(
    `update ai_jobs
     set status = 'running',
         attempts = attempts + 1,
         claim_token = $1,
         lease_until = now() + ($2::integer * interval '1 second'),
         updated_at = now()
     where id = (
       select id from ai_jobs
       where status = 'queued' and next_attempt_at <= now()
         and case when $3 = 'research' then item_id like 'research:%' else item_id not like 'research:%' end
       order by created_at, id
       limit 1
     )
     returning *`,
    [claimToken, opts.leaseSeconds, kind],
  );
  return row ? mapJob(row) : null;
}

export async function enqueueResearchJob(sql: Queryable, input: {
  question: string;
  requestId: string;
  materialHash: string;
}): Promise<{ id: string; status: string } | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    `insert into ai_jobs (id, item_id, material_hash, policy_version, status, payload)
     values ($1,$2,$3,$4,'queued',$5::jsonb)
     on conflict (item_id, material_hash, policy_version) do update
       set updated_at = ai_jobs.updated_at
     returning id, status`,
    [randomUUID(), `research:${input.requestId}`, input.materialHash, POLICY_VERSION, JSON.stringify({ question: input.question })],
  );
  if (!row) return null;
  return { id: String(row.id), status: String(row.status) };
}

export async function getAiJob(sql: Queryable, id: string): Promise<AiJob | null> {
  const [row] = await sql.query<Record<string, unknown>>("select * from ai_jobs where id = $1", [id]);
  return row ? mapJob(row) : null;
}

export async function finishAiJob(sql: Queryable, input: {
  id: string;
  claimToken: string;
  status: "succeeded" | "failed" | "outcome_unknown";
  runId?: string;
  errorCode?: string;
}): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update ai_jobs
     set status = $3,
         run_id = coalesce($4, run_id),
         error_code = coalesce($5, error_code),
         claim_token = '',
         lease_until = null,
         updated_at = now()
     where id = $1 and claim_token = $2 and status = 'running'
     returning id`,
    [input.id, input.claimToken, input.status, input.runId ?? null, input.errorCode ?? ""],
  );
  return rows.length === 1;
}

export function autoAnalyzeConfigFromEnv(): AutoAnalyzeConfig {
  const read = (name: string, fallback: string) => (process.env[name] ?? fallback).trim();
  return {
    autoAnalyze: read("AUTO_ANALYZE", "false") === "true",
    dailyLimit: Math.max(0, Number(read("AUTO_ANALYZE_DAILY_LIMIT", "20")) || 0),
    dailyBudgetRmb: Math.max(0, Number(read("AUTO_ANALYZE_DAILY_BUDGET_RMB", "20")) || 0),
    priceVersion: read("AUTO_ANALYZE_PRICE_VERSION", "v1") || "v1",
    worstCostRmb: Math.max(0.01, Number(read("AUTO_ANALYZE_WORST_COST_RMB", "1")) || 1),
  };
}
