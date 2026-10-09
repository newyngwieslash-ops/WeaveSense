import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";
import { claimAssistantJob } from "@/lib/server/assistant-jobs";

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
        if (action !== "assistant_claim") return Response.json({ error: "unknown_action" }, { status: 400 });
        const result = await claimAssistantJob(await getSql(), { leaseSeconds: 60 });
        if (!result) return new Response(null, { status: 204 });
        return Response.json({
          job_id: result.jobId,
          turn_id: result.turnId,
          claim_token: result.claimToken,
          question: result.question,
          mode: "research",
          governed: true,
          profile: "assistant",
        }, { status: 200 });
      },
    },
  },
});
