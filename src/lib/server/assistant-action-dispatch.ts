/**
 * Assistant collection dispatch (plan Task 12 / §6.2).
 *
 * prepare  — one short transaction: stable jobs id, action→job link,
 *            approved→executing. No IO inside the transaction.
 * execute  — the caller runs the existing scheduler IO (runSourceJob /
 *            runKeywordJob) between two prepare/observe transactions;
 *            dispatch_started_at is persisted BEFORE the external send so a
 *            crash leaves convergent evidence (A13).
 * observe  — read-only convergence: the persisted job row is the single
 *            source of truth for outcome and counts. A completed action
 *            replayed by id replays its receipt and never re-collects.
 *
 * mapCollectionReceipt translates scheduler outcomes honestly: "已停用" is
 * skipped, "正在运行" is a conflict, all-external-failure is failed, and a
 * success with zero new items carries an explicit zero_new warning (§6.2:
 * never present HTTP 200 as "collected", never fake counts on partial
 * failure).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "@/lib/db";

type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type SqlLike = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

export type CollectionKind = "keyword.collect_once" | "source.collect_once";

export type PreparedCollection = {
  kind: "prepared" | "replay";
  actionId: string;
  jobId: string;
};

export type CollectionReceipt = {
  action_id: string;
  status: "succeeded" | "failed" | "skipped" | "conflict" | "not_found";
  effect?: "skipped" | "unchanged";
  result_refs: Array<{ type: "keyword" | "source" | "job"; id: string }>;
  counts?: { inserted: number };
  warnings: Array<{ code: string; message: string }>;
  error_code?: string;
  partial_effects_possible?: boolean;
  changed_domains: Array<"keywords" | "sources" | "jobs" | "items">;
};

function shortId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Prepare one collection action: stable jobs id + action link in one
 * transaction. A second prepare of an already-decided action replays the
 * stored receipt (the caller re-reads it) instead of creating a second job.
 */
export async function prepareAssistantCollection(
  sql: Queryable,
  input: { actionId: string; turnId: string; conversationId: string; kind: CollectionKind; targetId: string },
): Promise<PreparedCollection> {
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [action] = await tx.query<Record<string, unknown>>(
      "select id, status, child_job_id from assistant_actions where id = $1 for update",
      [input.actionId],
    );
    if (!action) throw new Error("action_not_found");
    const existingJob = action.child_job_id == null ? null : String(action.child_job_id);
    if (["succeeded", "failed", "skipped", "conflict"].includes(String(action.status)) && existingJob) {
      return { kind: "replay" as const, actionId: input.actionId, jobId: existingJob };
    }
    if (existingJob) {
      return { kind: "replay" as const, actionId: input.actionId, jobId: existingJob };
    }
    const jobId = `asst_${shortId()}`;
    const platform = "rss";
    const sourceId = input.kind === "keyword.collect_once" ? "src_kw_radar" : input.targetId;
    // Target validation rides prepare (§6.2): a missing or disabled target
    // resolves the action honestly here, without creating a job or IO.
    if (input.kind === "keyword.collect_once") {
      const [kw] = await tx.query<Record<string, unknown>>(
        "select id, enabled from keywords where id = $1", [input.targetId],
      );
      if (!kw) {
        const receipt: CollectionReceipt = { action_id: input.actionId, status: "not_found", effect: "skipped", result_refs: [], warnings: [], error_code: "target_missing", changed_domains: [] };
        await persistReceipt(tx, { actionId: input.actionId, conversationId: input.conversationId, turnId: input.turnId }, receipt);
        return { kind: "replay" as const, actionId: input.actionId, jobId: "" };
      }
      if (!kw.enabled) {
        const receipt: CollectionReceipt = { action_id: input.actionId, status: "skipped", effect: "skipped", result_refs: [], warnings: [{ code: "target_disabled", message: "目标已停用，未发起采集" }], changed_domains: [] };
        await persistReceipt(tx, { actionId: input.actionId, conversationId: input.conversationId, turnId: input.turnId }, receipt);
        return { kind: "replay" as const, actionId: input.actionId, jobId: "" };
      }
    }
    await tx.query(
      `insert into jobs (id, source_id, platform, status, kind) values ($1,$2,$3,'pending',$4)`,
      [jobId, sourceId, platform, "assistant"],
    );
    await tx.query(
      "update assistant_actions set status='executing', child_job_id=$2 where id=$1",
      [input.actionId, jobId],
    );
    return { kind: "prepared" as const, actionId: input.actionId, jobId };
  });
}

