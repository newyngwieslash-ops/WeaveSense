import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { getSnapshot } from "@/lib/server/assistant-events";

/**
 * GET/PATCH /api/assistant/conversations/$conversationId (plan §5.3):
 * consistent snapshot (watermark + events + turns + messages) for recovery,
 * and title/archive updates. Reads never seed; writes never call models.
 */
export const Route = createFileRoute("/api/assistant/conversations/$conversationId")({
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
        const sql = await getSql();
        const snapshot = await getSnapshot(sql, conversationId);
        if (!snapshot) return Response.json({ error: "not_found" }, { status: 404, headers });
        return Response.json(snapshot, { headers });
      },
      PATCH: async ({ request, params }) => {
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
        if (raw.length > 2048) return Response.json({ error: "too_large" }, { status: 413, headers });
        let body: { title?: unknown; status?: unknown };
        try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
        const updates: string[] = [];
        const values: unknown[] = [conversationId];
        if (typeof body.title === "string" && body.title.trim().length > 0 && Array.from(body.title).length <= 80) {
          values.push(body.title.trim());
          updates.push(`title = $${values.length}`);
        }
        if (body.status === "archived" || body.status === "open") {
          values.push(body.status);
          updates.push(`status = $${values.length}`);
        }
        if (updates.length === 0) return Response.json({ error: "invalid_request" }, { status: 400, headers });
        const sql = await getSql();
        const rows = await sql.query(
          `update assistant_conversations set ${updates.join(", ")}, updated_at = clock_timestamp() where id = $1 returning id, title, status`,
          values,
        );
        if (rows.length === 0) return Response.json({ error: "not_found" }, { status: 404, headers });
        return Response.json({ id: String(rows[0].id), title: String(rows[0].title), status: String(rows[0].status) }, { headers });
      },
    },
  },
});
