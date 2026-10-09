import { createFileRoute } from "@tanstack/react-router";
import { getRequestIP } from "@tanstack/react-start/server";
import { assistantAccessFromRequest } from "@/lib/server/assistant-access";
import { assistantCapabilities } from "@/lib/server/assistant-capabilities";

/**
 * GET /api/assistant/capabilities (plan §5.3): what the assistant can do
 * right now and why not, if not. Never calls a model, never seeds.
 */
export const Route = createFileRoute("/api/assistant/capabilities")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const headers = { "Cache-Control": "no-store" };
        if (!assistantAccessFromRequest(request, getRequestIP({ xForwardedFor: false }), process.env).allowed) {
          return Response.json({ error: "assistant_requires_trusted_local_access" }, { status: 403, headers });
        }
        return Response.json(await assistantCapabilities(), { headers });
      },
    },
  },
});
