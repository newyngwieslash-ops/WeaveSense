import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { assistantCapabilities } from "@/lib/server/assistant-capabilities";
import { prod } from "@/lib/server/config";
import { submitAssistantMessage } from "@/lib/server/assistant-events";
import { assistantMessageInput, parseAssistantMessageInput } from "@/lib/assistant-contract";

/**
 * POST /api/assistant/conversations/$conversationId/messages (plan §5.3/A04):
 * strict contract validation, idempotent enqueue (same request replays,
 * different content → 409), returns 202 with the turn identity. Never calls
 * a model inline.
 */
export const Route = createFileRoute("/api/assistant/conversations/$conversationId/messages")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const headers = { "Cache-Control": "no-store" };
        const access = assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env);
        if (!access.allowed) return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        if (request.headers.get("origin") !== new URL(request.url).origin) {
          return Response.json({ error: "same_origin_required" }, { status: 403, headers });
        }
        const conversationId = String(params.conversationId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
          return Response.json({ error: "invalid_conversation" }, { status: 400, headers });
        }
        const raw = await request.text();
        if (raw.length > 32 * 1024) return Response.json({ error: "too_large" }, { status: 413, headers });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
        const parsed = parseAssistantMessageInput(body);
        if (!parsed.ok) return Response.json({ error: "invalid_request", detail: parsed.error }, { status: 400, headers });
        // Honest fast-fail (A01): without a configured engine/worker the turn
        // would sit queued forever and block the conversation's active-turn
        // slot, so refuse submission up front instead. Capabilities alone
        // aren't enough — a submitted turn needs a worker that will actually
        // claim it, so require the worker switch + token as well.
        const caps = await assistantCapabilities();
        const workerReady = prod.opencodeWorkerEnabled && Boolean(prod.opencodeWorkerToken || prod.assistantWorkerToken);
        if (!caps.enabled || !workerReady) {
          return Response.json({
            error: "assistant_unavailable",
            reason: caps.enabled ? "assistant_worker_not_running" : caps.reason,
          }, { status: 503, headers });
        }
        const sql = await getSql();
        const submission = await submitAssistantMessage(sql, conversationId, parsed.value);
        if (submission.kind === "conflict") {
          return Response.json({
            error: "conflict",
            reason: submission.reason,
            error_code: submission.reason === "request_conflict" ? "request_conflict" : "revision_or_active_conflict",
          }, { status: 409, headers });
        }
        // Enqueue the model job for this turn (§4.1/§4.2): the turn row is
        // the product record; the assistant ai_jobs row is what the Go
        // worker claims. item_id follows the assistant:<turn_id> contract
        // the 0027 trigger enforces.
        const jobId = crypto.randomUUID();
        await sql.query(
          `insert into ai_jobs(id, item_id, material_hash, policy_version, status, runtime_provider, job_kind, payload)
           values($1,$2,'assistant',$3,'queued','opencode','assistant',$4::jsonb)`,
          [jobId, `assistant:${submission.turn.id}`, "loom-assistant-v1",
            JSON.stringify({ provider: "opencode", question: parsed.value.text, turn_id: submission.turn.id })],
        );
        await sql.query("update assistant_turns set job_id=$2 where id=$1", [submission.turn.id, jobId]);
        return Response.json({
          turn_id: submission.turn.id,
          job_id: jobId,
          status: submission.turn.status,
          revision: submission.revision,
          replay: submission.kind === "replay",
        }, { status: 202, headers });
      },
    },
  },
});
void assistantMessageInput;
