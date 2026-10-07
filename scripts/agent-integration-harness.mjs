import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';

const manual=process.argv.includes('--manual');
const resume=manual&&process.argv.includes('--resume-sept13');
const mode=process.argv.includes('--built')?'built':manual||process.argv.includes('--dev')?'dev':'built';
const root=process.cwd(),out=resolve(manual?`artifacts/agent-manual/${randomUUID()}`:'validation/agent/implementation-v3-2026-09-08'),assets=resolve('artifacts/agent-v3');
mkdirSync(out,{recursive:true});mkdirSync(assets,{recursive:true});mkdirSync(resolve('screenshots'),{recursive:true});
const identity=resume?'loom-agent-harness-b7e5daa3':`loom-agent-harness-${randomUUID().slice(0,8)}`,children=[],servers=[],evidence={identity,mode,pids:[],requests:[],checks:[],screenshots:[]};
const fixtures=resolve(assets,identity);
let db,browser,goProcess,activePage,containerCreated=false,killOnCheckpoint=false,dropComplete=false,checkpointKilled=false,holdClaims=false;
const windows=process.platform==='win32';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function command(exe,args,env={}){const r=spawnSync(exe,args,{cwd:root,env:{...process.env,...env},encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(`${exe}: ${r.stderr?.slice(-2000)??r.error}`);return r.stdout.trim();}
function launch(exe,args,env,label){const p=spawn(exe,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});const log=createWriteStream(resolve(out,`${mode}-${label}.log`));p.stdout.pipe(log);p.stderr.pipe(log);children.push(p);evidence.pids.push({label,pid:p.pid});return p;}
function stop(p){if(!p||p.exitCode!==null||p.signalCode!==null)return;if(windows)spawnSync('taskkill',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else p.kill('SIGKILL');}
function npm(script,portNo,env,label){return windows?launch('cmd.exe',['/d','/s','/c',`npm run ${script} -- --host 127.0.0.1 --port ${portNo} --strictPort`],env,label):launch('npm',['run',script,'--','--host','127.0.0.1','--port',String(portNo),'--strictPort'],env,label);}
async function until(fn,label,ms=60000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error(`timeout: ${label}`);}
async function serve(handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s);return `http://127.0.0.1:${s.address().port}`;}
async function jsonBody(req){req.setEncoding('utf8');let text='';for await(const chunk of req){text+=chunk;if(text.length>1024*1024)throw Error('request too large');}return JSON.parse(text||'{}');}
const json=(res,body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
const testToken=`offline-${randomUUID()}`;
try {
 const pgPort=resume?55191:await port(),appPort=resume?55192:await port(),goPort=await port();
 if(resume){
  assert.equal(command('docker',['inspect','--format','{{index .Config.Labels "loom.agent.validation"}}',identity]),'v3-harness');
  command('docker',['start',identity]);
 }else{
  command('docker',['run','--detach','--name',identity,'--label','loom.agent.validation=v3-harness','-e','POSTGRES_PASSWORD=review-only-local','-e','POSTGRES_DB=review','-p',`127.0.0.1:${pgPort}:5432`,'postgres:16-alpine']);containerCreated=true;
 }
 evidence.container={name:identity,port:pgPort};
 await until(async()=>{try{const c=new pg.Client({host:'127.0.0.1',port:pgPort,user:'postgres',password:'review-only-local',database:'review'});await c.connect();db=c;return true;}catch{return false;}},'isolated PG');
 if(!resume){
 await db.query('create table _migrations(name text primary key,applied_at timestamptz not null default now())');
 for(const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort()){
  await db.query('begin');try{await db.query(readFileSync(resolve('migrations',name),'utf8'));await db.query('insert into _migrations(name) values($1)',[name]);await db.query('commit');}catch(e){await db.query('rollback');throw e;}
 }
 await db.query("insert into sources(id,platform,name) values('s','rss','离线测试材料')");
 await db.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('battery','s','rss','battery','Battery 研究','Battery 证据：量产良率为 97%。',clock_timestamp())");
 }
 let modelCalls=0,mcpCalls=0;
 const model=await serve(async(req,res)=>{try{
  const body=await jsonBody(req);modelCalls++;const messages=body.messages??[];
  evidence.requests.push({kind:'model',number:modelCalls,max_tokens:body.max_tokens,roles:messages.map(m=>m.role)});
  assert.ok(body.max_tokens>0&&body.max_tokens<=1800);
  const prompt=messages.map(m=>m.content??'').join('\n');
  const toolMessages=messages.filter(m=>m.role==='tool');
  let message;
  if(prompt.includes('失败测试') || prompt.includes('invalid JSON for failure test')) message={role:'assistant',content:'invalid JSON for failure test'};
  else if(prompt.includes('预算耗尽')) message={role:'assistant',tool_calls:[{id:`call-${modelCalls}`,type:'function',function:{name:'skill',arguments:JSON.stringify({skill:'demo'})}}]};
  else if(prompt.includes('工具技能') && toolMessages.length<3){
   const calls=[['skill',{skill:'demo'}],['get_item',{item_id:'battery'}],['mcp_lab_search',{}]];
   const [name,args]=calls[toolMessages.length];message={role:'assistant',tool_calls:[{id:`call-${modelCalls}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
  } else {
   const citations=[];
   const seed=/evidence_id=([^\s]+).*?\n[^\n]*\n([^\n]+)/s.exec(prompt);
   if(seed)citations.push({evidence_id:seed[1],quote:seed[2].slice(0,80)});
   for(const m of toolMessages){try{const t=JSON.parse(m.content);if(t.evidence_id&&t.text)citations.push({evidence_id:t.evidence_id,quote:t.text.slice(0,200)});}catch{/* a tool message that is not JSON contributes no citation */}}
   const content=prompt.includes('summary')&&prompt.includes('topics')
    ?{summary:'离线条目分析',topics:['Battery'],entities:[],insights:'良率证据',tags:[],citations,insufficient_evidence:false}
    :{title:'离线研究结果',content:'离线模型已根据材料完成回答。量产良率为 97%。',citations,insufficient_evidence:citations.length===0};
   message={role:'assistant',content:JSON.stringify(content)};
  }
  if(manual&&!prompt.includes('工具技能')) await pause(25000);
  json(res,{id:`fake-${modelCalls}`,choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});
 }catch(e){json(res,{error:String(e)},500);}});
 const mcp=await serve(async(req,res)=>{try{
  assert.equal(req.headers.authorization,`Bearer ${testToken}`);
  const b=await jsonBody(req);evidence.requests.push({kind:'mcp',method:b.method});
  if(b.method?.startsWith('notifications/')){res.writeHead(202);res.end();return;}
  let result;
  if(b.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'offline-lab',version:'1'}};
  else if(b.method==='tools/list')result={tools:[{name:'search',description:'Read evidence',inputSchema:{type:'object',properties:{}}}]};
  else if(b.method==='tools/call'){mcpCalls++;result={content:[{type:'text',text:'外部实验室证据：量产良率为 97%。'}],isError:false};}
  else {json(res,{jsonrpc:'2.0',id:b.id,error:{code:-32601,message:'unsupported'}});return;}
  json(res,{jsonrpc:'2.0',id:b.id,result});
 }catch(e){json(res,{error:String(e)},500);}});
 mkdirSync(resolve(fixtures,'skills/demo'),{recursive:true});
 writeFileSync(resolve(fixtures,'skills/demo/SKILL.md'),'---\nname: demo\ndescription: evidence discipline\n---\nUse exact quotes; never fabricate evidence.');
 writeFileSync(resolve(fixtures,'mcp.json'),JSON.stringify({servers:[{id:'lab',enabled:true,url:mcp,transport:'streamable_http',token_env:'AGENT_V3_MCP_TOKEN',allowed_tools:['search'],required:true}]}));
 const appURL=`http://127.0.0.1:${appPort}`;
 const gateway=await serve(async(req,res)=>{try{
  const b=await jsonBody(req),action=b.action;
  if (holdClaims && action === 'claim') { res.writeHead(204);res.end();return; }
  const route=req.url.endsWith('/agent-jobs')?'agent-jobs':'agent-data';
  const remote=await fetch(`${appURL}/api/internal/${route}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${testToken}`,...(req.headers['x-agent-run-token']?{'x-agent-run-token':req.headers['x-agent-run-token']}:{})},body:JSON.stringify(b)});
  const text=await remote.text();evidence.requests.push({kind:'app',action,status:remote.status});
  if(action==='save_checkpoint'&&remote.ok&&killOnCheckpoint){killOnCheckpoint=false;checkpointKilled=true;stop(goProcess);res.destroy();return;}
  if(action==='complete'&&remote.ok&&dropComplete){dropComplete=false;res.destroy();return;}
  res.writeHead(remote.status,{'content-type':'application/json'});res.end(text);
 }catch(e){if(!res.destroyed)json(res,{error:String(e)},503);}});
 const env={DATABASE_URL:`postgresql://postgres:review-only-local@127.0.0.1:${pgPort}/review`,AI_ENGINE:'eino',AUTO_ANALYZE:'false',EXTRACT_AUTO:'false',AGENT_ASYNC_RESEARCH_ENABLED:'true',AGENT_WORKER_ENABLED:'true',
  AGENT_SERVICE_URL:`http://127.0.0.1:${goPort}`,AGENT_SERVICE_TOKEN:testToken,AGENT_DATA_TOKEN:testToken,AGENT_MCP_ALLOWED_TOOLS:'mcp_lab_search',VITE_AUTH_ENABLED:'false',LOOM_MODEL_CONFIG:resolve(fixtures,'unused.local.json'),XAI_API_KEY:''};
 let appProcess=npm(mode==='dev'?'dev':'preview',appPort,env,'app');
 await until(async()=>{try{return (await fetch(`${appURL}/knowledge`)).ok;}catch{return false;}},'app render',90000);
 const goEnv={AGENT_LISTEN_ADDR:`127.0.0.1:${goPort}`,AGENT_SERVICE_TOKEN:testToken,AGENT_MODEL_BASE_URL:model+'/v1',AGENT_MODEL_NAME:'offline-model',AGENT_MODEL_API_KEY:testToken,
  AGENT_DATA_URL:gateway+'/agent-data',AGENT_DATA_TOKEN:testToken,AGENT_WORKER_ENABLED:'true',AGENT_MCP_CONFIG:resolve(fixtures,'mcp.json'),AGENT_V3_MCP_TOKEN:testToken,AGENT_SKILLS_DIR:resolve(fixtures,'skills')};
 const startGo=()=>launch(process.env.LOOM_AGENT_TEST_BINARY??resolve(assets,windows?'agent.exe':'agent'),[],goEnv,`go-${evidence.pids.length}`);
 goProcess=startGo();await until(async()=>{try{return (await fetch(`http://127.0.0.1:${goPort}/readyz`)).ok;}catch{return false;}},'Go readiness');
 if(manual){
  const ready={appURL,goURL:`http://127.0.0.1:${goPort}`,container:identity,pgPort,modelDelayMs:25000,model:'local fake only',out};
  writeFileSync(resolve(out,'ready.json'),JSON.stringify(ready,null,2));
  console.log(JSON.stringify(ready,null,2));
  // Keep the isolated services alive for human QA; graceful stop retains its database.
  await new Promise(done=>{process.once('SIGINT',done);process.once('SIGTERM',done);});
  evidence.counts={modelCalls,mcpCalls};
 } else {
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage(),errors=[];
 activePage=page;
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
 await page.route('**/*',route=>{const url=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(url.hostname)?route.continue():route.fulfill({status:200,contentType:route.request().resourceType()==='stylesheet'?'text/css':'application/javascript',body:''});});
 await page.goto(`${appURL}/knowledge`);await page.getByLabel('向矩阵提问',{exact:true}).waitFor();
 async function submit(q,background=false){await page.waitForLoadState('networkidle');const input=page.getByLabel('向矩阵提问',{exact:true});await input.fill('');await input.pressSequentially(q);const checkbox=page.getByRole('checkbox');if(await checkbox.count())await checkbox.setChecked(background);else assert.equal(background,false);await page.getByRole('button',{name:'提问',exact:true}).click();}
 async function notes(n){await until(async()=>Number((await db.query('select count(*) from knowledge_notes')).rows[0].count)>=n,`notes ${n}`);await page.reload();}
 await submit('Battery 同步测试');await notes(1);evidence.checks.push('browser synchronous answer persisted');
 await submit('Battery 工具技能测试');await notes(2);assert.ok(mcpCalls>=1);evidence.checks.push('Skill + internal get_item + real fake MCP protocol + authenticated evidence receipt + cited note');
 assert.ok((await db.query("select count(*) from ai_runs where response_json::text like '%mcp:%'")).rows[0].count>0);
 dropComplete=true;await submit('Battery 异步丢响应测试',true);await page.waitForURL(/job=/);await page.reload();await notes(3);
 assert.equal(dropComplete,false);evidence.checks.push('async refresh and committed complete response loss retried without duplicate note');
 const beforeCrash=modelCalls;killOnCheckpoint=true;await submit('Battery 进程恢复测试',true);await until(()=>checkpointKilled,'checkpoint persisted then worker killed');
 const [interrupted]=(await db.query("select * from ai_jobs where status='running' order by created_at desc limit 1")).rows;assert.ok(interrupted);
 await db.query("update ai_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[interrupted.id]);
 goProcess=startGo();await notes(4);assert.equal(modelCalls,beforeCrash+1,'restoring completed model message must not send it again');evidence.checks.push('real process kill after durable Eino checkpoint; new worker Resume; no repeated model call');
 await submit('Battery 失败测试');await until(async()=>Number((await db.query("select count(*) from ai_runs where status='failed'")).rows[0].count)>0,'failed run');
 await until(()=>page.getByRole('button',{name:'提问',exact:true}).isEnabled(),'failure form usable');
 await submit('Battery 失败后新问题');await notes(5);evidence.checks.push('invalid output failure and new question');
 await submit('Battery 预算耗尽');await until(async()=>Number((await db.query("select count(*) from ai_runs where status='failed' and error_code='budget_exceeded' and tool_calls=4")).rows[0].count)>0,'positive Skill budget exhausted');
 await page.getByRole('button',{name:'生成今日简报',exact:true}).click();await notes(6);
 await page.goto(`${appURL}/inbox/battery`);await page.getByRole('button',{name:/LLM|分析/}).first().click();
 await until(async()=>Number((await db.query('select count(*) from analyses')).rows[0].count)===1,'browser item analysis');
 evidence.checks.push('positive budget refusal; briefing and item analysis through browser');
 await page.goto(`${appURL}/knowledge?job=${randomUUID()}`);await until(()=>!page.url().includes('job='),'missing job stops polling');
 assert.equal(errors.length,0,errors.join('\n'));
 const desktop=resolve(`screenshots/agent-v3-${mode}-desktop.png`);await page.screenshot({path:desktop,fullPage:true});evidence.screenshots.push(desktop);
 await page.setViewportSize({width:390,height:844});await page.reload();await page.getByLabel('向矩阵提问',{exact:true}).waitFor();
 await page.getByRole('heading',{name:'Battery 工具技能测试',exact:true}).waitFor();
 await page.getByText('外部实验室证据：量产良率为 97%。',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const mobile=resolve(`screenshots/agent-v3-${mode}-mobile.png`);await page.screenshot({path:mobile,fullPage:true});evidence.screenshots.push(mobile);
 const beforeHealth=modelCalls;await fetch(`http://127.0.0.1:${goPort}/healthz`);await fetch(`http://127.0.0.1:${goPort}/readyz`);assert.equal(modelCalls,beforeHealth);
 const smokeArgs=['scripts/browser-smoke.mjs',`${appURL}/knowledge`,`screenshots/agent-v3-${mode}-smoke.png`,...(mode==='built'?['--baseline','screenshots/agent-v3-dev-smoke.json']:[])];
 writeFileSync(resolve(out,`${mode}-smoke-output.json`),command(process.execPath,smokeArgs,{VITE_AUTH_ENABLED:'false',AGENT_OFFLINE_SMOKE:'true'}));
 evidence.checks.push('browser-smoke desktop/mobile content, console and dev/built baseline');
 // C02: keep Eino selected while the dedicated worker is down, then restore it.
 stop(goProcess);await page.goto(`${appURL}/knowledge`);await page.getByRole('heading',{name:'Battery 工具技能测试',exact:true}).waitFor();
 const runsBeforeDown=Number((await db.query('select count(*) from ai_runs')).rows[0].count);
 await submit('Battery 停机测试');
 await until(async()=>Number((await db.query('select count(*) from ai_runs')).rows[0].count)>runsBeforeDown,'unavailable operation recorded');
 await until(async()=>!(await db.query("select 1 from ai_runs where status='running'")).rows.length,'unavailable operation terminated');
 assert.equal(modelCalls,beforeHealth,'unavailable Eino must not fall back to another model');
 assert.equal(Number((await db.query('select count(*) from knowledge_notes')).rows[0].count),6);
 goProcess=startGo();await until(async()=>{try{return (await fetch(`http://127.0.0.1:${goPort}/readyz`)).ok;}catch{return false;}},'restored worker ready');
 await submit('Battery 停机后恢复');await notes(7);assert.equal(modelCalls,beforeHealth+1);
 evidence.checks.push('C02 Eino unavailable: history readable, failed request no model/fallback/note; new request succeeds after worker restart');
 const beforeRollback=modelCalls;
 holdClaims=true;await page.setViewportSize({width:1280,height:900});await page.goto(`${appURL}/knowledge`);await page.getByLabel('向矩阵提问',{exact:true}).waitFor();await submit('Battery 回滚排队测试',true);await page.waitForURL(/job=/);const rollbackURL=page.url();stop(goProcess);
 await page.goto('about:blank');stop(appProcess);appProcess=npm(mode==='dev'?'dev':'preview',appPort,{...env,AI_ENGINE:'legacy',AGENT_ASYNC_RESEARCH_ENABLED:'false',XAI_API_KEY:''},'rollback-app');
 await until(async()=>{try{return (await fetch(`${appURL}/knowledge`)).ok;}catch{return false;}},'rollback app');
 await page.goto(rollbackURL,{waitUntil:'domcontentloaded'});await until(()=>!page.url().includes('job='),'queued job explicitly cancelled after rollback');
 await page.getByRole('heading',{name:'Battery 工具技能测试',exact:true}).waitFor();
 assert.equal(await page.getByRole('checkbox').count(),0);
 const deniedClaim=await fetch(`${appURL}/api/internal/agent-jobs`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${testToken}`},body:JSON.stringify({action:'claim'})});
 assert.equal(deniedClaim.status,503);assert.equal(modelCalls,beforeRollback);
 assert.equal(Number((await db.query("select count(*) from ai_jobs where status='failed' and error_code='capability_disabled'")).rows[0].count),1);
 evidence.checks.push('owned app rollback to legacy cancels unstarted job; claim gate closed; Agent down leaves browsing/history available; no new model request');
 evidence.counts={modelCalls,mcpCalls,notes:Number((await db.query('select count(*) from knowledge_notes')).rows[0].count),checkpoints:Number((await db.query('select count(*) from agent_checkpoints')).rows[0].count)};
 evidence.ok=true;console.log(JSON.stringify(evidence,null,2));
 }
}catch(error){evidence.ok=false;evidence.error=String(error?.stack??error);console.error(evidence.error);process.exitCode=1;
 if(activePage){await activePage.screenshot({path:resolve(`screenshots/agent-v3-${mode}-failure.png`),fullPage:true}).catch(()=>{});evidence.failureText=(await activePage.locator('body').innerText()).slice(0,3000);}
}finally{
 if(db) evidence.runs=(await db.query('select id,mode,provider,status,error_code,model_calls,tool_calls,input_tokens,output_tokens from ai_runs order by created_at')).rows;
 writeFileSync(resolve(out,`harness-${mode}.json`),JSON.stringify(evidence,null,2));
 if(browser)await browser.close();for(const p of children.reverse())stop(p);
 for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}
 if(db)await db.end();if(containerCreated&&!manual)command('docker',['rm','--force',identity]);
}
