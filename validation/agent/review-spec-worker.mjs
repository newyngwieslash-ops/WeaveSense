import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {enqueueResearchJob} from '../../src/lib/server/agent-queue.ts';
import {handleAgentJobs} from '../../src/lib/server/agent-jobs.ts';
import {handleAgentData} from '../../src/lib/server/agent-data.ts';

// Offline review reproduction; assertions document defects, not acceptance.
const pg=new PGlite();
await pg.waitReady;
try {
  for(const name of ['0002_schema.sql','0011_ai_runs.sql','0012_ai_jobs.sql','0013_agent_checkpoints.sql'])
    await pg.exec(readFileSync(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
  const sql={async query(text,params=[]){return (await pg.query(text,params)).rows;}};
  await enqueueResearchJob(sql,{question:'test corpus',requestId:'review-job',materialHash:'test-hash'});
  const claim=await handleAgentJobs({sql,authorized:true,action:'claim',params:{}});
  assert.equal(claim.status,200);
  const data=await handleAgentData({sql,serviceToken:'review-only',providedServiceToken:'review-only',runToken:'',runId:claim.body.run_id,action:'search_items',params:{query:'test'}});
  assert.equal(data.status,403);
  const completion=await handleAgentJobs({sql,authorized:true,action:'complete',params:{...claim.body,status:'succeeded',response:{schema_version:1,run_id:claim.body.run_id,ok:true,result:{content:'answer which must survive',citations:[],coverage:'full',warnings:[]},runtime:{model:'offline',model_calls:1,input_tokens:12,output_tokens:8}}}});
  assert.equal(completion.status,200);
  const [run]=await sql.query('select status,response_json,model_calls,input_tokens,output_tokens from ai_runs where id=$1',[claim.body.run_id]);
  const [job]=await sql.query('select status from ai_jobs where id=$1',[claim.body.job_id]);
  const notes=await sql.query('select id from knowledge_notes');
  assert.equal(job.status,'succeeded');
  assert.equal(run.status,'running');
  assert.equal(run.response_json,null);
  assert.equal(run.model_calls,0);
  assert.equal(notes.length,0);
  console.log(JSON.stringify({review:'defects reproduced; no real model called',internalDataStatus:data.status,completionStatus:completion.status,job,run,noteCount:notes.length},null,2));
} finally {await pg.close();}
