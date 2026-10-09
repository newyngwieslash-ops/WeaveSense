import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
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
        const sql = await getSql();
        const submission = await submitAssistantMessage(sql, conversationId, parsed.value);
        if (submission.kind === "conflict") {
          return Response.json({
            error: "conflict",
            reason: submission.reason,
            error_code: submission.reason === "request_conflict" ? "request_conflict" : "revision_or_active_conflict",
          }, { status: 409, headers });
        }
        return Response.json({
          turn_id: submission.turn.id,
          status: submission.turn.status,
          revision: submission.revision,
          replay: submission.kind === "replay",
        }, { status: 202, headers });
      },
    },
  },
});
void assistantMessageInput;
