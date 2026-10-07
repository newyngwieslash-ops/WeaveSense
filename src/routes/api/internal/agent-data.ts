import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { handleAgentData } from "@/lib/server/agent-data";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";

export const Route = createFileRoute("/api/internal/agent-data")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!tokenOk(token, prod.agentDataToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const runToken = request.headers.get("x-agent-run-token") ?? "";
        const parsed = await readAgentJson(request, 32 * 1024);
        if (!parsed.ok) return parsed.response;
        const payload = parsed.value;
        const result = await handleAgentData({
          sql: await getSql(),
          serviceToken: prod.agentDataToken,
          providedServiceToken: token,
          runToken,
          runId: String(payload.run_id ?? ""),
          action: String(payload.action ?? ""),
          params: (payload.params && typeof payload.params === "object" && !Array.isArray(payload.params) ? payload.params : {}) as Record<string, unknown>,
        });
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
