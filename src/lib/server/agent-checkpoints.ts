type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

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
  const [run] = await sql.query<{ claim_token: string; status: string }>(
    "select claim_token, status from ai_runs where id = $1",
    [input.runId],
  );
  if (!run || run.status !== "running" || run.claim_token !== input.claimToken) return "stale";
  await sql.query(
    `insert into agent_checkpoints (check_point_id, run_id, claim_token, sequence, schema_version, runtime_version, payload)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (check_point_id) do update
       set payload = excluded.payload, sequence = excluded.sequence, claim_token = excluded.claim_token
     where agent_checkpoints.claim_token = excluded.claim_token`,
    [input.checkPointId, input.runId, input.claimToken, input.sequence, input.schemaVersion, input.runtimeVersion, input.payload],
  );
  return "ok";
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
