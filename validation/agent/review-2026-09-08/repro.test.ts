// Review-only regression checks. Assert required behavior; failures reproduce gaps in HEAD 76b6da1.
// Isolated PGlite and protocol doubles only. No live database or model requests.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { analyzeItemWith, askKnowledgeWith } from "../../../src/lib/server/analyze.ts";
import { beginRun, getRun } from "../../../src/lib/server/agent-runs.ts";
import { handleAgentData, hashRunToken } from "../../../src/lib/server/agent-data.ts";
import { enqueueReadyAnalyses, enqueueResearchJob, claimAiJob, finishAiJob } from "../../../src/lib/server/agent-queue.ts";
import { executeAgent } from "../../../src/lib/server/agent-client.ts";
import type { ExecuteRequest, ExecuteResponse } from "../../../src/lib/agent-contract.ts";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.waitReady;
  for (const name of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql","0022_research_review.sql","0023_research_runtime.sql","0024_research_call_roles.sql","0025_research_tool_calls.sql","0027_assistant_runtime.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources(id,platform,name) values('s','rss','测试信源')");
  await pg.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('item-1','s','rss','1','电池研究','电池原始正文。','2026-09-07T00:00:00Z')");
  return { pg, sql: {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    }, async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } } };
}

function success(request: ExecuteRequest): ExecuteResponse {
  return { schema_version: 1, run_id: request.run_id, ok: true,
    result: { analysis: { summary: "摘要", topics: [], entities: [], insights: "洞察", tags: [] },
      citations: [],
      insufficient_evidence: false, coverage: "full", warnings: [] },
    runtime: { model: "review-double", prompt_version: "v1", skill_versions: {}, input_tokens: null,
      output_tokens: null, model_calls: 1, tool_calls: 0, events: [] },
    evidence: request.input.sources.map(s => ({ evidence_id:s.evidence_id, item_id:s.item_id,
      title:s.title, url:s.url, text:s.text, origin:"internal" as const })) };
}

test("R01: legacy analysis accepts the exact JSON shape its own prompt requests", async t => {
  const { sql } = await setup(t);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "review-only-never-sent";
  let calls = 0;
  globalThis.fetch = async () => { calls++;
    return Response.json({choices:[{message:{content:JSON.stringify({
      summary:"摘要",topics:[],entities:[],insights:"洞察",tags:[],
      citations:[],insufficient_evidence:false,
    })}}]});
  };
  try {
    const result = await analyzeItemWith({sql,itemId:"item-1",engine:"legacy"});
    assert.equal(calls, 1);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = originalKey;
  }
});

test("R02: completed request replays even if source body is later emptied", async t => {
  const { sql } = await setup(t);
  const requestId = randomUUID();
  let calls=0;
  const execute=async(req:ExecuteRequest)=>{calls++;return success(req);};
  const first=await analyzeItemWith({sql,itemId:"item-1",requestId,engine:"eino",execute});
  assert.equal(first.ok,true);
  await sql.query("update items set body='' where id='item-1'");
  const second=await analyzeItemWith({sql,itemId:"item-1",requestId,engine:"eino",execute});
  assert.equal(calls,1);
  assert.equal(second.ok,true,JSON.stringify(second));
});

test("R03: research persists a valid newly retrieved evidence receipt", async t => {
  const { sql } = await setup(t);
  await sql.query("insert into items(id,source_id,platform,external_id,title,body) values('new-evidence','s','rss','2','补充材料','新发现的证据。')");
  const result=await askKnowledgeWith({sql,question:"电池",engine:"eino",execute:async req=>{
    const data=await handleAgentData({sql,serviceToken:"test-service",providedServiceToken:"test-service",
      runToken:req.data_access_token!,runId:req.run_id,action:"get_item",params:{item_id:"new-evidence"}});
    assert.equal(data.status,200);
    const evidence={evidence_id:String(data.body.evidence_id),item_id:"new-evidence",title:"补充材料",
      url:"https://example.com/evidence",text:String(data.body.text),origin:"internal" as const};
    const out=success(req);
    if(!out.ok) throw Error("bad fixture");
    out.result={content:"根据新证据回答。",citations:[{evidence_id:evidence.evidence_id,quote:"新发现的证据"}],
      insufficient_evidence:false,coverage:"full",warnings:[]};
    out.evidence.push(evidence);
    return out;
  }});
  assert.equal(result.ok,true,JSON.stringify(result));
});

