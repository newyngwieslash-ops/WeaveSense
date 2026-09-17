import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { prod, agentAsyncAvailable } from "@/lib/server/config";
import { handleAgentJobs } from "@/lib/server/agent-jobs";
import { cancelQueuedResearchJobs } from "@/lib/server/agent-queue";

function tokenOk(got: string, want: string): boolean {
  if (!got || !want) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/internal/agent-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        if (!tokenOk(token, prod.agentDataToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        let payload: Record<string, unknown> = {};
        try { payload = await request.json() as Record<string, unknown>; } catch {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return Response.json({ error: "invalid_request" }, { status: 400 });
        if (payload.action === "claim" && !agentAsyncAvailable()) {
          await cancelQueuedResearchJobs(await getSql());
          return Response.json({ error: "capability_unavailable" }, { status: 503 });
        }
        const result = await handleAgentJobs({
          sql: await getSql(),
          authorized: tokenOk(token, prod.agentDataToken),
          action: String(payload.action ?? ""),
          params: payload,
        });
        return Response.json(result.body, { status: result.status });
      },
    },
  },
});
