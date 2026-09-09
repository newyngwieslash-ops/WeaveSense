import { agentTransaction, lockRun, ownsRun, type AgentSql as Queryable } from "./agent-transaction.ts";

const MAX_BYTES = 256 * 1024;

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(Uint8Array.from(value as number[]));
  if (typeof value === "string") {
    if (/^(?:\d{1,3},)+\d{1,3}$/.test(value)) {
      return Buffer.from(value.split(",").map((n) => Number(n)));
    }
    if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "utf8");
  }
  return Buffer.alloc(0);
}

export async function saveCheckpoint(sql: Queryable, input: {
  checkPointId: string;
  runId: string;
  claimToken: string;
  sequence: number;
  schemaVersion: string;
  runtimeVersion: string;
  payload: Buffer;
}): Promise<"ok" | "stale" | "too_large"> {
  if (input.payload.length > MAX_BYTES) return "too_large";
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || !input.checkPointId) return "stale";
  return agentTransaction(sql, async sql => {
  const locked = await lockRun(sql, input.runId);
  if (!await ownsRun(sql, locked, input.claimToken)) return "stale";
  const [existing] = await sql.query<{ payload: unknown; sequence: number; claim_token: string; check_point_id: string; run_id: string; schema_version: string; runtime_version: string }>(
    "select * from agent_checkpoints where check_point_id = $1 or (run_id=$2 and sequence=$3)", [input.checkPointId,input.runId,input.sequence],
  );
  if (existing && (existing.check_point_id !== input.checkPointId || existing.run_id !== input.runId || existing.schema_version !== input.schemaVersion || existing.runtime_version !== input.runtimeVersion)) return "stale";
  if (existing && (String(existing.claim_token) !== input.claimToken || Number(existing.sequence) > input.sequence ||
    (Number(existing.sequence) === input.sequence && !asBuffer(existing.payload).equals(input.payload)))) return "stale";
  if (existing && Number(existing.sequence) === input.sequence) return "ok";
  const rows = await sql.query<{ check_point_id: string }>(
    `insert into agent_checkpoints (check_point_id, run_id, claim_token, sequence, schema_version, runtime_version, payload)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (check_point_id) do update
       set payload = excluded.payload, sequence = excluded.sequence, claim_token = excluded.claim_token
     where agent_checkpoints.claim_token = excluded.claim_token
       and excluded.sequence >= agent_checkpoints.sequence
     returning check_point_id`,
    [input.checkPointId, input.runId, input.claimToken, input.sequence, input.schemaVersion, input.runtimeVersion, input.payload],
  );
  if (rows.length) await sql.query(`update agent_checkpoints set updated_at=clock_timestamp(),
    model_call_count=(select count(*) from ai_model_calls where run_id=$2),
    evidence_event_count=(select jsonb_array_length(events_json) from ai_runs where id=$2)
    where check_point_id=$1`, [input.checkPointId,input.runId]);
  return rows.length === 1 ? "ok" : "stale";
  });
}

export async function loadCheckpoint(sql: Queryable, input: {
  checkPointId: string;
  runId: string;
  runtimeVersion: string;
}): Promise<{ ok: true; payload: Buffer } | { ok: false; error: string }> {
  const [row] = await sql.query<Record<string, unknown>>(
    "select * from agent_checkpoints where check_point_id = $1",
    [input.checkPointId],
  );
  if (!row) return { ok: false, error: "not_found" };
  if (String(row.run_id) !== input.runId) return { ok: false, error: "run_mismatch" };
  if (String(row.runtime_version) !== input.runtimeVersion) return { ok: false, error: "version_mismatch" };
  return { ok: true, payload: asBuffer(row.payload) };
}
