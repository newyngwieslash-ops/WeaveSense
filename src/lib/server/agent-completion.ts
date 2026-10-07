import { agentTransaction, lockRun, ownsRun, type AgentSql } from "./agent-transaction.ts";
import { hashCanonical } from "./agent-runs.ts";
import { settleJobBudget } from "./agent-budget.ts";
import { researchPublicationError } from "./agent-research-publication.ts";

export type CompletionInput = {
  runId: string; claimToken: string; jobId?: string;
  status: "succeeded" | "failed" | "outcome_unknown" | "timed_out" | "cancelled";
  errorCode?: string; responseJson?: unknown;
  validate?: (tx: AgentSql, run: Record<string, any>) => Promise<string | null>;
  write?: (tx: AgentSql) => Promise<Record<string, unknown>>;
  model?: string; promptVersion?: string; skillVersions?: Record<string, string>;
  inputTokens?: number | null; outputTokens?: number | null; modelCalls?: number; toolCalls?: number;
  expired?: boolean;
  expiredLease?: boolean;
};

function completionHash(input: CompletionInput) {
  const response = input.responseJson && typeof input.responseJson === "object" ? { ...input.responseJson } as Record<string, unknown> : input.responseJson;
  if (response && typeof response === "object") {
    for (const key of ["note_id", "analysis_id", "_completion"]) delete (response as Record<string, unknown>)[key];
  }
  return hashCanonical({ status: input.status, error: input.errorCode ?? "", response: response ?? null });
}

/** All terminal writes, including business rows and job ownership, share this boundary. */
export async function completeRun(sql: AgentSql, input: CompletionInput): Promise<
  { ok: true; replay: boolean; response: Record<string, unknown> } | { ok: false; error: string }
> {
  return agentTransaction(sql, async tx => {
    const locked = await lockRun(tx, input.runId, input.jobId);
    const { run, job } = locked;
    if (input.expired && run?.status === "running") {
      const calls = await tx.query("select call_id from ai_model_calls where run_id=$1", [input.runId]);
      const status = calls.length ? "outcome_unknown" : "timed_out";
      input = { ...input, status, errorCode: status };
    }
    const digest = completionHash(input);
    if (!run || run.claim_token !== input.claimToken || (input.jobId && (job?.id !== input.jobId || job.run_id !== run.id))) return { ok: false, error: "stale" };
    if (run.status !== "running") {
      const response = run.response_json ?? {};
      if (run.status === input.status && response._completion?.digest === digest && (!job || job.status === input.status)) {
        return { ok: true, replay: true, response };
      }
      return { ok: false, error: "completion_conflict" };
    }
    const owned = async () => {
      if (!input.expired && !input.expiredLease) return ownsRun(tx, locked, input.claimToken, input.jobId);
      const [clock] = await tx.query<{ now: Date }>("select clock_timestamp() as now");
      if (input.expiredLease) return Boolean(job && job.status === "running" && job.run_id === run.id && job.claim_token === run.claim_token && job.lease_until && new Date(job.lease_until) <= new Date(clock.now));
      return new Date(run.expires_at) <= new Date(clock.now) && (!job || (job.status === "running" && job.run_id === run.id && job.claim_token === run.claim_token));
    };
    if (!await owned()) return { ok: false, error: "stale" };
    if (input.status === "succeeded" && job?.payload?.cancel_requested) return { ok: false, error: "cancel_requested" };
    if (input.status === "succeeded") {
      const publicationError = await researchPublicationError(tx, run, input.responseJson);
      if (publicationError) return { ok: false, error: publicationError };
    }
    const invalid = await input.validate?.(tx, run);
    if (invalid) return { ok: false, error: invalid };
    // Validation may have waited on item/source locks. Use wall clock AFTER that wait.
    if (!await owned()) return { ok: false, error: "stale" };
    const business = input.status === "succeeded" ? await input.write?.(tx) ?? {} : {};
    const response = { ...(input.responseJson as object ?? {}), ...business, _completion: { digest } };
    await tx.query(`update ai_runs set status=$2, error_code=$3, response_json=$4::jsonb,
      model=$5, prompt_version=$6, skill_versions=$7::jsonb, input_tokens=$8, output_tokens=$9,
      model_calls=$10, tool_calls=$11, finished_at=clock_timestamp() where id=$1`,
      [input.runId, input.status, input.errorCode ?? "", JSON.stringify(response), input.model ?? "", input.promptVersion ?? "",
        JSON.stringify(input.skillVersions ?? {}), input.inputTokens ?? null, input.outputTokens ?? null, input.modelCalls ?? 0, input.toolCalls ?? 0]);
    if (job) {
      await tx.query(`update ai_jobs set status=$2, error_code=$3, claim_token='', lease_until=null, updated_at=clock_timestamp() where id=$1`,
        [job.id, input.status === "timed_out" || input.status === "cancelled" ? "outcome_unknown" : input.status, input.errorCode ?? ""]);
      // A terminal error is never evidence of zero supplier spend.
      await settleJobBudget(tx, job.id, input.runId);
    }
    return { ok: true, replay: false, response };
  });
}
