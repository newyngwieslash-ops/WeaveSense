import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { offlineEnv } from '../../../scripts/readiness-offline.mjs';
import { packExcluded } from '../../../scripts/deployment-policy.mjs';

const [sha,context,appImage,telethonImage,reportPath]=process.argv.slice(2);
assert.match(sha,/^[a-f0-9]{40}$/);assert.ok(context&&appImage&&telethonImage&&reportPath);
const nonce=`t18-release-${sha.slice(0,7)}-${Date.now().toString(36)}`;
const env=offlineEnv(process.env);const report={ok:false,sourceSha:sha,scope:'isolated-Linux-image-release-candidate',productionActivated:false,roles:{},rollback:{production:'not-surveyed; no-production-deployment',isolated:{}},checks:{},cleanup:[]};
const owned=[];let network;
function run(command,args,{input,timeout=180000,cwd=process.cwd(),overrides={},log}={}) {
  const result=spawnSync(command,args,{encoding:'utf8',input,timeout,windowsHide:true,maxBuffer:64*1024*1024,cwd,env:offlineEnv(process.env,overrides)});
  if(log)writeFileSync(log,`${result.stdout??''}\n${result.stderr??''}`,{flag:'wx'});
  assert.equal(result.status,0,`${command} ${args[0]} failed: ${result.stderr?.slice(-3000)}`);return result.stdout.trim();
}
const docker=(args,options)=>run('docker',args,options);
const inspect=id=>JSON.parse(docker(['inspect',id]))[0];
function start(role,image,extra=[],command=[]) {
  const name=`${nonce}-${role}`;
  const id=docker(['run','-d','--name',name,'--label',`loom.t18.release=${nonce}`,'--memory','1g','--cpus','2',...extra,image,...command]);owned.push(id);
  const details=inspect(id);report.roles[role]={containerId:id,imageId:details.Image,command:details.Config.Cmd,revision:details.Config.Labels?.['org.opencontainers.image.revision']??null};
  return {name,id,details};
}
async function healthy(url,options={}) {for(let i=0;i<120;i++){try{const r=await fetch(url,options);if(r.ok)return r;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error(`isolated_health_timeout:${url}`);}
function execJson(id,code) {return JSON.parse(docker(['exec',id,'node','-e',code]));}
function zipInventory(bytes) {
  const files=new Map();let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){const method=bytes.readUInt16LE(offset+8),size=bytes.readUInt32LE(offset+18),len=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);const name=bytes.subarray(offset+30,offset+30+len).toString().replace(/^zhishi-loom\//,'');const begin=offset+30+len+extra;const body=bytes.subarray(begin,begin+size);assert.equal(packExcluded(name),false,name);files.set(name,method===8?inflateRawSync(body):body);offset=begin+size;}
  const tests=JSON.parse(files.get('package.json')).scripts.test.match(/(?:scripts|src|validation)\/[^\s]+\.test\.(?:ts|mjs)/g);for(const name of tests)assert.ok(files.has(name),name);assert.ok(files.has('validation/agent/contracts/analyze-valid.json'));
  return {entries:files.size,sha256:createHash('sha256').update(bytes).digest('hex'),registeredTests:tests.length,privateStateExcluded:true};
}
try {
  for(const [role,image] of [['app',appImage],['telethon',telethonImage]]){const info=JSON.parse(docker(['image','inspect',image]))[0];assert.equal(info.Config.Labels['org.opencontainers.image.revision'],sha);report.checks[`${role}Image`]={id:info.Id,tags:info.RepoTags,revision:sha};}
  network=docker(['network','create','--opt','com.docker.network.bridge.enable_ip_masquerade=false','--label',`loom.t18.release=${nonce}`,nonce]);
  report.network={scope:'owned fixture bridge; loopback app publication; masquerade disabled',externalProviders:'none configured; zero source rows; auto/paid disabled; browser external requests stubbed'};
  const pg=start('postgres','postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
    ['--network',nonce,'--network-alias','pg','-e','POSTGRES_DB=t18_release','-e','POSTGRES_PASSWORD=t18-dummy-release']);
  for(let n=0;n<80;n++){const r=spawnSync('docker',['exec',pg.id,'pg_isready','-h','127.0.0.1','-U','postgres','-d','t18_release'],{env,encoding:'utf8',windowsHide:true});if(r.status===0)break;await new Promise(r=>setTimeout(r,250));}
  const migration=start('migration',appImage,['--network',nonce,'-e','DATABASE_URL=postgresql://postgres:t18-dummy-release@pg:5432/t18_release'],['node','scripts/migrate.mjs']);
  assert.equal(docker(['wait',migration.id]),'0');report.checks.migrationLog=docker(['logs',migration.id]);
  docker(['exec','-i',pg.id,'psql','-U','postgres','-d','t18_release','-v','ON_ERROR_STOP=1'],{input:"insert into app_meta(key,value) values('seeded','1'); insert into sources(id,platform,name,enabled) values('src_kw_radar','rss','Disabled fixture radar',false); insert into keywords(id,phrase,enabled) values('t18-disabled','fixture keyword',false);"});
  report.checks.disabledFixtureInputs=docker(['exec',pg.id,'psql','-U','postgres','-d','t18_release','-Atc','select (select count(*) from sources where enabled)+(select count(*) from keywords where enabled)']);assert.equal(report.checks.disabledFixtureInputs,'0');
  const app=start('app',appImage,['--network',nonce,'--network-alias','app','-p','127.0.0.1::8080',
    '-e','DATABASE_URL=postgresql://postgres:t18-dummy-release@pg:5432/t18_release','-e','CRON_SECRET=t18-dummy-cron',
    '-e','AUTO_ANALYZE=false','-e','EXTRACT_AUTO=false','-e','AGENT_WORKER_ENABLED=false','-e','AGENT_ASYNC_RESEARCH_ENABLED=false','-e','LOOM_MODEL_CONFIG=/tmp/disabled-missing.json']);
  await new Promise(r=>setTimeout(r,1000));
  const activeApp=inspect(app.id);if(!activeApp.State.Running)throw Error(`app startup exited: ${docker(['logs',app.id])}`);
  const port=Number(activeApp.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort);assert.ok(port,`missing app published port: ${JSON.stringify(activeApp.NetworkSettings.Ports)}`);const origin=`http://127.0.0.1:${port}`;
  const homepage=await healthy(origin);report.checks.appHttp={status:homepage.status,bytes:(await homepage.text()).length};
  const guide=await healthy(`${origin}/guide`);assert.match(await guide.text(),/zhishi-loom-source\.zip/);
  const archive=Buffer.from(await(await healthy(`${origin}/zhishi-loom-source.zip`)).arrayBuffer());report.checks.download=zipInventory(archive);
  mkdirSync('artifacts',{recursive:true});writeFileSync(join('artifacts',`${nonce}-source.zip`),archive,{flag:'wx'});
  assert.equal(docker(['exec',pg.id,'psql','-U','postgres','-d','t18_release','-Atc','select (select count(*) from sources where enabled)+(select count(*) from keywords where enabled)']),'0');
  const scheduler=start('scheduler',appImage,['--network',nonce,'-e','CRON_ENDPOINT=http://app:8080/api/cron/tick','-e','CRON_SECRET=t18-dummy-cron','-e','CRON_INTERVAL_MS=60000'],['npm','run','cron:start']);
  let tick;for(let n=0;n<120;n++){const text=docker(['logs',scheduler.id]);tick=text.split(/\r?\n/).map(l=>{try{return JSON.parse(l)}catch{return null}}).find(r=>r?.status===200);if(tick)break;await new Promise(r=>setTimeout(r,500));}
  assert.ok(tick,'scheduler did not successfully call real isolated app');assert.equal(tick.error_count,0);report.checks.schedulerTick=tick;
  report.checks.enabledInputsAfterTick=docker(['exec',pg.id,'psql','-U','postgres','-d','t18_release','-Atc','select (select count(*) from sources where enabled)+(select count(*) from keywords where enabled)']);assert.equal(report.checks.enabledInputsAfterTick,'0');
  const gateway=start('gateway',appImage,['--network','none','--read-only','--tmpfs','/data','--tmpfs','/tmp','-e','WECHAT_GATEWAY_TOKEN=t18-dummy-gateway','-e','GATEWAY_DB_PATH=/data/gateway.sqlite','-e','PORT=8790','-e','WECHAT_PRIMARY_ALLOWED_HOSTS=fixture.invalid','-e','DAJIALA_DAILY_BUDGET_RMB=0','-e','DAJIALA_DAILY_CALL_LIMIT=0'],['npm','run','gateway:start']);
  await new Promise(r=>setTimeout(r,1500));
  const health=execJson(gateway.id,"fetch('http://127.0.0.1:8790/v1/health',{headers:{authorization:'Bearer t18-dummy-gateway'}}).then(async r=>{if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()))})");report.checks.gatewayHealth=health;
  const telegram=start('telethon',telethonImage,['--network','none','--read-only','--tmpfs','/data','--tmpfs','/tmp','-e','PORT=8787']);await new Promise(r=>setTimeout(r,1500));
  const tgHealth=JSON.parse(docker(['exec',telegram.id,'python','-c',"import json,urllib.request;print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8787/health'))))"]));assert.equal(tgHealth.state,'unconfigured');assert.equal(tgHealth.authorized,false);report.checks.telethonHealth=tgHealth;
  report.checks.nodeRuntime=docker(['exec',app.id,'node','--version']);report.checks.pythonRuntime=docker(['exec',telegram.id,'python','--version']);report.checks.pythonPackages=docker(['exec',telegram.id,'python','-m','pip','freeze']).split(/\r?\n/);
  docker(['exec',telegram.id,'python','-m','pip','check']);
  const coreLog=join('.superpowers','sdd',`${nonce}-node-tests.log`);
  docker(['run','--rm','--network','none','--read-only','--tmpfs','/tmp','--memory','1g','--cpus','2',appImage,'sh','-c','node --test scripts/restore-policy.test.mjs scripts/collection-backup.test.mjs scripts/cron-loop.test.mjs workers/wechat-gateway/*.test.mjs'],{log:coreLog});report.checks.nodeTests={exit:0,log:coreLog};
  const checkName=`${nonce}-python-check`;const checkId=docker(['create','--name',checkName,'--label',`loom.t18.release=${nonce}`,'--network','none','--memory','512m','--cpus','2',telethonImage,'python','-m','unittest','discover','-s','.','-p','test_history.py']);owned.push(checkId);
  docker(['cp',join(resolve(context),'workers/telethon/test_history.py'),`${checkId}:/app/test_history.py`]);
  const pyLog=join('.superpowers','sdd',`${nonce}-python-tests.log`);docker(['start','-a',checkId],{log:pyLog});assert.equal(inspect(checkId).State.ExitCode,0);report.checks.pythonTests={exit:0,log:pyLog};
  const screenshot=`screenshots/${nonce}.png`;const smokeLog=join('.superpowers','sdd',`${nonce}-browser.log`);
  run(process.execPath,['scripts/browser-smoke.mjs',origin,screenshot],{overrides:{AGENT_OFFLINE_SMOKE:'true'},log:smokeLog});
  report.checks.browser=JSON.parse(readFileSync(screenshot.replace(/\.png$/,'.json'),'utf8'));report.checks.screenshots=[resolve(screenshot),resolve(screenshot.replace(/\.png$/,'-mobile.png'))];
  report.checks.migrations=docker(['exec',pg.id,'psql','-U','postgres','-d','t18_release','-Atc','select name from _migrations order by name']).split(/\r?\n/);
  for(const role of ['app','scheduler','gateway','telethon'])report.rollback.isolated[role]=report.roles[role].imageId;
  report.rollback.note='These are verified candidate artifact IDs that can be restarted in this isolated lab; production pre-switch IDs require separate approved inventory.';
  report.ok=true;
} catch(e){report.error=String(e.stack);throw e;}
finally {
  for(const id of owned.reverse()){try{const current=inspect(id);assert.equal(current.Config.Labels['loom.t18.release'],nonce);const logs=docker(['logs',id]);docker(['rm','-f','-v',id]);report.cleanup.push({id,removed:true,exitCode:current.State.ExitCode,logs:logs.slice(-10000)});}catch{report.ok=false;report.cleanup.push({id,removed:false});}}
  if(network){try{const n=JSON.parse(docker(['network','inspect',network]))[0];assert.equal(n.Labels['loom.t18.release'],nonce);docker(['network','rm',network]);report.cleanup.push({network,removed:true});}catch{report.ok=false;}}
  assert.equal(existsSync(reportPath),false);writeFileSync(reportPath,JSON.stringify(report,null,2),{flag:'wx'});
}
console.log(JSON.stringify({ok:report.ok,sourceSha:sha,reportPath,checks:Object.keys(report.checks)}));if(!report.ok)process.exitCode=1;
