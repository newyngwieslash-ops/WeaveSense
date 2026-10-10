import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";
import { runAssistantTool } from "@/lib/server/assistant-tools";
import { admitGovernedModelCall, modelCallSchema } from "@/lib/server/agent-budget";
import { hashRunToken } from "@/lib/server/agent-data";

/**
 * POST /api/internal/assistant-data (plan Task 6 / §4.3): the fixed endpoint
 * assistant grants reach for read tools and model receipts. Authorization is
 * service token + per-run data token; the per-run assistant_tool_calls
 * ledger inside runAssistantTool arbitrates replays, conflicts and budget.
 * Research grants never route here — the bridge posts them to agent-data.
 */
export const Route = createFileRoute("/api/internal/assistant-data")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!tokenOk(token, prod.agentDataToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const runToken = request.headers.get("x-agent-run-token") ?? "";
        const parsed = await readAgentJson(request, 64 * 1024);
        if (!parsed.ok) return parsed.response;
        const payload = parsed.value;
        const runId = String(payload.run_id ?? "");
        const claimToken = String(payload.claim_token ?? "");
        const action = String(payload.action ?? "");
        const params = (payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
          ? payload.params : {}) as Record<string, unknown>;

        if (action === "model_call") {
          // Same governed receipt admission as research (§4.3: the model
          // receipt precedes the actual send; run + data token verified).
          const parsed = modelCallSchema.safeParse(params);
          if (!parsed.success) return Response.json({ error: "invalid_receipt" }, { status: 400 });
          const sql = await getSql();
          const disposition = await admitGovernedModelCall(sql, runId, { role: "producer", tokenHash: hashRunToken(runToken) }, parsed.data);
          return Response.json({ ok: disposition !== "denied", disposition }, { status: disposition === "denied" ? 409 : 200 });
        }
        if (action === "tool_start" || action === "tool_complete") {
          // The ledger inside runAssistantTool covers start/read/complete
          // atomically; the separate start/complete posts from the bridge's
          // receipt discipline map to the same call_id ledger row. Start is
          // acknowledged before the read; complete is the bridge's own
          // receipt and replays as already_started.
          return Response.json({ ok: true, disposition: action === "tool_start" ? "send_once" : "completed" });
        }
        if (!runId || !claimToken) return Response.json({ error: "invalid_request" }, { status: 400 });
        const sql = await getSql();
        // conversation/turn identity comes from the claim: the assistant-jobs
        // route froze item_id="assistant:<turnId>"; the turn row carries the
        // conversation for conversation-scoped tools (get_operation, status).
        const [job] = await sql.query<Record<string, unknown>>(
          `select j.item_id from ai_jobs j where j.run_id=$1 and j.claim_token=$2 and j.status='running'`,
          [runId, claimToken],
        );
        if (!job) return Response.json({ error: "run_not_active" }, { status: 403 });
        const turnId = String(job.item_id ?? "").slice("assistant:".length);
        const [turn] = await sql.query<Record<string, unknown>>(
          "select conversation_id from assistant_turns where id=$1", [turnId],
        );
        if (!turn) return Response.json({ error: "run_not_active" }, { status: 403 });
        const outcome = await runAssistantTool(sql, {
          runId,
          conversationId: String(turn.conversation_id),
          turnId,
          dataTokenHash: hashRunToken(runToken),
          callId: String(params.call_id ?? ""),
          tool: action,
          args: (() => { const { call_id: _c, request_digest: _d, ...rest } = params; return rest; })(),
        });
        if (!outcome.ok) {
          const status = outcome.error_code === "tool_budget_exceeded" ? 429
            : outcome.error_code === "run_not_active" ? 403 : 409;
          return Response.json({ error: outcome.error_code }, { status });
        }
        return Response.json(outcome.value ?? {}, { status: 200 });
      },
    },
  },
});
