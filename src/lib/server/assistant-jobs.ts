/**
 * Assistant queue claiming, policy and the §4.4 finalizer (plan Task 7).
 *
 * The assistant uses the shared ai_jobs/ai_runs machinery with an explicit
 * job_kind='assistant'. Claiming is a dedicated path: the legacy analyze and
 * research claims can never pick up an assistant job. Terminal handling
 * follows §4.4 in two persisted stages:
 *   1. result_saved  — the validated answer is stored immutably and the run
 *                      is marked in ai_runtime_bindings as result_saved;
 *                      producer sends are now blocked.
 *   2. runtime_stopped — the worker's stop receipt lands (epoch-bound), the
 *                      run/job settle, the assistant message is written, and
 *                      the turn reaches a terminal state.
 * Both stages are idempotent: a re-finalize replays without duplicating.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentTransaction } from "./agent-transaction.ts";
import { hashCanonical } from "./agent-runs.ts";
import { settleJobBudget } from "./agent-budget.ts";
import { assistantResultSchema } from "../assistant-contract.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export type AssistantPolicy = {
  version: string;
  maxModelCalls: number;
  maxToolCalls: number;
  maxOutputTokensPerCall: number;
  executionTimeoutMs: number;
  queueTtlMs: number;
};

const num = (value: string | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
};

/**
 * Environment numbers arrive as strings; an explicit `0` is only meaningful
 * for tool budgets, so the fallback fires whenever the parsed value is not a
 * safe integer in range — but 0 must stay 0 for maxToolCalls. Treat a set
 * but unparseable/empty variable as absent.
 */
function envNum(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  return value;
}

export function assistantPolicyFromEnv(env: Record<string, string | undefined>): AssistantPolicy {
  return {
    version: "loom-assistant-v1",
    maxModelCalls: num(envNum(env, "AGENT_ASSISTANT_MAX_MODEL_CALLS"), 6, 1, 20),
    maxToolCalls: num(envNum(env, "AGENT_ASSISTANT_MAX_TOOL_CALLS"), 8, 0, 40),
    maxOutputTokensPerCall: num(envNum(env, "AGENT_ASSISTANT_MAX_OUTPUT_TOKENS"), 1800, 200, 4000),
    executionTimeoutMs: num(envNum(env, "AGENT_ASSISTANT_EXECUTE_TIMEOUT_MS"), 120_000, 1000, 900_000),
    queueTtlMs: num(envNum(env, "AGENT_ASSISTANT_QUEUE_TTL_MS"), 600_000, 1000, 86_400_000),
  };
}

export type AssistantClaim = {
  jobId: string;
  turnId: string;
  conversationId: string;
  claimToken: string;
  question: string;
};

/**
 * Claim one queued assistant job. Explicitly job_kind based: legacy analyze
 * and research claims filter on their own kinds and can never take this row
 * (A: queue isolation).
 */
