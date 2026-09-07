import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { prod } from "@/lib/server/config";
import { handleAgentJobs } from "@/lib/server/agent-jobs";

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
        let payload: Record<string, unknown> = {};
        try { payload = await request.json() as Record<string, unknown>; } catch {
          return Response.json({ error: "invalid_request" }, { status: 400 });
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
