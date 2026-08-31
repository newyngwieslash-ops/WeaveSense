import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  enqueueReconciliationSources,
  processReconciliationQueue,
} from "./reconciliation-queue.ts";

test("reconciliation queue is idempotent, bounded, and retries failures next tick", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(readFileSync(new URL("../../../migrations/0006_reconciliation_queue.sql", import.meta.url), "utf8"));
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };

  await enqueueReconciliationSources(sql, ["wx-1", "wx-2", "wx-1"]);
  await enqueueReconciliationSources(sql, ["wx-2"]);
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from reconciliation_queue")).rows[0]?.n, 2);

  let now = 0;
  const first = await processReconciliationQueue(sql, async (sourceId) => {
    now += 10;
    return { source_id: sourceId, items_found: 1, items_new: 1, error: "" };
  }, { deadlineMs: 25, reserveMs: 20, now: () => now });
  assert.deepEqual(first, { processed: 1, succeeded: 1, failed: 0, deferred: 1, results: [
    { source_id: "wx-1", items_found: 1, items_new: 1, error: "" },
  ] });

  const failed = await processReconciliationQueue(sql, async (sourceId) => ({
    source_id: sourceId, items_found: 0, items_new: 0, error: "provider secret",
  }), { deadlineMs: 50, reserveMs: 20, now: () => now });
  assert.deepEqual(failed, { processed: 1, succeeded: 0, failed: 1, deferred: 1, results: [
    { source_id: "wx-2", items_found: 0, items_new: 0, error: "reconcile_scan_failed" },
  ] });
  assert.deepEqual((await pg.query("select source_id, attempts, last_error from reconciliation_queue" )).rows,
    [{ source_id: "wx-2", attempts: 1, last_error: "reconcile_scan_failed" }]);

  const retried = await processReconciliationQueue(sql, async (sourceId) => ({
    source_id: sourceId, items_found: 2, items_new: 1, error: "",
  }), { deadlineMs: 50, reserveMs: 20, now: () => now });
  assert.equal(retried.succeeded, 1);
  assert.equal(retried.deferred, 0);
  await pg.close();
});
