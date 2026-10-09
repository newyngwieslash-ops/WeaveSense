import { completeRun } from "./agent-completion.ts";
import { agentTransaction, lockRun, ownsRun } from "./agent-transaction.ts";
import { completeJobSchema, checkpointActionSchema, renewJobSchema, claimJobSchema } from "../agent-contract.ts";
import { settleJobBudget } from "./agent-budget.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { beginRun, hashCanonical, receiptsForRun } from "./agent-runs.ts";
import { loadCheckpoint, saveCheckpoint } from "./agent-checkpoints.ts";
import { claimAiJob, finishAiJob, expireQueuedResearchJobs } from "./agent-queue.ts";
import { hashRunToken } from "./agent-data.ts";
import { parseExecuteResponse } from "../agent-contract.ts";
import { evidenceMap, runtimeSources, validateCitations } from "./agent-context.ts";
import { z } from "zod";
import { getResearchCandidate, saveResearchCandidate, startResearchReview, saveResearchReview } from "./agent-candidates.ts";
import { researchPublicationError } from "./agent-research-publication.ts";
import { researchIntentHash } from "./agent-research-policy.ts";
import { shortId } from "../utils.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

const stageIds = z.object({ job_id: z.uuid(), run_id: z.uuid(), claim_token: z.uuid() });
const stageEnvelope = z.discriminatedUnion("action", [
  stageIds.extend({ action: z.literal("candidate"), response: z.unknown() }).strict(),
  stageIds.extend({ action: z.literal("review_start") }).strict(),
  stageIds.extend({ action: z.literal("review_result"), report: z.unknown() }).strict(),
  stageIds.extend({ action: z.literal("review_status") }).strict(),
  stageIds.extend({ action: z.literal("review_error"), error_code: z.string().min(1).max(128), outcome_unknown: z.boolean() }).strict(),
  stageIds.extend({ action: z.literal("finalize") }).strict(),
]);

