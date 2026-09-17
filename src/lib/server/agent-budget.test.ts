import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { enqueueReadyAnalyses, claimAiJob, finishAiJob } from './agent-queue.ts';
import { beginRun } from './agent-runs.ts';
import { completeRun } from './agent-completion.ts';
import { confirmJobNotSent, recordModelCall, admitBudgetDay } from './agent-budget.ts';

async function setup(t: any, day?: string) {
 const pg = new PGlite(); await pg.waitReady; t.after(()=>pg.close());
 for (const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort()) await pg.exec(readFileSync(`migrations/${name}`,'utf8'));
 const sql = { query: async <T>(q:string,p:unknown[]=[]) => (await pg.query<T>(q,p)).rows,
  transaction: async <T>(fn:(tx:any)=>Promise<T>)=>pg.transaction(tx=>fn({query:async <R>(q:string,p:unknown[]=[]) => (await tx.query<R>(q,p)).rows})) };
 await sql.query("insert into sources(id,platform,name) values('s','rss','source')");
 await sql.query("insert into items(id,source_id,platform,external_id,title,body,pipeline_status) values('i','s','rss','i','Battery','Known material','extracted')");
 const today=(await sql.query<any>("select to_char(clock_timestamp() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day"))[0].day;
 assert.equal((await enqueueReadyAnalyses(sql,{autoAnalyze:true,dailyLimit:1,dailyBudgetRmb:1,priceVersion:'p1',worstCostRmb:1,pricing:{model:'fake',input_per_million:2,output_per_million:4}},day??today)).enqueued,1);
 const job=(await claimAiJob(sql,{worker:'test',leaseSeconds:60}))!;
 const runId=randomUUID();
 const link=()=>beginRun(sql,{id:runId,requestId:randomUUID(),mode:'analyze_item',provider:'eino',inputHash:'intent',materialHash:job.material_hash,policyVersion:'loom-agent-v1',requestJson:{policy:{max_model_calls:2}},claimToken:job.claim_token,expiresAt:new Date(Date.now()+60000).toISOString(),dataTokenHash:'hash',jobId:job.id});
 const call=(call_id:string,phase:'started'|'completed'|'unknown',extra={})=>recordModelCall(sql,runId,'hash',{call_id,phase,model:'fake',policy_version:'loom-agent-v1',...extra});
 const conservation=async()=>{
  const [total]=await sql.query<any>('select sum(reserved_count)::int as count,sum(reserved_rmb)::float as amount,sum(settled_rmb)::float as settled from ai_budget_days');
  const [details]=await sql.query<any>("select count(*) filter(where status in ('reserved','unknown'))::int as count,coalesce(sum(reserved_rmb) filter(where status in ('reserved','unknown')),0)::float as amount,coalesce(sum(actual_rmb) filter(where status='settled'),0)::float as settled from ai_budget_reservations");
  assert.deepEqual(total,details);
 };
 return {sql,job,runId,link,call,today,conservation};
}

test('V3 trusted preflight releases once; an error label alone retains unknown reserve',async t=>{
 const f=await setup(t);
 assert.equal(await confirmJobNotSent(f.sql,f.job.id,'forged'),false);
 assert.equal(await confirmJobNotSent(f.sql,f.job.id,f.job.claim_token),true);
 assert.equal(await finishAiJob(f.sql,{id:f.job.id,claimToken:f.job.claim_token,status:'failed',errorCode:'invalid_output'}),true);
 assert.equal(await confirmJobNotSent(f.sql,f.job.id,f.job.claim_token),false);
 await f.conservation();
 assert.equal((await f.sql.query<any>('select status from ai_budget_reservations'))[0].status,'released');
});
for (const fact of ['no_receipt','started','unknown','completed_without_usage','completed']) test(`V3 invalid_output with ${fact}: facts determine settlement, never the terminal label`,async t=>{
 const f=await setup(t); await f.link(); const id=randomUUID();
 if(fact!=='no_receipt') assert.equal(await f.call(id,'started'),true);
 if(fact==='unknown') assert.equal(await f.call(id,'unknown'),true);
 if(fact==='completed_without_usage') assert.equal(await f.call(id,'completed'),true);
 if(fact==='completed') {
  assert.equal(await f.call(id,'completed',{input_tokens:100,output_tokens:20}),true);
  assert.equal(await f.call(id,'completed',{input_tokens:101,output_tokens:20}),false);
 }
 const input={runId:f.runId,jobId:f.job.id,claimToken:f.job.claim_token,status:'failed' as const,errorCode:'invalid_output'};
 assert.equal((await completeRun(f.sql,input)).ok,true);
 assert.equal((await completeRun(f.sql,input)).ok,true);
 const [r]=await f.sql.query<any>('select * from ai_budget_reservations');
 assert.equal(r.status,fact==='completed'?'settled':'unknown');
 if(fact==='completed') assert.equal(Number(r.actual_rmb),0.00028); else assert.equal(r.actual_rmb,null);
 await f.conservation();
});
test('V3 first dispatch transfers yesterday reserve atomically; call cap and model snapshot are enforced',async t=>{
 const f=await setup(t,'2020-01-01'); await f.link();
 assert.equal(await recordModelCall(f.sql,f.runId,'hash',{call_id:randomUUID(),phase:'started',model:'changed',policy_version:'loom-agent-v1'}),false);
 assert.equal(await f.call(randomUUID(),'started'),true);
 assert.equal((await f.sql.query<any>('select day from ai_budget_reservations'))[0].day,f.today);
 assert.equal(await f.call(randomUUID(),'started'),true);
 assert.equal(await f.call(randomUUID(),'started'),false);
 await f.conservation();
});

test('V3 price version changes do not reset a calendar day allowance',async t=>{
 const f=await setup(t);
 assert.equal(await f.sql.transaction(tx=>admitBudgetDay(tx,f.today,'new-price',0.01,1,1)),false);
 await f.conservation();
});
