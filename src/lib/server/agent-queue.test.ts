import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  claimAiJob,
  enqueueReadyAnalyses,
  enqueueResearchJob,
  finishAiJob,
  expireQueuedResearchJobs,
  cancelQueuedResearchJobs,
  POLICY_VERSION,
} from "./agent-queue.ts";
import { materialFingerprint } from "./agent-context.ts";
import type { ItemRow } from "../types.ts";

async function setup(runtimeMigration = true) {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0007_extract_target_state.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql", ...(runtimeMigration ? ["0023_research_runtime.sql","0027_assistant_runtime.sql"] : [])]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources (id, platform, name) values ('s','rss','信源')");
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

function item(id: string, body: string): ItemRow {
  return {
    id, source_id: "s", platform: "rss", external_id: id, title: "标题", body, author: "",
    url: "", media_type: "article", media_urls: [], thumbnail_url: "", views: null, likes: null,
    published_at: "2026-09-07T01:00:00.000Z", collected_at: "2026-09-07T01:00:00.000Z",
    pipeline_status: "extracted", extra: {}, matched_keywords: [], source_name: "信源",
  };
}

test("same item/material/policy enqueues once", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('a','s','rss','a','标题','正文足够长','extracted')");
  const cfg = { autoAnalyze: true, dailyLimit: 10, dailyBudgetRmb: 20, priceVersion: "v1", worstCostRmb: 1 };
  const first = await enqueueReadyAnalyses(sql, cfg, "2026-09-07");
  const second = await enqueueReadyAnalyses(sql, cfg, "2026-09-07");
  assert.equal(first.enqueued, 1);
  assert.equal(second.enqueued, 0);
  const rows = await sql.query("select id from ai_jobs");
  assert.equal(rows.length, 1);
  await pg.close();
});

test("empty body, pending OCR, failed media, and existing analysis are skipped", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('empty','s','rss','empty','t','   ','extracted')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('ocr','s','rss','ocr','t','正文足够长','ingested')");
  await pg.query("insert into extract_jobs (id,item_id,kind,status) values ('j1','ocr','ocr','pending')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('fail','s','rss','fail','t','正文足够长','extracted')");
  await pg.query("insert into extract_jobs (id,item_id,kind,status,error) values ('j2','fail','ocr','error','vision failed')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('done','s','rss','done','t','正文足够长','analyzed')");
  const hash = materialFingerprint({ ...item("done", "正文足够长"), title: "t", author: "", url: "", published_at: null });
  await pg.query("insert into ai_runs (id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at) values ('run-done','req-done','analyze_item','eino','h',$1,'loom-agent-v1','{}','succeeded','c', now() + interval '1 hour')", [hash]);
  await pg.query("insert into analyses (id,item_id,summary,run_id) values ('an1','done','s','run-done')");
  const result = await enqueueReadyAnalyses(sql, {
    autoAnalyze: true, dailyLimit: 10, dailyBudgetRmb: 20, priceVersion: "v1", worstCostRmb: 1,
  }, "2026-09-07");
  assert.equal(result.enqueued, 0);
  await pg.close();
});

test("two schedulers claim the same queued job once", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('a','s','rss','a','标题','正文足够长','extracted')");
  await enqueueReadyAnalyses(sql, {
    autoAnalyze: true, dailyLimit: 10, dailyBudgetRmb: 20, priceVersion: "v1", worstCostRmb: 1,
  }, "2026-09-07");
  const first = claimAiJob(sql, { worker: "w1", leaseSeconds: 30 });
  const second = claimAiJob(sql, { worker: "w2", leaseSeconds: 30 });
  const [a, b] = await Promise.all([first, second]);
  const claimed = [a, b].filter(Boolean);
  assert.equal(claimed.length, 1);
  await pg.close();
});

test("daily count and RMB budget cannot overspend concurrently", async () => {
  const { pg, sql } = await setup();
  for (const id of ["a", "b", "c"]) {
    await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ($1,'s','rss',$1,'标题','正文足够长','extracted')", [id]);
  }
  const cfg = { autoAnalyze: true, dailyLimit: 2, dailyBudgetRmb: 1.5, priceVersion: "v1", worstCostRmb: 1 };
  const result = await enqueueReadyAnalyses(sql, cfg, "2026-09-07");
  assert.equal(result.enqueued, 1);
  const jobs = await sql.query("select id from ai_jobs");
  assert.equal(jobs.length, 1);
  await pg.close();
});

test("AUTO_ANALYZE=false enqueues zero jobs", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('a','s','rss','a','标题','正文足够长','extracted')");
  const result = await enqueueReadyAnalyses(sql, {
    autoAnalyze: false, dailyLimit: 10, dailyBudgetRmb: 20, priceVersion: "v1", worstCostRmb: 1,
  }, "2026-09-07");
  assert.equal(result.enqueued, 0);
  assert.equal((await sql.query("select id from ai_jobs")).length, 0);
  await pg.close();
});