test("R04: get_item cannot escape a saved run time range", async t => {
  const { sql } = await setup(t);
  const runId=randomUUID(), token="run-token-for-review";
  await beginRun(sql,{id:runId,requestId:randomUUID(),mode:"research",provider:"eino",inputHash:"h",materialHash:"m",
    policyVersion:"v1",requestJson:{range:{from:"2026-01-01T00:00:00Z",to:"2026-01-02T00:00:00Z"}},
    claimToken:randomUUID(),dataTokenHash:hashRunToken(token),expiresAt:new Date(Date.now()+60000).toISOString()});
  const result=await handleAgentData({sql,runId,runToken:token,serviceToken:"s",providedServiceToken:"s",
    action:"get_item",params:{item_id:"item-1"}});
  assert.equal(result.status,403,JSON.stringify(result));
});

test("R05: zero daily count and money budgets enqueue no analysis", async t => {
  const { sql } = await setup(t);
  const result=await enqueueReadyAnalyses(sql,{autoAnalyze:true,dailyLimit:0,dailyBudgetRmb:0,
    priceVersion:"review",worstCostRmb:1},"2026-09-08");
  const budget=await sql.query("select * from ai_budget_days");
  assert.equal(result.enqueued,0,JSON.stringify({result,budget}));
});

test("R06: an expired job lease cannot complete", async t => {
  const { sql } = await setup(t);
  await enqueueResearchJob(sql,{question:"研究",requestId:randomUUID(),materialHash:"h"});
  const job=await claimAiJob(sql,{worker:"review",leaseSeconds:60,kind:"research"});
  assert.ok(job);
  await sql.query("update ai_jobs set lease_until=now()-interval '1 minute' where id=$1",[job.id]);
  assert.equal(await finishAiJob(sql,{id:job.id,claimToken:job.claim_token,status:"succeeded"}),false);
});

test("R07: expired running requests are not reported in_progress forever", async t => {
  const { sql } = await setup(t);
  const input={id:randomUUID(),requestId:randomUUID(),mode:"research" as const,provider:"eino" as const,
    inputHash:"h",materialHash:"m",policyVersion:"v1",requestJson:{},claimToken:randomUUID(),
    expiresAt:"2000-01-01T00:00:00Z"};
  await beginRun(sql,input);
  const retry=await beginRun(sql,{...input,id:randomUUID()});
  assert.notEqual(retry.kind,"in_progress",JSON.stringify(await getRun(sql,input.id)));
});

test("R08: client timeout covers response body after headers arrive", async () => {
  const fixture=JSON.parse(readFileSync(new URL("../contracts/analyze-valid.json",import.meta.url),"utf8"));
  const fetchImpl:typeof fetch=async()=>new Response(new ReadableStream({start(controller){
    setTimeout(()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(fixture.response)));controller.close();},80);
  }}),{headers:{"content-type":"application/json"}});
  await assert.rejects(()=>executeAgent(fixture.request,{engine:"eino",serviceUrl:"https://unused.invalid",
    serviceToken:"test",timeoutMs:10,fetchImpl}),/timeout|aborted|Abort|model_timeout/i);
});

test("R09: source metadata changes invalidate current-item analysis", async t => {
  const { sql }=await setup(t);
  const result=await analyzeItemWith({sql,itemId:"item-1",engine:"eino",execute:async req=>{
    await sql.query("update sources set name='完全不同的信源' where id='s'");
    return success(req);
  }});
  assert.equal(result.ok,false,JSON.stringify(result));
});