async function handleResearchStage(opts: Parameters<typeof handleAgentJobsInner>[0]): Promise<{ status: number; body: Record<string, unknown> }> {
  const provider = opts.provider ?? "eino";
  const checked = stageEnvelope.safeParse({ ...opts.params, action: opts.action });
  if (!checked.success) return { status: 400, body: { error: "invalid_request" } };
  const p = checked.data;
  const locked = await lockRun(opts.sql, p.run_id, p.job_id);
  const { run, job } = locked;
  if (!run?.request_json?.governed || run.provider !== provider || job?.runtime_provider !== provider ||
    run.mode !== "research" || job.run_id !== run.id || run.claim_token !== p.claim_token) return { status: 409, body: { error: "stale" } };
  // Final ACK can be lost after both rows commit. Replay its stored decision, never re-run models.
  if (run.status !== "running" && p.action === "finalize" && run.response_json?._completion) {
    const jobStatus = ["cancelled", "timed_out"].includes(run.status) ? "outcome_unknown" : run.status;
    if (job.status !== jobStatus) return { status: 409, body: { error: "completion_conflict" } };
    return { status: 200, body: { ok: true, replay: true, status: run.status, error_code: run.error_code, note_id: run.response_json.note_id } };
  }
  if (!await ownsRun(opts.sql, locked, p.claim_token, p.job_id)) return { status: 409, body: { error: "stale" } };
  const fail = (error: string) => ({ status: error === "candidate_too_large" ? 413 : 409, body: { error } });
  if (p.action === "candidate") {
    const parsed = parseExecuteResponse(JSON.stringify(p.response), "research");
    if (!parsed.ok || !parsed.value.ok || parsed.value.run_id !== p.run_id) return { status: 400, body: { error: "invalid_candidate" } };
    const saved = await saveResearchCandidate(opts.sql, { runId: run.id, claimToken: p.claim_token, result: parsed.value.result });
    if (!saved.ok) return fail(saved.error);
    if (!saved.replay) await opts.sql.query("update ai_runs set request_json=jsonb_set(request_json,'{candidate_runtime}',$2::jsonb),data_token_hash='' where id=$1", [run.id, JSON.stringify(parsed.value.runtime)]);
    if (provider === "opencode") await opts.sql.query("update ai_runtime_bindings set state='candidate_saved',last_observed_at=clock_timestamp() where run_id=$1 and state in ('submitted','dispatch_unknown')", [run.id]);
    return { status: 200, body: { ok: true, replay: saved.replay, candidate_digest: saved.candidate.candidate_digest } };
  }
  const candidate = await getResearchCandidate(opts.sql, run.id);
  if (!candidate) return fail("candidate_missing");
  const [review] = await opts.sql.query<Record<string, any>>("select * from ai_research_reviews where run_id=$1 for update", [run.id]);
  if (!review) return fail("review_missing");
  if (p.action === "review_start") {
    if (candidate.frozen_policy.mode === "off" || ["completed", "unknown", "failed"].includes(review.state)) return { status: 200, body: { ok: true, skip: true } };
    const started = await startResearchReview(opts.sql, { runId: run.id, claimToken: p.claim_token });
    if (!started.ok && ["review_deadline_exceeded", "review_unconfigured", "review_input_too_large"].includes(started.error)) {
      await opts.sql.query("update ai_research_reviews set state='failed',error_code=$2,grant_hash=null,finished_at=clock_timestamp() where run_id=$1", [run.id, started.error]);
      return { status: 200, body: { ok: true, skip: true } };
    }
    return started.ok ? { status: 200, body: { ok: true, request: started.request } } : fail(started.error);
  }
  if (p.action === "review_result") {
    const saved = await saveResearchReview(opts.sql, { runId: run.id, claimToken: p.claim_token, report: p.report });
    return saved.ok ? { status: 200, body: { ok: true, replay: saved.replay } } : fail(saved.error);
  }
  if (p.action === "review_status") return { status: 200, body: { ok: true, state: review.state, error_code: review.error_code } };
  if (p.action === "review_error") {
    if (review.state === "completed") return job.payload.cancel_requested
      ? { status: 200, body: { ok: true, replay: true } } : fail("review_conflict");
    // An adapter's unknown receipt can have committed before its detailed error ACK.
    // A repeated error never upgrades that stored uncertainty to a known failure.
    if (review.state === "unknown" && p.outcome_unknown) return { status: 200, body: { ok: true, replay: true } };
    if (["failed", "unknown"].includes(review.state)) return review.error_code === p.error_code
      ? { status: 200, body: { ok: true, replay: true } } : fail("review_conflict");
    const [call] = await opts.sql.query<{ state: string }>("select state from ai_model_calls where run_id=$1 and call_id=$2", [run.id, review.review_call_id]);
    const unknown = p.outcome_unknown || call?.state === "started" || call?.state === "unknown";
    if (call?.state === "started") await opts.sql.query("update ai_model_calls set state='unknown',finished_at=clock_timestamp() where run_id=$1 and call_id=$2", [run.id, review.review_call_id]);
    await opts.sql.query("update ai_research_reviews set state=$2,error_code=$3,grant_hash=null,finished_at=clock_timestamp() where run_id=$1", [run.id, unknown ? "unknown" : "failed", p.error_code]);
    return { status: 200, body: { ok: true } };
  }
  // The host derives publication from persisted evidence and review. No caller-supplied status.
  const producerRuntime = run.request_json.candidate_runtime ?? {};
  const calls = await opts.sql.query<Record<string, any>>("select * from ai_model_calls where run_id=$1", [run.id]);
  const [toolFacts] = provider === "opencode" ? await opts.sql.query<{ n: number }>("select count(*)::int as n from ai_tool_calls where run_id=$1", [run.id]) : [];
  const allUsageKnown = calls.length > 0 && calls.every(c => c.state === "completed" && c.input_tokens != null && c.output_tokens != null);
  const runtime = { ...producerRuntime, model: run.request_json.model_profile.model,
    prompt_version: producerRuntime.prompt_version ?? run.policy_version, skill_versions: producerRuntime.skill_versions ?? {},
    input_tokens: allUsageKnown ? calls.reduce((n, c) => n + Number(c.input_tokens), 0) : null,
    output_tokens: allUsageKnown ? calls.reduce((n, c) => n + Number(c.output_tokens), 0) : null,
    model_calls: calls.length, tool_calls: toolFacts?.n ?? producerRuntime.tool_calls ?? 0, events: [] };
  const response = { schema_version: 1, run_id: run.id, ok: true, result: candidate.result_json, runtime, evidence: [] };
  let status: "succeeded" | "failed" | "outcome_unknown" = "succeeded", errorCode = "";
  if (job.payload.cancel_requested) { status = "outcome_unknown"; errorCode = "cancelled"; }
  else {
    if (candidate.frozen_policy.mode === "enforce" && ["pending", "running"].includes(review.state)) return fail("review_required");
    errorCode = await researchPublicationError(opts.sql, run, response) ?? "";
    if (errorCode === "review_required" && review.state === "failed") errorCode = review.error_code || "review_failed";
    if (errorCode) { status = review.state === "unknown" ? "outcome_unknown" : "failed"; }
  }
  const noteId = shortId();
  const result = await completeRun(opts.sql, { jobId: job.id, runId: run.id, claimToken: p.claim_token, status, errorCode,
    responseJson: response, model: runtime.model, promptVersion: runtime.prompt_version, skillVersions: runtime.skill_versions,
    inputTokens: runtime.input_tokens, outputTokens: runtime.output_tokens, modelCalls: runtime.model_calls, toolCalls: runtime.tool_calls,
    write: async tx => {
      const itemIds = [...new Set(candidate.evidence_json.flatMap(e => e.item_id ? [e.item_id] : []))];
      await tx.query("insert into knowledge_notes(id,title,content,kind,item_ids,run_id) values($1,$2,$3,'answer',$4::jsonb,$5)",
        [noteId, String(run.request_json.question).slice(0, 80), candidate.result_json.content, JSON.stringify(itemIds), run.id]);
      return { note_id: noteId, answer: candidate.result_json.content, verified_evidence: candidate.evidence_json };
    } });
  return result.ok ? { status: 200, body: { ok: true, replay: result.replay, status, error_code: errorCode, note_id: result.response.note_id } } : fail(result.error);
}

