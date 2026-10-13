import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { safeEnv } from './b03-postgres-build.mjs';

const IMAGE='minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
const MC='minio/mc:latest@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';
export async function withPrivateMinio(callback, record=()=>{}) {
  const name='loom-c02-qa-minio-'+randomUUID(),credentials={MINIO_ACCESS_KEY:'c02-local-user',MINIO_SECRET_KEY:'c02-local-password-test',MINIO_REGION:'us-east-1',MINIO_FORCE_PATH_STYLE:'true'};
  const evidence={name,image:IMAGE,mcImage:MC,created:false};
  const docker=args=>{const r=spawnSync('docker',args,{env:safeEnv(),encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stderr.slice(-500));return r.stdout.trim();};
  const mc=args=>docker(['run','--rm','--pull=never','--network','container:'+name,'-e','MC_HOST_qa=http://c02-local-user:c02-local-password-test@127.0.0.1:9000',MC,...args]);
  try {
    docker(['image','inspect',IMAGE,'--format','{{.Id}}']);docker(['image','inspect',MC,'--format','{{.Id}}']);
    docker(['run','-d','--pull=never','--name',name,'--label','loom.c02.qa=private-storage','-e','MINIO_ROOT_USER=c02-local-user','-e','MINIO_ROOT_PASSWORD=c02-local-password-test','-p','127.0.0.1::9000',IMAGE,'server','/data']);evidence.created=true;record(evidence);
    const ports=JSON.parse(docker(['inspect','--format','{{json .NetworkSettings.Ports}}',name]));assert.equal(ports['9000/tcp'][0].HostIp,'127.0.0.1');
    const origin='http://127.0.0.1:'+ports['9000/tcp'][0].HostPort;const deadline=Date.now()+30000;
    while(Date.now()<deadline){try{if((await fetch(origin+'/minio/health/ready',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{ /* owned storage is still starting */ }await new Promise(resolve=>setTimeout(resolve,200));}
    assert.equal((await fetch(origin+'/minio/health/ready')).status,200);
    mc(['mb','qa/loom-subtitles']);mc(['anonymous','set','none','qa/loom-subtitles']);
    evidence.initialPolicy=mc(['anonymous','get','qa/loom-subtitles']);record(evidence);
    await callback({env:{...credentials,MINIO_ENDPOINT:origin,MINIO_BUCKET:'loom',MINIO_PUBLIC_URL:''},origin,
      removePrivateBucket(){mc(['rb','--force','qa/loom-subtitles']);},
      recreatePrivateBucket(){mc(['mb','qa/loom-subtitles']);mc(['anonymous','set','none','qa/loom-subtitles']);},
      readExactObject(key){return mc(['cat','qa/loom-subtitles/'+key]);},
      async anonymousGet(key){const response=await fetch(origin+'/loom-subtitles/'+key,{redirect:'error'});const body=await response.text();return{status:response.status,body};},evidence});
  } finally {
    if(evidence.created){docker(['rm','--force','--volumes',name]);const r=spawnSync('docker',['inspect',name],{env:safeEnv(),encoding:'utf8',windowsHide:true});evidence.removalVerified=r.status!==0&&/No such (object|container)/.test(r.stderr);}
    record(evidence);
    assert.ok(!evidence.created || evidence.removalVerified, 'owned MinIO cleanup failed');
  }
}
