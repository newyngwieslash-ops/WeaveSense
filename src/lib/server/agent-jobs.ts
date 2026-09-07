import { randomUUID } from "node:crypto";
import { beginRun } from "./agent-runs.ts";
import { loadCheckpoint, saveCheckpoint } from "./agent-checkpoints.ts";
import { claimAiJob, finishAiJob } from "./agent-queue.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export async function handleAgentJobs(opts: {
  sql: Queryable;
  authorized: boolean;
  action: string;
  params: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.authorized) return { status: 401, body: { error: "unauthorized" } };
  if (opts.action === "claim") {
    const job = await claimAiJob(opts.sql, { worker: "agent", leaseSeconds: 60, kind: "research" });
    if (!job) return { status: 404, body: { error: "empty" } };
    const runId = randomUUID();
    const begun = await beginRun(opts.sql, {
      id: runId, requestId: randomUUID(), mode: "research", provider: "eino",
      inputHash: job.material_hash, materialHash: job.material_hash, policyVersion: job.policy_version,
      requestJson: { job_id: job.id, question: job.payload.question ?? "" }, claimToken: job.claim_token,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const actualRun = begun.kind === "won" ? begun.run.id : runId;
    return {
      status: 200,
      body: {
        job_id: job.id,
        run_id: actualRun,
        claim_token: job.claim_token,
        mode: job.item_id.startsWith("research:") ? "research" : "analyze_item",
        question: String(job.payload.question ?? ""),
        item_id: job.item_id.startsWith("research:") ? "" : job.item_id,
      },
    };
  }
  if (opts.action === "save_checkpoint") {
    const result = await saveCheckpoint(opts.sql, {
      checkPointId: String(opts.params.check_point_id ?? ""),
      runId: String(opts.params.run_id ?? ""),
      claimToken: String(opts.params.claim_token ?? ""),
      sequence: Number(opts.params.sequence ?? 0) || 0,
      schemaVersion: String(opts.params.schema_version ?? "1"),
      runtimeVersion: String(opts.params.runtime_version ?? ""),
      payload: Buffer.from(String(opts.params.payload ?? ""), "base64"),
    });
    if (result === "stale") return { status: 409, body: { error: "stale" } };
    if (result === "too_large") return { status: 413, body: { error: "too_large" } };
    return { status: 200, body: { ok: true } };
  }
  if (opts.action === "get_checkpoint") {
    const loaded = await loadCheckpoint(opts.sql, {
      checkPointId: String(opts.params.check_point_id ?? ""),
      runId: String(opts.params.run_id ?? ""),
      runtimeVersion: String(opts.params.runtime_version ?? ""),
    });
    if (!loaded.ok) return { status: 409, body: { error: loaded.error, found: false } };
    return { status: 200, body: { found: true, payload: loaded.payload.toString("base64") } };
  }
  if (opts.action === "complete") {
    const ok = await finishAiJob(opts.sql, {
      id: String(opts.params.job_id ?? ""),
      claimToken: String(opts.params.claim_token ?? ""),
      status: (opts.params.status as "succeeded" | "failed" | "outcome_unknown") ?? "failed",
      runId: String(opts.params.run_id ?? ""),
      errorCode: String(opts.params.error_code ?? ""),
    });
    if (!ok) return { status: 409, body: { error: "stale" } };
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { error: "invalid_action" } };
}
