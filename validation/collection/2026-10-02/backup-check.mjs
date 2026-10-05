#!/usr/bin/env node
/** Isolated fixture exercise of the delivered operator CLI. No production config.
 * node validation/collection/2026-10-02/backup-check.mjs <SHA|development>
 *   <primary-root> <secondary-root> <report.json> <python-executable>
 * Both roots must already exist; creates only unique children, never deletes files.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { offlineEnv } from '../../../scripts/readiness-offline.mjs';
import { privateDirectory, restrictPath, initKey, sha256, seal, unseal } from '../../../scripts/collection-backup.mjs';
import { openStore } from '../../../workers/wechat-gateway/store.mjs';

const [sha,primaryRoot,secondaryRoot,reportPath,python]=process.argv.slice(2);
assert.ok(sha==='development'||/^[a-f0-9]{40}$/.test(sha));
assert.ok(primaryRoot&&secondaryRoot&&reportPath&&python);
const nonce=`t18-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const env=offlineEnv(process.env,{LOOM_BACKUP_PG_PASSWORD:'t18-dummy-only',LOOM_BACKUP_MINIO_ACCESS:'t18-dummy',LOOM_BACKUP_MINIO_SECRET:'t18-dummy-only'});
const PG='postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
const MINIO='minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
const NODE='node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c';
const report={ok:false,scope:'isolated-fixture-only',sourceSha:sha,runtime:process.version,nonce,productionActivated:false,offMachine:false,failures:{},resources:[]};
const run=(command,args,input)=>{
  const r=spawnSync(command,args,{input,encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:32*1024*1024,env});
  assert.equal(r.status,0,`${command} operation failed: ${(r.stderr??'').slice(-2000)}`);return r.stdout.trim();
};
const docker=args=>run('docker',args);
const inspect=id=>JSON.parse(docker(['inspect',id]))[0];
const owned=[];
function start(role,image,extra=[],command=[]) {
  const name=`${nonce}-${role}`;
  const id=docker(['run','-d','--name',name,'--label',`loom.backup.group=${nonce}`,'--label',`loom.backup.role=${role}`,
    '--memory','512m','--cpus','2',...extra,image,...command]);
  owned.push(id); const state=inspect(id);
  report.resources.push({role,id,image:state.Image,digest:image,memory:state.HostConfig.Memory,nanoCpus:state.HostConfig.NanoCpus});
  return {name,id,state};
}
const root=privateDirectory(tmpdir(),nonce); const lab=privateDirectory(root,'lab');
const keyPath=initKey(root,'keys'); const restoreRoot=privateDirectory(lab,'restored'); const scratchRoot=privateDirectory(lab,'scratch');
const localConfig=join(lab,'operator.local.json');
function cli(action,config,success=true) {
  writeFileSync(localConfig,JSON.stringify(config),{mode:0o600}); restrictPath(localConfig);
  const r=spawnSync(process.execPath,['scripts/collection-backup.mjs',action,localConfig],{encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:32*1024*1024,env});
  if(success) {assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
  assert.notEqual(r.status,0);assert.ok(!`${r.stdout}${r.stderr}`.includes('t18-dummy-only'));return r.stderr.trim();
}
let client;
try {
  const source=start('postgres',PG,['-e','POSTGRES_PASSWORD=t18-dummy-only','-e','POSTGRES_DB=t18','-p','127.0.0.1::5432']);
  const storage=start('minio',MINIO,['-e','MINIO_ROOT_USER=t18-dummy','-e','MINIO_ROOT_PASSWORD=t18-dummy-only','-p','127.0.0.1::9000'],['server','/data']);
  for(const role of ['app','scheduler','telethon','gateway']) {const r=start(role,NODE,['--network','none'],['node','-e','process.exit(0)']);assert.equal(docker(['wait',r.id]),'0');}
  const port=Number(source.state.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  const minioPort=Number(storage.state.NetworkSettings.Ports['9000/tcp'][0].HostPort);
  for(let i=0;i<80;i++) {
    const attempt=new pg.Client({host:'127.0.0.1',port,user:'postgres',password:'t18-dummy-only',database:'t18',connectionTimeoutMillis:1000});
    try {await attempt.connect();client=attempt;break;}catch{await attempt.end().catch(()=>{});await new Promise(r=>setTimeout(r,250));}
  }
  assert.ok(client,'PG fixture startup');
  await client.query('create table _migrations(name text primary key, applied_at timestamptz not null default now())');
  const schema=readdirSync('migrations').filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort();
  for(const name of schema) {await client.query(readFileSync(join('migrations',name),'utf8'));await client.query('insert into _migrations(name) values($1)',[name]);}
  const media=Buffer.from('fixture-media-t18-ordered-data');
  await client.query("insert into sources(id,platform,name,last_external_id) values('t18-source','rss','T18 fixture','42'); insert into items(id,source_id,platform,external_id,title,body,published_at) values('t18-item','t18-source','rss','42','fixture','body retained','2026-10-02T00:00:00Z'); insert into extract_jobs(id,item_id,kind,status) values('t18-pending','t18-item','ocr','pending')");
  await client.query("insert into media_objects(id,item_id,object_key,bytes,sha256,status) values('t18-media','t18-item','fixture/item.bin',$1,$2,'stored')",[media.length,sha256(media)]);
  await client.end();client=null;
  for(let i=0;i<80;i++) {if(await fetch(`http://127.0.0.1:${minioPort}/minio/health/live`).then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250));}
  run(python,['-c',"import sys,json,io;from minio import Minio;c=json.load(sys.stdin);m=Minio(c['endpoint'],access_key='t18-dummy',secret_key='t18-dummy-only',secure=False);m.make_bucket('t18-media');d=b'fixture-media-t18-ordered-data';m.put_object('t18-media','fixture/item.bin',io.BytesIO(d),len(d))"],JSON.stringify({endpoint:`127.0.0.1:${minioPort}`}));
  const sqlitePath=join(lab,'gateway.sqlite'); const store=openStore(sqlitePath);store.close();
  const sqlite=new DatabaseSync(sqlitePath);
  sqlite.exec("insert into reconciliation_outbox values('t18-source','2026-10-02T00:00:00Z'); insert into detail_queue(source_id,canonical_id,item_json,created_at,updated_at) values('t18-source','t18-item','{}','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z')");sqlite.close();
  const sessionPath=join(lab,'fixture.session');const session=new DatabaseSync(sessionPath);
  session.exec("create table sessions(dc_id integer primary key,server_address text,port integer,auth_key blob,takeout_id integer);insert into sessions values(0,'fixture.invalid',0,x'00010203',null)");session.close();restrictPath(sessionPath);
  const config={group:nonce,generation:nonce,backupRoot:resolve(primaryRoot),keyPath,scratchRoot,sqlitePath,sessionPath,python:resolve(python),database:'t18',bucket:'t18-media',
    postgres:{container:source.name,host:'127.0.0.1',port,user:'postgres',passwordEnv:'LOOM_BACKUP_PG_PASSWORD'},
    minio:{container:storage.name,host:'127.0.0.1',port:minioPort,accessEnv:'LOOM_BACKUP_MINIO_ACCESS',secretEnv:'LOOM_BACKUP_MINIO_SECRET'}};
  report.failures.wrongLabel=cli('backup',{...config,group:'wrong'},false);
  report.backup=cli('backup',config);
  report.failures.existingGeneration=cli('backup',config,false);
  const archivePath=join(primaryRoot,nonce,'generation.loom-backup');
  const secondary=privateDirectory(secondaryRoot,nonce);const secondArchive=join(secondary,'generation.loom-backup');
  copyFileSync(archivePath,secondArchive,constants.COPYFILE_EXCL);restrictPath(secondArchive);
  assert.equal(sha256(readFileSync(archivePath)),sha256(readFileSync(secondArchive)));
  report.copies=[{path:resolve(archivePath),sha256:sha256(readFileSync(archivePath)),permissions:restrictPath(dirnameOf(archivePath))},
    {path:resolve(secondArchive),sha256:sha256(readFileSync(secondArchive)),permissions:restrictPath(secondary)}];
  report.keyPermissions=restrictPath(keyPath);report.keySeparate=true;
  const restore={...config,archivePath,restoreRoot,restoreGeneration:'restored-a',targetDatabase:'t18_restored_a',targetBucket:`${nonce}-a`};
  report.restorePrimary=cli('restore',restore);
  report.restoreSecondary=cli('restore',{...restore,archivePath:secondArchive,restoreGeneration:'restored-b',targetDatabase:'t18_restored_b',targetBucket:`${nonce}-b`});
  for(const restored of [report.restorePrimary,report.restoreSecondary]) {
    assert.deepEqual(restored.postgres,report.backup.postgres);assert.deepEqual(restored.sqlite,report.backup.sqlite);
    assert.equal(restored.sessionSchema,report.backup.sessionSchema);assert.equal(restored.objects,1);
    assert.equal(restored.postgres.extract_jobs.count,1);assert.equal(restored.sqlite.reconciliation_outbox.count,1);assert.equal(restored.sqlite.detail_queue.count,1);
  }
  report.failures.existingRestore=cli('restore',restore,false);
  // Authenticated malformed manifests exercise validation before target creation.
  const encrypted=readFileSync(archivePath); const key=readFileSync(keyPath); const original=unseal(encrypted,key);
  const mutations={corruptCipher:()=>{const b=Buffer.from(encrypted);b[b.length-1]^=1;return b;},
    corruptHash:p=>{p.manifest.files[0].sha256='0'.repeat(64);return seal(p,key);},
    corruptSchema:p=>{p.manifest.schema=['9999_wrong.sql'];return seal(p,key);},
    traversal:p=>{p.manifest.files[0].name='../outside';return seal(p,key);},
    credentialField:p=>{p.manifest.token='t18-dummy-only';return seal(p,key);}};
  for(const [name,mutate] of Object.entries(mutations)) {
    const path=join(lab,`${name}.loom-backup`);writeFileSync(path,mutate(structuredClone(original)),{flag:'wx',mode:0o600});restrictPath(path);
    report.failures[name]=cli('restore',{...restore,archivePath:path,restoreGeneration:`rejected-${name}`,targetDatabase:'t18_must_not_exist',targetBucket:`${nonce}-must-not-exist`},false);
    assert.equal(existsSync(join(restoreRoot,`rejected-${name}`)),false);
  }
  client=new pg.Client({host:'127.0.0.1',port,user:'postgres',password:'t18-dummy-only',database:'t18'});await client.connect();
  assert.equal((await client.query("select count(*)::int n from pg_database where datname='t18_must_not_exist'")).rows[0].n,0);
  await client.end();client=null;
  report.retention=cli('retention-plan',config);
  report.recoveryGoals={RPOSeconds:86400,RTOSeconds:7200,measuredRTOSeconds:Math.max(report.restorePrimary.elapsedSeconds,report.restoreSecondary.elapsedSeconds),
    observedSnapshotAgeSeconds:Math.max(report.restorePrimary.snapshotAgeSeconds,report.restoreSecondary.snapshotAgeSeconds),continuousRPOProven:false};
  report.schema=schema;report.ok=true;
} catch(error) {report.error=String(error.stack);throw error;}
finally {
  await client?.end().catch(()=>{});
  report.cleanup=[];
  for(const id of owned.reverse()) {
    try {assert.equal(inspect(id).Config.Labels['loom.backup.group'],nonce);docker(['rm','-f','-v',id]);report.cleanup.push({id,removed:true});}
    catch{report.ok=false;report.cleanup.push({id,removed:false});}
  }
  writeFileSync(reportPath,JSON.stringify(report,null,2),{flag:'wx'});
}
function dirnameOf(path){return resolve(path,'..');}
console.log(JSON.stringify({ok:report.ok,sourceSha:sha,reportPath:resolve(reportPath),copies:report.copies,recoveryGoals:report.recoveryGoals}));
if(!report.ok)process.exitCode=1;
