import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup } from '../review-third-2026-09-08/postgres-repro.test.ts';
import { enqueueResearchJob,enqueueReadyAnalyses,claimAiJob,finishAiJob } from '../../../src/lib/server/agent-queue.ts';
import { handleAgentJobs } from '../../../src/lib/server/agent-jobs.ts';
import { saveCheckpoint } from '../../../src/lib/server/agent-checkpoints.ts';
import { completeRun } from '../../../src/lib/server/agent-completion.ts';

for (const sent of [false,true]) test(`V3 concurrent terminal ${sent?'settlement':'trusted release'} changes the daily ledger once`,async t=>{
 const {sql,sa,sb,locker,waitLocks}=await setup(t);const c=await claim(sql);
 await sql.query("insert into ai_budget_days(day,price_version,reserved_count,reserved_rmb) values('2026-09-08','p',1,1)");
 await sql.query("insert into ai_budget_reservations(id,job_id,day,price_version,reserved_rmb,status,dispatch_state,pricing) values($1,$2,'2026-09-08','p',1,'reserved',$3,$4::jsonb)",[randomUUID(),c.job_id,sent?'unconfirmed':'not_sent',JSON.stringify({model:'fake',input_per_million:2,output_per_million:4})]);
 if(sent) await sql.query("insert into ai_model_calls(run_id,call_id,model,policy_version,execution_day,state,input_tokens,output_tokens) values($1,$2,'fake','p','2026-09-08','completed',100,20)",[c.run_id,randomUUID()]);
 await locker.query('begin');await locker.query('select id from ai_jobs where id=$1 for update',[c.job_id]);
 const input={runId:String(c.run_id),jobId:String(c.job_id),claimToken:String(c.claim_token),status:'failed' as const,errorCode:'invalid_output'};
 const pending=[completeRun(sa,input),completeRun(sb,input)];
 try {await waitLocks(2);t.diagnostic('two terminal transactions blocked on the same job; settlement follows ownership lock');}finally{await locker.query('commit');}
 assert.ok((await Promise.all(pending)).every(r=>r.ok));
 const [day]=await sql.query<any>('select * from ai_budget_days'),[detail]=await sql.query<any>('select * from ai_budget_reservations');
 assert.equal(Number(day.reserved_count),0);assert.equal(Number(day.reserved_rmb),0);
 assert.equal(Number(day.settled_count),sent?1:0);assert.equal(Number(day.settled_rmb),sent?0.00028:0);
 assert.equal(Number(detail.actual_rmb),Number(day.settled_rmb));assert.equal(detail.status,sent?'settled':'released');
});

for(const table of ['ai_jobs','ai_budget_reservations']) test(`V3 ${table} insertion failure rolls back the entire admission`,async t=>{
 const {sql}=await setup(t);
 await sql.query("insert into sources(id,platform,name) values('s','rss','Source');insert into items(id,source_id,platform,external_id,title,body,pipeline_status) values('i','s','rss','i','Battery','Material','extracted')");
 await sql.query(`create function reject_admission() returns trigger language plpgsql as $$begin raise exception 'injected admission failure';end$$;create trigger reject_admission before insert on ${table} for each row execute function reject_admission()`);
 await assert.rejects(enqueueReadyAnalyses(sql,{autoAnalyze:true,dailyLimit:1,dailyBudgetRmb:1,priceVersion:'p1',worstCostRmb:1},'2026-09-08'),/injected admission failure/);
 assert.equal((await sql.query('select * from ai_budget_days')).length,0);
 assert.equal((await sql.query('select * from ai_jobs')).length,0);
 assert.equal((await sql.query('select * from ai_budget_reservations')).length,0);
});

