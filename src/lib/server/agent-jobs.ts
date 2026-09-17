import { completeRun } from "./agent-completion.ts";
import { agentTransaction, lockRun, ownsRun } from "./agent-transaction.ts";
import { completeJobSchema, checkpointActionSchema, renewJobSchema, claimJobSchema } from "../agent-contract.ts";
import { settleJobBudget } from "./agent-budget.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { beginRun, failRun, finishNoteAtomically, hashCanonical, receiptsForRun } from "./agent-runs.ts";
import { loadCheckpoint, saveCheckpoint } from "./agent-checkpoints.ts";
import { claimAiJob, finishAiJob } from "./agent-queue.ts";
import { hashRunToken } from "./agent-data.ts";
import { parseExecuteResponse } from "../agent-contract.ts";
import { evidenceMap, validateCitations } from "./agent-context.ts";
import { shortId } from "../utils.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

async function handleAgentJobsInner(opts: {
  sql: Queryable;
  authorized: boolean;
  action: string;
  params: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.authorized) return { status: 401, body: { error: "unauthorized" } };
  if (opts.action === "claim") {
    if (!claimJobSchema.safeParse(opts.params).success) return { status:400,body:{error:"invalid_request"} };
    const [expired] = await opts.sql.query<Record<string, any>>(`select * from ai_jobs
      where status='running' and lease_until<=clock_timestamp() and item_id like 'research:%'
      order by id for update skip locked limit 1`);
    if (expired) {
      const locked = await lockRun(opts.sql, expired.run_id, expired.id);
      const run = locked.run;
      const [cp] = await opts.sql.query<Record<string, any>>("select * from agent_checkpoints where run_id=$1 order by sequence desc limit 1 for update", [expired.run_id]);
      const [facts] = await opts.sql.query<{ n: number; uncertain: number }>("select count(*)::int as n,count(*) filter(where state in ('started','unknown'))::int as uncertain from ai_model_calls where run_id=$1",[expired.run_id]);
      const [clock] = await opts.sql.query<{ now: Date }>("select clock_timestamp() as now");
      if (run?.status === "running" && new Date(run.expires_at)>new Date(clock.now) && cp && cp.runtime_version === "eino-v0.9.19"
        && facts.uncertain === 0 && facts.n === Number(cp.model_call_count) && run.events_json.length === Number(cp.evidence_event_count)) {
        const token = randomUUID(), dataToken = randomBytes(32).toString("hex");
        await opts.sql.query("update ai_jobs set claim_token=$2,attempts=attempts+1,lease_until=least($3::timestamptz,clock_timestamp()+interval '60 seconds') where id=$1",[expired.id,token,run.expires_at]);
        await opts.sql.query("update ai_runs set claim_token=$2,data_token_hash=$3 where id=$1",[run.id,token,hashRunToken(dataToken)]);
        await opts.sql.query("update agent_checkpoints set claim_token=$2 where run_id=$1",[run.id,token]);
        return { status:200,body:{job_id:expired.id,run_id:run.id,claim_token:token,data_access_token:dataToken,mode:run.mode,
          question:run.request_json.question,input:{question:run.request_json.question,sources:run.request_json.sources??[],range:run.request_json.range??null},
          policy:run.request_json.policy,resume:true,sequence:cp.sequence} };
      }
      // No safe checkpoint or an external call may have happened since it. Never re-execute it.
      if (run?.status === 'running') await completeRun(opts.sql, {runId:run.id,jobId:expired.id,claimToken:run.claim_token,status:'outcome_unknown',errorCode:'recovery_unsafe',expiredLease:true});
      else {
        await opts.sql.query("update ai_jobs set status='outcome_unknown',error_code='recovery_unsafe',claim_token='',lease_until=null where id=$1",[expired.id]);
        await settleJobBudget(opts.sql, expired.id, run?.id);
      }
    }
    const job = await claimAiJob(opts.sql, { worker: "agent", leaseSeconds: 60, kind: "research" });
    if (!job) return { status: 404, body: { error: "empty" } };
    if (job.payload.provider !== "eino" || job.payload.mode !== "research") {
      await finishAiJob(opts.sql,{id:job.id,claimToken:job.claim_token,status:"failed",errorCode:"unsupported_saved_provider"});
      return {status:409,body:{error:"unsupported_saved_provider"}};
    }
    const runId = randomUUID();
    const dataAccessToken = randomBytes(32).toString("hex");
    const begun = await beginRun(opts.sql, {
      id: runId, requestId: String(job.payload.request_id ?? randomUUID()), mode: "research", provider: "eino",
      inputHash: hashCanonical({ mode: "research", question: String(job.payload.question ?? "") }), materialHash: job.material_hash, policyVersion: job.policy_version,
      requestJson: { ...job.payload, job_id: job.id, material_hash: job.material_hash }, claimToken: job.claim_token,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      dataTokenHash: hashRunToken(dataAccessToken),
    });
    if (begun.kind !== "won") {
      throw new ClaimConflict(begun.kind);
    }
    const actualRun = begun.run.id;
    const linked = await opts.sql.query<{ id: string }>(
      `update ai_jobs set run_id = $3 where id = $1 and status = 'running' and claim_token = $2 returning id`,
      [job.id, job.claim_token, actualRun],
    );
    if (!linked.length) throw new ClaimConflict("stale");
    return {
      status: 200,
      body: {
        job_id: job.id,
        run_id: actualRun,
        claim_token: job.claim_token,
        data_access_token: dataAccessToken,
        mode: job.item_id.startsWith("research:") ? "research" : "analyze_item",
        question: String(job.payload.question ?? ""),
        item_id: job.item_id.startsWith("research:") ? "" : job.item_id,
        input: { question: job.payload.question, sources: job.payload.sources ?? [], range: job.payload.range ?? null },
        policy: job.payload.policy,
      },
    };
  }
  if (opts.action === "save_checkpoint") {
    const validated = checkpointActionSchema.safeParse(opts.params);
    if (!validated.success || validated.data.payload === undefined || validated.data.sequence === undefined || validated.data.schema_version !== "1") return { status: 400, body: { error: "invalid_request" } };
    const result = await saveCheckpoint(opts.sql, {
      checkPointId: String(opts.params.check_point_id ?? ""),
      runId: String(opts.params.run_id ?? ""),
      claimToken: String(opts.params.claim_token ?? ""),
      sequence: Number(opts.params.sequence ?? 0) || 0,
      schemaVersion: String(opts.params.schema_version ?? "1"),
      runtimeVersion: String(opts.params.runtime_version ?? ""),
      payload: Buffer.from(String(opts.params.payload ?? ""), "base64"),
    });
    if (result === "stale") return { status: 409, body: { error: "stale" } };
    if (result === "too_large") return { status: 413, body: { error: "too_large" } };
    return { status: 200, body: { ok: true } };
  }
  if (opts.action === "get_checkpoint") {
    const validated = checkpointActionSchema.safeParse(opts.params);
    if (!validated.success) return { status: 400, body: { error: "invalid_request" } };
    const locked = await lockRun(opts.sql, validated.data.run_id);
    if (!await ownsRun(opts.sql, locked, validated.data.claim_token)) return { status: 409, body: { error: "stale" } };
    const loaded = await loadCheckpoint(opts.sql, {
      checkPointId: String(opts.params.check_point_id ?? ""),
      runId: String(opts.params.run_id ?? ""),
      runtimeVersion: String(opts.params.runtime_version ?? ""),
    });
    if (!loaded.ok) return { status: 409, body: { error: loaded.error, found: false } };
    return { status: 200, body: { found: true, payload: loaded.payload.toString("base64") } };
  }
  if (opts.action === "renew") {
    const p = renewJobSchema.safeParse(opts.params);
    if (!p.success) return { status: 400, body: { error: "invalid_request" } };
    const locked = await lockRun(opts.sql, p.data.run_id, p.data.job_id);
    if (!await ownsRun(opts.sql, locked, p.data.claim_token, p.data.job_id)) return { status: 409, body: { error: "stale" } };
    await opts.sql.query("update ai_jobs set lease_until=least($2::timestamptz,clock_timestamp()+interval '60 seconds') where id=$1", [p.data.job_id,locked.run.expires_at]);
    return { status: 200, body: { ok: true } };
  }
  if (opts.action === "complete") {
    const envelope = completeJobSchema.safeParse(opts.params);
    if (!envelope.success) return { status: 400, body: { error: "invalid_request" } };
    const p = envelope.data;
    if (p.response && p.response.run_id !== p.run_id) return { status: 400, body: { error: "run_mismatch" } };
    const parsed = p.status === "succeeded" ? parseExecuteResponse(JSON.stringify(p.response), "research") : null;
    if (p.status === "succeeded" && (!parsed?.ok || !parsed.value.ok)) return { status: 400, body: { error: "invalid_output" } };
    const response = parsed?.ok && parsed.value.ok ? parsed.value : null;
    const runtime = p.response?.runtime;
    const noteId = shortId();
    const result = await completeRun(opts.sql, {
      jobId: p.job_id, runId: p.run_id, claimToken: p.claim_token, status: p.status, errorCode: p.error_code,
      responseJson: response ?? p.response,
      model: runtime?.model, promptVersion: runtime?.prompt_version, skillVersions: runtime?.skill_versions,
      inputTokens: runtime?.input_tokens, outputTokens: runtime?.output_tokens,
      modelCalls: runtime?.model_calls, toolCalls: runtime?.tool_calls,
      validate: async (tx, run) => {
        if (p.status !== "succeeded" && p.response?.ok) return "terminal_response_mismatch";
        if (run.mode !== "research" || (p.mode && p.mode !== run.mode)) return "mode_mismatch";
        if (!response) return null;
        const receipts = await receiptsForRun(tx, p.run_id);
        const seeds = evidenceMap(run.request_json?.sources ?? []);
        return validateCitations(response.result.citations, new Map([...seeds, ...receipts])).ok ? null : "invalid_citation";
      },
      write: async tx => {
        const [run] = await tx.query<{ request_json: { question?: string; sources?: any[] } }>("select request_json from ai_runs where id=$1", [p.run_id]);
        const receipts = await receiptsForRun(tx, p.run_id);
        const content = response!.result.content!;
        const ids = [...new Set([...(run.request_json.sources ?? []).map(s => s.item_id), ...[...receipts.values()].flatMap(r => r.item_id ? [r.item_id] : [])])];
        await tx.query(`insert into knowledge_notes (id,title,content,kind,item_ids,run_id) values ($1,$2,$3,'answer',$4::jsonb,$5)`,
          [noteId,(run.request_json.question ?? "问答").slice(0,80),content,JSON.stringify(ids),p.run_id]);
        const verified = new Map([...evidenceMap(run.request_json.sources ?? []), ...receipts]);
        return { note_id: noteId, answer: content, verified_evidence: [...verified.values()] };
      },
    });
    return result.ok ? { status: 200, body: { ok: true, replay: result.replay, note_id: result.response.note_id } }
      : { status: ["invalid_citation","mode_mismatch","terminal_response_mismatch"].includes(result.error) ? 400 : 409, body: { error: result.error } };
  }
  return { status: 400, body: { error: "invalid_action" } };
}

export async function handleAgentJobs(opts: Parameters<typeof handleAgentJobsInner>[0]) {
  if (!opts.authorized) return { status: 401, body: { error: "unauthorized" } };
  try { return await agentTransaction(opts.sql, sql => handleAgentJobsInner({ ...opts, sql })); }
  catch (error) { if (error instanceof ClaimConflict) return { status: 409, body: { error: error.message } }; throw error; }
}
class ClaimConflict extends Error {}
