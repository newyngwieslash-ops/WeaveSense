import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT,QA_ROOT,HELPER_DIR,NPM_CLI,safeEnv,withPostgresBuild } from './b03-postgres-build.mjs';
import { withPrivateMinio } from './c02-minio.mjs';
import { checkSubtitles } from './c02-ui.mjs';
assert.equal(process.argv[2],'--run','source-stable GO required');
const runId='c02-'+randomUUID(),directory=join(QA_ROOT,runId),screenshots=join(ROOT,'screenshots',runId);mkdirSync(directory,{recursive:true});mkdirSync(screenshots,{recursive:true});
const report={runId,timeouts_skipped:process.argv.includes("--skip-timeouts"),children:[],ok:false},save=()=>writeFileSync(join(directory,'runner.json'),JSON.stringify(report,null,2));
function launch(args,env,name){const fd=openSync(join(directory,name+'.log'),'w');const child=spawn(process.execPath,args,{cwd:ROOT,env,windowsHide:true,stdio:['ignore',fd,fd]});closeSync(fd);const record={name,pid:child.pid,exited:false};report.children.push(record);save();child.once('exit',code=>{record.exited=true;record.code=code;save();});return{child,record};}
async function port(){const s=createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});const p=s.address().port;await new Promise(resolve=>s.close(resolve));assert.ok(![8080,8182,55191,55192].includes(p));return p;}
async function stop(handle){if(handle.record.exited)return;await new Promise(resolve=>{const c=spawn('taskkill',['/PID',String(handle.child.pid),'/T','/F'],{env:safeEnv(),windowsHide:true,stdio:'ignore'});c.once('error',error=>{handle.record.cleanupError=error.message;resolve();});c.once('exit',code=>{handle.record.cleanupCode=code;resolve();});});save();assert.ok(handle.record.exited||handle.record.cleanupCode===0,'owned app cleanup failed');}
try{
  await withPostgresBuild(async({databases,directory:pgDirectory})=>{
    report.postgresBuildDirectory=pgDirectory;
    await withPrivateMinio(async storage=>{
      for(const mode of ['dev','built']){
        const p=await port(),origin='http://127.0.0.1:'+p,control=join(directory,mode);mkdirSync(control,{recursive:true});
        const env=safeEnv({...storage.env,DATABASE_URL:databases[mode],SUBTITLE_ENABLED:'true',SUBTITLE_SERVICE_TOKEN:'c02-generated-offline-token',C02_QA_PRELOAD:'true',C02_QA_CONTROL_DIR:control,NODE_OPTIONS:'--import='+JSON.stringify(pathToFileURL(join(HELPER_DIR,'c02-preload.mjs')).href)});
        const app=launch([NPM_CLI,'run',mode==='dev'?'dev':'preview','--','--host','127.0.0.1','--port',String(p)],env,mode);app.record.port=p;
        try{
          const deadline=Date.now()+120000;let ready=false;while(Date.now()<deadline){assert.equal(app.record.exited,false,'app exited');if(existsSync(join(control,'preload-ready.json')))ready=await new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port:p});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>{socket.destroy();resolve(false);});socket.once('timeout',()=>{socket.destroy();resolve(false);});});if(ready)break;await new Promise(resolve=>setTimeout(resolve,200));}assert.equal(ready,true);
          await checkSubtitles({origin,directory:control,storage,screenshots,mode,skipTimeouts:process.argv.includes('--skip-timeouts')});
        }finally{await stop(app);}
        storage.removePrivateBucket();storage.recreatePrivateBucket();
      }
    },evidence=>{report.minio=evidence;save();});
  });report.ok=true;
}catch(error){report.error=error.message;throw error;}
finally{save();console.log(JSON.stringify({ok:report.ok,report:join(directory,'runner.json'),screenshots}));}
