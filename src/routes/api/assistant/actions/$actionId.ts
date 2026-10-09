import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { actionReceiptView } from "@/lib/server/assistant-action-receipt";

/**
 * GET /api/assistant/actions/$actionId (plan §5.3): the persisted receipt and
 * stable result references for one action. Read-only, never re-executes.
 */
export const Route = createFileRoute("/api/assistant/actions/$actionId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const headers = { "Cache-Control": "no-store" };
        if (!assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env).allowed) {
          return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        }
        const actionId = String(params.actionId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(actionId)) {
          return Response.json({ error: "invalid_action" }, { status: 400, headers });
        }
        const sql = await getSql();
        const receipt = await actionReceiptView(sql, actionId);
        if (!receipt) return Response.json({ error: "not_found" }, { status: 404, headers });
        return Response.json(receipt, { headers });
      },
    },
  },
});