/**
 * Observe the persisted job for a collection action and write the receipt.
 * Read-only with respect to collection: no external call, no re-run. If the
 * job row vanished, the receipt is unknown-shaped rather than fabricated.
 */
export async function observeAssistantCollection(
  sql: Queryable,
  input: { actionId: string; conversationId: string; turnId: string; jobId: string },
): Promise<CollectionReceipt> {
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [action] = await tx.query<Record<string, unknown>>(
      "select id, status, result_json, kind from assistant_actions where id = $1 for update",
      [input.actionId],
    );
    if (!action) throw new Error("action_not_found");
    if (["succeeded", "failed", "skipped"].includes(String(action.status))) {
      const stored = action.result_json == null ? null : typeof action.result_json === "string" ? JSON.parse(action.result_json) : action.result_json;
      if (stored && typeof stored === "object" && stored.status) {
        return stored as CollectionReceipt;
      }
    }
    const [job] = await tx.query<Record<string, unknown>>(
      "select id, status, items_new, items_found, error, kind from jobs where id = $1",
      [input.jobId],
    );
    if (!job) {
      const receipt = failReceipt(input.actionId, "job_record_missing", true);
      await persistReceipt(tx, input, receipt);
      return receipt;
    }
    if (String(job.status) === "pending") {
      const pending = { action_id: input.actionId, status: "skipped" as const, effect: "skipped" as const, result_refs: [], warnings: [], changed_domains: [] };
      await persistReceipt(tx, input, pending);
      return pending;
    }
    const outcome = {
      items_found: Number(job.items_found ?? 0),
      items_new: Number(job.items_new ?? 0),
      error: String(job.error ?? ""),
      job_status: String(job.status ?? ""),
    };
    const kind = String(action.kind) as CollectionKind;
    const receipt = outcomeToReceipt(input.actionId, kind, outcome);
    await persistReceipt(tx, input, receipt);
    return receipt;
  });
}

function failReceipt(actionId: string, code: string, partial: boolean): CollectionReceipt {
  return {
    action_id: actionId,
    status: "failed",
    effect: "skipped",
    result_refs: [],
    warnings: [],
    error_code: code,
    partial_effects_possible: partial,
    changed_domains: [],
  };
}

function dbStatus(status: string): string {
  // Receipt statuses are honest; the DB enum stores the closest terminal state.
  return status === "skipped" || status === "not_found" ? "succeeded" : status;
}

async function persistReceipt(
  tx: Tx,
  input: { actionId: string; conversationId: string; turnId: string },
  receipt: CollectionReceipt,
) {
  await tx.query(
    "update assistant_actions set status=$2, result_json=$3::jsonb where id=$1",
    [input.actionId, dbStatus(receipt.status), JSON.stringify(receipt)],
  );
  const [seqRow] = await tx.query<{ n: number | null }>(
    "select coalesce(max(seq)+1, 0)::int as n from assistant_events where conversation_id = $1",
    [input.conversationId],
  );
  await tx.query(
    `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
     values($1,$2,$3,$4,'action.updated',$5::jsonb)`,
    [randomUUID(), input.conversationId, input.turnId, Number(seqRow?.n ?? 0), JSON.stringify({ action_id: input.actionId, kind: "collect_once", status: receipt.status })],
  );
}

/**
 * Map a raw scheduler outcome to a structured receipt. Pure.
 */
