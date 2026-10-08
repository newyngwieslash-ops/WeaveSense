import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beginRun } from "../../../src/lib/server/agent-runs.ts";
import type { AgentSql } from "../../../src/lib/server/agent-transaction.ts";

export async function researchTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  const migrations = new URL("../../../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    await pg.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
    async transaction<T>(fn: (tx: AgentSql) => Promise<T>): Promise<T> {
      return pg.transaction(tx => fn({ query: async <R>(text: string, params: unknown[] = []) => (await tx.query<R>(text, params)).rows }));
    },
  };
  return { pg, sql };
}

export async function testResearchRun(sql: Awaited<ReturnType<typeof researchTestDb>>["sql"], overrides: Record<string, unknown> = {}) {
  const runId = randomUUID(), claimToken = randomUUID();
  const policy = { version: "loom-agent-v1", max_model_calls: 7, max_tool_calls: 4, max_output_tokens_per_call: 1800 };
  const requestJson = { governed: false, question: "材料支持什么结论？", sources: [], scope: "corpus", policy,
    model_profile: { model: "fake", input_per_million: 2, output_per_million: 4 },
    review_policy: { mode: "enforce", version: policy.version, question: "材料支持什么结论？", model: "fake", max_output_tokens_per_call: 1800 },
    role_limits: { producer: 6, reviewer: 1 }, ...overrides };
  let jobId: string | undefined;
  if (requestJson.governed) {
    jobId = randomUUID();
    await sql.query(`insert into ai_jobs(id,item_id,material_hash,policy_version,status,claim_token,lease_until,runtime_provider,job_kind,payload)
      values($1,$2,'materials',$3,'running',$4,clock_timestamp()+interval '60 seconds',$5,'research',$6::jsonb)`,
    [jobId, "research:" + runId, policy.version, claimToken, overrides.provider ?? "eino", JSON.stringify(requestJson)]);
    const [clock] = await sql.query<{ day: string }>("select to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day");
    await sql.query("insert into ai_budget_days(day,price_version,reserved_count,reserved_rmb) values($1,'test-price',1,10) on conflict(day,price_version) do update set reserved_count=ai_budget_days.reserved_count+1,reserved_rmb=ai_budget_days.reserved_rmb+10", [clock.day]);
    await sql.query(`insert into ai_budget_reservations(id,job_id,day,price_version,reserved_rmb,status,pricing)
      values($1,$2,$3,'test-price',10,'reserved',$4::jsonb)`, [randomUUID(), jobId, clock.day, JSON.stringify({ ...requestJson.model_profile, daily_limit: 20, daily_budget_rmb: 200 })]);
  }
  const begun = await beginRun(sql, { id: runId, requestId: randomUUID(), mode: "research", provider: overrides.provider === "opencode" ? "opencode" : "eino", jobId,
    inputHash: "intent", materialHash: "materials", policyVersion: policy.version, requestJson,
    claimToken, expiresAt: new Date(Date.now() + 120_000).toISOString(), dataTokenHash: "producer-token-hash" });
  if (begun.kind !== "won") throw new Error("test_run_failed");
  return { runId, claimToken, requestJson };
}
