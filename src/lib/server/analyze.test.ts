import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ExecuteResponse } from "../agent-contract.ts";
import { analyzeItemWith, askKnowledgeWith, generateBriefingWith } from "./analyze.ts";
import { autoAnalyzeConfigFromEnv, enqueueReadyAnalyses, claimAiJob } from "./agent-queue.ts";
import { recordModelCall } from "./agent-budget.ts";
import { hashRunToken } from "./agent-data.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql","0022_research_review.sql","0023_research_runtime.sql","0024_research_call_roles.sql","0027_assistant_runtime.sql"]) {
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

test('C03 automatic admission through analysis settles once and preserves the daily limit', async t => {
 const {pg,sql}=await setup();t.after(()=>pg.close());
 const keys=['AI_ENGINE','AUTO_ANALYZE','AGENT_MODEL_NAME','AGENT_PRICE_INPUT_RMB_PER_MILLION','AGENT_PRICE_OUTPUT_RMB_PER_MILLION','AUTO_ANALYZE_DAILY_LIMIT','AUTO_ANALYZE_DAILY_BUDGET_RMB','AUTO_ANALYZE_PRICE_VERSION'];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys) {if(previous[k]===undefined) delete process.env[k];else process.env[k]=previous[k];}});
 Object.assign(process.env,{AI_ENGINE:'eino',AUTO_ANALYZE:'false',AGENT_MODEL_NAME:'compat',AGENT_PRICE_INPUT_RMB_PER_MILLION:'2',AGENT_PRICE_OUTPUT_RMB_PER_MILLION:'4',AUTO_ANALYZE_DAILY_LIMIT:'1',AUTO_ANALYZE_DAILY_BUDGET_RMB:'1',AUTO_ANALYZE_PRICE_VERSION:'fake-c03'});
 await sql.query("insert into items(id,source_id,platform,external_id,title,body,pipeline_status) values('auto','s','rss','auto','Battery','Battery evidence','extracted')");
 const day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
 assert.equal((await enqueueReadyAnalyses(sql,autoAnalyzeConfigFromEnv(),day)).enqueued,0);
 process.env.AUTO_ANALYZE='true';process.env.AGENT_PRICE_INPUT_RMB_PER_MILLION='';
 assert.equal((await enqueueReadyAnalyses(sql,autoAnalyzeConfigFromEnv(),day)).enqueued,0);
 process.env.AGENT_PRICE_INPUT_RMB_PER_MILLION='2';process.env.AUTO_ANALYZE_DAILY_LIMIT='0';
 assert.equal((await enqueueReadyAnalyses(sql,autoAnalyzeConfigFromEnv(),day)).enqueued,0);
 process.env.AUTO_ANALYZE_DAILY_LIMIT='1';
 assert.equal((await enqueueReadyAnalyses(sql,autoAnalyzeConfigFromEnv(),day)).enqueued,1);
 const job=await claimAiJob(sql,{worker:'c03',kind:'analyze',leaseSeconds:60});assert.ok(job);
 let calls=0;
 const result=await analyzeItemWith({sql,itemId:'auto',job,requestId:`auto:${job.id}`,engine:'eino',execute:async req=>{
  calls++;const callId=randomUUID(),token=hashRunToken(req.data_access_token!);
  const base={call_id:callId,model:'compat',policy_version:req.policy.version};
  assert.equal(await recordModelCall(sql,req.run_id,token,{...base,phase:'started'}),true);
  assert.equal(await recordModelCall(sql,req.run_id,token,{...base,phase:'completed',input_tokens:100,output_tokens:20}),true);
  const response=okAnalyze();response.run_id=req.run_id;
  assert.ok(response.runtime);
  response.runtime.input_tokens=100;response.runtime.output_tokens=20;
  return response;
 }});
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls,1);
 assert.equal((await sql.query('select id from analyses')).length,1);
 const [reservation]=await sql.query<any>('select status,actual_rmb from ai_budget_reservations');
 const [totals]=await sql.query<any>('select reserved_count,reserved_rmb,settled_count,settled_rmb from ai_budget_days');
 assert.equal(reservation.status,'settled');assert.equal(Number(reservation.actual_rmb),0.00028);
 assert.equal(Number(totals.reserved_count),0);assert.equal(Number(totals.reserved_rmb),0);
 assert.equal(Number(totals.settled_count),1);assert.equal(Number(totals.settled_rmb),Number(reservation.actual_rmb));
 await sql.query("insert into items(id,source_id,platform,external_id,title,body,pipeline_status) values('second','s','rss','second','Battery second','More evidence','extracted')");
 assert.equal((await enqueueReadyAnalyses(sql,autoAnalyzeConfigFromEnv(),day)).enqueued,0);
 assert.equal(await claimAiJob(sql,{worker:'c03',kind:'analyze',leaseSeconds:60}),null);
 assert.equal(calls,1);
});

