import type { Queryable } from "../db.ts";

export type AgentSql = Queryable & {
  transaction?<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};
const transactions = new WeakSet<object>();

/** Never emulate a transaction with pool.query BEGIN/COMMIT. */
export async function agentTransaction<T>(sql: AgentSql, fn: (tx: AgentSql) => Promise<T>): Promise<T> {
  if (transactions.has(sql)) return fn(sql);
  if (!sql.transaction) throw new Error("agent_transaction_required");
  return sql.transaction(async tx => {
    transactions.add(tx);
    try { return await fn(tx); } finally { transactions.delete(tx); }
  });
}

export async function lockRun(sql: AgentSql, runId: string, jobId?: string) {
  // Global lock order: job -> run -> item -> source -> budget detail -> day.
  const [job] = await sql.query<Record<string, any>>(
    jobId ? "select * from ai_jobs where id = $1 for update" : "select * from ai_jobs where run_id = $1 order by id for update",
    [jobId ?? runId],
  );
  const [run] = await sql.query<Record<string, any>>("select * from ai_runs where id = $1 for update", [runId]);
  return { job, run };
}

export async function ownsRun(sql: AgentSql, locked: Awaited<ReturnType<typeof lockRun>>, token: string, jobId?: string): Promise<boolean> {
  const { run, job } = locked;
  const [clock] = await sql.query<{ now: Date }>("select clock_timestamp() as now");
  const now = new Date(clock.now).getTime();
  return !!run && run.status === "running" && run.claim_token === token && new Date(run.expires_at).getTime() > now
    && (!jobId || job?.id === jobId)
    && (!job || (job.run_id === run.id && job.status === "running" && job.claim_token === token && job.lease_until != null && new Date(job.lease_until).getTime() > now));
}
