import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { getSnapshot } from "@/lib/server/assistant-events";
import { createConversation } from "@/lib/server/assistant-store";

/**
 * GET/POST /api/assistant/conversations (plan §5.3): paginated conversation
 * list and new-conversation creation. GETs are no-store and never seed.
 */
export const Route = createFileRoute("/api/assistant/conversations")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const headers = { "Cache-Control": "no-store" };
        if (!assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env).allowed) {
          return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        }
        const sql = await getSql();
        const url = new URL(request.url);
        const limitRaw = Number(url.searchParams.get("limit") ?? 20);
        const limit = Number.isSafeInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 50 ? limitRaw : 20;
        const before = url.searchParams.get("before");
        const rows = await sql.query<Record<string, unknown>>(
          `select c.id, c.title, c.revision, c.status, c.updated_at,
             (select count(*)::int from assistant_turns t where t.conversation_id = c.id) as turn_count
           from assistant_conversations c
           where ($1::text is null or c.updated_at < $1::timestamptz)
           order by c.updated_at desc limit $2`,
          [before && /^\d{4}-\d{2}-\d{2}T/.test(before) ? before : null, limit + 1],
        );
        return Response.json({
          conversations: rows.slice(0, limit).map((r) => ({
            id: String(r.id), title: String(r.title), revision: Number(r.revision),
            status: String(r.status), turn_count: Number(r.turn_count),
            updated_at: String(r.updated_at),
          })),
          has_more: rows.length > limit,
        }, { headers });
      },
      POST: async ({ request }) => {
        const headers = { "Cache-Control": "no-store" };
        const access = assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env);
        if (!access.allowed) {
          return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        }
        if (request.headers.get("origin") !== new URL(request.url).origin) {
          return Response.json({ error: "same_origin_required" }, { status: 403, headers });
        }
        const sql = await getSql();
        const conversation = await createConversation(sql, {});
        return Response.json({ id: conversation.id, revision: conversation.revision, status: conversation.status }, { status: 201, headers });
      },
    },
  },
});
