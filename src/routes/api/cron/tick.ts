import { createFileRoute } from "@tanstack/react-router";
import {
  authorizeCron,
  reconciliationDue,
  requestWechatReconciliation,
  runCronStages,
  runReconciledSourceJobs,
} from "@/lib/server/cron";
import { prod } from "@/lib/server/config";
import { runProductionTick } from "@/lib/server/nodes";
import { runSourceJob, tickDueSources } from "@/lib/server/scheduler";

export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization") ?? "";
        if (!prod.cronSecret || !authorizeCron(authorization, prod.cronSecret)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        return Response.json(await runCronStages({
          collection: () => tickDueSources(prod.cronTickLimit),
          production: () => runProductionTick(),
          reconciliation: async () => {
            if (!reconciliationDue(new Date()) || !prod.wechatGatewayUrl || !prod.wechatGatewayToken) return null;
            const gateway = await requestWechatReconciliation({
              url: prod.wechatGatewayUrl,
              token: prod.wechatGatewayToken,
            });
            return gateway.ok
              ? {
                  ...gateway.value,
                  source_results: await runReconciledSourceJobs(
                    gateway.value.succeeded_source_ids,
                    (sourceId) => runSourceJob(sourceId, "reconcile"),
                  ),
                }
              : gateway;
          },
        }));
      },
    },
  },
});
