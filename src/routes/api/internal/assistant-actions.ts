import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";
import { prod } from "@/lib/server/config";
import { prepareAssistantCollection, observeAssistantCollection } from "@/lib/server/assistant-action-dispatch";

/**
 * Internal assistant-actions endpoint (plan §5.3): the trusted dispatcher
 * (worker/reconcile loop) prepares and observes collection actions. The
 * browser can never reach this route — service token only, run-fenced
 * params, and strict byte caps on the body.
 */
export const Route = createFileRoute("/api/internal/assistant-actions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!tokenOk(token, prod.agentDataToken)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const parsed = await readAgentJson(request, 64 * 1024);
        if (!parsed.ok) return parsed.response;
        const payload = parsed.value;
        const action = String(payload.action ?? "");
        const sql = await getSql();
        try {
          if (action === "prepare") {
            const result = await prepareAssistantCollection(sql, {
              actionId: String(payload.action_id ?? ""),
              turnId: String(payload.turn_id ?? ""),
              conversationId: String(payload.conversation_id ?? ""),
              kind: payload.kind === "source.collect_once" ? "source.collect_once" : "keyword.collect_once",
              targetId: String(payload.target_id ?? ""),
            });
            return Response.json(result, { status: 200 });
          }
          if (action === "observe") {
            const receipt = await observeAssistantCollection(sql, {
              actionId: String(payload.action_id ?? ""),
              conversationId: String(payload.conversation_id ?? ""),
              turnId: String(payload.turn_id ?? ""),
              jobId: String(payload.job_id ?? ""),
            });
            return Response.json(receipt, { status: 200 });
          }
          return Response.json({ error: "unknown_action" }, { status: 400 });
        } catch (error) {
          const code = error instanceof Error && error.message === "action_not_found" ? "action_not_found" : "dispatch_failed";
          return Response.json({ error: code }, { status: code === "action_not_found" ? 404 : 500 });
        }
      },
    },
  },
});