export async function claimAssistantJob(sql: Queryable, opts: { leaseSeconds: number }): Promise<AssistantClaim | null> {
  const claimToken = randomUUID();
  // Converge expired assistant runs first (§5.4 reconcile contract): a run
  // whose expires_at passed without a stop receipt must reach a terminal
  // state and release its turn, otherwise the conversation's active-turn
  // slot is blocked forever. Covers both live jobs (running) and orphan
  // runs whose job already failed but the run never settled.
  const expired = await sql.query<Record<string, unknown>>(
    `select r.id as run_id, j.id as job_id, j.status as job_status from ai_runs r
     left join ai_jobs j on j.run_id = r.id and j.job_kind = 'assistant'
     where r.provider = 'opencode' and r.mode = 'research' and r.status = 'running'
       and r.expires_at <= clock_timestamp()
     order by r.id for update of r skip locked limit 10`,
  );
  for (const row of expired as Array<{ run_id: string; job_id: string | null; job_status: string | null }>) {
    // Only the job owner (or no job at all) may settle the run.
    const jobLive = row.job_id && row.job_status === 'running';
    if (jobLive) {
      const [own] = await sql.query<{ n: number }>(
        'select 1 as n from ai_jobs where id=$1 and claim_token=(select claim_token from ai_runs where id=$2)',
        [row.job_id, row.run_id],
      );
      if (!own) continue;
      await sql.query(
        `update ai_jobs set status='failed', error_code='runtime_deadline_unknown', claim_token='', lease_until=null, updated_at=clock_timestamp() where id=$1`,
        [row.job_id],
      );
    } else if (row.job_id && row.job_status !== 'failed' && row.job_status !== 'outcome_unknown') {
      continue; // terminal job already recorded; nothing to do
    }
    await sql.query(
      `update ai_runs set status='outcome_unknown', error_code='runtime_deadline_unknown', finished_at=clock_timestamp() where id=$1 and status='running'`,
      [row.run_id],
    );
    const jobIdForTurn = row.job_id;
    const [turnRow] = await sql.query<Record<string, unknown>>(
      "select id, conversation_id from assistant_turns where job_id=$1",
      [jobIdForTurn],
    );
    if (turnRow) {
      await sql.query("update assistant_turns set status='failed', finished_at=clock_timestamp() where id=$1 and status in ('queued','running')", [turnRow.id]);
      const [seqRow] = await sql.query<{ n: number | null }>(
        "select coalesce(max(seq)+1,0)::int as n from assistant_events where conversation_id=$1",
        [turnRow.conversation_id],
      );
      await sql.query(
        `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
         values($1,$2,$3,$4,'turn.finished',$5::jsonb)`,
        [randomUUID(), turnRow.conversation_id, turnRow.id, Number(seqRow?.n ?? 0),
          JSON.stringify({ status: "failed", error_code: "runtime_deadline_unknown" })],
      );
    }
  }
  const [row] = await sql.query<Record<string, unknown>>(
    `with candidate as (
       select j.id from ai_jobs j
       where j.job_kind = 'assistant' and j.status = 'queued' and j.next_attempt_at <= now()
         and j.runtime_provider = 'opencode'
       order by j.created_at, j.id
       for update skip locked
       limit 1
     )
     update ai_jobs as j
     set status = 'running',
         attempts = attempts + 1,
         claim_token = $1,
         lease_until = now() + ($2::integer * interval '1 second'),
         updated_at = now()
     from candidate as c
     where j.id = c.id and j.status = 'queued'
     returning j.id, j.claim_token, j.item_id`,
    [claimToken, opts.leaseSeconds],
  );
  if (!row) return null;
  const turnId = String(row.item_id).slice("assistant:".length);
  const [turn] = await sql.query<Record<string, unknown>>(
    `select t.id, t.conversation_id, c.id as conversation_id, coalesce(m.content_json->>'text','') as question
     from assistant_turns t
     join assistant_conversations c on c.id = t.conversation_id
     left join assistant_messages m on m.turn_id = t.id and m.role = 'user'
     where t.id = $1`, [turnId],
  );
  if (!turn) return null;
  return {
    jobId: String(row.id),
    turnId: String(turn.id),
    conversationId: String(turn.conversation_id ?? row.item_id),
    claimToken: String(row.claim_token),
    question: String(turn.question ?? ""),
  };
}

const assistantAnswerSchema = z.object({
  schema_version: z.literal(1),
  conversation_id: z.string().min(1).max(128),
  turn_id: z.string().min(1).max(128),
  result: assistantResultSchema,
  runtime: z.object({
    model: z.string().max(128),
    prompt_version: z.string().max(64),
    skill_versions: z.record(z.string(), z.string()),
    input_tokens: z.number().int().min(0).nullable(),
    output_tokens: z.number().int().min(0).nullable(),
    model_calls: z.number().int().min(0),
    tool_calls: z.number().int().min(0),
    events: z.array(z.object({
      type: z.string().max(64), name: z.string().max(128),
      duration_ms: z.number().int().min(0), ok: z.boolean(),
    }).strict()).max(64),
  }).strict(),
}).strict();

