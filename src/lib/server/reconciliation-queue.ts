import type { Sql } from "@/lib/db";
import { runCronBatch, type CronBatchOptions } from "./cron.ts";

type QuerySql = Pick<Sql, "query">;

type RunResult = { items_found: number; items_new: number; error: string };
type SourceJobResult = RunResult & { source_id: string };

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export async function enqueueReconciliationSources(sql: QuerySql, sourceIds: readonly string[]): Promise<number> {
  for (const sourceId of new Set(sourceIds.map((value) => value.trim()).filter(Boolean))) {
    await sql.query(
      "insert into reconciliation_queue (source_id) values ($1) on conflict (source_id) do nothing",
      [sourceId],
    );
  }
  return queueSize(sql);
}

async function queueSize(sql: QuerySql): Promise<number> {
  const [row] = await sql.query<{ count: number }>("select count(*)::int as count from reconciliation_queue");
  return row?.count ?? 0;
}

// ponytail: single-replica cron needs no queue claim; add a token lease before scaling app/scheduler replicas.
export async function processReconciliationQueue(
  sql: QuerySql,
  run: (sourceId: string) => Promise<RunResult>,
  budget: CronBatchOptions = {},
): Promise<{ processed: number; succeeded: number; failed: number; deferred: number; results: SourceJobResult[] }> {
  const rows = await sql.query<{ source_id: string }>(
    "select source_id from reconciliation_queue order by created_at, source_id limit 500",
  );
  const { results } = await runCronBatch(rows, async ({ source_id }) => {
    let result: SourceJobResult;
    try {
      const value = await run(source_id);
      if (value.error || !validCount(value.items_found) || !validCount(value.items_new)) throw new Error();
      result = { ...value, source_id };
      await sql.query("delete from reconciliation_queue where source_id = $1", [source_id]);
    } catch {
      result = { source_id, items_found: 0, items_new: 0, error: "reconcile_scan_failed" };
      await sql.query(
        `update reconciliation_queue
         set attempts = attempts + 1, last_error = 'reconcile_scan_failed'
         where source_id = $1`,
        [source_id],
      );
    }
    return result;
  }, budget);
  return {
    processed: results.length,
    succeeded: results.filter(({ error }) => !error).length,
    failed: results.filter(({ error }) => Boolean(error)).length,
    deferred: await queueSize(sql),
    results,
  };
}