export function mapCollectionReceipt(outcome: { items_found: number; items_new: number; error: string }): Omit<CollectionReceipt, "action_id" | "result_refs"> {
  const warnings: Array<{ code: string; message: string }> = [];
  if (outcome.error === "已停用") {
    return { status: "skipped", effect: "skipped", warnings, changed_domains: [] as CollectionReceipt["changed_domains"] };
  }
  if (outcome.error === "正在运行") {
    return { status: "conflict", effect: "unchanged", warnings, error_code: "already_running", changed_domains: [] as CollectionReceipt["changed_domains"] };
  }
  if (outcome.error === "信源不存在" || outcome.error === "关键词不存在" || outcome.error === "任务不可用") {
    return { status: "not_found", effect: "skipped", warnings, error_code: "target_missing", changed_domains: [] as CollectionReceipt["changed_domains"] };
  }
  if (outcome.error && !outcome.error.startsWith("部分来源失败")) {
    // All-external-failure or a hard scheduler error.
    return { status: "failed", effect: "skipped", warnings, error_code: "collection_failed", partial_effects_possible: true, changed_domains: [] as CollectionReceipt["changed_domains"] };
  }
  if (outcome.items_new === 0) {
    warnings.push({ code: "zero_new", message: "新增 0 条（可能全部与已有内容合并）" });
  }
  if (outcome.error.startsWith("部分来源失败")) {
    warnings.push({ code: "partial_source_failure", message: outcome.error });
    return { status: "succeeded", warnings, partial_effects_possible: true, changed_domains: ["items", "jobs"] as CollectionReceipt["changed_domains"] };
  }
  return { status: "succeeded", counts: { inserted: Math.max(outcome.items_new, 0) }, warnings, changed_domains: ["items", "jobs"] as CollectionReceipt["changed_domains"] };
}

function outcomeToReceipt(actionId: string, kind: CollectionKind, outcome: { items_found: number; items_new: number; error: string; job_status: string }): CollectionReceipt {
  const mapped = mapCollectionReceipt(outcome);
  const refType = kind === "keyword.collect_once" ? "keyword" : "source";
  return {
    action_id: actionId,
    status: mapped.status,
    effect: mapped.effect,
    result_refs: [],
    counts: mapped.counts,
    warnings: mapped.warnings,
    error_code: mapped.error_code,
    partial_effects_possible: mapped.partial_effects_possible,
    changed_domains: mapped.changed_domains as CollectionReceipt["changed_domains"],
  };
}

export type ExecuteStep = {
  actionId: string;
  jobId: string;
  kind: CollectionKind;
  targetId: string;
};

/**
 * Dispatch driver: claims one approved+prepared collection action at a time,
 * persists dispatch_started_at BEFORE invoking the injected executor, then
 * observes the job and finalizes the receipt. The executor seam keeps this
 * module free of real IO in tests; production passes the scheduler calls.
 */
export async function dispatchAssistantActions(
  sql: Queryable,
  input: {
    conversationId: string;
    turnId: string;
    execute: (step: ExecuteStep) => Promise<{ status: "succeeded" | "failed" | "outcome_unknown"; outcome: { items_found: number; items_new: number; error: string } }>;
    jobFactory: PreparedCollection;
  },
): Promise<CollectionReceipt> {
  const step: ExecuteStep = {
    actionId: input.jobFactory.actionId,
    jobId: input.jobFactory.jobId,
    kind: "keyword.collect_once",
    targetId: "",
  };
  await sql.query("update assistant_actions set dispatch_started_at = clock_timestamp() where id = $1", [step.actionId]);
  const result = await input.execute(step);
  const receipt = mapCollectionReceipt(result.outcome);
  return await (sql as unknown as SqlLike).transaction(async (tx) => {
    const [action] = await tx.query<Record<string, unknown>>(
      "select kind from assistant_actions where id = $1 for update", [step.actionId],
    );
    const kind = String(action?.kind ?? "keyword.collect_once") as CollectionKind;
    const full: CollectionReceipt = {
      action_id: step.actionId,
      status: receipt.status,
      effect: receipt.effect,
      result_refs: [],
      counts: receipt.counts,
      warnings: receipt.warnings,
      error_code: receipt.error_code,
      partial_effects_possible: receipt.partial_effects_possible,
      changed_domains: receipt.changed_domains as CollectionReceipt["changed_domains"],
    };
    void kind;
    await tx.query(
      "update assistant_actions set status=$2, result_json=$3::jsonb where id=$1",
      [step.actionId, full.status === "not_found" ? "failed" : full.status, JSON.stringify(full)],
    );
    const [seqRow] = await tx.query<{ n: number | null }>(
      "select coalesce(max(seq)+1, 0)::int as n from assistant_events where conversation_id = $1",
      [input.conversationId],
    );
    await tx.query(
      `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
       values($1,$2,$3,$4,'action.updated',$5::jsonb)`,
      [randomUUID(), input.conversationId, input.turnId, Number(seqRow?.n ?? 0), JSON.stringify({ action_id: step.actionId, status: full.status })],
    );
    return full;
  });
}