test('A09-A12 legacy fixture boundaries, empty/pending rejection, tail coverage and revised material', async () => {
  const { pg, sql } = await setup();
  const oldFetch = globalThis.fetch;
  const oldConfig = process.env.LOOM_MODEL_CONFIG;
  const oldKey = process.env.XAI_API_KEY;
  delete process.env.LOOM_MODEL_CONFIG;
  process.env.XAI_API_KEY = 'offline-intercept-only';
  const inputs: any[][] = [];
  globalThis.fetch = (async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content as string;
    const sources = JSON.parse(prompt.split('素材 JSON：')[1]);
    inputs.push(sources);
    const source = sources.find((s: any) => s.text.includes('TAIL-973')) ?? sources[0];
    const quote = source.text.includes('TAIL-973') ? 'TAIL-973：返工率3%。' : source.text.slice(0, 80);
    const common = { citations: [{ evidence_id: source.evidence_id, quote }], insufficient_evidence: false };
    const result = prompt.includes('"summary"')
      ? { ...common, summary: quote, topics: [], entities: [], insights: '', tags: [] }
      : { ...common, title: '隔离验收', content: quote };
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  }) as typeof fetch;
  try {
    await pg.exec(readFileSync(new URL('../../../validation/agent/search-followup-fixtures.sql', import.meta.url), 'utf8'));
    for (const [id, code] of [['qa-empty', 'invalid_request'], ['qa-pending', 'material_incomplete']]) {
      const result = await analyzeItemWith({ sql, itemId: id, engine: 'legacy' });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error_code, code);
    }
    await sql.query("delete from extract_jobs where item_id='qa-pending'");
    const noJob = await analyzeItemWith({ sql, itemId: 'qa-pending', engine: 'legacy' });
    assert.equal(noJob.ok, false);
    if (!noJob.ok) assert.equal(noJob.error_code, 'material_incomplete');
    const empty = await generateBriefingWith({ sql, engine: 'legacy', from: '2020-01-01T16:00:00Z', to: '2020-01-02T16:00:00Z' });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.error_code, 'insufficient_evidence');
    assert.equal(inputs.length, 0);
    assert.equal((await sql.query('select id from ai_runs')).length, 0);
    assert.equal((await sql.query('select id from analyses')).length, 0);
    const briefing = await generateBriefingWith({ sql, engine: 'legacy', from: '2026-09-10T16:00:00Z', to: '2026-09-11T16:00:00Z' });
    assert.equal(briefing.ok, true, JSON.stringify(briefing));
    const ids = inputs[0].map(s => s.item_id);
    assert.ok(ids.includes('qa-start') && ids.includes('qa-last'));
    assert.ok(!ids.includes('qa-before') && !ids.includes('qa-end'));
    const long = await analyzeItemWith({ sql, itemId: 'qa-long', engine: 'legacy' });
    assert.equal(long.ok, true, JSON.stringify(long));
    const ask = await askKnowledgeWith({ sql, question: 'TAIL-973', engine: 'legacy' });
    assert.equal(ask.ok, true, JSON.stringify(ask));
    assert.ok(inputs[1].some(s => s.text.includes('TAIL-973：返工率3%。')));
    assert.ok(inputs[2].some(s => s.text.includes('TAIL-973：返工率3%。')));
    if (!long.ok) throw Error('long failed');
    const [longRun] = await sql.query<any>('select response_json from ai_runs where id=$1', [long.run_id]);
    assert.equal(longRun.response_json.result.coverage, 'partial');
    assert.ok(longRun.response_json.verified_evidence.some((s: any) => s.text.includes('TAIL-973')));
    const before = await analyzeItemWith({ sql, itemId: 'qa-change', engine: 'legacy' });
    await sql.query("update items set body='当前结论：良率96%。' where id='qa-change'");
    const after = await analyzeItemWith({ sql, itemId: 'qa-change', engine: 'legacy' });
    assert.ok(before.ok && after.ok);
    if (!before.ok || !after.ok) throw Error('revision failed');
    assert.notEqual(before.id, after.id);
    const revisions = await sql.query<any>('select material_hash, request_json from ai_runs where id in ($1,$2) order by created_at', [before.run_id, after.run_id]);
    assert.notEqual(revisions[0].material_hash, revisions[1].material_hash);
    assert.ok(inputs[3].some(s => s.text.includes('97%')));
    assert.ok(inputs[4].some(s => s.text.includes('96%')));
    assert.ok(!inputs[4].some(s => s.text.includes('97%')));
    assert.equal((await sql.query("select id from analyses where item_id='qa-change'")).length, 2);
    assert.equal(inputs.length, 5);
    const runs = await sql.query<any>('select model_calls,status from ai_runs');
    assert.ok(runs.every(r => r.model_calls === 1 && r.status === 'succeeded'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldConfig === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = oldConfig;
    if (oldKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = oldKey;
    await pg.close();
  }
});

