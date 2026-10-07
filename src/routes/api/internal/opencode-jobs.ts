import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";
import { handleOpenCodeJobs } from "@/lib/server/agent-opencode-jobs";

export const Route = createFileRoute("/api/internal/opencode-jobs")({
  server: { handlers: { POST: async ({ request }) => {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokenOk(token, prod.opencodeWorkerToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const parsed = await readAgentJson(request, 1024 * 1024);
    if (!parsed.ok) return parsed.response;
    if (parsed.value.action === "claim" && !prod.opencodeWorkerEnabled) return Response.json({ error: "capability_unavailable" }, { status: 503 });
    const result = await handleOpenCodeJobs({ sql: await getSql(), authorized: true, action: String(parsed.value.action ?? ""), params: parsed.value });
    return Response.json(result.body, { status: result.status });
  } } },
});