test("outcome_unknown jobs are not auto-retried", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('a','s','rss','a','标题','正文足够长','extracted')");
  await enqueueReadyAnalyses(sql, {
    autoAnalyze: true, dailyLimit: 10, dailyBudgetRmb: 20, priceVersion: "v1", worstCostRmb: 1,
  }, "2026-09-07");
  const job = await claimAiJob(sql, { worker: "w1", leaseSeconds: 30 });
  assert.ok(job);
  await finishAiJob(sql, { id: job.id, claimToken: job.claim_token, status: "outcome_unknown" });
  const again = await claimAiJob(sql, { worker: "w2", leaseSeconds: 30 });
  assert.equal(again, null);
  await pg.close();
});

test("research jobs are not claimed by the analyze worker", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('a','s','rss','a','标题','正文足够长','extracted')");
  await enqueueReadyAnalyses(sql, {
    autoAnalyze: true, dailyLimit: 10, dailyBudgetRmb: 20, priceVersion: "v1", worstCostRmb: 1,
  }, "2026-09-07");
  await enqueueResearchJob(sql, { question: "固态电池", requestId: "11111111-1111-4111-8111-111111111111", materialHash: "h" });
  const analyze = await claimAiJob(sql, { worker: "cron", leaseSeconds: 30, kind: "analyze" });
  const research = await claimAiJob(sql, { worker: "agent", leaseSeconds: 30, kind: "research" });
  assert.ok(analyze);
  assert.ok(research);
  assert.notEqual(analyze.id, research.id);
  assert.equal(research.item_id.startsWith("research:"), true);
  await pg.close();
});

test("zero daily count and money budgets enqueue no analysis", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body,pipeline_status) values ('a','s','rss','a','标题','正文足够长','extracted')");
  const result = await enqueueReadyAnalyses(sql, {
    autoAnalyze: true, dailyLimit: 0, dailyBudgetRmb: 0, priceVersion: "v1", worstCostRmb: 1,
  }, "2026-09-08");
  assert.equal(result.enqueued, 0);
  assert.equal((await sql.query("select id from ai_jobs")).length, 0);
  await pg.close();
});

test("policy version is the identity used for uniqueness", () => {
  assert.equal(POLICY_VERSION, "loom-agent-v1");
});

test("runtime ownership is filtered before a job can be claimed", async () => {
  const f = await setup();
  try {
    const opencode = await enqueueResearchJob(f.sql, { question: "opencode研究", requestId: "opencode-owner", materialHash: "h", snapshot: { provider: "opencode" } });
    const eino = await enqueueResearchJob(f.sql, { question: "eino研究", requestId: "eino-owner", materialHash: "h" });
    assert.ok(opencode); assert.ok(eino);
    const e = await claimAiJob(f.sql, { worker: "eino", kind: "research", leaseSeconds: 30 });
    assert.equal(e?.id, eino.id);
    const o = await claimAiJob(f.sql, { worker: "opencode", provider: "opencode", kind: "research", leaseSeconds: 30 });
    assert.equal(o?.id, opencode.id);
    assert.equal(await claimAiJob(f.sql, { worker: "eino", kind: "research", leaseSeconds: 30 }), null);
  } finally { await f.pg.close(); }
});

test("queue expiration and explicit capability cancellation affect only the selected runtime", async () => {
  const f = await setup();
  try {
    const jobs = [];
    for (const provider of ["eino", "opencode"] as const) {
      const job = await enqueueResearchJob(f.sql, { question: `${provider}研究`, requestId: `${provider}-expiry`, materialHash: "h", snapshot: { provider } });
      assert.ok(job); jobs.push(job);
      await f.sql.query("update ai_jobs set payload=jsonb_set(payload,'{queue_expires_at}','\"2000-01-01T00:00:00.000Z\"'::jsonb) where id=$1", [job.id]);
    }
    assert.equal(await expireQueuedResearchJobs(f.sql, "eino"), 1);
    assert.equal((await f.sql.query<{ status: string }>("select status from ai_jobs where id=$1", [jobs[1].id]))[0].status, "queued");
    assert.equal(await cancelQueuedResearchJobs(f.sql, "eino"), 0);
    assert.equal(await cancelQueuedResearchJobs(f.sql, "opencode"), 1);
    assert.equal((await f.sql.query<{ error_code: string }>("select error_code from ai_jobs where id=$1", [jobs[1].id]))[0].error_code, "capability_disabled");
  } finally { await f.pg.close(); }
});

