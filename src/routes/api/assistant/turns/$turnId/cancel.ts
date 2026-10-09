import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { cancelTurn } from "@/lib/server/assistant-turn-status";

/**
 * POST /api/assistant/turns/$turnId/cancel (plan §5.3/A17): idempotent stop
 * for the current turn and its owned unfinished actions/research. Same-origin
 * POST; executed writes are never rolled back.
 */
export const Route = createFileRoute("/api/assistant/turns/$turnId/cancel")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const headers = { "Cache-Control": "no-store" };
        const access = assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env);
        if (!access.allowed) return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        if (request.headers.get("origin") !== new URL(request.url).origin) {
          return Response.json({ error: "same_origin_required" }, { status: 403, headers });
        }
        const turnId = String(params.turnId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(turnId)) {
          return Response.json({ error: "invalid_turn" }, { status: 400, headers });
        }
        const raw = await request.text();
        if (raw.length > 1024) return Response.json({ error: "too_large" }, { status: 413, headers });
        let conversationId = "";
        try {
          const body = JSON.parse(raw || "{}") as { conversation_id?: unknown };
          if (typeof body.conversation_id === "string" && /^[0-9a-f-]{36}$/i.test(body.conversation_id)) {
            conversationId = body.conversation_id;
          }
        } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
        if (!conversationId) return Response.json({ error: "conversation_id_required" }, { status: 400, headers });
        const sql = await getSql();
        const result = await cancelTurn(sql, conversationId, turnId);
        if (!result.ok) return Response.json({ error: result.error_code ?? "not_found" }, { status: 404, headers });
        return Response.json({ ok: true }, { headers });
      },
    },
  },
});
