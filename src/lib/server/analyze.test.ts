import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ExecuteResponse } from "../agent-contract.ts";
import { analyzeItemWith, askKnowledgeWith, generateBriefingWith } from "./analyze.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources (id, platform, name) values ('s','rss','信源')");
  const sql = {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    }, async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  return { pg, sql };
}

function okAnalyze(): ExecuteResponse {
  return {
    schema_version: 1,
    run_id: "00000000-0000-4000-8000-000000000001",
    ok: true,
    result: {
      analysis: { summary: "摘要", topics: ["主题"], entities: ["实体"], insights: "洞察", tags: ["标签"] },
      citations: [],
      insufficient_evidence: false,
      coverage: "full",
      warnings: [],
    },
    runtime: { model: "compat", prompt_version: "loom-agent-v1", skill_versions: {}, input_tokens: 1, output_tokens: 1, model_calls: 1, tool_calls: 0, events: [] },
    evidence: [],
  };
}

test("V10 legacy -> eino -> legacy uses the selected transport for all three public operations", async () => {
  const {pg,sql}=await setup();
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('switch','s','rss','switch','Battery','Battery material',clock_timestamp())");
  const originalFetch=globalThis.fetch;
  const names=['AI_ENGINE','XAI_API_KEY','AGENT_SERVICE_URL','AGENT_SERVICE_TOKEN'] as const;
  const previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{XAI_API_KEY:'offline-intercept-only',AGENT_SERVICE_URL:'http://offline.invalid',AGENT_SERVICE_TOKEN:'offline-intercept-only'});
  const calls:string[]=[];
  globalThis.fetch=(async (url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(String(url).startsWith('http://offline.invalid/')) {
      calls.push('eino');
      const response=okAnalyze();assert.equal(response.ok,true);if(!response.ok)throw new Error('invalid fixture');response.run_id=body.run_id;
      if(body.mode!=='analyze_item') response.result={content:'Offline answer',title:'Offline',citations:[],insufficient_evidence:true,coverage:'full',warnings:[]};
      return Response.json(response);
    }
    assert.equal(String(url),'https://api.x.ai/v1/chat/completions');calls.push('legacy');
    const analysis=String(body.messages[1].content).includes('"summary"');
    return Response.json({choices:[{message:{content:JSON.stringify(analysis?{summary:'Offline',topics:[],entities:[],insights:'',tags:[],citations:[],insufficient_evidence:true}:{title:'Offline',content:'Offline answer',citations:[],insufficient_evidence:true})}}]});
  }) as typeof fetch;
  try {
    for(const engine of ['legacy','eino','legacy']) {
      process.env.AI_ENGINE=engine;
      for(const run of [()=>analyzeItemWith({sql,itemId:'switch'}),()=>generateBriefingWith({sql}),()=>askKnowledgeWith({sql,question:'Battery'})]) {
        const result=await run();assert.equal(result.ok,true,JSON.stringify(result));
      }
    }
    assert.deepEqual(calls,['legacy','legacy','legacy','eino','eino','eino','legacy','legacy','legacy']);
    assert.equal((await sql.query('select * from analyses')).length,3);
    assert.equal((await sql.query('select * from knowledge_notes')).length,6);
    assert.equal((await sql.query("select * from ai_runs where status='succeeded'")).length,9);
  } finally {
    globalThis.fetch=originalFetch;
    for(const k of names) {if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
    await pg.close();
  }
});

test("legacy analysis accepts the flat JSON its own prompt requests", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','电池研究','电池原始正文。')");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "review-only-never-sent";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "摘要", topics: ["主题"], entities: ["实体"], insights: "洞察", tags: ["标签"],
            citations: [],
            insufficient_evidence: false,
          }),
        },
      }],
    });
  }) as typeof fetch;
  try {
    const result = await analyzeItemWith({ sql, itemId: "item-1", engine: "legacy" });
    assert.equal(calls, 1);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
    await pg.close();
  }
});

