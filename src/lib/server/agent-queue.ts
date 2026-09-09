import { mapAgentItem as mapItem } from "./agent-retrieval.ts";
import { agentTransaction } from "./agent-transaction.ts";
import { settleJobBudget, admitBudgetDay } from "./agent-budget.ts";
import { completeRun } from "./agent-completion.ts";
import { convergeExpiredRun, hashCanonical } from "./agent-runs.ts";
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
  pricing?: { model: string; input_per_million: number; output_per_million: number };
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
    `select i.*,s.name as source_name,
            (select count(*)::int from extract_jobs e where e.item_id = i.id and e.status in ('pending','running')) as pending_extracts,
            (select count(*)::int from extract_jobs e where e.item_id = i.id and e.status = 'error') as failed_extracts,
            (select coalesce(jsonb_agg(r.material_hash),'[]'::jsonb) from analyses a
              left join ai_runs r on r.id = a.run_id
              where a.item_id = i.id and a.run_id is not null and r.status = 'succeeded'
            ) as analysis_hashes
     from items i join sources s on s.id=i.source_id
     where i.pipeline_status in ('extracted','ingested','analyzed')
     order by coalesce(i.published_at, i.collected_at) desc, i.id
     limit 40`,
  );
  let enqueued = 0;
  for (const row of rows) {
    if (!ready(row)) continue;
    const item = mapItem(row);
    const hash = materialFingerprint(item);
    if (Array.isArray(row.analysis_hashes) && row.analysis_hashes.includes(hash)) continue;
    if (item.pipeline_status === "ingested" && !["article","text"].includes(item.media_type)) continue;
    const admitted = await agentTransaction(sql, async sql => {
    if ((await sql.query("select id from ai_jobs where item_id=$1 and material_hash=$2 and policy_version=$3",[item.id,hash,POLICY_VERSION])).length) return true;
    const reserved = await reserveBudget(sql, {
      day, priceVersion: cfg.priceVersion, worstCostRmb: cfg.worstCostRmb,
      dailyLimit: cfg.dailyLimit, dailyBudgetRmb: cfg.dailyBudgetRmb,
    });
    if (!reserved) return false;
    const inserted = await sql.query<{ id: string }>(
      `insert into ai_jobs (id, item_id, material_hash, policy_version, status)
       values ($1,$2,$3,$4,'queued')
       on conflict (item_id, material_hash, policy_version) do nothing
       returning id`,
      [randomUUID(), item.id, hash, POLICY_VERSION],
    );
    if (inserted.length === 1) {
      await sql.query(
        `insert into ai_budget_reservations (id, job_id, day, price_version, reserved_rmb, status, pricing)
         values ($1,$2,$3,$4,$5,'reserved',$6::jsonb)
         on conflict (job_id) do nothing`,
        [randomUUID(), inserted[0].id, day, cfg.priceVersion, cfg.worstCostRmb, JSON.stringify({ ...cfg.pricing, daily_limit:cfg.dailyLimit, daily_budget_rmb:cfg.dailyBudgetRmb })],
      );
      enqueued += 1;
    } else await releaseBudget(sql, { day, priceVersion: cfg.priceVersion, worstCostRmb: cfg.worstCostRmb });
    return true;
    });
    if (!admitted) break;
  }
  return { enqueued };
}

async function reserveBudget(sql: Queryable, input: {
  day: string; priceVersion: string; worstCostRmb: number; dailyLimit: number; dailyBudgetRmb: number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.dailyLimit) || !Number.isFinite(input.dailyBudgetRmb) || !Number.isFinite(input.worstCostRmb)
    || input.worstCostRmb<0 || input.dailyLimit <= 0 || input.dailyBudgetRmb <= 0 || input.worstCostRmb > input.dailyBudgetRmb) return false;
  return admitBudgetDay(sql,input.day,input.priceVersion,input.worstCostRmb,input.dailyLimit,input.dailyBudgetRmb);
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
    `with candidate as (
       select id from ai_jobs
       where status = 'queued' and next_attempt_at <= now()
         and case when $3 = 'research' then item_id like 'research:%' else item_id not like 'research:%' end
       order by created_at, id
       for update skip locked
       limit 1
     )
     update ai_jobs as j
     set status = 'running',
         attempts = attempts + 1,
         claim_token = $1,
         lease_until = now() + ($2::integer * interval '1 second'),
         updated_at = now()
     from candidate as c
     where j.id = c.id and j.status = 'queued'
     returning j.*`,
    [claimToken, opts.leaseSeconds, kind],
  );
  return row ? mapJob(row) : null;
}

