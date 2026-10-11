import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { listEventsAfter } from "@/lib/server/assistant-events";

/**
 * GET /api/assistant/conversations/$conversationId/events?after=N (§5.4/A18):
 * replayable incremental events. resync_required when the cursor predates
 * retained history. Same-origin GET, no-store, never seeds, never models.
 */
export const Route = createFileRoute("/api/assistant/conversations/$conversationId/events")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const headers = { "Cache-Control": "no-store" };
        if (!assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env).allowed) {
          return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        }
        const conversationId = String(params.conversationId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
          return Response.json({ error: "invalid_conversation" }, { status: 400, headers });
        }
        const url = new URL(request.url);
        const afterRaw = url.searchParams.get("after");
        const after = afterRaw == null ? -1 : Number(afterRaw);
        if (!Number.isSafeInteger(after) || after < -1) {
          return Response.json({ error: "invalid_cursor" }, { status: 400, headers });
        }
        const sql = await getSql();
        const page = await listEventsAfter(sql, conversationId, after);
        if (page.resyncRequired) {
          return Response.json({ resync_required: true, events: [] }, { headers });
        }
        return Response.json({
          resync_required: false,
          events: page.events.map((e) => ({
            seq: e.seq, type: e.type, turn_id: e.turn_id, conversation_id: conversationId, payload: e.payload, created_at: e.created_at,
          })),
        }, { headers });
      },
    },
  },
});
