import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { getSql } from "@/lib/db";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { decideAssistantAction } from "@/lib/server/assistant-actions";
import { actionDecisionInput } from "@/lib/assistant-contract";

/**
 * POST /api/assistant/actions/$actionId/decision (plan §5.3/§6.1): approve or
 * reject a frozen action by id + digest + revision. No new parameters are
 * accepted; the request id gives decision idempotency.
 */
export const Route = createFileRoute("/api/assistant/actions/$actionId/decision")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const headers = { "Cache-Control": "no-store" };
        const access = assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env);
        if (!access.allowed) return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        if (request.headers.get("origin") !== new URL(request.url).origin) {
          return Response.json({ error: "same_origin_required" }, { status: 403, headers });
        }
        const actionId = String(params.actionId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(actionId)) {
          return Response.json({ error: "invalid_action" }, { status: 400, headers });
        }
        const raw = await request.text();
        if (raw.length > 4096) return Response.json({ error: "too_large" }, { status: 413, headers });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
        // Convert wire case (request_id/preview_digest/expected_revision) to the
        // domain shape.
        const wire = body as Record<string, unknown>;
        const candidate = {
          requestId: wire.request_id,
          decision: wire.decision,
          previewDigest: wire.preview_digest,
          revision: wire.expected_revision,
        };
        const parsed = actionDecisionInput.safeParse({
          request_id: candidate.requestId,
          decision: candidate.decision,
          preview_digest: candidate.previewDigest,
          expected_revision: candidate.revision,
        });
        if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
        // The conversation must be resolved server-side: the action row knows it.
        const sql = await getSql();
        const [owner] = await sql.query<{ conversation_id: string }>(
          "select t.conversation_id from assistant_actions a join assistant_turns t on t.id = a.turn_id where a.id = $1",
          [actionId],
        );
        if (!owner) return Response.json({ error: "not_found" }, { status: 404, headers });
        const receipt = await decideAssistantAction(sql, String(owner.conversation_id), actionId, {
          requestId: String(candidate.requestId),
          decision: candidate.decision === "approve" ? "approve" : "reject",
          previewDigest: String(candidate.previewDigest),
          revision: Number(candidate.revision),
        });
        const status = receipt.status === "succeeded" ? 200
          : receipt.status === "conflict" || receipt.status === "digest_mismatch" ? 409
          : receipt.status === "expired" ? 410
          : receipt.status === "not_found" ? 404
          : 200;
        return Response.json(receipt, { status, headers });
      },
    },
  },
});
