import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, appendFile } from 'node:fs/promises';

const exec = promisify(execFile);
const runtimeImage = 'weavesense-opencode-runtime:1.3.13';
const bridgeImage = 'weavesense-agent-bridge:offline-proxy-test';
async function docker(...args) {
  const result = await exec('docker', args, { windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  return (args[0]==='logs'?result.stdout+result.stderr:result.stdout).trim();
}
const restricted = ['--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=768m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000', '--tmpfs', '/state:rw,noexec,nosuid,size=256m,uid=1000,gid=1000'];
const wrapperToken = 'offline-wrapper-control-fixture';
const controlToken = 'offline-bridge-control-fixture';
const appToken = 'offline-app-service-fixture';
const vendorToken = 'offline-vendor-secret-fixture';
const grantToken = 'offline-proxy-opaque-grant-fixture';
const runToken = 'offline-host-run-access-fixture';

// This is a deliberately fake application ledger and vendor, never a replacement
// for the real trusted Go bridge. All actual OpenCode HTTP sends traverse Go.
const fixtureScript = `
import {createServer} from 'node:http';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const calls=new Map(),toolCalls=new Map(),receipts=[],vendorRequests=[];let toolReads=0;
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))};
createServer(async(req,res)=>{
 if(req.url==='/stats')return json(res,{receipts,vendorRequests,modelCalls:[...calls.values()],toolCalls:[...toolCalls.values()],toolReads});
 req.setEncoding('utf8');let text='';for await(const b of req)text+=b;const input=JSON.parse(text);
 if(req.url==='/agent-data'){
  assert.equal(req.headers.authorization,'Bearer ${appToken}');assert.equal(req.headers['x-agent-run-token'],'${runToken}');
  assert.ok(/^[a-f0-9-]{36}$/.test(input.run_id));assert.ok(/^[a-f0-9-]{36}$/.test(input.claim_token));
  const p=input.params;receipts.push(input);
  if(input.action==='model_call'){
   assert.equal(p.model,'fixture');assert.equal(p.policy_version,'loom-agent-v1');assert.ok(/^[a-f0-9]{64}$/.test(p.request_digest));
   const old=calls.get(p.call_id);
   if(p.phase==='started'){
    if(old)return json(res,{ok:true,disposition:old.phase==='completed'?'completed':'already_started'});
    if([...calls.values()].some(c=>c.phase==='unknown'||c.phase==='started'))return json(res,{ok:false,disposition:'denied'},409);
    calls.set(p.call_id,{...p});return json(res,{ok:true,disposition:'send_once'});
   }
   assert.ok(old);assert.equal(old.request_digest,p.request_digest);calls.set(p.call_id,{...p});return json(res,{ok:true,disposition:p.phase});
  }
  if(input.action==='tool_start'){assert.ok(!toolCalls.has(p.call_id));toolCalls.set(p.call_id,{...p});return json(res,{ok:true,disposition:'send_once'})}
  if(input.action==='tool_complete'){const old=toolCalls.get(p.call_id);assert.ok(old);assert.equal(old.request_digest,p.request_digest);toolCalls.set(p.call_id,{...p,completed:true});return json(res,{ok:true,disposition:'completed'})}
  if(input.action==='search_items'){toolReads++;return json(res,{items:[{item_id:'fixture-item',evidence_id:'host-search-evidence',snippet:'The approved corpus supports cotton conductivity.',coverage:'partial'}]})}
  if(input.action==='get_item'){toolReads++;return json(res,{item_id:'fixture-item',evidence_id:'host-read-evidence',text:'The approved corpus supports cotton conductivity.',coverage:'full',start:0,end:49})}
  return json(res,{error:'unexpected_action'},400);
 }
 if(req.url!=='/v1/chat/completions')return json(res,{error:'forbidden'},404);
 assert.equal(req.headers.authorization,'Bearer ${vendorToken}');assert.equal(req.headers['x-agent-run-token'],undefined);
 assert.equal(input.model,'fixture');assert.ok(input.max_tokens>0&&input.max_tokens<=1800);assert.equal(input.stream,true);assert.equal(input.stream_options.include_usage,true);
 const admitted=[...calls.values()].find(c=>c.phase==='started'&&c.request_digest===digest(input));assert.ok(admitted,'actual body lacks admitted digest');
 vendorRequests.push({body:input,bytes:Buffer.byteLength(text),request_digest:digest(input),call_id:admitted.call_id,headers:{authorization:'[vendor credential]',content_type:req.headers['content-type']}});
 const count=input.messages.filter(m=>m.role==='tool').length;
 const call=count===0?{id:'call_search',type:'function',function:{name:'corpus_search_items',arguments:JSON.stringify({query:'cotton'})}}:count===1?{id:'call_read',type:'function',function:{name:'corpus_get_item',arguments:JSON.stringify({item_id:'fixture-item'})}}:null;
 res.writeHead(200,{'content-type':'text/event-stream'});
 const delta=call?{role:'assistant',tool_calls:[{index:0,...call}]}:{role:'assistant',content:JSON.stringify({title:'Trusted proxy fixture report',body:'Cotton conductivity has approved support.',citations:[{item_id:'fixture-item',evidence_id:'host-read-evidence'}]})};
 for(const [part,finish]of[[delta,null],[{},call?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:'fake-chat',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta:part,finish_reason:finish}]})+'\\n\\n');
 res.write('data: '+JSON.stringify({id:'fake-chat',object:'chat.completion.chunk',created:1,model:input.model,choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\\n\\n');res.end('data: [DONE]\\n\\n');
}).listen(8793,'0.0.0.0');
`;

test('actual Linux OpenCode routes model and corpus calls through the trusted Go proxy', { timeout: 360000 }, async () => {
  const dockerVersion = await docker('version', '--format', '{{.Server.Version}}');
  await docker('build', '--platform', 'linux/amd64', '-f', 'workers/agent/Dockerfile.bridge', '-t', bridgeImage, 'workers/agent');
  const suffix = randomUUID().slice(0, 8), label = `weavesense.model-proxy-test=${suffix}`;
  const sandbox = `weavesense-proxy-sandbox-${suffix}`, trusted = `weavesense-proxy-trusted-${suffix}`;
  const runtime = `weavesense-proxy-runtime-${suffix}`, bridge = `weavesense-proxy-bridge-${suffix}`, fixture = `weavesense-proxy-fixture-${suffix}`, controller = `weavesense-proxy-controller-${suffix}`;
  let evidence;
  try {
    for (const network of [sandbox, trusted]) await docker('network', 'create', '--label', label, '--internal', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', network);
    await docker('run', '-d', '--label', label, '--name', fixture, '--network', trusted, '--network-alias', 'fake-app-vendor', ...restricted, runtimeImage, 'node', '--input-type=module', '-e', fixtureScript);
    await docker('run', '-d', '--label', label, '--name', bridge, '--network', trusted, ...restricted,
      '-e', `OPENCODE_BRIDGE_CONTROL_TOKEN=${controlToken}`, '-e', 'AGENT_DATA_URL=http://fake-app-vendor:8793/agent-data', '-e', `AGENT_DATA_TOKEN=${appToken}`,
      '-e', 'AGENT_MODEL_BASE_URL=http://fake-app-vendor:8793/v1', '-e', `AGENT_MODEL_API_KEY=${vendorToken}`, '-e', 'AGENT_MODEL_NAME=fixture', bridgeImage);
    await docker('network', 'connect', '--alias', 'agent-bridge', sandbox, bridge);
    await docker('run', '-d', '--label', label, '--name', runtime, '--network', sandbox, ...restricted,
      '-e', `OPENCODE_RUNTIME_TOKEN=${wrapperToken}`, '-e', 'OPENCODE_BRIDGE_URL=http://agent-bridge:8792', '-e', 'OPENCODE_MODEL_NAME=fixture', runtimeImage, 'node', '/opt/runtime/server.mjs');
    await docker('run', '-d', '--label', label, '--name', controller, '--network', sandbox, ...restricted, runtimeImage, '/bin/sleep', '300');
    await docker('network', 'connect', trusted, controller);
    const fixtureIP = JSON.parse(await docker('inspect', fixture))[0].NetworkSettings.Networks[trusted].IPAddress;
    const script = `
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import net from 'node:net';
const run_id=randomUUID(),claim_token=randomUUID(),runtime='http://${runtime}:4097',bridge='http://agent-bridge:8792';
async function req(base,path,body,token='${wrapperToken}') {const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();return {status:r.status,value:text?JSON.parse(text):null}}
for(let n=0;n<100;n++){try{if((await req(runtime,'/health')).status===200)break}catch{}await new Promise(r=>setTimeout(r,100))}
const prepared=await req(runtime,'/prepare',{run_id,claim_token,grant:'${grantToken}'});assert.equal(prepared.status,200,JSON.stringify(prepared));
const identity={instance_id:prepared.value.instance_id,epoch:prepared.value.epoch};
const grant={grant:'${grantToken}',run_id,claim_token,...identity,expires_at:new Date(Date.now()+120000).toISOString(),data_access_token:'${runToken}',model:'fixture',policy_version:'loom-agent-v1',max_output_tokens_per_call:1800};
assert.equal((await req(bridge,'/v1/grants',grant,'${controlToken}')).status,201);
assert.equal((await req(runtime,'/start',identity)).status,200);
const session=await req(runtime,'/forward',{...identity,method:'POST',path:'/session',body:{title:'Trusted proxy research'}});assert.equal(session.status,200);
assert.equal((await req(runtime,'/forward',{...identity,method:'POST',path:'/session/'+session.value.id+'/prompt_async',body:{parts:[{type:'text',text:'Use the approved cotton corpus and return report JSON with actual host evidence IDs.'}]}})).status,204);
let report;
for(let n=0;n<200;n++){const messages=await req(runtime,'/forward',{...identity,method:'GET',path:'/session/'+session.value.id+'/message'});assert.equal(messages.status,200);report=messages.value.flatMap(m=>m.parts).find(p=>p.type==='text'&&p.text.includes('Trusted proxy fixture report'));if(report)break;await new Promise(r=>setTimeout(r,100))}
if(!report){console.error(JSON.stringify({messages:(await req(runtime,'/forward',{...identity,method:'GET',path:'/session/'+session.value.id+'/message'})).value,stats:await(await fetch('http://fake-app-vendor:8793/stats')).json()}))}
assert.ok(report,'actual OpenCode failed to finish through Go proxy');assert.ok(report.text.includes('host-read-evidence'));
for(const bad of [{model:'foreign',messages:[{role:'user',content:'denied'}]},{model:'fixture',messages:[{role:'user',content:'x'.repeat(524289)}]},{model:'fixture',max_tokens:1801,messages:[{role:'user',content:'denied'}]}]){const denied=await req(bridge,'/v1/chat/completions',bad,'${grantToken}');assert.ok([400,413].includes(denied.status))}
const stats=await(await fetch('http://fake-app-vendor:8793/stats')).json();assert.equal(stats.vendorRequests.length,3);assert.equal(stats.modelCalls.length,3);assert.equal(stats.toolCalls.length,2);assert.equal(stats.toolReads,2);
assert.ok(stats.modelCalls.every(c=>c.phase==='completed'&&c.input_tokens===10&&c.output_tokens===5));assert.ok(stats.toolCalls.every(c=>c.completed));
assert.deepEqual(stats.vendorRequests.map(r=>r.body.max_tokens),[1800,1800,1800]);assert.ok(stats.vendorRequests.every(r=>r.bytes<=524288));
assert.equal((await req(runtime,'/stop',identity)).value.stopped,true);
assert.equal((await fetch(bridge+'/v1/grants',{method:'DELETE',headers:{authorization:'Bearer ${controlToken}','content-type':'application/json'},body:JSON.stringify(identity)})).status,200);
console.log(JSON.stringify({run_id,identity,report:JSON.parse(report.text),stats,real_paid_model_requests:0}));
`;
    const result = JSON.parse(await docker('exec', controller, 'node', '--input-type=module', '-e', script));
    const networkCheck = JSON.parse(await docker('exec', runtime, 'node', '--input-type=module', '-e', `import net from 'node:net';const out=await Promise.all([['approved_bridge','agent-bridge',8792],['vendor_bypass','${fixtureIP}',8793],['public_egress','1.1.1.1',80]].map(([name,host,port])=>new Promise(resolve=>{const s=net.connect({host,port});let done=false;const end=allowed=>{if(done)return;done=true;s.destroy();resolve({name,allowed})};s.once('connect',()=>end(true));s.once('error',()=>end(false));s.setTimeout(1200,()=>end(false))})));console.log(JSON.stringify(out));`));
    assert.equal(networkCheck[0].allowed,true);assert.equal(networkCheck[1].allowed,false);assert.equal(networkCheck[2].allowed,false);
    const inspected = JSON.parse(await docker('inspect', runtime))[0];
    assert.equal(inspected.HostConfig.Binds,null);assert.deepEqual(inspected.HostConfig.PortBindings,{});assert.equal(inspected.HostConfig.ReadonlyRootfs,true);
    assert.ok(!inspected.Config.Env.some(x=>x.startsWith('AGENT_MODEL_API_KEY=')||x.startsWith('AGENT_DATA_TOKEN=')));
    const bridgeInfo = JSON.parse(await docker('image','inspect',bridgeImage))[0];
    evidence={observed_at:new Date().toISOString(),docker_version:dockerVersion,bridge_image_id:bridgeInfo.Id,runtime_image:runtimeImage,network_checks:networkCheck,runtime_without_vendor_or_app_credentials:true,host_binds:null,published_ports:{},...result,scope:'Real Linux OpenCode 1.3.13 and production Go bridge with fake application ledger and fake vendor. Does not prove real database, paid model quality, or deployment-host isolation.'};
  } catch (error) {
    const diagnostics=[];
    for(const name of [bridge,fixture,runtime]) diagnostics.push(`${name}: ${await docker('logs','--tail','20',name).catch(()=> 'unavailable')}`);
    throw new Error(`${error.message}\n${diagnostics.join('\n')}`,{cause:error});
  } finally {
    for (const name of [runtime,bridge,fixture,controller]) await docker('rm','-f',name).catch(()=>{});
    for (const name of [sandbox,trusted]) await docker('network','rm',name).catch(()=>{});
    assert.equal(await docker('ps','-aq','--filter',`label=${label}`),'','test containers leaked');
    assert.equal(await docker('network','ls','-q','--filter',`label=${label}`),'','test networks leaked');
  }
  await writeFile(new URL('./model-proxy-isolation.fixture.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
  await appendFile(new URL('./baseline.md',import.meta.url),`\nGo ModelProxy integration (${evidence.observed_at}): actual pinned Linux OpenCode completed 3 admitted model sends and 2 corpus tools through the production Go bridge. Natural SDK max_tokens was 1800 on every send; exact bounded request digests and completed usage receipts matched the fake ledger. Runtime vendor bypass/public egress were denied; no vendor/app credentials, host binds or published ports existed in runtime. Labelled test resources were removed. Paid requests: 0. This covers fake-ledger integration only, not real-DB end-to-end publication or model quality.\n`);
});
