import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// Only disposable, randomly named resources; no production env files or services.
const exec = promisify(execFile);
const image = 'weavesense-subtitle:2026.08.19';
const suffix = randomUUID().slice(0, 8);
const internal = `subtitle-check-in-${suffix}`, external = `subtitle-check-out-${suffix}`;
const worker = `subtitle-check-worker-${suffix}`, egress = `subtitle-check-egress-${suffix}`, canary = `subtitle-check-app-${suffix}`;
const token = 'offline-subtitle-control-token-123', proxy = 'offline-subtitle-proxy-token-456';
const restrict = ['--init','--user','1000:1000','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=256m','--tmpfs','/tmp:rw,noexec,nosuid,size=32m,uid=1000,gid=1000'];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|HOME|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG)$/i.test(k)));
async function docker(...args) { return (await exec('docker', args, {env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024})).stdout.trim(); }
async function py(container, source) { return JSON.parse(await docker('exec',container,'python','-c',source)); }
const http = createServer((_req,res)=>res.end('subtitle-host-positive-canary'));
const udp = createSocket('udp4'); udp.on('message',(message,remote)=>udp.send(message,remote.port,remote.address));
const evidence = { mode:'offline-production-image-isolation', live_youtube_acceptance:false, checks:{} };
try {
  evidence.docker = await docker('version','--format','{{.Server.Version}}');
  evidence.image = JSON.parse(await docker('image','inspect',image,'--format','{{json .}}')).Id;
  const compose = await readFile(new URL('../../docker-compose.yml',import.meta.url),'utf8');
  // No compose config resolution: it reads external env_file credentials. Static
  // contract + actual inspected disposable topology cover this public manifest.
  for(const name of ['subtitle-worker','subtitle-egress']) {
    const block=compose.split(`  ${name}:`)[1].split(/\n {2}[a-z][a-z-]*:/)[0];
    assert.match(block,/profiles: \["subtitles"\]/); assert.doesNotMatch(block,/ports:|volumes:|privileged:|LOOM_EGRESS_CIDRS/);
  }
  const app=compose.split('  app:')[1].split(/\n {2}[a-z][a-z-]*:/)[0];
  assert.doesNotMatch(app,/subtitle-internal/); assert.match(app,/SUBTITLE_ENABLED: \$\{SUBTITLE_ENABLED:-false\}/);
  await new Promise(resolve=>http.listen(0,'0.0.0.0',resolve)); await new Promise(resolve=>udp.bind(0,'0.0.0.0',resolve));
  const hostPort=http.address().port, udpPort=udp.address().port;
  await docker('network','create','--internal','--driver','bridge','--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated',internal);
  await docker('network','create',external);
  const net=JSON.parse(await docker('network','inspect',internal))[0]; assert.equal(net.Internal,true); assert.equal(net.Options['com.docker.network.bridge.gateway_mode_ipv4'],'isolated');
  await docker('run','-d','--name',canary,'--network',external,'--network-alias','app-canary',...restrict,image,'python','-m','http.server','8080');
  await docker('run','-d','--name',egress,'--network',external,...restrict,'-e','SUBTITLE_ROLE=egress','-e',`SUBTITLE_SERVICE_TOKEN=${token}`,'-e',`SUBTITLE_PROXY_TOKEN=${proxy}`,image);
  await docker('network','connect','--alias','subtitle-egress',internal,egress);
  const fixture = `import asyncio,server
async def fake(video,language):
 return dict(status='no_subtitles',video_id=video,language=language,kind='none',text='')
async def main():
 app=server.Server('worker','${token}','${proxy}',extractor=fake)
 listener=await asyncio.start_server(app.handle,'0.0.0.0',8793,limit=8192)
 async with listener: await listener.serve_forever()
asyncio.run(main())`;
  await docker('run','-d','--name',worker,'--network',internal,'--network-alias','subtitle-worker','--dns','127.0.0.1',...restrict,image,'python','-c',fixture);
  for (const name of [worker,egress]) {
    const info=JSON.parse(await docker('inspect',name))[0];
    assert.equal(info.HostConfig.ReadonlyRootfs,true); assert.deepEqual(info.HostConfig.CapDrop,['ALL']); assert.equal(info.Config.User,'1000:1000');
    assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges')); assert.deepEqual(info.HostConfig.PortBindings,{}); assert.equal(info.HostConfig.Binds,null);
    assert.equal(info.HostConfig.Memory,268435456); assert.equal(info.HostConfig.PidsLimit,64); assert.match(info.HostConfig.Tmpfs['/tmp'],/size=32m/);
    assert.deepEqual(Object.keys(info.NetworkSettings.Networks).sort(),(name===worker?[internal]:[internal,external]).sort());
  }
  const appIP=JSON.parse(await docker('inspect',canary))[0].NetworkSettings.Networks[external].IPAddress;
  const egressIP=JSON.parse(await docker('inspect',egress))[0].NetworkSettings.Networks[external].IPAddress;
  // Verify the host and app canaries are ALIVE from the unrestricted external
  // bridge before interpreting any negative worker probes.
  const positive = JSON.parse(await docker('run','--rm','--network',external,...restrict,image,'python','-c',`import json,socket,urllib.request,time
socket.setdefaulttimeout(3)
host=socket.gethostbyname('host.docker.internal')
assert urllib.request.urlopen('http://'+host+':${hostPort}',timeout=3).read()==b'subtitle-host-positive-canary'
assert urllib.request.urlopen('http://${appIP}:8080',timeout=3).status==200
u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);u.settimeout(3);u.sendto(b'positive',(host,${udpPort}));assert u.recv(50)==b'positive'
for n in range(40):
 try:
  assert urllib.request.urlopen('http://${egressIP}:8794/health',timeout=2).status==200
  break
 except Exception:
  if n==39: raise
  time.sleep(.1)
print(json.dumps({'host':host,'host_tcp':True,'host_udp':True,'app':True,'egress_health':True}))`));
  evidence.checks.positive=positive;
  evidence.checks.control = JSON.parse(await docker('run','--rm','--network',external,...restrict,image,'python','-c',`import json,urllib.request,urllib.error
base='http://${egressIP}:8794/v1/transcript'
def call(token):
 req=urllib.request.Request(base,data=b'{"video_id":"BaW_jenozKc","language":"en"}',headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
 try:
  r=urllib.request.urlopen(req,timeout=5);return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
assert call('')[0]==401
status,body=call('${token}');assert status==200,(status,body);assert body['status']=='no_subtitles'
print(json.dumps({'authenticated_relay':True,'unauthenticated_401':True}))`));
  evidence.checks.network = await py(worker, `import asyncio,json,socket
async def probe(name,host,port):
 try:
  r,w=await asyncio.wait_for(asyncio.open_connection(host,port),1.5);w.close();await w.wait_closed();return {'name':name,'allowed':True}
 except Exception:return {'name':name,'allowed':False}
async def main():
 targets=[('relay','subtitle-egress',8794),('public_ipv4','1.1.1.1',80),('public_ipv6','2606:4700:4700::1111',80),('host_alias','host.docker.internal',${hostPort}),('host_numeric','${positive.host}',${hostPort}),('metadata','169.254.169.254',80),('app','${appIP}',8080),('public_dns_tcp','1.1.1.1',53),('host_dns_tcp','${positive.host}',53)]
 out=await asyncio.gather(*(probe(*t) for t in targets))
 try: await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo('example.com',443),3); dns=True
 except Exception: dns=False
 print(json.dumps({'tcp':out,'external_dns':dns}))
asyncio.run(main())`);
  for(const result of evidence.checks.network.tcp) assert.equal(result.allowed,result.name==='relay',JSON.stringify(result));
  assert.equal(evidence.checks.network.external_dns,false);
  evidence.checks.udp = await py(worker, `import json,socket
out=[]
for name,host,port in [('host_udp','${positive.host}',${udpPort}),('public_dns_udp','1.1.1.1',53),('host_dns_udp','${positive.host}',53)]:
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(1.5)
 try:
  query=bytes.fromhex('123401000001000000000000076578616d706c6503636f6d0000010001') if port==53 else b'positive'
  s.sendto(query,(host,port));s.recv(512);allowed=True
 except OSError: allowed=False
 finally:s.close()
 out.append({'name':name,'allowed':allowed})
print(json.dumps(out))`);
  for(const result of evidence.checks.udp) assert.equal(result.allowed,false,JSON.stringify(result));
  evidence.checks.proxy = await py(worker, `import socket,json,base64
s=socket.create_connection(('subtitle-egress',8794),3)
auth=base64.b64encode(b'subtitle:${proxy}').decode()
s.sendall(('CONNECT attacker.example:443 HTTP/1.1\\r\\nHost: attacker.example:443\\r\\nProxy-Authorization: Basic '+auth+'\\r\\n\\r\\n').encode())
reply=s.recv(1024);assert b' 403 ' in reply,reply
s.close();print(json.dumps({'authenticated_proxy_reachable':True,'unknown_host_refused':True}))`);
  // Run all protocol/process checks against the actual production module in the
  // same image, with test source supplied via stdin rather than built fixtures.
  const tests=await readFile(new URL('./test_server.py',import.meta.url),'utf8');
  const testPath=`/tmp/test_server_${suffix}.py`;
  const writeCode=`from pathlib import Path;Path('${testPath}').write_text(${JSON.stringify(tests)},encoding='utf-8')`;
  await docker('exec',worker,'python','-c',writeCode);
  evidence.checks.protocol=await docker('exec',worker,'python','-c',`import runpy,sys,unittest,json;sys.path.insert(0,'/opt/subtitle');namespace=runpy.run_path('${testPath}');suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(namespace[name]) for name in ['Protocol','ProcessAndExtraction']);result=unittest.TextTestRunner().run(suite);print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped)}));sys.exit(not result.wasSuccessful() or bool(result.skipped))`);
  evidence.passed=true;
} catch(error) {
  evidence.passed=false; evidence.error=String(error.message).slice(0,4000); throw error;
} finally {
  for(const name of [worker,egress,canary]) await docker('rm','-f',name).catch(()=>{});
  for(const name of [internal,external]) await docker('network','rm',name).catch(()=>{});
  if(http.listening) await new Promise(resolve=>http.close(resolve)); try{udp.close();}catch{ /* not yet bound */ }
  const report=process.argv[2]; if(report) await writeFile(report,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
}
