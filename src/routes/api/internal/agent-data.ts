import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { handleAgentData } from "@/lib/server/agent-data";

export const Route = createFileRoute("/api/internal/agent-data")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const runToken = request.headers.get("x-agent-run-token") ?? "";
        let payload: Record<string, unknown> = {};
        try {
          payload = await request.json() as Record<string, unknown>;
        } catch {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        const result = await handleAgentData({
          sql: await getSql(),
          serviceToken: prod.agentDataToken,
          providedServiceToken: authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
          runToken,
          runId: String(payload.run_id ?? ""),
          action: String(payload.action ?? ""),
          params: (payload.params && typeof payload.params === "object" ? payload.params : {}) as Record<string, unknown>,
        });
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
