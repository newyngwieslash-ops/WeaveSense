import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { beginRun } from "./agent-runs.ts";
import { loadCheckpoint, saveCheckpoint } from "./agent-checkpoints.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const sql = {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    }, async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  const begun = await beginRun(sql, {
    id: randomUUID(), requestId: randomUUID(), mode: "research", provider: "eino",
    inputHash: "h", materialHash: "m", policyVersion: "loom-agent-v1", requestJson: {},
    claimToken: "claim-1", expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(begun.kind, "won");
  return { pg, sql, runId: begun.kind === "won" ? begun.run.id : "", claim: "claim-1" };
}

test("only the current claim_token can save a checkpoint", async () => {
  const { pg, sql, runId, claim } = await setup();
  const id = "cp-1";
  const ok = await saveCheckpoint(sql, {
    checkPointId: id, runId, claimToken: claim, sequence: 1,
    schemaVersion: "1", runtimeVersion: "eino-v0.9.19", payload: Buffer.from("state"),
  });
  assert.equal(ok, "ok");
  const stale = await saveCheckpoint(sql, {
    checkPointId: id, runId, claimToken: "old-worker", sequence: 2,
    schemaVersion: "1", runtimeVersion: "eino-v0.9.19", payload: Buffer.from("hijack"),
  });
  assert.equal(stale, "stale");
  const loaded = await loadCheckpoint(sql, { checkPointId: id, runId, runtimeVersion: "eino-v0.9.19" });
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.payload.toString(), "state");
  await pg.close();
});

test("runtime version mismatch refuses restore", async () => {
  const { pg, sql, runId, claim } = await setup();
  await saveCheckpoint(sql, {
    checkPointId: "cp-2", runId, claimToken: claim, sequence: 1,
    schemaVersion: "1", runtimeVersion: "eino-v0.9.19", payload: Buffer.from("state"),
  });
  const loaded = await loadCheckpoint(sql, { checkPointId: "cp-2", runId, runtimeVersion: "eino-v1.0.0" });
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.error, "version_mismatch");
  await pg.close();
});