export async function enqueueResearchJob(sql: Queryable, input: {
  question: string;
  requestId: string;
  materialHash: string;
  snapshot?: Record<string, unknown>;
}): Promise<{ id: string; status: string; kind: "won" | "replay" | "conflict" } | null> {
  const [existing] = await sql.query<Record<string, unknown>>("select id, status, payload from ai_jobs where request_id = $1", [input.requestId]);
  if (existing) {
    const payload = typeof existing.payload === "string" ? JSON.parse(existing.payload) : existing.payload as Record<string, unknown>;
    if (String(payload?.question ?? "") !== input.question || ["provider", "mode", "scope", "range", "intent"].some(k =>
      input.snapshot?.[k] !== undefined && hashCanonical(payload[k]??null) !== hashCanonical(input.snapshot[k]))) return { id: String(existing.id), status: String(existing.status), kind: "conflict" };
    return { id: String(existing.id), status: String(existing.status), kind: "replay" };
  }
  const [row] = await sql.query<Record<string, unknown>>(
    `insert into ai_jobs (id, item_id, material_hash, policy_version, status, payload, request_id)
     values ($1,$2,$3,$4,'queued',$5::jsonb,$6)
     on conflict (request_id) where request_id is not null do nothing
     returning id, status`,
    [randomUUID(), `research:${input.requestId}`, input.materialHash, POLICY_VERSION, JSON.stringify({
      provider: "eino", mode: "research", range: null, sources: [], scope: "corpus",
      policy: { version: POLICY_VERSION, deadline_at: new Date(Date.now()+120000).toISOString(), max_model_calls: 6, max_tool_calls: 4, max_output_tokens_per_call: 1800 },
      ...input.snapshot, question: input.question, request_id: input.requestId,
    }), input.requestId],
  );
  if (row) return { id: String(row.id), status: String(row.status), kind: "won" };
  return enqueueResearchJob(sql, input);
}

export async function cancelQueuedResearchJobs(sql: Queryable) {
  return agentTransaction(sql,async tx=>{
    const jobs=await tx.query<{id:string}>("select id from ai_jobs where status='queued' and run_id is null and item_id like 'research:%' order by id for update skip locked limit 40");
    for(const job of jobs) {
      await tx.query("update ai_jobs set status='failed',error_code='capability_disabled',updated_at=clock_timestamp() where id=$1",[job.id]);
      await tx.query("update ai_budget_reservations set dispatch_state='not_sent' where job_id=$1 and dispatch_state='unconfirmed'",[job.id]);
      await settleJobBudget(tx,job.id);
    }
    return jobs.length;
  });
}

export async function getAiJob(sql: Queryable, id: string): Promise<AiJob | null> {
  const [row] = await sql.query<Record<string, unknown>>("select * from ai_jobs where id = $1", [id]);
  if(row?.run_id && row.status==='running') {
    await convergeExpiredRun(sql,String(row.run_id));
    const [current]=await sql.query<Record<string,unknown>>("select * from ai_jobs where id=$1",[id]);
    return current?mapJob(current):null;
  }
  return row ? mapJob(row) : null;
}

export async function finishAiJob(sql: Queryable, input: {
  id: string;
  claimToken: string;
  status: "succeeded" | "failed" | "outcome_unknown";
  runId?: string;
  errorCode?: string;
}): Promise<boolean> {
  return agentTransaction(sql, async tx => {
    const [job] = await tx.query<Record<string, any>>("select * from ai_jobs where id=$1 for update", [input.id]);
    if (!job) return false;
    if (job.run_id) {
      if (input.runId && input.runId !== job.run_id) return false;
      // Linked runs can only succeed via their business completion entry, never job-only ACK.
      if (input.status === "succeeded") {
        const [run] = await tx.query<Record<string, any>>("select * from ai_runs where id=$1 for update", [job.run_id]);
        return job.status === "succeeded" && run?.status === "succeeded" && run.claim_token === input.claimToken;
      }
      return (await completeRun(tx, { runId: job.run_id, jobId: job.id, claimToken: input.claimToken,
        status: input.status, errorCode: input.errorCode })).ok;
    }
    const rows = await tx.query(`update ai_jobs set status=$3,error_code=$4,claim_token='',lease_until=null,updated_at=clock_timestamp()
      where id=$1 and claim_token=$2 and status='running' and lease_until>clock_timestamp() returning id`,
      [input.id,input.claimToken,input.status,input.errorCode ?? ""]);
    if (!rows.length) return false;
    await settleJobBudget(tx,input.id);
    return true;
  });
}

export function autoAnalyzeConfigFromEnv(): AutoAnalyzeConfig {
  const read = (name: string, fallback: string) => (process.env[name] ?? fallback).trim();
  const inputRate = Number(read("AGENT_PRICE_INPUT_RMB_PER_MILLION", "NaN"));
  const outputRate = Number(read("AGENT_PRICE_OUTPUT_RMB_PER_MILLION", "NaN"));
  const model = read("AGENT_MODEL_NAME", "");
  const priced = !!model && Number.isFinite(inputRate) && inputRate > 0 && Number.isFinite(outputRate) && outputRate > 0;
  return {
    autoAnalyze: read("AUTO_ANALYZE", "false") === "true" && priced && read("AI_ENGINE", "legacy") === "eino",
    dailyLimit: Math.max(0, Number(read("AUTO_ANALYZE_DAILY_LIMIT", "20")) || 0),
    dailyBudgetRmb: Math.max(0, Number(read("AUTO_ANALYZE_DAILY_BUDGET_RMB", "20")) || 0),
    priceVersion: read("AUTO_ANALYZE_PRICE_VERSION", "v1") || "v1",
    // Two fixed calls, bounded 12k code points + schema/repair overhead (UTF-8 byte upper bound).
    worstCostRmb: priced ? (2 * 128000 * inputRate + 2 * 1200 * outputRate) / 1_000_000 : Infinity,
    ...(priced ? { pricing: { model, input_per_million: inputRate, output_per_million: outputRate } } : {}),
  };
}