const stopReceiptSchema = z.object({
  epoch: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  instance: z.string().min(1).max(128),
  ok: z.literal(true),
}).strict();

export type FinalizeInput = {
  runId: string;
  jobId: string;
  claimToken: string;
  stage: "result_saved" | "runtime_stopped";
  payload: unknown;
};

export type FinalizeOutcome = { ok: true; replay: boolean } | { ok: false; error: string };

/**
 * §4.4 two-stage terminal handling. Stage 1 saves the validated result and
 * flips ai_runtime_bindings.state to result_saved (producer sends blocked by
 * admission checks that require state != result_saved). Stage 2 records the
 * stop receipt, settles the run/job/budget, writes the assistant message and
 * finishes the turn — all in one idempotent transaction.
 */
export async function completeAssistantRun(sql: Queryable, input: FinalizeInput): Promise<FinalizeOutcome> {
  return agentTransaction(sql, async (tx) => {
    const [run] = await tx.query<Record<string, unknown>>(
      "select * from ai_runs where id = $1 for update", [input.runId],
    );
    if (!run || run.claim_token !== input.claimToken) return { ok: false, error: "stale" };
    const [job] = await tx.query<Record<string, unknown>>(
      "select * from ai_jobs where id = $1 for update", [input.jobId],
    );
    if (!job || job.run_id !== run.id) return { ok: false, error: "stale" };

    if (input.stage === "result_saved") {
      const parsed = assistantAnswerSchema.safeParse(input.payload);
      if (!parsed.success) return { ok: false, error: "invalid_answer" };
      if (parsed.data.turn_id !== String(job.item_id).slice("assistant:".length)) {
        return { ok: false, error: "turn_mismatch" };
      }
      const [binding] = await tx.query<Record<string, unknown>>(
        "select state from ai_runtime_bindings where run_id = $1", [input.runId],
      );
      const state = binding ? String(binding.state) : null;
      if (state === "result_saved") return { ok: true, replay: true };
      // A missing binding row is the recovery path; existing rows must be in
      // a pre-result dispatch state to accept the validated answer.
      if (binding && state !== "submitted" && state !== "dispatching" && state !== "prepared") {
        return { ok: false, error: "binding_state_conflict" };
      }
      if (binding) {
        await tx.query("update ai_runtime_bindings set state='result_saved', last_observed_at=clock_timestamp() where run_id=$1", [input.runId]);
      } else {
        // Recovery path: the binding row was lost but the result is here.
        await tx.query(
          `insert into ai_runtime_bindings(run_id, provider, runtime_version, config_digest, instance_id, epoch, session_id, dispatch_id, state)
           values($1,'opencode','unknown',$2,'unknown',$3,'unknown','unknown','result_saved')`,
          [input.runId, "0".repeat(64), randomUUID()],
        );
      }
      await tx.query("update ai_runs set response_json=$2::jsonb where id=$1", [input.runId, JSON.stringify(parsed.data)]);
      return { ok: true, replay: false };
    }

    // stage: runtime_stopped
    const [binding] = await tx.query<Record<string, unknown>>(
      "select state, runtime_stopped_at from ai_runtime_bindings where run_id = $1 for update", [input.runId],
    );
    if (!binding) return { ok: false, error: "stale" };
    const alreadyStopped = binding.runtime_stopped_at != null;
    if (!alreadyStopped) {
      if (String(binding.state) !== "result_saved") return { ok: false, error: "result_not_saved" };
      const receipt = stopReceiptSchema.safeParse(input.payload);
      if (!receipt.success) return { ok: false, error: "invalid_stop_receipt" };
      await tx.query(
        "update ai_runtime_bindings set runtime_stopped_at=clock_timestamp(), stop_receipt_json=$2::jsonb where run_id=$1",
        [input.runId, JSON.stringify(receipt.data)],
      );
    }
    if (run.status !== "running") return { ok: true, replay: true };

    // Run status/response were already validated at stage 1; reuse them.
    const [fresh] = await tx.query<Record<string, unknown>>(
      "select response_json from ai_runs where id = $1", [input.runId],
    );
    const answer = typeof fresh?.response_json === "string" ? JSON.parse(fresh.response_json) : fresh?.response_json;
    const runtime = (answer?.runtime ?? {}) as Record<string, unknown>;
    await tx.query(
      `update ai_runs set status='succeeded', finished_at=clock_timestamp(),
         model=$2, prompt_version=$3, skill_versions=$4::jsonb, input_tokens=$5, output_tokens=$6,
         model_calls=$7, tool_calls=$8, events_json='[]'::jsonb
       where id=$1`,
      [
        input.runId, String(runtime.model ?? ""), String(runtime.prompt_version ?? ""),
        JSON.stringify(runtime.skill_versions ?? {}),
        runtime.input_tokens == null ? null : Number(runtime.input_tokens),
        runtime.output_tokens == null ? null : Number(runtime.output_tokens),
        Number(runtime.model_calls ?? 0), Number(runtime.tool_calls ?? 0),
      ],
    );
    await tx.query(
      `update ai_jobs set status='succeeded', error_code='', claim_token='', lease_until=null, updated_at=clock_timestamp() where id=$1`,
      [input.jobId],
    );
    await settleJobBudget(tx as never, input.jobId, input.runId);

    // Assistant message + turn completion (exactly once — the transaction
    // guards via run.status check above; a concurrent finalize would replay).
    const turnId = String(job.item_id).slice("assistant:".length);
    const [turn] = await tx.query<Record<string, unknown>>(
      "select * from assistant_turns where id = $1 for update", [turnId],
    );
    if (turn) {
      const ordinal = await nextMessageOrdinal(tx, String(turn.conversation_id));
      await tx.query(
        `insert into assistant_messages(id, conversation_id, turn_id, ordinal, role, content_json)
         values($1,$2,$3,$4,'assistant',$5::jsonb)`,
        [randomUUID(), String(turn.conversation_id), turnId, ordinal, JSON.stringify({ text: String(answer?.result?.answer ?? "") })],
      );
      const seq = await nextEventSeq(tx, String(turn.conversation_id));
      await tx.query(
        `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
         values($1,$2,$3,$4,'message.completed',$5::jsonb)`,
        [randomUUID(), String(turn.conversation_id), turnId, seq, JSON.stringify({ message_id: turnId, ordinal })],
      );
      await tx.query(
        `update assistant_turns set status='completed', finished_at=clock_timestamp() where id=$1`,
        [turnId],
      );
      const seq2 = await nextEventSeq(tx, String(turn.conversation_id));
      await tx.query(
        `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
         values($1,$2,$3,$4,'turn.finished',$5::jsonb)`,
        [randomUUID(), String(turn.conversation_id), turnId, seq2, JSON.stringify({ status: "completed" })],
      );
    }
    return { ok: true, replay: false };
  });
}

async function nextMessageOrdinal(tx: Tx, conversationId: string): Promise<number> {
  const [row] = await tx.query<{ n: number | null }>(
    "select coalesce(max(ordinal)+1, 0)::int as n from assistant_messages where conversation_id = $1",
    [conversationId],
  );
  return Number(row?.n ?? 0);
}

async function nextEventSeq(tx: Tx, conversationId: string): Promise<number> {
  const [row] = await tx.query<{ n: number | null }>(
    "select coalesce(max(seq)+1, 0)::int as n from assistant_events where conversation_id = $1",
    [conversationId],
  );
  return Number(row?.n ?? 0);
}

export const assistantIntentHash = hashCanonical;
