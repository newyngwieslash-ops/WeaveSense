import type { Queryable } from "@/lib/db";

/**
 * Persisted receipt reader (plan §5.5): returns the stored ActionReceipt for
 * an action, or null. Pure read; the receipt is a host fact, so nothing here
 * re-executes or fabricates.
 */
export type ActionReceiptPublic = {
  action_id: string;
  kind: string;
  status: string;
  effect?: string;
  result_refs: Array<{ type: string; id: string }>;
  counts?: { inserted: number };
  warnings: Array<{ code: string; message: string }>;
  error_code?: string;
  partial_effects_possible?: boolean;
  changed_domains: string[];
};

export async function actionReceiptView(sql: Queryable, actionId: string): Promise<ActionReceiptPublic | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    "select id, kind, status, result_json from assistant_actions where id = $1",
    [actionId],
  );
  if (!row) return null;
  const stored = row.result_json == null ? null : typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
  const result = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  return {
    action_id: String(row.id),
    kind: String(row.kind),
    status: String(row.status),
    effect: typeof result.effect === "string" ? result.effect : undefined,
    result_refs: Array.isArray(result.result_refs) ? result.result_refs as ActionReceiptPublic["result_refs"] : [],
    counts: result.counts as ActionReceiptPublic["counts"],
    warnings: Array.isArray(result.warnings) ? result.warnings as ActionReceiptPublic["warnings"] : [],
    error_code: typeof result.error_code === "string" ? result.error_code : undefined,
    partial_effects_possible: result.partial_effects_possible === true,
    changed_domains: Array.isArray(result.changed_domains) ? result.changed_domains as string[] : [],
  };
}
