import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { handleReviewReceipt } from "@/lib/server/agent-review-receipts";
import { tokenOk, readAgentJson } from "@/lib/server/agent-internal-http";

export const Route = createFileRoute("/api/internal/agent-review")({
  server: { handlers: { POST: async ({ request }) => {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!tokenOk(token, prod.agentDataToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
    // Receipts carry no evidence snapshot.
    const parsed = await readAgentJson(request, 8 * 1024);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const result = await handleReviewReceipt({ sql: await getSql(), serviceToken: prod.agentDataToken,
      providedServiceToken: token,
      runToken: request.headers.get("x-agent-run-token") ?? "", runId: String(body.run_id ?? ""), action: String(body.action ?? ""),
      params: body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params as Record<string, unknown> : {} });
    return Response.json(result.body, { status: result.status });
  } } },
});
