import { createHash, timingSafeEqual } from "node:crypto";
import { modelCallSchema, admitGovernedModelCall } from "./agent-budget.ts";
import type { AgentSql } from "./agent-transaction.ts";

export async function handleReviewReceipt(opts: {
  sql: AgentSql; serviceToken: string; providedServiceToken: string; runToken: string;
  runId: string; action: string; params: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const expected = Buffer.from(opts.serviceToken), provided = Buffer.from(opts.providedServiceToken);
  if (!expected.length || expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { status: 401, body: { error: "unauthorized" } };
  if (opts.action !== "model_call") return { status: 400, body: { error: "invalid_action" } };
  const parsed = modelCallSchema.safeParse(opts.params);
  if (!parsed.success || !opts.runToken) return { status: 400, body: { error: "invalid_receipt" } };
  const disposition = await admitGovernedModelCall(opts.sql, opts.runId, { role: "reviewer", tokenHash: createHash("sha256").update(opts.runToken).digest("hex") }, parsed.data);
  return { status: disposition === "denied" ? 409 : 200, body: { ok: disposition !== "denied", disposition } };
}
