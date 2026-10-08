import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { claimAiJob, enqueueResearchJob, finishAiJob } from "./agent-queue.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql","0022_research_review.sql","0023_research_runtime.sql","0024_research_call_roles.sql","0027_assistant_runtime.sql"]) {
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

test("two concurrent claims still elect one winner after skip-locked fencing", async () => {
  const { pg, sql } = await setup();
  await enqueueResearchJob(sql, { question: "研究", requestId: "11111111-1111-4111-8111-111111111111", materialHash: "h" });
  const [a, b] = await Promise.all([
    claimAiJob(sql, { worker: "a", leaseSeconds: 30, kind: "research" }),
    claimAiJob(sql, { worker: "b", leaseSeconds: 30, kind: "research" }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  await pg.close();
});

test("expired lease cannot complete even with the original claim token", async () => {
  const { pg, sql } = await setup();
  await enqueueResearchJob(sql, { question: "研究", requestId: "22222222-2222-4222-8222-222222222222", materialHash: "h" });
  const job = await claimAiJob(sql, { worker: "a", leaseSeconds: 30, kind: "research" });
  assert.ok(job);
  await sql.query("update ai_jobs set lease_until = now() - interval '1 minute' where id = $1", [job.id]);
  assert.equal(await finishAiJob(sql, { id: job.id, claimToken: job.claim_token, status: "succeeded" }), false);
  await pg.close();
});