test('all synchronous entries preserve transport/response diagnostics and write no partial result', async () => {
  const { pg, sql } = await setup();
  const oldFetch = globalThis.fetch, oldKey = process.env.XAI_API_KEY, oldPath = process.env.LOOM_MODEL_CONFIG;
  delete process.env.LOOM_MODEL_CONFIG; process.env.XAI_API_KEY = 'offline-test-only';
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('diagnostic','s','rss','diagnostic','Battery','Battery evidence',clock_timestamp())");
  try {
    for (const [kind, code] of [['timeout','model_timeout'], ['network','model_network_error'], ['json','model_response_invalid'], ['shape','model_response_invalid']] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (kind === 'timeout') throw new DOMException('secret-upstream', 'TimeoutError');
        if (kind === 'network') throw new TypeError('secret-upstream');
        return kind === 'json' ? new Response('secret-upstream') : Response.json({choices:[{message:{content:{secret:'upstream'}}}]});
      }) as typeof fetch;
      for (const run of [() => analyzeItemWith({sql,itemId:'diagnostic',engine:'legacy'}), () => generateBriefingWith({sql,engine:'legacy'}), () => askKnowledgeWith({sql,question:'Battery evidence',engine:'legacy'})]) {
        const result = await run();
        assert.equal(result.ok, false);
        if (result.ok) throw new Error('unexpected success');
        assert.equal(result.error_code, code);
        assert.equal(JSON.stringify(result).includes('secret-upstream'), false);
      }
      assert.equal(calls, 3, 'no automatic transport retry');
    }
    const runs = await sql.query<{status:string;model_calls:number;response_json:any}>('select status,model_calls,response_json from ai_runs');
    assert.equal(runs.length, 12);
    assert(runs.every(r => r.model_calls === 1 && r.response_json.runtime.events.length > 0));
    assert.equal(runs.filter(r => r.status === 'outcome_unknown').length, 6);
    assert.equal((await sql.query('select id from analyses')).length, 0);
    assert.equal((await sql.query('select id from knowledge_notes')).length, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = oldKey;
    if (oldPath === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = oldPath;
    await pg.close();
  }
});