test("same analyze request calls the model once and replays the saved id", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','标题','正文内容足够长')");
  let calls = 0;
  const execute = async (req: { run_id: string }) => {
    calls += 1;
    return { ...okAnalyze(), run_id: req.run_id };
  };
  const requestId = randomUUID();
  const first = await analyzeItemWith({ sql, itemId: "item-1", requestId, engine: "eino", execute });
  const second = await analyzeItemWith({ sql, itemId: "item-1", requestId, engine: "eino", execute });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.equal(first.id, second.id);
  assert.equal(calls, 1);
  const analyses = await sql.query("select id from analyses");
  assert.equal(analyses.length, 1);
  await pg.close();
});

test("completed analyze request replays after the source body is emptied", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','标题','正文内容足够长')");
  const requestId = randomUUID();
  let calls = 0;
  const execute = async (req: { run_id: string }) => {
    calls += 1;
    return { ...okAnalyze(), run_id: req.run_id };
  };
  const first = await analyzeItemWith({ sql, itemId: "item-1", requestId, engine: "eino", execute });
  assert.equal(first.ok, true);
  await pg.query("update items set body='' where id='item-1'");
  const second = await analyzeItemWith({ sql, itemId: "item-1", requestId, engine: "eino", execute });
  assert.equal(calls, 1);
  assert.equal(second.ok, true, JSON.stringify(second));
  await pg.close();
});

test("invalid output writes no analysis row", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','标题','正文内容足够长')");
  const execute = async (req: { run_id: string }): Promise<ExecuteResponse> => ({
    schema_version: 1, run_id: req.run_id, ok: false,
    error: { code: "invalid_output", message: "bad", retryable: false, outcome_unknown: false },
  });
  const result = await analyzeItemWith({ sql, itemId: "item-1", engine: "eino", execute });
  assert.equal(result.ok, false);
  assert.equal((await sql.query("select id from analyses")).length, 0);
  assert.equal((await sql.query<{ pipeline_status: string }>("select pipeline_status from items"))[0]?.pipeline_status, "ingested");
  await pg.close();
});

test("material change during analyze rejects the old snapshot", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','标题','正文内容足够长')");
  const execute = async (req: { run_id: string }) => {
    await pg.query("update items set body = body || ' OCR追加' where id = 'item-1'");
    return { ...okAnalyze(), run_id: req.run_id };
  };
  const result = await analyzeItemWith({ sql, itemId: "item-1", engine: "eino", execute });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error_code, "input_changed");
  assert.equal((await sql.query("select id from analyses")).length, 0);
  await pg.close();
});

test("briefing only uses the requested range", async () => {
  const { pg, sql } = await setup();
  await pg.query(`insert into items (id,source_id,platform,external_id,title,body,published_at)
    values ('old','s','rss','old','上周','上周新闻','2026-08-01T00:00:00Z')`);
  let calls = 0;
  const result = await generateBriefingWith({
    sql, from: "2026-09-06T16:00:00.000Z", to: "2026-09-07T16:00:00.000Z", engine: "eino",
    execute: async () => { calls += 1; return okAnalyze(); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  await pg.close();
});

test("async ask enqueues a job without calling the model", async () => {
  const { pg, sql } = await setup();
  await pg.exec(readFileSync(new URL("../../../migrations/0012_ai_jobs.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0014_agent_integrity.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0015_agent_budget_reservations.sql", import.meta.url), "utf8"));
  await pg.query(`insert into items (id,source_id,platform,external_id,title,body)
    values ('item-1','s','rss','e1','固态电池量产卡点','电解液仍是瓶颈')`);
  let calls = 0;
  const result = await askKnowledgeWith({
    sql, question: "固态电池量产卡点", engine: "eino", async: true,
    execute: async () => { calls += 1; return okAnalyze(); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.ok(result.job_id);
  assert.equal(calls, 0);
  await pg.close();
});

test("ask with no matches does not invent citations", async () => {
  const { pg, sql } = await setup();
  await pg.query(`insert into items (id,source_id,platform,external_id,title,body)
    values ('item-1','s','rss','e1','无关标题','无关正文足够长')`);
  let calls = 0;
  const result = await askKnowledgeWith({
    sql, question: "固态电池量产卡点", engine: "eino",
    execute: async () => { calls += 1; return okAnalyze(); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(result.citations ?? [], []);
  await pg.close();
});