async function claim(sql:any) {
 await enqueueResearchJob(sql,{question:'Battery',requestId:randomUUID(),materialHash:'h'});
 const claimed=await handleAgentJobs({sql,authorized:true,action:'claim',params:{}});
 assert.equal(claimed.status,200);return claimed.body;
}
function response(run:any) {return {schema_version:1,run_id:run,ok:true,result:{content:'Answer',citations:[],insufficient_evidence:false,coverage:'full',warnings:[]},runtime:{model:'fake',prompt_version:'v1',skill_versions:{},input_tokens:5,output_tokens:3,model_calls:1,tool_calls:0,events:[]},evidence:[]};}
for(const status of ['succeeded','failed','outcome_unknown']) {
 test(`V1 ${status}: revoked owner writes nothing after a real row-lock wait`,async t=>{
  const {sql,sa,locker,waitLocks}=await setup(t);const c=await claim(sql);
  await locker.query('begin');await locker.query("update ai_jobs set claim_token='new-generation' where id=$1",[c.job_id]);
  const finish=handleAgentJobs({sql:sa,authorized:true,action:'complete',params:{...c,status,...(status==='succeeded'?{response:response(c.run_id)}:{error_code:'invalid_output'})}});
  try {await waitLocks(1);t.diagnostic('old completion blocked on job lock; new-generation committed before predicate recheck');} finally {await locker.query('commit');}
  assert.equal((await finish).status,409);
  assert.equal((await sql.query<any>('select status from ai_runs where id=$1',[c.run_id]))[0].status,'running');
  assert.equal((await sql.query('select * from knowledge_notes')).length,0);
 });
 test(`V1 ${status}: simultaneous identical terminal messages have one consistent result`,async t=>{
  const {sql,sa,sb,locker,waitLocks}=await setup(t);const c=await claim(sql);
  const params={...c,status,...(status==='succeeded'?{response:response(c.run_id)}:{error_code:'invalid_output'})};
  await locker.query('begin');await locker.query('select id from ai_runs where id=$1 for update',[c.run_id]);
  const a=handleAgentJobs({sql:sa,authorized:true,action:'complete',params});
  const b=handleAgentJobs({sql:sb,authorized:true,action:'complete',params});
  try {await waitLocks(2);t.diagnostic('both completion transactions blocked before run mutation');}finally{await locker.query('commit');}
  const results=await Promise.all([a,b]);assert.deepEqual(results.map(r=>r.status),[200,200]);
  assert.equal(results[0].body.note_id,results[1].body.note_id);
  assert.equal((await sql.query<any>('select status from ai_runs where id=$1',[c.run_id]))[0].status,status);
  assert.equal((await sql.query<any>('select status from ai_jobs where id=$1',[c.job_id]))[0].status,status);
  assert.equal((await sql.query('select * from knowledge_notes')).length,status==='succeeded'?1:0);
 });
}
test('V1 SQL failure rolls back note, run and job together',async t=>{
 const {sql}=await setup(t);const c=await claim(sql);
 await sql.query("create function reject_terminal() returns trigger language plpgsql as $$ begin raise exception 'forced rollback'; end $$");
 await sql.query('create trigger reject_terminal before update on ai_jobs for each row execute function reject_terminal()');
 await assert.rejects(handleAgentJobs({sql,authorized:true,action:'complete',params:{...c,status:'succeeded',response:response(c.run_id)}}),/forced rollback/);
 assert.equal((await sql.query('select * from knowledge_notes')).length,0);
 assert.equal((await sql.query<any>('select status from ai_runs where id=$1',[c.run_id]))[0].status,'running');
 assert.equal((await sql.query<any>('select status from ai_jobs where id=$1',[c.job_id]))[0].status,'running');
});
test('V6 competing checkpoint payloads at the same sequence cannot overwrite one another',async t=>{
 const {sql,sa,sb,locker,waitLocks}=await setup(t);const c=await claim(sql);
 const input={checkPointId:'cp',runId:String(c.run_id),claimToken:String(c.claim_token),sequence:1,schemaVersion:'1',runtimeVersion:'v1',payload:Buffer.from('first')};
 await locker.query('begin');await locker.query('select id from ai_runs where id=$1 for update',[c.run_id]);
 const a=saveCheckpoint(sa,input),b=saveCheckpoint(sb,{...input,payload:Buffer.from('second')});
 try {await waitLocks(2);}finally{await locker.query('commit');}
 assert.deepEqual((await Promise.all([a,b])).sort(),['ok','stale']);
});
test('V3 two schedulers cannot reserve the last daily allowance twice',async t=>{
 const {sql,sa,sb}=await setup(t);
 await sql.query("insert into sources(id,platform,name) values('s','rss','s')");
 await sql.query("insert into items(id,source_id,platform,external_id,title,body) values('a','s','rss','a','a','material'),('b','s','rss','b','b','material')");
 const cfg={autoAnalyze:true,dailyLimit:1,dailyBudgetRmb:1,priceVersion:'v3',worstCostRmb:1};
 const result=await Promise.all([enqueueReadyAnalyses(sa,cfg,'2026-09-08'),enqueueReadyAnalyses(sb,cfg,'2026-09-08')]);
 assert.equal(result.reduce((n,r)=>n+r.enqueued,0),1);
 const [day]=await sql.query<any>('select * from ai_budget_days');
 const [details]=await sql.query<any>('select sum(reserved_rmb) as cost,count(*)::int as n from ai_budget_reservations');
 assert.equal(Number(day.reserved_rmb),Number(details.cost));assert.equal(details.n,1);
 const job=await claimAiJob(sql,{worker:'test',leaseSeconds:60});assert.ok(job);
 await finishAiJob(sql,{id:job.id,claimToken:job.claim_token,status:'failed',errorCode:'not_sent'});
 assert.equal(Number((await sql.query<any>('select reserved_rmb from ai_budget_days'))[0].reserved_rmb),1,'untrusted not_sent label cannot release cost');
});
