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
          if (payload.result) {
            // The worker wraps the answer in jobEnvelope — strip envelope
            // fields so the strict assistantAnswerSchema sees only the
            // answer payload.
            const { action: _a, job_id: _j, run_id: _r, claim_token: _c, ...answerPayload } = payload;
            const outcome = await completeAssistantRun(await getSql(), {
              runId, jobId, claimToken, stage: "result_saved", payload: answerPayload,
            });
            if (!outcome.ok) console.log("[assistant-jobs] result_saved rejected:", outcome.error);
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
        const begun = await beginRun(await getSql(), {
          id: runId, requestId: randomUUID(), mode: "research", provider: "opencode",
          inputHash: "assistant:" + result.turnId, materialHash: "assistant",
          policyVersion: policy.version,
          requestJson: { provider: "opencode", mode: "research", profile: "assistant", governed: true, question: result.question, job_id: result.jobId },
          claimToken: result.claimToken,
          expiresAt: deadline,
          dataTokenHash: hashRunToken(dataAccessToken),
        });
        if (begun.kind !== "won") return Response.json({ error: "claim_conflict", detail: begun.kind }, { status: 409 });
        const sql = await getSql();
        await sql.query("update ai_jobs set run_id=$2 where id=$1", [result.jobId, runId]);
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
