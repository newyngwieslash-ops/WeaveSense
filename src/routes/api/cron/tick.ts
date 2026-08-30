import { createFileRoute } from "@tanstack/react-router";
import {
  authorizeCron,
  cronHasBudget,
  CRON_EXTRACT_RESERVE_MS,
  CRON_GATEWAY_RESERVE_MS,
  CRON_INGEST_RESERVE_MS,
  CRON_SERVER_BUDGET_MS,
  CRON_SOURCE_RESERVE_MS,
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

        const startedAt = Date.now();
        const deadlineMs = startedAt + CRON_SERVER_BUDGET_MS;
        const reconciliationConfigured = reconciliationDue(new Date(startedAt))
          && Boolean(prod.wechatGatewayUrl && prod.wechatGatewayToken);
        const productionReserve = CRON_INGEST_RESERVE_MS
          + (prod.extractAuto ? CRON_EXTRACT_RESERVE_MS : 0);
        const reconciliationReserve = reconciliationConfigured
          ? CRON_GATEWAY_RESERVE_MS + CRON_SOURCE_RESERVE_MS
          : 0;
        return Response.json(await runCronStages({
          collection: () => tickDueSources(prod.cronTickLimit, {
            deadlineMs: deadlineMs - productionReserve - reconciliationReserve,
            reserveMs: CRON_SOURCE_RESERVE_MS,
          }),
          production: () => runProductionTick({ deadlineMs: deadlineMs - reconciliationReserve }),
          reconciliation: async () => {
            if (!reconciliationConfigured) return null;
            if (!cronHasBudget(deadlineMs, CRON_GATEWAY_RESERVE_MS + CRON_SOURCE_RESERVE_MS)) {
              return { ok: false, error: "reconciliation_deferred" };
            }
            const gateway = await requestWechatReconciliation({
              url: prod.wechatGatewayUrl,
              token: prod.wechatGatewayToken,
            });
            if (!gateway.ok) return gateway;
            const sourceResults = await runReconciledSourceJobs(
              gateway.value.succeeded_source_ids,
              (sourceId) => runSourceJob(sourceId, "reconcile"),
              { deadlineMs, reserveMs: CRON_SOURCE_RESERVE_MS },
            );
            return {
              ...gateway.value,
              source_results: sourceResults,
              deferred_source_count: gateway.value.succeeded_source_ids.length - sourceResults.length,
            };
          },
        }));
      },
    },
  },
});
