import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const exec = promisify(execFile);
const image = 'weavesense-opencode-probe:1.3.13';
async function docker(...args) {
  const result = await exec('docker', args, { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}
const restricted = ['--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=768m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000', '--tmpfs', '/state:rw,noexec,nosuid,size=256m,uid=1000,gid=1000'];
const controlToken = 'offline-wrapper-control-fixture';
const wrapperScript = `
import assert from 'node:assert/strict';
const base='http://127.0.0.1:4097';
async function req(route,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{authorization:'Bearer ${controlToken}',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});let value=null;const text=await r.text();if(text)value=JSON.parse(text);return {status:r.status,value}}
assert.equal((await fetch(base+'/health')).status,401);
const prepared=await req('/prepare',{run_id:'container-fixture-run',grant:'opaque-run-grant-fixture',claim_token:'opaque-claim-token-fixture'});assert.equal(prepared.status,200,JSON.stringify(prepared));
const identity={instance_id:prepared.value.instance_id,epoch:prepared.value.epoch};
assert.equal((await req('/start',identity)).status,200);
const session=await req('/forward',{...identity,method:'POST',path:'/session',body:{title:'Isolated research'}});assert.equal(session.status,200,JSON.stringify(session));
assert.equal((await req('/forward',{...identity,method:'POST',path:'/session/'+session.value.id+'/prompt_async',body:{parts:[{type:'text',text:'Research the approved cotton corpus. Return report JSON.'}]}})).status,204);
let report;
for(let n=0;n<150;n++){const result=await req('/forward',{...identity,method:'GET',path:'/session/'+session.value.id+'/message'});assert.equal(result.status,200);report=result.value.flatMap(m=>m.parts).find(p=>p.type==='text'&&p.text.includes('Isolated fixture report'));if(report)break;await new Promise(r=>setTimeout(r,100))}
assert.ok(report,'real runtime did not produce a report');
const counts=await(await fetch('http://fixture-bridge:8792/fixture/counts')).json();assert.deepEqual(counts,{modelCalls:3,toolCalls:2});
const denied=await req('/forward',{...identity,method:'GET',path:'/file/content?path=/etc/passwd'});assert.equal(denied.status,400);
const stop=await req('/stop',identity);assert.equal(stop.status,200,JSON.stringify(stop));assert.equal(stop.value.stopped,true);
const next=await req('/prepare',{run_id:'container-next-run',grant:'opaque-run-grant-fixture',claim_token:'opaque-claim-token-fixture'});assert.equal(next.status,200);assert.notEqual(next.value.epoch,identity.epoch);
const old=await req('/status?instance_id='+identity.instance_id+'&epoch='+identity.epoch);assert.equal(old.status,409);
const nextIdentity={instance_id:next.value.instance_id,epoch:next.value.epoch};assert.equal((await req('/start',nextIdentity)).status,200);
const fresh=await req('/status?instance_id='+nextIdentity.instance_id+'&epoch='+nextIdentity.epoch);assert.equal(fresh.value.session_id,null);
assert.equal((await req('/forward',{...nextIdentity,method:'GET',path:'/session/'+session.value.id+'/message'})).status,400);
await req('/stop',{instance_id:next.value.instance_id,epoch:next.value.epoch});
console.log(JSON.stringify({counts,version:prepared.value.version,stop_confirmed:stop.value.stopped,stale_epoch_rejected:true,forbidden_file_route_rejected:true,fresh_task_history_isolated:true}));
`;

const processTreeScript = `import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {terminateProcessTree} from '/opt/runtime/server.mjs';
const source=\`const {spawn}=require('node:child_process');const child=spawn('/bin/sleep',['60']);console.log(child.pid);setInterval(()=>{},1000);\`;
const parent=spawn(process.execPath,['-e',source],{detached:true,stdio:['ignore','pipe','ignore']});
const descendant=await new Promise((resolve,reject)=>{parent.stdout.once('data',d=>resolve(Number(d.toString().trim())));parent.once('error',reject)});
assert.ok(descendant>0);assert.equal(await terminateProcessTree(parent),true);
for(const pid of [parent.pid,descendant])assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
console.log(JSON.stringify({parent_and_descendant_terminated:true}));`;

test('real pinned Linux runtime completes fake research and blocks forbidden network exits', { timeout: 180000 }, async () => {
  // A missing daemon/image is a failure, never skipped success.
  const dockerVersion = await docker('version', '--format', '{{.Server.Version}}');
  const imageInfo = JSON.parse(await docker('image', 'inspect', image));
  assert.equal(imageInfo[0].Config.User, 'node');
  assert.equal(imageInfo[0].Architecture, 'amd64');
  const productionInfo = JSON.parse(await docker('image', 'inspect', 'weavesense-opencode-runtime:1.3.13'))[0];
  const productionArtifact = JSON.parse(await docker('run', '--rm', '--network', 'none', ...restricted, 'weavesense-opencode-runtime:1.3.13', 'node', '--input-type=module', '-e', `import assert from 'node:assert/strict';import fs from 'node:fs';import{createHash}from'node:crypto';assert.equal(fs.existsSync('/opt/probe'),false);console.log(JSON.stringify({binary_sha256:createHash('sha256').update(fs.readFileSync('/usr/local/bin/opencode')).digest('hex'),wrapper_sha256:createHash('sha256').update(fs.readFileSync('/opt/runtime/server.mjs')).digest('hex'),test_fixtures_absent:true}));`));
  const suffix = randomUUID().slice(0, 8), network = `weavesense-isolation-${suffix}`;
  const runtime = `weavesense-runtime-${suffix}`, bridge = `weavesense-bridge-${suffix}`;
  const host = createServer((_req, res) => res.end('forbidden-host-canary'));
  await new Promise((resolve) => host.listen(0, '0.0.0.0', resolve));
  const hostPort = host.address().port;
  let networkEvidence, actualProbe, wrapperEvidence, security;
  try {
    // Resolve the host using an unrestricted control, then test its numeric IP
    // inside the sandbox too. DNS denial alone is not an egress boundary.
    const hostControl = JSON.parse(await docker('run', '--rm', ...restricted, image, 'node', '--input-type=module', '-e', `import dns from 'node:dns/promises';const address=(await dns.lookup('host.docker.internal',{family:4})).address;const r=await fetch('http://'+address+':${hostPort}',{signal:AbortSignal.timeout(4000)});console.log(JSON.stringify({status:r.status,text:await r.text(),address}));`));
    assert.equal(hostControl.status, 200); assert.equal(hostControl.text, 'forbidden-host-canary');
    await docker('network', 'create', '--internal', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', network);
    const netInfo = JSON.parse(await docker('network', 'inspect', network))[0];
    assert.equal(netInfo.Internal, true);
    await docker('run', '-d', '--name', bridge, '--network', network, '--network-alias', 'fixture-bridge', ...restricted, image, 'node', '/opt/probe/isolation.fixture.mjs');
    await docker('run', '-d', '--name', runtime, '--network', network, ...restricted,
      '-e', `OPENCODE_RUNTIME_TOKEN=${controlToken}`, '-e', 'OPENCODE_BRIDGE_URL=http://fixture-bridge:8792', '-e', 'OPENCODE_MODEL_NAME=fixture', image, 'node', '/opt/runtime/server.mjs');
    const inspect = JSON.parse(await docker('inspect', runtime))[0];
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
    assert.ok(inspect.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.deepEqual(inspect.HostConfig.PortBindings, {});
    assert.equal(inspect.HostConfig.Binds, null);
    assert.ok(inspect.Mounts.every((mount) => mount.Type === 'tmpfs'));
    security = { user: inspect.Config.User, read_only: true, cap_drop: inspect.HostConfig.CapDrop, security_opt: inspect.HostConfig.SecurityOpt, pids_limit: inspect.HostConfig.PidsLimit, memory: inspect.HostConfig.Memory, host_binds: inspect.HostConfig.Binds, exposed_host_ports: inspect.HostConfig.PortBindings };
    const networkScript = `import net from 'node:net';import dns from 'node:dns/promises';
      const targets=[['approved_bridge','fixture-bridge',8792],['public_ipv4','1.1.1.1',80],['public_ipv6','2606:4700:4700::1111',80],['host_alias','host.docker.internal',${hostPort}],['host_numeric_canary','${hostControl.address}',${hostPort}],['host_numeric_model_port','${hostControl.address}',8792],['link_local_metadata','169.254.169.254',80]];
      const out=await Promise.all(targets.map(async([name,hostname,port])=>{let address;try{address=(await dns.lookup(hostname)).address}catch{address=hostname}return await new Promise(resolve=>{const socket=net.connect({host:hostname,port});let done=false;const finish=(allowed,error)=>{if(done)return;done=true;socket.destroy();resolve({name,hostname,address,port,allowed,error})};socket.once('connect',()=>finish(true));socket.once('error',e=>finish(false,e.code));socket.setTimeout(1500,()=>finish(false,'TIMEOUT'))})}));console.log(JSON.stringify(out));`;
    networkEvidence = JSON.parse(await docker('exec', runtime, 'node', '--input-type=module', '-e', networkScript));
    assert.equal(networkEvidence.find((x) => x.name === 'approved_bridge').allowed, true);
    for (const target of networkEvidence.filter((x) => x.name !== 'approved_bridge')) assert.equal(target.allowed, false, JSON.stringify(target));
    actualProbe = JSON.parse(await docker('exec', runtime, 'node', '--input-type=module', '-e', `import {probe} from '/opt/probe/scripts/opencode-contract-probe.mjs';console.log(JSON.stringify(await probe({persist:false})));`));
    assert.equal(actualProbe.version, '1.3.13'); assert.equal(actualProbe.platform, 'linux-x64'); assert.equal(actualProbe.real_paid_model_requests, 0);
    wrapperEvidence = JSON.parse(await docker('exec', runtime, 'node', '--input-type=module', '-e', wrapperScript));
    const processTreeEvidence = JSON.parse(await docker('exec', runtime, 'node', '--input-type=module', '-e', processTreeScript));
    const binaryHash = (await docker('exec', runtime, 'sha256sum', '/usr/local/bin/opencode')).split(' ')[0];
    assert.equal(actualProbe.binary_sha256, binaryHash);
    assert.equal(productionArtifact.binary_sha256, binaryHash);
    const probeWrapperHash = (await docker('exec', runtime, 'sha256sum', '/opt/runtime/server.mjs')).split(' ')[0];
    assert.equal(productionArtifact.wrapper_sha256, probeWrapperHash, 'production and tested wrapper must be identical');
    const lockPath = new URL('./runtime-lock.json', import.meta.url);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const hostInfo = JSON.parse(await docker('info', '--format', '{{json .}}'));
    const observedAt = new Date().toISOString();
    lock.linux = { version: '1.3.13', source: 'https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.3.13.tgz', npm_integrity: 'sha512-zL+gG/TnevdTgbc6z3RwYXIpaodmdt2IqHF+CAQuf8Ayzx1LF0SvkkiclIEz12kdjlfttjNOxuRFWCJLzQIJIw==', license: 'MIT', binary_sha256: binaryHash,
      base_image: 'public.ecr.aws/docker/library/node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752', probe_image_id: imageInfo[0].Id, runtime_image_id: productionInfo.Id, runtime_image_digest: null,
      runtime_local_repo_digests: productionInfo.RepoDigests, runtime_image_reference: 'local build: weavesense-opencode-runtime:1.3.13; no published/pullable registry manifest attested', production_artifact: productionArtifact, docker_version: dockerVersion,
      network_isolation_verified: true, network_profile: { internal: true, gateway_mode_ipv4: 'isolated', docker_network_options: netInfo.Options }, network_checks: networkEvidence, positive_host_control: hostControl,
      security, real_runtime_probe: actualProbe, wrapper_probe: wrapperEvidence, process_tree: processTreeEvidence,
      deployment_host: { docker_id: hostInfo.ID, docker_version: hostInfo.ServerVersion, platform: `${hostInfo.OSType}/${hostInfo.Architecture}`, verified_at: observedAt },
      observed_at: observedAt, scope: 'Docker Desktop Linux bridge isolated profile; repeat on the deployment host before enabling live use', live_accepted: false };
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
    await writeFile(new URL('./isolation.fixture.json', import.meta.url), JSON.stringify(lock.linux, null, 2) + '\n');
  } finally {
    await Promise.all([docker('rm', '-f', runtime).catch(() => {}), docker('rm', '-f', bridge).catch(() => {})]);
    await docker('network', 'rm', network).catch(() => {});
    await new Promise((resolve) => host.close(resolve));
  }
});
