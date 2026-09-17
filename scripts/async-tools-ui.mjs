import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { chromium } from 'playwright';
import pg from 'pg';

const manifest=resolve(process.argv[2]??'');
assert.ok(!relative(resolve('artifacts/agent-manual'),manifest).startsWith('..'));
const ready=JSON.parse(readFileSync(manifest,'utf8'));
assert.equal(ready.model,'local fake only');
const origin=new URL(ready.appURL);
assert.equal(origin.hostname,'127.0.0.1');assert.notEqual(origin.port,'8182');
const db=new pg.Client({host:origin.hostname,port:ready.pgPort,user:'postgres',password:'review-only-local',database:'review'});
await db.connect();
const browser=await chromium.launch();
const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const existing=process.argv.includes('--reuse')?(await db.query("select n.title,j.id from knowledge_notes n join ai_jobs j on j.run_id=n.run_id where n.title like 'Battery 工具技能 检查点回归 %' order by n.created_at desc limit 1")).rows[0]:null;
if(process.argv.includes('--reuse')) assert.ok(existing);
const question=existing?.title??`Battery 工具技能 检查点回归 ${Date.now()}`;
const folder=resolve(ready.out,'async-tools-check');mkdirSync(folder,{recursive:true});
try {
 await page.goto(origin+'/knowledge');
 let jobId=existing?.id;
 if(!existing){
 await page.getByLabel('向矩阵提问',{exact:true}).fill(question);
 await page.getByRole('checkbox').check();
 await page.getByRole('button',{name:'提问',exact:true}).click();
 await page.waitForURL(/job=/);
 jobId=new URL(page.url()).searchParams.get('job');
 }
 await page.getByRole('heading',{name:question,exact:true}).waitFor({timeout:60000});
 await page.waitForURL(url=>!url.searchParams.has('job'));
 await page.reload();
 // The persisted card is the evidence; do not rely on the transient answer panel.
 const heading=page.getByRole('heading',{name:question,exact:true});
 await heading.waitFor();
 const note=(await db.query('select r.response_json from knowledge_notes n join ai_runs r on r.id=n.run_id where n.run_id=(select run_id from ai_jobs where id=$1)',[jobId])).rows;
 assert.equal(note.length,1);assert.ok(JSON.stringify(note).includes('外部实验室证据：量产良率为 97%。'));
 const job=(await db.query('select status,attempts,run_id from ai_jobs where id=$1',[jobId])).rows[0];
 assert.equal(job.status,'succeeded');assert.equal(job.attempts,1);
 const run=(await db.query('select status,model_calls,tool_calls,skill_versions from ai_runs where id=$1',[job.run_id])).rows[0];
 assert.equal(run.status,'succeeded');assert.equal(run.model_calls,4);assert.equal(run.tool_calls,3);
 assert.ok(JSON.stringify(run.skill_versions).includes('demo'));
 const checkpoint=(await db.query('select sequence from agent_checkpoints where run_id=$1',[job.run_id])).rows[0];
 assert.equal(checkpoint.sequence,4);
 await heading.scrollIntoViewIfNeeded();
 await page.screenshot({path:resolve(folder,'desktop.png')});
 await page.setViewportSize({width:390,height:844});await heading.scrollIntoViewIfNeeded();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:resolve(folder,'mobile.png')});
 await page.getByRole('link',{name:'Battery 研究',exact:true}).first().click();
 await page.getByText('Battery 证据：量产良率为 97%。',{exact:true}).first().waitFor();
 assert.deepEqual(errors,[]);
 const result={ok:true,question,jobId,job,run,checkpoint,notes:note.length,errors};
 writeFileSync(resolve(folder,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally {await browser.close();await db.end();}
