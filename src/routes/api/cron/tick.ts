import { createFileRoute } from "@tanstack/react-router";
import {
  authorizeCron,
  cronHasBudget,
  CRON_GATEWAY_RESERVE_MS,
  CRON_INGEST_RESERVE_MS,
  CRON_SERVER_BUDGET_MS,
  CRON_SOURCE_RESERVE_MS,
  reconciliationDue,
  requestWechatReconciliation,
  runCronStages,
} from "@/lib/server/cron";
import { prod } from "@/lib/server/config";
import { getSql } from "@/lib/db";
import { runProductionTick } from "@/lib/server/nodes";
import { runSourceJob, tickDueSources } from "@/lib/server/scheduler";
import {
  enqueueReconciliationSources,
  processReconciliationQueue,
} from "@/lib/server/reconciliation-queue";

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
        const gatewayReserve = reconciliationConfigured ? CRON_GATEWAY_RESERVE_MS : 0;
        const queue = { processed: 0, succeeded: 0, failed: 0, deferred: 0,
          results: [] as Array<{ source_id: string; items_found: number; items_new: number; error: string }> };
        let queueError = false;
        const drainQueue = async (queueDeadlineMs: number) => {
          try {
            const batch = await processReconciliationQueue(await getSql(),
              (sourceId) => runSourceJob(sourceId, "reconcile"),
              { deadlineMs: queueDeadlineMs, reserveMs: CRON_SOURCE_RESERVE_MS });
            queue.processed += batch.processed;
            queue.succeeded += batch.succeeded;
            queue.failed += batch.failed;
            queue.deferred = batch.deferred;
            queue.results.push(...batch.results);
            return batch;
          } catch {
            queueError = true;
            return null;
          }
        };
        const stages = await runCronStages({
          collection: async () => {
            await drainQueue(deadlineMs - gatewayReserve);
            return tickDueSources(prod.cronTickLimit, {
              // Extraction is optional in a bounded tick; reserve ingest + gateway so collection cannot starve.
              deadlineMs: deadlineMs - CRON_INGEST_RESERVE_MS - gatewayReserve,
              reserveMs: CRON_SOURCE_RESERVE_MS,
            });
          },
          production: () => runProductionTick({ deadlineMs: deadlineMs - gatewayReserve }),
          reconciliation: async () => {
            if (!reconciliationConfigured) return null;
            if (!cronHasBudget(deadlineMs, CRON_GATEWAY_RESERVE_MS)) {
              return { ok: false, error: "reconciliation_deferred" };
            }
            const gateway = await requestWechatReconciliation({
              url: prod.wechatGatewayUrl,
              token: prod.wechatGatewayToken,
            });
            if (!gateway.ok) return gateway;
            queue.deferred = await enqueueReconciliationSources(
              await getSql(), gateway.value.succeeded_source_ids,
            );
            return {
              ...gateway.value,
              queued_source_count: gateway.value.succeeded_source_ids.length,
              source_results: [],
              deferred_source_count: queue.deferred,
            };
          },
        });
        return Response.json({ ...stages, reconciliation_queue: {
          ...queue,
          ...(queueError ? { error: "queue_failed" } : {}),
        } });
      },
    },
  },
});