test("model file drives all synchronous public entries and preserves in-flight model identity", async () => {
  const { pg, sql } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "loom-model-entry-"));
  const file = join(dir, "model.local.json");
  const oldPath = process.env.LOOM_MODEL_CONFIG, oldFetch = globalThis.fetch;
  process.env.LOOM_MODEL_CONFIG = file;
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('config','s','rss','config','Battery','Battery evidence',clock_timestamp())");
  let count = 0;
  const config = (n: number) => ({ baseURL: "http://offline.invalid/v1", model: `model-${n}`, apiKey: "offline-private" });
  writeFileSync(file, JSON.stringify(config(0)));
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "http://offline.invalid/v1/chat/completions");
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, `model-${count}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-private");
    assert.equal(init?.redirect, "error");
    writeFileSync(file, JSON.stringify(config(++count)));
    const analysis = String(body.messages[1].content).includes('"summary"');
    return Response.json({ choices: [{ message: { content: JSON.stringify(analysis ? { summary: "Offline", topics: [], entities: [], insights: "", tags: [], citations: [], insufficient_evidence: true } : { title: "Offline", content: "Offline answer", citations: [], insufficient_evidence: true }) } }] });
  }) as typeof fetch;
  try {
    for (const run of [() => analyzeItemWith({sql, itemId: "config", engine: "legacy"}), () => generateBriefingWith({sql, engine: "legacy"}), () => askKnowledgeWith({sql, question: "Battery", engine: "legacy"})]) assert.equal((await run()).ok, true);
    assert.equal(count, 3);
    const models = await sql.query<{model:string}>("select model from ai_runs where status='succeeded'");
    assert.deepEqual(models.map(r => r.model).sort(), ["model-0", "model-1", "model-2"]);
  } finally { globalThis.fetch = oldFetch; if (oldPath === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = oldPath; await pg.close(); rmSync(dir, {recursive:true}); }
});

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

test("async ask enqueues a priced, frozen job without calling the model", async (t) => {
  const settings = { AGENT_MODEL_NAME: "fake", AGENT_PRICE_INPUT_RMB_PER_MILLION: "2", AGENT_PRICE_OUTPUT_RMB_PER_MILLION: "4", AGENT_SKILL_SNAPSHOT_DIGEST: "a".repeat(64), AGENT_RESEARCH_REVIEW: "shadow" };
  const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
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
  const [reservation] = await sql.query<{ status: string }>("select status from ai_budget_reservations where job_id=$1", [result.job_id]);
  assert.equal(reservation.status, "reserved");
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

// --- T21-b: legacy path must record the usage the gateway actually returns -----
//
// Verified live: the gateway answers with a standard `usage` block
// (prompt_tokens / completion_tokens / total_tokens). The legacy runtime
// hard-coded `input_tokens: null, output_tokens: null`, so completed runs
// recorded no cost data even though the numbers were in the response — which is
// why spend could not be reconciled from the ledger.

test("a legacy analysis persists the token usage the gateway returned", async () => {
  const { pg, sql } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "loom-usage-"));
  const file = join(dir, "model.local.json");
  const oldPath = process.env.LOOM_MODEL_CONFIG, oldFetch = globalThis.fetch;
  process.env.LOOM_MODEL_CONFIG = file;
  writeFileSync(file, JSON.stringify({ baseURL: "http://offline.invalid/v1", model: "usage-model", apiKey: "offline-private" }));
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('u','s','rss','u','Usage','Usage evidence text',clock_timestamp())");
  globalThis.fetch = (async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ summary: "摘要", topics: [], entities: [], insights: "", tags: [], citations: [], insufficient_evidence: true }) } }],
    // The real gateway's shape.
    usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
  })) as typeof fetch;
  try {
    const result = await analyzeItemWith({ sql, itemId: "u", engine: "legacy" });
    assert.equal(result.ok, true, `analysis should succeed: ${JSON.stringify(result)}`);
    const [run] = await sql.query<{ input_tokens: number | null; output_tokens: number | null; status: string }>(
      "select input_tokens, output_tokens, status from ai_runs order by created_at desc limit 1");
    assert.equal(run.status, "succeeded");
    assert.equal(Number(run.input_tokens), 1234, "prompt_tokens must be persisted, not null");
    assert.equal(Number(run.output_tokens), 56, "completion_tokens must be persisted, not null");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPath === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = oldPath;
    await pg.close(); rmSync(dir, { recursive: true });
  }
});

test("a response without usage still records nulls rather than inventing numbers", async () => {
  const { pg, sql } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "loom-usage-none-"));
  const file = join(dir, "model.local.json");
  const oldPath = process.env.LOOM_MODEL_CONFIG, oldFetch = globalThis.fetch;
  process.env.LOOM_MODEL_CONFIG = file;
  writeFileSync(file, JSON.stringify({ baseURL: "http://offline.invalid/v1", model: "usage-model", apiKey: "offline-private" }));
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('u2','s','rss','u2','Usage2','Usage evidence text',clock_timestamp())");
  globalThis.fetch = (async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ summary: "摘要", topics: [], entities: [], insights: "", tags: [], citations: [], insufficient_evidence: true }) } }],
  })) as typeof fetch;
  try {
    const result = await analyzeItemWith({ sql, itemId: "u2", engine: "legacy" });
    assert.equal(result.ok, true);
    const [run] = await sql.query<{ input_tokens: number | null; output_tokens: number | null }>(
      "select input_tokens, output_tokens from ai_runs order by created_at desc limit 1");
    assert.equal(run.input_tokens, null, "an absent usage block must stay unknown, never 0");
    assert.equal(run.output_tokens, null);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPath === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = oldPath;
    await pg.close(); rmSync(dir, { recursive: true });
  }
});

// --- T21-b: the run lease must outlast the work a run is allowed to do --------
//
// Live evidence: two analyses took 58.5 s and 61.7 s, and both failed to persist
// (`persist_failed`) against the old flat 60 s lease — the money was spent and the
// result thrown away. `completeRun` refuses to write a run whose `expires_at` has
// passed, which is correct for reaping ABANDONED runs, so the lease has to be
// strictly longer than the call budget rather than equal to a round number.
//
// This asserts the property that actually matters (lease > worst-case work) for
// every synchronous entry, instead of simulating an expired lease — a test that
// expires it on purpose could only ever reproduce the bug, not the fix.

test("every synchronous entry grants a lease longer than its own call budget", async () => {
  const { pg, sql } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "loom-lease-"));
  const file = join(dir, "model.local.json");
  const oldPath = process.env.LOOM_MODEL_CONFIG, oldFetch = globalThis.fetch;
  process.env.LOOM_MODEL_CONFIG = file;
  writeFileSync(file, JSON.stringify({ baseURL: "http://offline.invalid/v1", model: "lease-model", apiKey: "offline-private" }));
  await sql.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('lease','s','rss','lease','Lease','Lease evidence text',clock_timestamp())");
  globalThis.fetch = (async (_url, init) => {
    // Answer in the shape the mode requested (same branching as the existing
    // model-entry test above).
    const body = JSON.parse(String(init?.body));
    const wantsAnalysis = String(body.messages?.[1]?.content ?? "").includes('"summary"');
    const payload = wantsAnalysis
      ? { summary: "摘要", topics: [], entities: [], insights: "", tags: [], citations: [], insufficient_evidence: true }
      : { title: "标题", content: "正文内容", citations: [], insufficient_evidence: true };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
  }) as typeof fetch;
  const PER_CALL_MS = 120_000; // analyze.ts MODEL_CALL_TIMEOUT_SECONDS
  try {
    const entries: [string, () => Promise<{ ok: boolean }>][] = [
      ["analyze", () => analyzeItemWith({ sql, itemId: "lease", engine: "legacy" })],
      ["briefing", () => generateBriefingWith({ sql, engine: "legacy" })],
      ["ask", () => askKnowledgeWith({ sql, question: "lease question", engine: "legacy" })],
    ];
    for (const [name, run] of entries) {
      const started = Date.now();
      const produced = await run();
      assert.equal(produced.ok, true, `${name} must succeed; got ${JSON.stringify(produced)}`);
      const [row] = await sql.query<{ expires_at: Date; policy: string; created_at: Date }>(
        "select expires_at, request_json->'policy'->>'max_model_calls' as policy, created_at from ai_runs order by created_at desc limit 1");
      const leaseMs = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
      const maxCalls = Number(row.policy);
      assert.ok(Number.isFinite(maxCalls) && maxCalls > 0, `policy must expose max_model_calls; got ${row.policy}`);
      const budget = maxCalls * PER_CALL_MS;
      assert.ok(leaseMs > budget,
        `lease (${leaseMs} ms) must exceed the call budget (${maxCalls} x ${PER_CALL_MS} ms = ${budget} ms); otherwise a slow but successful run is discarded after paying for it`);
      void started;
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPath === undefined) delete process.env.LOOM_MODEL_CONFIG; else process.env.LOOM_MODEL_CONFIG = oldPath;
    await pg.close(); rmSync(dir, { recursive: true });
  }
});
