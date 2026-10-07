import { z } from "zod";
import { agentTransaction, lockRun, ownsRun, type AgentSql } from "./agent-transaction.ts";

export async function admitBudgetDay(tx: AgentSql, day: string, version: string, amount: number, countLimit: number, moneyLimit: number) {
  if (!Number.isSafeInteger(countLimit) || countLimit<=0 || !Number.isFinite(moneyLimit) || moneyLimit<=0 || !Number.isFinite(amount) || amount<0 || amount>moneyLimit) return false;
  await tx.query("insert into ai_budget_admission_days(day) values($1) on conflict do nothing",[day]);
  await tx.query("select day from ai_budget_admission_days where day=$1 for update",[day]);
  const [total]=await tx.query<{count:number;amount:number}>("select coalesce(sum(reserved_count+settled_count),0)::int as count,coalesce(sum(reserved_rmb+settled_rmb),0)::float as amount from ai_budget_days where day=$1",[day]);
  if(total.count>=countLimit || total.amount+amount>moneyLimit) return false;
  await tx.query(`insert into ai_budget_days(day,price_version,reserved_count,reserved_rmb) values($1,$2,1,$3)
    on conflict(day,price_version) do update set reserved_count=ai_budget_days.reserved_count+1,reserved_rmb=ai_budget_days.reserved_rmb+excluded.reserved_rmb`,[day,version,amount]);
  return true;
}

