import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { assistantActionStatus } from "@/lib/server/assistant-turn-status";

/**
 * GET /api/assistant/turns/$turnId (plan §5.3): recover one turn's status and
 * its stable business links (job/run/action ids) without creating anything.
 */
export const Route = createFileRoute("/api/assistant/turns/$turnId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const headers = { "Cache-Control": "no-store" };
        if (!assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env).allowed) {
          return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        }
        const turnId = String(params.turnId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(turnId)) {
          return Response.json({ error: "invalid_turn" }, { status: 400, headers });
        }
        const sql = await getSql();
        const result = await assistantActionStatus(sql, turnId);
        if (!result) return Response.json({ error: "not_found" }, { status: 404, headers });
        return Response.json(result, { headers });
      },
    },
  },
});
