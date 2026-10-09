import { randomUUID } from "node:crypto";
import { z } from "zod";
import { handleAgentJobs } from "./agent-jobs.ts";
import { agentTransaction, lockRun, ownsRun, type AgentSql } from "./agent-transaction.ts";

const ids = z.object({ job_id: z.uuid(), run_id: z.uuid(), claim_token: z.uuid() });
const bindingSchema = z.discriminatedUnion("action", [
  ids.extend({ action: z.literal("bind"), instance_id: z.uuid(), epoch: z.uuid(), session_id: z.string().regex(/^ses_[a-zA-Z0-9]+$/),
    runtime_version: z.literal("1.3.13"), config_digest: z.string().regex(/^[a-f0-9]{64}$/),
    // The assistant profile binds with its profile marker (Task 8); the
    // research worker omits it, so it stays optional here.
    profile: z.literal("assistant").optional() }).strict(),
  ids.extend({ action: z.literal("dispatching") }).strict(),
  ids.extend({ action: z.literal("submitted") }).strict(),
  ids.extend({ action: z.literal("dispatch_unknown"), error_code: z.string().min(1).max(128).optional() }).strict(),
  ids.extend({ action: z.literal("aborted"), stopped: z.literal(true) }).strict(),
]);
class UnsafeOpenCodeClaim extends Error {}

/** Fixed trusted worker lane. A request parameter never selects the provider. */
export async function handleOpenCodeJobs(opts: { sql: AgentSql; authorized: boolean; action: string; params: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.authorized) return { status: 401, body: { error: "unauthorized" } };
  if (!["bind", "dispatching", "submitted", "dispatch_unknown", "aborted"].includes(opts.action)) {
    if (!["claim", "renew", "candidate", "review_start", "review_result", "review_status", "review_error", "finalize", "complete"].includes(opts.action)) return { status: 400, body: { error: "invalid_action" } };
    try {
      return await agentTransaction(opts.sql, async sql => {
        const result = await handleAgentJobs({ ...opts, sql, provider: "opencode" });
        if (opts.action === "claim" && result.status === 200 && result.body.governed !== true) throw new UnsafeOpenCodeClaim("governance_required");
        if (opts.action === "candidate" && result.status === 200) {
          const [binding] = await sql.query<{ state: string }>("select state from ai_runtime_bindings where run_id=$1", [opts.params.run_id]);
          if (binding?.state !== "candidate_saved") throw new UnsafeOpenCodeClaim("runtime_binding_missing");
        }
        return result;
      });
    } catch (error) {
      if (error instanceof UnsafeOpenCodeClaim) return { status: 409, body: { error: error.message } };
      throw error;
    }
  }
  const parsed = bindingSchema.safeParse({ ...opts.params, action: opts.action });
  if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
  const p = parsed.data;
  return agentTransaction(opts.sql, async sql => {
    const locked = await lockRun(sql, p.run_id, p.job_id);
    if (locked.run?.provider !== "opencode" || locked.job?.runtime_provider !== "opencode" || !locked.run.request_json?.governed ||
      !await ownsRun(sql, locked, p.claim_token, p.job_id)) return { status: 409, body: { error: "stale" } };
    const [old] = await sql.query<Record<string, any>>("select * from ai_runtime_bindings where run_id=$1 for update", [p.run_id]);
    if (p.action === "bind") {
      const keys = ["instance_id", "epoch", "session_id", "runtime_version", "config_digest"] as const;
      if (old) return keys.every(key => old[key] === p[key]) ? { status: 200, body: { ok: true, replay: true, dispatch_id: old.dispatch_id } }
        : { status: 409, body: { error: "runtime_binding_conflict" } };
      const expected = locked.run.request_json.expected_config_digest;
      if (expected && expected !== p.config_digest) return { status: 409, body: { error: "runtime_config_mismatch" } };
      const dispatchId = randomUUID();
      await sql.query(`insert into ai_runtime_bindings(run_id,provider,runtime_version,config_digest,instance_id,epoch,session_id,dispatch_id)
        values($1,'opencode',$2,$3,$4,$5,$6,$7)`, [p.run_id, p.runtime_version, p.config_digest, p.instance_id, p.epoch, p.session_id, dispatchId]);
      return { status: 200, body: { ok: true, dispatch_id: dispatchId } };
    }
    if (!old) return { status: 409, body: { error: "runtime_binding_missing" } };
    const next = p.action === "aborted" ? "aborted" : p.action;
    if (old.state === next) return { status: 200, body: { ok: true, replay: true } };
    const allowed = p.action === "dispatching" ? old.state === "prepared" : p.action === "submitted" ? old.state === "dispatching"
      : p.action === "dispatch_unknown" ? ["dispatching", "submitted"].includes(old.state) : p.action === "aborted";
    if (!allowed) return { status: 409, body: { error: "dispatch_state_conflict" } };
    await sql.query("update ai_runtime_bindings set state=$2,last_observed_at=clock_timestamp() where run_id=$1", [p.run_id, next]);
    if (p.action === "dispatch_unknown" || p.action === "aborted") await sql.query("update ai_runs set data_token_hash='' where id=$1", [p.run_id]);
    return { status: 200, body: { ok: true } };
  });
}