test("request replay cannot switch frozen review, model or Skill intent", async () => {
  const f = await setup();
  try {
    const snapshot = { governed: false, provider: "eino", scope: "corpus", sources: [], review_policy: { mode: "shadow", version: "review-1" }, model_profile: { model: "fake-a" }, skill_snapshot_digest: "a".repeat(64), role_limits: { producer: 6, reviewer: 1 }, policy: { max_model_calls: 7 }, budget: { dailyLimit: 2 } };
    const input = { question: "固定意图", requestId: "frozen-intent", materialHash: "h", snapshot };
    assert.equal((await enqueueResearchJob(f.sql, input))?.kind, "won");
    assert.equal((await enqueueResearchJob(f.sql, input))?.kind, "replay");
    for (const replacement of [{ provider: "opencode" }, { scope: "other" }, { review_policy: { mode: "enforce", version: "review-1" } }, { model_profile: { model: "fake-b" } }, { skill_snapshot_digest: "b".repeat(64) }, { governed: true }, { role_limits: { producer: 7, reviewer: 0 } }, { policy: { max_model_calls: 8 } }, { budget: { dailyLimit: 3 } }, { sources: [{ item_id: "other" }] }]) {
      assert.equal((await enqueueResearchJob(f.sql, { ...input, snapshot: { ...snapshot, ...replacement } }))?.kind, "conflict");
    }
  } finally { await f.pg.close(); }
});

test("runtime migration proves old ownership and preserves linked runs", async () => {
  const f = await setup(false);
  try {
    await f.sql.query("insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at) values('linked-run','linked-request','research','eino','h','m','v','{\"provider\":\"eino\",\"mode\":\"research\"}','running','claim',now()+interval '1 minute')");
    // Pre-0023 rows: no job_kind or runtime_provider yet — 0023 backfills them.
    await f.sql.query("insert into ai_jobs(id,item_id,material_hash,policy_version,status,payload,run_id) values('auto-old','item-old','h','v','queued','{}',null),('research-old','research:old','h','v','queued','{\"provider\":\"eino\",\"mode\":\"research\"}',null),('linked-old','research:linked','h','v','running','{}','linked-run')");
    await f.pg.transaction(tx => tx.exec(readFileSync(new URL("../../../migrations/0023_research_runtime.sql", import.meta.url), "utf8")));
    const jobs = await f.sql.query<{ runtime_provider: string }>("select runtime_provider from ai_jobs order by id");
    assert.deepEqual(jobs.map(row => row.runtime_provider), ["eino", "eino", "eino"]);
    assert.equal((await f.sql.query("select id from ai_runs where id='linked-run'")).length, 1);
    await f.sql.query("insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at) values('opencode-run','opencode-request','research','opencode','h','m','v','{}','running','claim',now()+interval '1 minute')");
    const binding = ["opencode-run", "1.3.13", "a".repeat(64), "instance-1", "00000000-0000-4000-8000-000000000001", "session-1", "dispatch-1"];
    await f.sql.query("insert into ai_runtime_bindings(run_id,provider,runtime_version,config_digest,instance_id,epoch,session_id,dispatch_id) values($1,'opencode',$2,$3,$4,$5,$6,$7)", binding);
    await assert.rejects(f.sql.query("insert into ai_runtime_bindings(run_id,provider,runtime_version,config_digest,instance_id,epoch,session_id,dispatch_id) values($1,'opencode',$2,$3,$4,$5,$6,$7)", binding), /duplicate/);
    await assert.rejects(f.sql.query("update ai_runs set provider='unknown' where id='linked-run'"), /check constraint/);
  } finally { await f.pg.close(); }
});

test("runtime migration aborts unknown or contradictory historical ownership with job IDs", async () => {
  for (const fixture of [
    { id: "missing-owner", item: "research:unknown", payload: "{}" },
    { id: "unknown-owner", item: "research:unknown", payload: '{"provider":"future","mode":"research"}' },
    { id: "contradictory-owner", item: "research:linked", payload: '{"provider":"opencode","mode":"research"}', linked: true },
  ]) {
    const f = await setup(false);
    try {
      if (fixture.linked) await f.sql.query("insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at) values('linked-run','linked-request','research','eino','h','m','v','{}','running','claim',now()+interval '1 minute')");
      // Pre-0023 rows have neither job_kind nor runtime_provider.
      await f.sql.query("insert into ai_jobs(id,item_id,material_hash,policy_version,status,payload,run_id) values($1,$2,'h','v','queued',$3::jsonb,$4)", [fixture.id, fixture.item, fixture.payload, fixture.linked ? "linked-run" : null]);
      await assert.rejects(f.pg.transaction(tx => tx.exec(readFileSync(new URL("../../../migrations/0023_research_runtime.sql", import.meta.url), "utf8"))), new RegExp(fixture.id));
      assert.equal((await f.sql.query("select column_name from information_schema.columns where table_name='ai_jobs' and column_name='runtime_provider'")).length, 0);
      assert.equal((await f.sql.query("select id from ai_jobs where id=$1", [fixture.id])).length, 1);
    } finally { await f.pg.close(); }
  }
});
