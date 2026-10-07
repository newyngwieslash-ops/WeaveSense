import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { handleAgentJobs } from "@/lib/server/agent-jobs";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";

export const Route = createFileRoute("/api/internal/agent-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!tokenOk(token, prod.agentDataToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const parsed = await readAgentJson(request, 1024 * 1024);
        if (!parsed.ok) return parsed.response;
        const payload = parsed.value;
        // New-job switches must not prevent already queued Eino work from draining.
        if (payload.action === "claim" && !(prod.agentWorkerEnabled && prod.agentServiceUrl && prod.agentServiceToken && prod.agentDataToken)) {
          return Response.json({ error: "capability_unavailable" }, { status: 503 });
        }
        const result = await handleAgentJobs({
          sql: await getSql(),
          authorized: true,
          action: String(payload.action ?? ""),
          params: payload,
        });
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
