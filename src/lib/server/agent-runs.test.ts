import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { beginRun, failRun, finishRun, getRun, hashCanonical } from "./agent-runs.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const sql = {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    },
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  return { pg, sql };
}

const base = {
  id: "run-1",
  requestId: "req-1",
  mode: "analyze_item" as const,
  provider: "eino" as const,
  inputHash: "hash-a",
  materialHash: "mat-a",
  policyVersion: "loom-agent-v1",
  requestJson: { item_id: "item-1" },
  claimToken: "claim-1",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test("concurrent beginRun with the same request_id elects one winner", async () => {
  const { pg, sql } = await setup();
  const first = beginRun(sql, base);
  const second = beginRun(sql, { ...base, id: "run-2", claimToken: "claim-2" });
  const [a, b] = await Promise.all([first, second]);
  const outcomes = [a, b];
  assert.equal(outcomes.filter((o) => o.kind === "won").length, 1);
  assert.equal(outcomes.filter((o) => o.kind === "in_progress").length, 1);
  const rows = await sql.query<{ id: string }>("select id from ai_runs");
  assert.equal(rows.length, 1);
  await pg.close();
});

test("same request_id with a different input_hash is a conflict", async () => {
  const { pg, sql } = await setup();
  const first = await beginRun(sql, base);
  assert.equal(first.kind, "won");
  const conflict = await beginRun(sql, { ...base, id: "run-2", inputHash: "hash-b", claimToken: "claim-2" });
  assert.equal(conflict.kind, "conflict");
  await pg.close();
});

test("successful run can be replayed without a second insert", async () => {
  const { pg, sql } = await setup();
  const first = await beginRun(sql, base);
  assert.equal(first.kind, "won");
  const saved = await finishRun(sql, {
    id: base.id,
    claimToken: base.claimToken,
    responseJson: { ok: true },
    model: "compat-model",
    promptVersion: "loom-agent-v1",
    skillVersions: {},
    inputTokens: 1,
    outputTokens: 2,
    modelCalls: 1,
    toolCalls: 0,
  });
  assert.equal(saved, true);
  const replay = await beginRun(sql, { ...base, id: "run-2", claimToken: "claim-2" });
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") assert.deepEqual(replay.responseJson, { ok: true });
  const rows = await sql.query("select id from ai_runs");
  assert.equal(rows.length, 1);
  await pg.close();
});

test("expired running claim cannot finish", async () => {
  const { pg, sql } = await setup();
  const first = await beginRun(sql, { ...base, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(first.kind, "won");
  const saved = await finishRun(sql, {
    id: base.id,
    claimToken: base.claimToken,
    responseJson: { ok: true },
    model: "compat-model",
    promptVersion: "loom-agent-v1",
    skillVersions: {},
    inputTokens: null,
    outputTokens: null,
    modelCalls: 1,
    toolCalls: 0,
  });
  assert.equal(saved, false);
  const run = await getRun(sql, base.id);
  assert.equal(run?.status, "running");
  await pg.close();
});

test("expired running requests converge instead of staying in_progress", async () => {
  const { pg, sql } = await setup();
  const first = await beginRun(sql, { ...base, expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(first.kind, "won");
  const retry = await beginRun(sql, { ...base, id: "run-2", claimToken: "claim-2" });
  assert.notEqual(retry.kind, "in_progress");
  assert.equal(retry.kind, "failed");
  const run = await getRun(sql, base.id);
  assert.equal(run?.status, "timed_out");
  await pg.close();
});

test("wrong claim_token cannot change status", async () => {
  const { pg, sql } = await setup();
  assert.equal((await beginRun(sql, base)).kind, "won");
  assert.equal(await failRun(sql, { id: base.id, claimToken: "other", errorCode: "model_timeout" }), false);
  const run = await getRun(sql, base.id);
  assert.equal(run?.status, "running");
  await pg.close();
});

test("hashCanonical is order-independent for the same fields", () => {
  assert.equal(
    hashCanonical({ b: 2, a: 1 }),
    hashCanonical({ a: 1, b: 2 }),
  );
  assert.notEqual(hashCanonical({ a: 1 }), hashCanonical({ a: 2 }));
});
