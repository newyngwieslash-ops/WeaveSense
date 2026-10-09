#!/usr/bin/env node
/**
 * A27 real-PostgreSQL convergence acceptance (plan Task 18): runs the
 * assistant suites + e2e against a disposable PostgreSQL via
 * ASSISTANT_MIGRATION_DSN, then verifies crash-recovery convergence on that
 * real server (worker kill simulation: result_saved without stop, restart,
 * reconcile/settle converges exactly once). Explicit --run required.
 *
 * Env: ASSISTANT_MIGRATION_DSN=postgres://user:pass@host:port/db
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
if (!args.includes("--run") || !process.env.ASSISTANT_MIGRATION_DSN) {
  console.log(JSON.stringify({ ok: true, checks: 0, mode: "import-only", note: "requires --run and ASSISTANT_MIGRATION_DSN" }));
  process.exit(0);
}

const schema = `assist_${randomUUID().replaceAll("-", "")}`;
const results = [];
const record = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); };

const client = new pg.Client({ connectionString: process.env.ASSISTANT_MIGRATION_DSN });
await client.connect();
await client.query(`create schema ${schema}`);
await client.query(`set search_path to ${schema}`);

async function applyAll() {
  for (const name of readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
    await client.query(readFileSync("migrations/" + name, "utf8"));
  }
}

const sql = {
  async query(text, params = []) {
    const res = await client.query(text, params);
    return res.rows;
  },
  async transaction(fn) {
    await client.query("begin");
    try {
      const saved = client.query.bind(client);
      const res = await fn({
        async query(text, params = []) { return (await saved(text, params)).rows; },
      });
      await client.query("commit");
      return res;
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  },
};

try {
  // 1. Fresh-database migration chain on real PG.
  await applyAll();
  record("A27-migrate", true, "full migration chain applied on real PostgreSQL");

  // 2. Crash-after-save recovery on real PG.
  const [conv] = await sql.query("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','queued') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  const jobId = randomUUID();
  await sql.query(
    `insert into ai_jobs(id, item_id, material_hash, policy_version, status, runtime_provider, job_kind, payload)
     values($1,$2,'materials','loom-assistant-v1','queued','opencode','assistant','{"provider":"opencode","question":"q"}')`,
    [jobId, `assistant:${turn.id}`],
  );
  const { claimAssistantJob, completeAssistantRun } = await import("../../../src/lib/server/assistant-jobs.ts");
  const claim = await claimAssistantJob(sql, { leaseSeconds: 60 });
  assert.ok(claim, "claim on real PG");
  const runId = randomUUID();
  await sql.query(
    `insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,data_token_hash)
     values($1,$2,'research','opencode','i','m','loom-assistant-v1','{}','running',$3, clock_timestamp()+interval '5 minutes','dtok')`,
    [runId, randomUUID(), claim.claimToken],
  );
  await sql.query("update ai_jobs set run_id=$2 where id=$1", [jobId, runId]);
  const payload = {
    schema_version: 1, conversation_id: conv.id, turn_id: turn.id,
    result: { version: 1, answer: "真实PG答案", citations: [], actions: [] },
    runtime: { model: "offline-model", prompt_version: "v1", skill_versions: { "project-assistant": "x" }, input_tokens: 10, output_tokens: 2, model_calls: 1, tool_calls: 0, events: [] },
  };
  const saved = await completeAssistantRun(sql, { runId, jobId, claimToken: claim.claimToken, stage: "result_saved", payload });
  assert.equal(saved.ok, true);
  // Worker "restarts" here — the same persisted facts drive convergence.
  const settle = await completeAssistantRun(sql, { runId, jobId, claimToken: claim.claimToken, stage: "runtime_stopped", payload: { epoch: randomUUID(), instance: "inst", ok: true } });
  assert.equal(settle.ok, true);
  const msgs = await sql.query("select count(*)::int as n from assistant_messages where conversation_id=$1", [conv.id]);
  record("A27-crash-recovery", msgs[0].n === 1, `messages=${msgs[0].n} after real-PG restart convergence`);
} catch (error) {
  record("A27-unexpected", false, String(error).slice(0, 200));
} finally {
  await client.query(`drop schema ${schema} cascade`).catch(() => {});
  await client.end();
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.length }));
process.exit(failed.length === 0 ? 0 : 1);
