import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  claimAiJob,
  enqueueReadyAnalyses,
  enqueueResearchJob,
  finishAiJob,
  POLICY_VERSION,
} from "./agent-queue.ts";
import { materialFingerprint } from "./agent-context.ts";
import type { ItemRow } from "../types.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0007_extract_target_state.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql"]) {
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
