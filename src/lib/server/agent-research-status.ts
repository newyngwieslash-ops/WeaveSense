import type { ResearchStatus } from "../types.ts";
import { reviewReportSchema } from "../agent-review-contract.ts";
import { agentTransaction, type AgentSql } from "./agent-transaction.ts";
import { settleJobBudget } from "./agent-budget.ts";
import { convergeExpiredRun } from "./agent-runs.ts";

function object(value: unknown): Record<string, any> {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
const publicErrors = new Set(["cancelled", "review_blocked", "review_outcome_unknown", "outcome_unknown", "queue_expired", "capability_disabled", "invalid_citation", "source_changed", "materials_changed", "budget_exhausted", "deadline_exceeded", "agent_unavailable", "invalid_output", "review_failed"]);

/** Project named facts only: never return the raw payload, runtime, report envelope or grants. */
export function mapResearchStatus(row: Record<string, unknown>): ResearchStatus {
  const payload = object(row.payload), request = object(row.request_json), result = object(row.result_json);
  const mode = object(row.frozen_policy).mode ?? object(request.review_policy).mode ?? object(payload.review_policy).mode;
  const reviewMode = mode === "enforce" || mode === "shadow" ? mode : "off";
  const status = String(row.status), terminal = !["queued", "running"].includes(status);
  const cancelRequested = payload.cancel_requested === true;
  let phase: ResearchStatus["phase"];
  if (status === "succeeded") phase = row.note_id ? "published" : "outcome_unknown";
  else if (status === "outcome_unknown" || row.review_state === "unknown") phase = "outcome_unknown";
  else if (terminal) phase = "blocked";
  else if (cancelRequested) phase = "cancel_requested";
  else if (status === "queued") phase = "queued";
  else phase = row.result_json && reviewMode !== "off" ? "reviewing" : "researching";
  const dto: ResearchStatus = { ok: true, job_id: String(row.id), status, phase, terminal,
    can_cancel: !terminal && !cancelRequested, review_mode: reviewMode };
  if (row.error_code) dto.error_code = publicErrors.has(String(row.error_code)) ? String(row.error_code) : "research_failed";
  if (phase === "published") dto.note_id = String(row.note_id);
  if (typeof result.content === "string") {
    dto.candidate = { content: Array.from(result.content).slice(0, 12000).join(""), citations: Array.isArray(result.citations)
      ? result.citations.slice(0, 20).flatMap((c: unknown) => {
        const citation = object(c);
        return typeof citation.evidence_id === "string" && typeof citation.quote === "string"
          ? [{ evidence_id: citation.evidence_id.slice(0, 128), quote: Array.from(citation.quote).slice(0, 500).join("") }] : [];
      }) : [] };
  }
  const review = reviewReportSchema.safeParse(row.report_json);
  if (review.success) dto.review = { checks: review.data.checks, findings: review.data.findings };
  return dto;
}

export async function getResearchStatus(sql: AgentSql, id: string): Promise<ResearchStatus | null> {
  const [expired] = await sql.query<{ run_id: string }>(`select j.run_id from ai_jobs j join ai_runs r on r.id=j.run_id
    where j.id=$1 and j.item_id like 'research:%' and j.status='running' and r.status='running'
      and r.expires_at<=clock_timestamp()`, [id]);
  if (expired) await convergeExpiredRun(sql, expired.run_id);
  const [row] = await sql.query<Record<string, unknown>>(`select j.id,j.status,j.payload,j.error_code,
    r.request_json,c.result_json,c.frozen_policy,v.state as review_state,v.report_json,n.id as note_id
    from ai_jobs j left join ai_runs r on r.id=j.run_id
    left join ai_research_candidates c on c.run_id=r.id
    left join ai_research_reviews v on v.run_id=r.id
    left join knowledge_notes n on n.run_id=r.id
    where j.id=$1 and j.item_id like 'research:%'`, [id]);
  return row ? mapResearchStatus(row) : null;
}

export async function cancelResearchJob(sql: AgentSql, id: string, authorized: boolean): Promise<ResearchStatus | { ok: false; error_code: string }> {
  if (!authorized) return { ok: false, error_code: "forbidden" };
  return agentTransaction(sql, async tx => {
    const [job] = await tx.query<Record<string, any>>("select * from ai_jobs where id=$1 and item_id like 'research:%' for update", [id]);
    if (!job) return { ok: false, error_code: "not_found" };
    if (["queued", "running"].includes(job.status)) {
      if (job.run_id) {
        const [run] = await tx.query<Record<string, unknown>>("select id,mode,status,claim_token from ai_runs where id=$1 for update", [job.run_id]);
        if (!run || run.mode !== "research" || run.status !== "running" || run.claim_token !== job.claim_token) return { ok: false, error_code: "stale" };
        await tx.query("update ai_runs set data_token_hash='' where id=$1", [job.run_id]);
        await tx.query("update ai_research_reviews set grant_hash=null where run_id=$1", [job.run_id]);
      }
      await tx.query("update ai_jobs set payload=jsonb_set(payload,'{cancel_requested}','true'::jsonb),updated_at=clock_timestamp() where id=$1", [id]);
      if (job.status === "queued" && !job.run_id) {
        await tx.query("update ai_jobs set status='failed',error_code='cancelled' where id=$1", [id]);
        await tx.query("update ai_budget_reservations set dispatch_state='not_sent' where job_id=$1 and dispatch_state='unconfirmed' and status='reserved'", [id]);
        await settleJobBudget(tx, id);
      }
    }
    return (await getResearchStatus(tx, id))!;
  });
}
