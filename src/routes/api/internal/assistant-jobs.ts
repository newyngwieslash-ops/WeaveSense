import { createFileRoute } from "@tanstack/react-router";
import { randomUUID, randomBytes } from "node:crypto";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";
import { handleOpenCodeJobs } from "@/lib/server/agent-opencode-jobs";
import { claimAssistantJob, assistantPolicyFromEnv, completeAssistantRun } from "@/lib/server/assistant-jobs";
import { beginRun } from "@/lib/server/agent-runs.ts";
import { hashRunToken } from "@/lib/server/agent-data.ts";

/** Mirrors the Go wrapper's pinned runtime version (client.go RuntimeVersion). */
const RUNTIME_VERSION = "1.3.13";

/**
 * Internal assistant-jobs endpoint (plan §5.3): the Go worker claims queued
 * assistant jobs here. Same trust boundary as agent-jobs — the shared data
 * token authenticates the worker; no browser can reach this route.
 *
 * claim: 204 when the queue is empty (the worker idles), 200 + claim JSON
 * when a job is handed out. Other actions (result/complete/aborted) are
 * posted by the worker through completeAssistantRun in later tasks; claim
 * is the only read-side action this deployment needs to bring the loop up.
 */
export const Route = createFileRoute("/api/internal/assistant-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!tokenOk(token, prod.agentDataToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const parsed = await readAgentJson(request, 1024 * 1024);
        if (!parsed.ok) return parsed.response;
        const payload = parsed.value;
        const action = String(payload.action ?? "");
        // Runtime lifecycle actions (bind/dispatching/submitted/…) reuse the
        // same state machine as research runs — assistant runs are also
        // provider='opencode' + governed, so handleOpenCodeJobs validates
        // them unchanged. renew extends the job lease while the runtime
        // boots; the Go assistant worker's heartbeat sends it with the same
        // envelope as research renews.
        if (action === "renew") {
          const runId = String(payload.run_id ?? "");
          const jobId = String(payload.job_id ?? "");
          const claimToken = String(payload.claim_token ?? "");
          const [run] = await (await getSql()).query<Record<string, unknown>>(
            "select r.expires_at from ai_runs r where r.id=$1 and r.status='running' and r.claim_token=$2",
            [runId, claimToken],
          );
          if (!run) return Response.json({ ok: false }, { status: 409 });
          const newLease = new Date(Math.min(Date.parse(String(run.expires_at)), Date.now() + 60_000)).toISOString();
          await (await getSql()).query(
            "update ai_jobs set lease_until=$2::timestamptz, updated_at=clock_timestamp() where id=$1 and status='running' and claim_token=$3",
            [jobId, newLease, claimToken],
          );
          return Response.json({ ok: true, cancel_requested: false });
        }
        if (["bind", "dispatching", "submitted", "dispatch_unknown", "aborted"].includes(action)) {
          const result = await handleOpenCodeJobs({ sql: await getSql(), authorized: true, action, params: payload });
          return Response.json(result.body, { status: result.status });
        }
        // assistant_result: the two-stage §4.4 finalizer. The worker posts
        // stage='result_saved' after validating the answer, then stage=
        // 'runtime_stopped' after the stop receipt; both idempotent.
        // Live progress (worker assistant.go): tool stages + reasoning tail
        // from the runtime's message list. Each accepted post appends one
        // assistant.progress conversation event; the worker rate-limits.
        if (action === "assistant_progress") {
          const runId = String(payload.run_id ?? "");
          const jobId = String(payload.job_id ?? "");
          const claimToken = String(payload.claim_token ?? "");
          const progress = payload.progress as { tools?: unknown; reason_tail?: unknown } | undefined;
          const tools = Array.isArray(progress?.tools) ? progress!.tools : [];
          const reasonTail = typeof progress?.reason_tail === "string" ? progress!.reason_tail : "";
          if (!tools.length && !reasonTail) return Response.json({ ok: true, skipped: "empty" });
          if (tools.length > 12 || reasonTail.length > 600) {
            return Response.json({ ok: false, error: "invalid_progress" }, { status: 400 });
          }
          const [turnRow] = await (await getSql()).query<Record<string, unknown>>(
            "select t.id, t.conversation_id from assistant_turns t join ai_jobs j on j.item_id = 'assistant:' || t.id::text where j.id=$1 and j.claim_token=$2 and j.status='running'",
            [jobId, claimToken],
          );
          if (!turnRow) return Response.json({ ok: false, error: "turn_not_active" }, { status: 409 });
          const { appendAssistantEvent } = await import("@/lib/server/assistant-events");
          await appendAssistantEvent(
            await getSql(),
            String(turnRow.conversation_id), String(turnRow.id),
            "assistant.progress",
            {
              tools: tools.map((t) => ({ call_id: String((t as Record<string, unknown>).call_id ?? ""), tool: String((t as Record<string, unknown>).tool ?? ""), state: String((t as Record<string, unknown>).state ?? "running") })),
              reason_tail: reasonTail,
            },
          );
          return Response.json({ ok: true });
        }
        if (action === "assistant_result") {
          // Worker posting shapes (assistant.go): success carries the
          // answer payload (schema_version/result/runtime); a fail path
          // carries {status:'failed', error_code, outcome_unknown}. The
          // two-stage §4.4 protocol maps: first post = result_saved; the
          // worker then posts the stop receipt via the same action with
          // stage field (Go worker posts stage='runtime_stopped').
          const runId = String(payload.run_id ?? "");
          const jobId = String(payload.job_id ?? "");
          const claimToken = String(payload.claim_token ?? "");
          // Stage-2 stop receipt (assistant.go posts stage='runtime_stopped'
          // after cleanup confirmed the process tree): route to the
          // runtime_stopped finalizer.
          if (payload.stage === "runtime_stopped") {
            const outcome = await completeAssistantRun(await getSql(), {
              runId, jobId, claimToken, stage: "runtime_stopped",
              payload: { epoch: String(payload.epoch ?? ""), instance: String(payload.instance ?? "worker"), ok: true },
            });
            return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
          }
          if (payload.result) {
            // The worker wraps the answer in jobEnvelope — strip envelope
            // fields so the strict assistantAnswerSchema sees only the
            // answer payload.
            const { action: _a, job_id: _j, run_id: _r, claim_token: _c, ...answerPayload } = payload;
            const outcome = await completeAssistantRun(await getSql(), {
              runId, jobId, claimToken, stage: "result_saved", payload: answerPayload,
            });
            if (!outcome.ok) {
              // Contract drift between the Go decoder and the zod schema is
              // invisible without the payload; log a shape summary once.
              const result = answerPayload.result as Record<string, unknown> | undefined;
              const shape = result && typeof result === "object"
                ? {
                    version: result.version,
                    answer_len: String(result.answer ?? "").length,
                    answer_head: String(result.answer ?? "").slice(0, 80),
                    citation_kinds: Array.isArray(result.citations)
                      ? (result.citations as Array<Record<string, unknown>>).map((c) => c.kind)
                      : String(result.citations),
                    actions_raw: JSON.stringify(result.actions)?.slice(0, 200),
                    clarification: result.clarification === undefined ? undefined : JSON.stringify(result.clarification)?.slice(0, 200),
                  }
                : answerPayload.result;
              console.log("[assistant-jobs] result_saved rejected:", outcome.error, JSON.stringify(shape));
            }
            return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
          }
          // Fail-path post: the worker's engine call failed (complete()
          // posts {status:'failed', error_code, outcome_unknown}) BEFORE
          // any result_saved. Per §4.4 the run has no answer to save, cost
          // stays unknown (never fabricated as zero), and the turn must
          // reach a terminal state so the conversation unblocks. Record the
          // failure directly on job + run + turn atomically.
          if (payload.status === "failed") {
            const sql = await getSql();
            const runId2 = runId, jobId2 = jobId;
            const errorCode = String(payload.error_code ?? "assistant_failed").slice(0, 64);
            await sql.query(
              `update ai_jobs set status='failed', error_code=$2, claim_token='', lease_until=null, updated_at=clock_timestamp() where id=$1 and status='running'`,
              [jobId2, errorCode],
            );
            await sql.query(
              `update ai_runs set status=case when $2::boolean then 'failed' else 'outcome_unknown' end, error_code=$3, finished_at=clock_timestamp() where id=$1 and status='running'`,
              [runId2, payload.outcome_unknown === true, errorCode],
            );
            const [turnRow] = await sql.query<Record<string, unknown>>(
              "select id, conversation_id from assistant_turns where job_id=$1",
              [jobId2],
            );
            if (turnRow) {
              await sql.query("update assistant_turns set status='failed', finished_at=clock_timestamp() where id=$1 and status in ('queued','running')", [turnRow.id]);
              const [seqRow] = await sql.query<{ n: number | null }>(
                "select coalesce(max(seq)+1,0)::int as n from assistant_events where conversation_id=$1",
                [turnRow.conversation_id],
              );
              await sql.query(
                `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
                 values($1,$2,$3,$4,'turn.finished',$5::jsonb)`,
                [randomUUID(), turnRow.conversation_id, turnRow.id, Number(seqRow?.n ?? 0),
                  JSON.stringify({ status: "failed", error_code: errorCode })],
              );
            }
            console.log("[assistant-jobs] engine failure recorded:", errorCode);
            return Response.json({ ok: true, recorded: "failed" }, { status: 200 });
          }
          // Stop-receipt post (after a successful result_saved).
          const outcome = await completeAssistantRun(await getSql(), {
            runId, jobId, claimToken, stage: "runtime_stopped",
            payload: { epoch: String(payload.epoch ?? ""), instance: "worker", ok: true },
          });
          return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
        }
        if (action !== "assistant_claim") return Response.json({ error: "unknown_action" }, { status: 400 });
        const result = await claimAssistantJob(await getSql(), { leaseSeconds: 60 });
        if (!result) return new Response(null, { status: 204 });
        // Full claim envelope matching the Go RunAssistantWorkerOnce parser,
        // mirroring the research claim: create the run first (beginRun),
        // link job→run, hand out a data access token, and return the exact
        // field set the Claim struct strict-decodes.
        const policy = assistantPolicyFromEnv(process.env);
        const now = Date.now();
        const deadline = new Date(now + policy.executionTimeoutMs).toISOString();
        const producerDeadline = new Date(now + policy.executionTimeoutMs - 5000).toISOString();
        const runId = randomUUID();
        const dataAccessToken = randomBytes(32).toString("hex");
        const model = process.env.AGENT_MODEL_NAME ?? "";
        const skillDigest = process.env.AGENT_SKILL_SNAPSHOT_DIGEST ?? "";
        const modelProfile = { model, input_per_million: Number(process.env.AGENT_PRICE_INPUT_RMB_PER_MILLION ?? 2), output_per_million: Number(process.env.AGENT_PRICE_OUTPUT_RMB_PER_MILLION ?? 4) };
        const policyJson = {
          version: policy.version, deadline_at: deadline,
          max_model_calls: policy.maxModelCalls, max_tool_calls: policy.maxToolCalls,
          max_output_tokens_per_call: policy.maxOutputTokensPerCall,
        };
        const begun = await beginRun(await getSql(), {
          id: runId, requestId: randomUUID(), mode: "research", provider: "opencode",
          inputHash: "assistant:" + result.turnId, materialHash: "assistant",
          policyVersion: policy.version,
          // model_profile + policy are what the budget admission checks on
          // every producer model call (agent-budget.ts line 47): without
          // model_profile the bridge's receipt is denied with
          // model_admission_unavailable and the model turn never runs.
          requestJson: {
            provider: "opencode", mode: "research", profile: "assistant", governed: true,
            question: result.question, job_id: result.jobId,
            model_profile: modelProfile, policy: policyJson,
            // role_limits: the admission gate denies producer calls when
            // role_limits.producer is not an integer.
            role_limits: { producer: policy.maxModelCalls, reviewer: 0 },
            producer_deadline_at: producerDeadline,
            skill_snapshot_digest: skillDigest,
          },
          claimToken: result.claimToken,
          expiresAt: deadline,
          dataTokenHash: hashRunToken(dataAccessToken),
        });
        if (begun.kind !== "won") return Response.json({ error: "claim_conflict", detail: begun.kind }, { status: 409 });
        const sql = await getSql();
        await sql.query("update ai_jobs set run_id=$2 where id=$1", [result.jobId, runId]);
        // Budget reservation (mirrors enqueueResearchJob): the admission
        // gate denies producer calls without a reserved row whose pricing
        // matches the model. Worst cost uses the byte-based caps the
        // research policy freezes.
        {
          const [clock] = await sql.query<{ day: string }>("select to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day");
          const priceVersion = process.env.AGENT_RESEARCH_PRICE_VERSION ?? "research-price-v1";
          const dailyLimit = prod.assistantDailyLimit || 20;
          const dailyBudgetRmb = prod.assistantDailyBudgetRmb || 20;
          const worstCostRmb = policy.maxModelCalls * (512 * 1024 * modelProfile.input_per_million + 1800 * modelProfile.output_per_million) / 1_000_000;
          const { admitBudgetDay } = await import("@/lib/server/agent-budget.ts");
          if (!await admitBudgetDay(sql, clock.day, priceVersion, worstCostRmb, dailyLimit, dailyBudgetRmb)) {
            await sql.query("update ai_jobs set status='failed', error_code='budget_exceeded', claim_token='' where id=$1", [result.jobId]);
            return Response.json({ error: "budget_exceeded" }, { status: 429 });
          }
          await sql.query(
            `insert into ai_budget_reservations(id, job_id, day, price_version, reserved_rmb, status, pricing)
             values($1,$2,$3,$4,$5,'reserved',$6::jsonb)`,
            [randomUUID(), result.jobId, clock.day, priceVersion, worstCostRmb,
              JSON.stringify({ ...modelProfile, daily_limit: dailyLimit, daily_budget_rmb: dailyBudgetRmb, price_version: priceVersion })],
          );
        }
        return Response.json({
          job_id: result.jobId,
          run_id: runId,
          claim_token: result.claimToken,
          data_access_token: dataAccessToken,
          question: result.question,
          item_id: `assistant:${result.turnId}`,
          mode: "research",
          governed: true,
          profile: "assistant",
          phase: "producer",
          runtime_version: RUNTIME_VERSION,
          skill_snapshot_digest: skillDigest,
          producer_deadline_at: producerDeadline,
          producer_model_calls: policy.maxModelCalls,
          model_profile: { model, input_per_million: 2, output_per_million: 4 },
          policy: {
            version: policy.version,
            deadline_at: deadline,
            max_model_calls: policy.maxModelCalls,
            max_tool_calls: policy.maxToolCalls,
            max_output_tokens_per_call: policy.maxOutputTokensPerCall,
          },
        }, { status: 200 });
      },
    },
  },
});