export const modelCallSchema = z.object({
  call_id: z.uuid(), phase: z.enum(["started", "completed", "unknown"]), model: z.string().min(1).max(128),
  policy_version: z.string().min(1).max(64), input_tokens: z.number().int().min(0).nullable().optional(),
  output_tokens: z.number().int().min(0).nullable().optional(),
  request_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export type SendDisposition = "send_once" | "already_started" | "completed" | "unknown" | "denied";

/** Role comes from the trusted receipt endpoint, never a model-supplied field. */
export async function admitGovernedModelCall(sql: AgentSql, runId: string,
  auth: { role: "producer" | "reviewer"; tokenHash: string }, input: z.infer<typeof modelCallSchema>): Promise<SendDisposition> {
  const parsed = modelCallSchema.safeParse(input);
  if (!parsed.success || !parsed.data.request_digest) return "denied";
  return agentTransaction(sql, async tx => {
    const locked = await lockRun(tx, runId);
    const run = locked.run;
    if (!run?.request_json?.governed || !await ownsRun(tx, locked, run.claim_token) || !locked.job || input.policy_version !== run.policy_version) return "denied";
    if (input.phase === "started" && locked.job.payload?.cancel_requested) return "denied";
    const [clock] = await tx.query<{ now: Date; day: string }>("select clock_timestamp() as now,to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day");
    let review: Record<string, any> | undefined;
    if (auth.role === "producer") {
      if (!run.data_token_hash || run.data_token_hash !== auth.tokenHash) return "denied";
      if (input.phase === "started" && run.request_json.producer_deadline_at && Date.parse(run.request_json.producer_deadline_at) <= new Date(clock.now).getTime()) return "denied";
    } else {
      [review] = await tx.query<Record<string, any>>("select * from ai_research_reviews where run_id=$1 for update", [runId]);
      if (!review?.grant_hash || review.grant_hash !== auth.tokenHash || review.claim_token !== run.claim_token ||
        input.call_id !== review.review_call_id || input.request_digest !== review.request_digest ||
        new Date(review.expires_at) <= new Date(clock.now) || !["pending", "running", "unknown"].includes(review.state)) return "denied";
      const [candidate] = await tx.query<Record<string, any>>("select * from ai_research_candidates where run_id=$1", [runId]);
      if (!candidate || ["candidate_digest", "evidence_digest", "policy_digest"].some(k => candidate[k] !== review![k])) return "denied";
    }
    if (run.request_json.model_profile?.model !== input.model) return "denied";
    const [old] = await tx.query<Record<string, any>>("select * from ai_model_calls where run_id=$1 and call_id=$2 for update", [runId, input.call_id]);
    if (old) {
      if (old.role !== auth.role || old.request_digest !== input.request_digest || old.model !== input.model || old.policy_version !== input.policy_version) return "denied";
      if (input.phase === "started") return old.state === "started" ? "already_started" : old.state === "completed" ? "completed" : "unknown";
      if (old.state === input.phase) return old.input_tokens == (input.input_tokens ?? null) && old.output_tokens == (input.output_tokens ?? null) ? old.state as SendDisposition : "denied";
      if (old.state !== "started") return "denied";
      await tx.query("update ai_model_calls set state=$3,input_tokens=$4,output_tokens=$5,finished_at=clock_timestamp() where run_id=$1 and call_id=$2",
        [runId, input.call_id, input.phase, input.input_tokens ?? null, input.output_tokens ?? null]);
      if (auth.role === "reviewer" && input.phase === "unknown") await tx.query("update ai_research_reviews set state='unknown',error_code='review_outcome_unknown' where run_id=$1", [runId]);
      return input.phase;
    }
    if (input.phase !== "started") return "denied";
    if (auth.role === "producer") {
      const [pending] = await tx.query<{ n: number }>("select count(*)::int as n from ai_model_calls where run_id=$1 and role='producer' and state!='completed'", [runId]);
      // A provider/SDK retry has a fresh call ID. It still cannot spend after an uncertain send.
      if (pending.n) return "denied";
      if ((await tx.query("select run_id from ai_research_candidates where run_id=$1", [runId])).length) return "denied";
    }
    const limits = run.request_json.role_limits;
    const [count] = await tx.query<{ total: number; role: number }>("select count(*)::int as total,count(*) filter(where role=$2)::int as role from ai_model_calls where run_id=$1", [runId, auth.role]);
    if (!Number.isSafeInteger(limits?.[auth.role]) || limits[auth.role] <= 0 || count.role >= limits[auth.role] || count.total >= run.request_json.policy?.max_model_calls) return "denied";
    const [reservation] = await tx.query<Record<string, any>>("select * from ai_budget_reservations where job_id=$1 for update", [locked.job.id]);
    if (!reservation || reservation.status !== "reserved" || reservation.pricing?.model !== input.model ||
      !Number.isFinite(reservation.pricing.input_per_million) || !Number.isFinite(reservation.pricing.output_per_million)) return "denied";
    if (reservation.day !== clock.day) {
      if (count.total || !await admitBudgetDay(tx, clock.day, reservation.price_version, Number(reservation.reserved_rmb), reservation.pricing.daily_limit, reservation.pricing.daily_budget_rmb)) return "denied";
      await tx.query("update ai_budget_days set reserved_count=reserved_count-1,reserved_rmb=reserved_rmb-$3 where day=$1 and price_version=$2", [reservation.day, reservation.price_version, reservation.reserved_rmb]);
      await tx.query("update ai_budget_reservations set day=$2 where job_id=$1", [locked.job.id, clock.day]);
    }
    // Reservation/day locks can wait beyond the lease or a role's shorter deadline.
    if (!await ownsRun(tx, locked, run.claim_token)) return "denied";
    const [sendClock] = await tx.query<{ now: Date; day: string }>("select clock_timestamp() as now,to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day");
    if (sendClock.day !== clock.day) return "denied";
    const roleDeadline = auth.role === "producer" ? run.request_json.producer_deadline_at : review?.expires_at;
    if (roleDeadline && new Date(roleDeadline) <= new Date(sendClock.now)) return "denied";
    await tx.query("update ai_budget_reservations set dispatch_state='started' where job_id=$1", [locked.job.id]);
    await tx.query(`insert into ai_model_calls(run_id,call_id,model,policy_version,execution_day,state,role,request_digest)
      values($1,$2,$3,$4,$5,'started',$6,$7)`, [runId, input.call_id, input.model, input.policy_version, clock.day, auth.role, input.request_digest]);
    if (review) await tx.query("update ai_research_reviews set state='running' where run_id=$1", [runId]);
    return "send_once";
  });
}

/** Only the authenticated execution adapter invokes this at the actual send boundary. */
export async function recordModelCall(sql: AgentSql, runId: string, tokenHash: string, input: z.infer<typeof modelCallSchema>) {
  return agentTransaction(sql, async tx => {
    const locked = await lockRun(tx, runId);
    if (!locked.run || locked.run.data_token_hash !== tokenHash || !await ownsRun(tx, locked, locked.run.claim_token)) return false;
    if (input.policy_version !== locked.run.policy_version) return false;
    const [existing] = await tx.query<Record<string, any>>("select * from ai_model_calls where run_id=$1 and call_id=$2 for update", [runId,input.call_id]);
    if (existing) {
      if (existing.model !== input.model || existing.policy_version !== input.policy_version) return false;
      if (existing.state === input.phase) return existing.input_tokens == (input.input_tokens ?? null) && existing.output_tokens == (input.output_tokens ?? null);
      if (existing.state !== "started" || input.phase === "started") return false;
      await tx.query(`update ai_model_calls set state=$3,input_tokens=$4,output_tokens=$5,finished_at=clock_timestamp() where run_id=$1 and call_id=$2`,
        [runId,input.call_id,input.phase,input.input_tokens ?? null,input.output_tokens ?? null]);
      return true;
    }
    if (input.phase !== "started") return false;
    if (locked.job) {
      const [reservation] = await tx.query<Record<string, any>>("select * from ai_budget_reservations where job_id=$1 for update", [locked.job.id]);
      if (reservation) {
        const [day] = await tx.query<{ day: string }>("select to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day");
        if (reservation.status !== "reserved" || reservation.pricing?.model !== input.model) return false;
        if (reservation.day !== day.day) {
          const [sent] = await tx.query<{ n: number }>("select count(*)::int as n from ai_model_calls where run_id=$1", [runId]);
          // Once any call is sent, stop at a day boundary and settle its known usage on its execution day.
          if (sent.n || !reservation.pricing.daily_limit || !reservation.pricing.daily_budget_rmb) return false;
          const admitted = await admitBudgetDay(tx,day.day,reservation.price_version,Number(reservation.reserved_rmb),reservation.pricing.daily_limit,reservation.pricing.daily_budget_rmb);
          if (!admitted) return false;
          await tx.query("update ai_budget_days set reserved_count=reserved_count-1,reserved_rmb=reserved_rmb-$3 where day=$1 and price_version=$2", [reservation.day,reservation.price_version,reservation.reserved_rmb]);
          await tx.query("update ai_budget_reservations set day=$2 where job_id=$1", [locked.job.id,day.day]);
        }
        await tx.query("update ai_budget_reservations set dispatch_state='started' where job_id=$1", [locked.job.id]);
      }
    }
    const [count] = await tx.query<{ n: number }>("select count(*)::int as n from ai_model_calls where run_id=$1", [runId]);
    const policy = locked.run.request_json?.policy;
    if (!policy || count.n >= policy.max_model_calls) return false;
    await tx.query(`insert into ai_model_calls (run_id,call_id,model,policy_version,execution_day,state)
      values ($1,$2,$3,$4,to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD'),'started')`,
      [runId,input.call_id,input.model,input.policy_version]);
    return true;
  });
}

/** Internal preflight only. Not exposed as a client error-code or receipt action. */
export async function confirmJobNotSent(sql: AgentSql, jobId: string, claimToken: string) {
  return agentTransaction(sql, async tx => {
    const [job] = await tx.query<Record<string, any>>("select * from ai_jobs where id=$1 for update", [jobId]);
    if (!job || job.claim_token !== claimToken || job.status !== "running" || job.run_id) return false;
    const [clock] = await tx.query<{ now: Date }>("select clock_timestamp() as now");
    if (!job.lease_until || new Date(job.lease_until) <= new Date(clock.now)) return false;
    const rows = await tx.query("update ai_budget_reservations set dispatch_state='not_sent' where job_id=$1 and dispatch_state='unconfirmed' and status='reserved' returning id", [jobId]);
    return rows.length === 1;
  });
}

/** Called while holding the job/run locks in the terminal transaction. */
export async function settleJobBudget(tx: AgentSql, jobId: string, runId?: string) {
  const [r] = await tx.query<Record<string, any>>("select * from ai_budget_reservations where job_id=$1 for update", [jobId]);
  if (!r || r.status !== "reserved") return;
  const calls = runId ? await tx.query<Record<string, any>>("select * from ai_model_calls where run_id=$1", [runId]) : [];
  let actual: number | null = null;
  if (r.dispatch_state === "not_sent" && calls.length === 0) actual = 0;
  else if (calls.length && Number.isFinite(r.pricing?.input_per_million) && Number.isFinite(r.pricing?.output_per_million)
    && calls.every(c => c.state === "completed" && c.input_tokens != null && c.output_tokens != null && c.model === r.pricing.model)) {
    actual = calls.reduce((sum,c) => sum + (Number(c.input_tokens)*r.pricing.input_per_million + Number(c.output_tokens)*r.pricing.output_per_million)/1_000_000, 0);
  }
  if (actual == null) {
    await tx.query("update ai_budget_reservations set status='unknown' where job_id=$1", [jobId]);
    return;
  }
  await tx.query("update ai_budget_reservations set status=$2,actual_rmb=$3,settled_at=clock_timestamp() where job_id=$1", [jobId,calls.length ? "settled" : "released",actual]);
  await tx.query(`update ai_budget_days set reserved_count=reserved_count-1,reserved_rmb=reserved_rmb-$3,
    settled_count=settled_count+$4,settled_rmb=settled_rmb+$5 where day=$1 and price_version=$2`,
    [r.day,r.price_version,r.reserved_rmb,calls.length ? 1 : 0,actual]);
}
