import { createFileRoute } from "@tanstack/react-router";
import {
  authorizeCron,
  cronHasBudget,
  CRON_GATEWAY_RESERVE_MS,
  CRON_EXTRACT_RESERVE_MS,
  CRON_INGEST_RESERVE_MS,
  CRON_SERVER_BUDGET_MS,
  CRON_SOURCE_RESERVE_MS,
  reconciliationDue,
  cronWorkSlot,
  requestWechatReconciliation,
  requestWechatReconciliationAck,
  runCronStages,
} from "@/lib/server/cron";
import { prod } from "@/lib/server/config";
import { runStageOnce } from "@/lib/server/stage-windows.ts";
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
        const gatewayConfigured = Boolean(prod.wechatGatewayUrl && prod.wechatGatewayToken);
        const reconciliationWindow = reconciliationDue(new Date(startedAt));
        const gatewayReserve = gatewayConfigured ? CRON_GATEWAY_RESERVE_MS : 0;
        const allowExtract = !(gatewayConfigured && reconciliationWindow)
          && cronWorkSlot(new Date(startedAt)) === "extract";
        const extractReserve = allowExtract ? CRON_EXTRACT_RESERVE_MS : 0;
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
        // T09: the paid/reconciliation work rides its own persistent window too,
        // so a 60-second tick cannot re-run it. The business window (23:30
        // Shanghai) is checked FIRST and the claim is only taken inside it —
        // claiming outside would consume the day's window and silently skip the
        // real reconciliation later that day.
        let reconciliationAllowed = false;
        if (gatewayConfigured && reconciliationWindow) {
          const stage = await runStageOnce(await getSql(), "reconcile",
            async () => ({ ok: true, note: "admitted" }), startedAt);
          reconciliationAllowed = stage.ran;
        }

        const stages = await runCronStages({
          collection: async () => {
            await drainQueue(deadlineMs - gatewayReserve - CRON_INGEST_RESERVE_MS - extractReserve);
            return tickDueSources(prod.cronTickLimit, {
              deadlineMs: deadlineMs - CRON_INGEST_RESERVE_MS - gatewayReserve - extractReserve,
              reserveMs: CRON_SOURCE_RESERVE_MS,
            });
          },
          production: () => runProductionTick({ deadlineMs: deadlineMs - gatewayReserve, allowExtract }),
          reconciliation: async () => {
            if (!gatewayConfigured) return null;
            if (!reconciliationAllowed) {
              return { ok: false, error: "reconciliation_deferred" };
            }
            if (!cronHasBudget(deadlineMs, CRON_GATEWAY_RESERVE_MS)) {
              return { ok: false, error: "reconciliation_deferred" };
            }
            const gateway = await requestWechatReconciliation({
              url: prod.wechatGatewayUrl,
              token: prod.wechatGatewayToken,
            });
            if (!gateway.ok) return gateway;
            queue.deferred = await enqueueReconciliationSources(
              await getSql(), gateway.value.outbox_source_ids,
            );
            const deliveryAck = await requestWechatReconciliationAck({
              url: prod.wechatGatewayUrl, token: prod.wechatGatewayToken,
              sourceIds: gateway.value.outbox_source_ids,
            });
            return {
              ...gateway.value,
              queued_source_count: gateway.value.outbox_source_ids.length,
              delivery_ack: deliveryAck,
              source_results: [],
              deferred_source_count: queue.deferred,
            };
          },
        });
        return Response.json({ ...stages,
          // T16: total tick duration, so the loop can report it and an operator can
          // see how much of the server budget a tick consumed.
          duration_ms: Date.now() - startedAt,
          reconciliation_queue: {
          ...queue,
          ...(queueError ? { error: "queue_failed" } : {}),
        } });
      },
    },
  },
});
