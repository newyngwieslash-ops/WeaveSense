import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes,createHash } from 'node:crypto';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteBackupHandler } from '../src/lib/server/pglite-backup.ts';

const db=new PGlite();
const token=randomBytes(32).toString('hex');
let accesses=0;
const handler=createPgliteBackupHandler({enabled:true,token,getDatabase:async()=>{accesses++;return db;}});
const server=http.createServer(async(req,res)=>{
  // Test adapter uses the socket peer, never forwarded headers.
  try {
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers});
    const response=await handler(request,req.socket.remoteAddress);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.statusCode=500;res.end('test adapter failed');}
});
try {
  for(const migration of ['0002_schema.sql','0004_production.sql']) await db.exec(readFileSync('migrations/'+migration,'utf8'));
  await db.exec(readFileSync('validation/agent/search-followup-fixtures.sql','utf8'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const send=(headers={})=>fetch(origin+'/backup',{method:'POST',headers});
  const unauthorized=await send({origin});assert.equal(unauthorized.status,403);await unauthorized.body?.cancel();
  const cross=await send({origin:'https://evil.invalid','x-loom-backup-token':token});assert.equal(cross.status,403);await cross.body?.cancel();
  assert.equal(accesses,0);
  mkdirSync('artifacts/pglite-http',{recursive:true});
  const folder=mkdtempSync(resolve('artifacts/pglite-http/run-'));
  const reports=[];
  for(const count of [8,9]) {
    if(count===9) await db.exec("insert into items(id,source_id,platform,external_id,title,body) values('after-export','qa-followup','rss','after-export','导出后新写入','当前存活实例')");
    const response=await send({origin,'x-loom-backup-token':token});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'),null);
    const bytes=Buffer.from(await response.arrayBuffer());
    const sha256=createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256,response.headers.get('x-backup-sha256'));
    assert.equal(bytes.length,Number(response.headers.get('content-length')));
    writeFileSync(join(folder,`snapshot-${count}.bin`),bytes,{flag:'wx'});
    const restored=new PGlite({loadDataDir:new Blob([bytes])});
    try {
      assert.equal((await restored.query('select id from items')).rows.length,count);
      assert.equal((await restored.query("select status from extract_jobs where id='qa-ocr'")).rows[0].status,'pending');
    } finally {await restored.close();}
    assert.equal((await db.query('select id from items')).rows.length,count);
    reports.push({count,bytes:bytes.length,sha256});
  }
  assert.equal(accesses,2);
  writeFileSync(join(folder,'result.json'),JSON.stringify({ok:true,pid:process.pid,accesses,reports},null,2));
  console.log(JSON.stringify({ok:true,folder,accesses,reports},null,2));
} finally {
  await new Promise(r=>server.close(r));
  await db.close();
}