async function handleAgentJobsInner(opts: {
  sql: Queryable;
  authorized: boolean;
  action: string;
  params: Record<string, unknown>;
  provider?: "eino" | "opencode";
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.authorized) return { status: 401, body: { error: "unauthorized" } };
  if (["candidate", "review_start", "review_result", "review_status", "review_error", "finalize"].includes(opts.action)) {
    return handleResearchStage(opts);
  }
  if (opts.action === "claim") {
    const provider = opts.provider ?? "eino";
    if (!claimJobSchema.safeParse(opts.params).success) return { status:400,body:{error:"invalid_request"} };
    await expireQueuedResearchJobs(opts.sql, provider);
    const [expired] = await opts.sql.query<Record<string, any>>(`select * from ai_jobs
      where runtime_provider=$1 and exists(select 1 from ai_runs r where r.id=ai_jobs.run_id and r.provider=$1)
        and status='running' and lease_until<=clock_timestamp() and job_kind='research'
      order by id for update skip locked limit 1`, [provider]);
    if (expired) {
      const locked = await lockRun(opts.sql, expired.run_id, expired.id);
      const run = locked.run;
      const candidate = run?.request_json?.governed ? await getResearchCandidate(opts.sql, run.id) : null;
      const [clock] = await opts.sql.query<{ now: Date }>("select clock_timestamp() as now");
      if (candidate && run?.provider === provider && run.status === "running" && new Date(run.expires_at) > new Date(clock.now)) {
        const [review] = await opts.sql.query<Record<string, any>>("select * from ai_research_reviews where run_id=$1 for update", [run.id]);
        if (review?.state === "running") {
          await opts.sql.query("update ai_research_reviews set state='unknown',grant_hash=null,error_code='review_outcome_unknown' where run_id=$1", [run.id]);
        }
        const token = randomUUID(), dataToken = randomBytes(32).toString("hex");
        await opts.sql.query("update ai_jobs set claim_token=$2,attempts=attempts+1,lease_until=least($3::timestamptz,clock_timestamp()+interval '60 seconds') where id=$1", [expired.id, token, run.expires_at]);
        await opts.sql.query("update ai_runs set claim_token=$2,data_token_hash='' where id=$1", [run.id, token]);
        return { status: 200, body: { job_id: expired.id, run_id: run.id, claim_token: token, data_access_token: dataToken,
          mode: "research", question: run.request_json.question, input: { question: run.request_json.question, sources: runtimeSources(run.request_json.sources ?? []), range: run.request_json.range ?? null },
          policy: run.request_json.policy, governed: true, producer_model_calls: run.request_json.role_limits.producer,
          producer_deadline_at: run.request_json.producer_deadline_at, skill_snapshot_digest: run.request_json.skill_snapshot_digest,
          model_profile: run.request_json.model_profile, runtime_version: provider === "opencode" ? "1.3.13" : undefined,
          phase: review && ["completed", "unknown", "failed"].includes(review.state) ? "finalize" : "review" } };
      }
      const [cp] = await opts.sql.query<Record<string, any>>("select * from agent_checkpoints where run_id=$1 order by sequence desc limit 1 for update", [expired.run_id]);
      const roleFilter = run?.request_json?.governed ? " and role='producer'" : "";
      const [facts] = await opts.sql.query<{ n: number; uncertain: number }>(`select count(*)::int as n,count(*) filter(where state in ('started','unknown'))::int as uncertain from ai_model_calls where run_id=$1${roleFilter}`,[expired.run_id]);
      if (provider === "opencode" && run?.status === "running" && new Date(run.expires_at) > new Date(clock.now)) {
        const [binding] = await opts.sql.query<Record<string, any>>("select * from ai_runtime_bindings where run_id=$1 for update", [run.id]);
        if (binding?.runtime_version === "1.3.13" && ["prepared", "dispatching", "submitted", "dispatch_unknown"].includes(binding.state)) {
          const token = randomUUID(), dataToken = randomBytes(32).toString("hex");
          await opts.sql.query("update ai_jobs set claim_token=$2,attempts=attempts+1,lease_until=least($3::timestamptz,clock_timestamp()+interval '60 seconds') where id=$1", [expired.id, token, run.expires_at]);
          await opts.sql.query("update ai_runs set claim_token=$2,data_token_hash='' where id=$1", [run.id, token]);
          if (binding.state === "dispatching") { binding.state = "dispatch_unknown"; await opts.sql.query("update ai_runtime_bindings set state='dispatch_unknown' where run_id=$1", [run.id]); }
          return { status: 200, body: { job_id: expired.id, run_id: run.id, claim_token: token, data_access_token: dataToken,
            mode: "research", question: run.request_json.question, input: { question: run.request_json.question, sources: runtimeSources(run.request_json.sources ?? []), range: run.request_json.range ?? null },
            policy: run.request_json.policy, governed: true, producer_model_calls: run.request_json.role_limits.producer,
            producer_deadline_at: run.request_json.producer_deadline_at, skill_snapshot_digest: run.request_json.skill_snapshot_digest,
            model_profile: run.request_json.model_profile, runtime_version: "1.3.13", runtime_binding: binding, phase: "reconcile" } };
        }
      }
      if (provider === "eino" && run?.status === "running" && new Date(run.expires_at)>new Date(clock.now) && cp && cp.runtime_version === "eino-v0.9.19"
        && facts.uncertain === 0 && facts.n === Number(cp.model_call_count) && run.events_json.length === Number(cp.evidence_event_count)) {
        const token = randomUUID(), dataToken = randomBytes(32).toString("hex");
        await opts.sql.query("update ai_jobs set claim_token=$2,attempts=attempts+1,lease_until=least($3::timestamptz,clock_timestamp()+interval '60 seconds') where id=$1",[expired.id,token,run.expires_at]);
        await opts.sql.query("update ai_runs set claim_token=$2,data_token_hash=$3 where id=$1",[run.id,token,hashRunToken(dataToken)]);
        await opts.sql.query("update agent_checkpoints set claim_token=$2 where run_id=$1",[run.id,token]);
        return { status:200,body:{job_id:expired.id,run_id:run.id,claim_token:token,data_access_token:dataToken,mode:run.mode,
          question:run.request_json.question,input:{question:run.request_json.question,sources:runtimeSources(run.request_json.sources??[]),range:run.request_json.range??null},
          policy:run.request_json.policy,resume:true,sequence:cp.sequence,
          ...(run.request_json.governed ? { governed: true, producer_model_calls: run.request_json.role_limits?.producer,
            producer_deadline_at: run.request_json.producer_deadline_at, skill_snapshot_digest: run.request_json.skill_snapshot_digest, phase: "producer" } : {}) } };
      }
      // No safe checkpoint or an external call may have happened since it. Never re-execute it.
      if (run?.status === 'running') await completeRun(opts.sql, {runId:run.id,jobId:expired.id,claimToken:run.claim_token,status:'outcome_unknown',errorCode:'recovery_unsafe',expiredLease:true});
      else {
        await opts.sql.query("update ai_jobs set status='outcome_unknown',error_code='recovery_unsafe',claim_token='',lease_until=null where id=$1",[expired.id]);
        await settleJobBudget(opts.sql, expired.id, run?.id);
      }
    }
    const job = await claimAiJob(opts.sql, { worker: "agent", leaseSeconds: 60, kind: "research", provider });
    if (!job) return { status: 404, body: { error: "empty" } };
    if (job.payload.provider !== provider || job.payload.mode !== "research") {
      await finishAiJob(opts.sql,{id:job.id,claimToken:job.claim_token,status:"failed",errorCode:"unsupported_saved_provider"});
      return {status:409,body:{error:"unsupported_saved_provider"}};
    }
    const [clock] = await opts.sql.query<{ now: Date }>("select clock_timestamp() as now");
    const executionTimeout = Number(job.payload.execution_timeout_ms);
    const policy = { ...(job.payload.policy as Record<string, unknown>) };
    if (job.payload.execution_timeout_ms !== undefined) {
      if (!Number.isSafeInteger(executionTimeout) || executionTimeout < 1000 || executionTimeout > 900_000) throw new ClaimConflict("invalid_research_timeout");
      policy.deadline_at = new Date(new Date(clock.now).getTime() + executionTimeout).toISOString();
    }
    const expiresAt = String(policy.deadline_at ?? "");
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= new Date(clock.now).getTime()) {
      await finishAiJob(opts.sql, { id: job.id, claimToken: job.claim_token, status: "failed", errorCode: "queue_expired" });
      return { status: 404, body: { error: "empty" } };
    }
    job.payload = { ...job.payload, policy };
    if (job.payload.governed) {
      const reserve = (job.payload.review_policy as { mode: string })?.mode !== "off";
      const start = new Date(clock.now).getTime(), total = Date.parse(expiresAt) - start;
      const persistMs = Math.min(10_000, Math.floor(total / 12));
      const reviewMs = reserve ? Math.min(30_000, Math.floor(total / 4)) : 0;
      job.payload.producer_deadline_at = new Date(start + total - persistMs - reviewMs).toISOString();
      job.payload.review_deadline_at = new Date(start + total - persistMs).toISOString();
    }
    await opts.sql.query("update ai_jobs set payload=$2::jsonb,lease_until=least($3::timestamptz,lease_until) where id=$1", [job.id, JSON.stringify(job.payload), expiresAt]);
    const runId = randomUUID();
    const dataAccessToken = randomBytes(32).toString("hex");
    const begun = await beginRun(opts.sql, {
      id: runId, requestId: String(job.payload.request_id ?? randomUUID()), mode: "research", provider,
      inputHash: researchIntentHash(job.payload, String(job.payload.question ?? "")), materialHash: job.material_hash, policyVersion: job.policy_version,
      requestJson: { ...job.payload, job_id: job.id, material_hash: job.material_hash }, claimToken: job.claim_token,
      expiresAt,
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
        input: { question: job.payload.question, sources: runtimeSources((job.payload.sources ?? []) as Parameters<typeof runtimeSources>[0]), range: job.payload.range ?? null },
        policy: job.payload.policy,
        ...(job.payload.governed ? { governed: true, producer_model_calls: (job.payload.role_limits as { producer?: number })?.producer,
          producer_deadline_at: job.payload.producer_deadline_at, skill_snapshot_digest: job.payload.skill_snapshot_digest,
          model_profile: job.payload.model_profile, ...(provider === "opencode" ? { runtime_version: "1.3.13" } : {}), phase: "producer" } : {}),
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
    if (locked.run?.provider !== (opts.provider ?? "eino") || locked.job?.runtime_provider !== (opts.provider ?? "eino")) return { status: 409, body: { error: "stale" } };
    if (!await ownsRun(opts.sql, locked, p.data.claim_token, p.data.job_id)) return { status: 409, body: { error: "stale" } };
    await opts.sql.query("update ai_jobs set lease_until=least($2::timestamptz,clock_timestamp()+interval '60 seconds') where id=$1", [p.data.job_id,locked.run.expires_at]);
    return { status: 200, body: { ok: true, cancel_requested: locked.job?.payload?.cancel_requested === true } };
  }
  if (opts.action === "complete") {
    const envelope = completeJobSchema.safeParse(opts.params);
    if (!envelope.success) return { status: 400, body: { error: "invalid_request" } };
    const p = envelope.data;
    const locked = await lockRun(opts.sql, p.run_id, p.job_id);
    if (locked.run?.provider !== (opts.provider ?? "eino") || locked.job?.runtime_provider !== (opts.provider ?? "eino")) return { status: 409, body: { error: "stale" } };
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
