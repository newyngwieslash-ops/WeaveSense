import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createPgliteBackupHandler } from './pglite-backup.ts';

test('backup rejects disabled, missing peer, cross origin, spoofed forwarding, token, method and input before DB access', async () => {
  let accesses = 0;
  const options = { enabled:true, token:'x'.repeat(32), getDatabase:async()=>{accesses++;return {dumpDataDir:async()=>new Blob(['test'])};} };
  const handler = createPgliteBackupHandler(options);
  const request = (overrides:RequestInit={},url='http://127.0.0.1:8193/backup') => new Request(url,{method:'POST',headers:{origin:'http://127.0.0.1:8193','x-loom-backup-token':options.token},...overrides});
  assert.equal((await createPgliteBackupHandler({...options,enabled:false})(request(),'127.0.0.1')).status,404);
  for(const peer of [undefined,'192.0.2.1']) assert.equal((await handler(request(),peer)).status,403);
  assert.equal((await handler(request({headers:{origin:'https://evil.invalid','x-loom-backup-token':options.token}}),'127.0.0.1')).status,403);
  assert.equal((await handler(request({headers:{origin:'http://127.0.0.1:8193','x-forwarded-for':'127.0.0.1','x-loom-backup-token':options.token}}),'192.0.2.1')).status,403);
  assert.equal((await handler(request({headers:{origin:'http://127.0.0.1:8193'}}),'127.0.0.1')).status,403);
  assert.equal((await handler(request({method:'GET'}),'127.0.0.1')).status,405);
  assert.equal((await handler(request({body:'sql=select'}),'127.0.0.1')).status,400);
  assert.equal((await handler(request({},'http://127.0.0.1:8193/backup?path=x'),'127.0.0.1')).status,400);
  assert.equal(accesses,0);
  const result=await handler(request(),'127.0.0.1');
  assert.equal(result.status,200);assert.equal(accesses,1);
  assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal(result.headers.get('x-backup-sha256'),createHash('sha256').update('test').digest('hex'));
});

test('overlapping export is rejected; failures are redacted and release the guard', async () => {
  let release!:()=>void;
  const gate = new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  const handler=createPgliteBackupHandler({enabled:true,token:'x'.repeat(32),getDatabase:async()=>({dumpDataDir:async()=>{calls++;await gate;if(calls===1)throw Error('private-path');return new Blob(['ok']);}})});
  const req=()=>new Request('http://localhost/backup',{method:'POST',headers:{origin:'http://localhost','x-loom-backup-token':'x'.repeat(32)}});
  const first=handler(req(),'::1');
  assert.equal((await handler(req(),'::1')).status,409);
  release();
  const failed=await first;assert.equal(failed.status,500);assert.ok(!(await failed.text()).includes('private-path'));
  assert.equal((await handler(req(),'::1')).status,200);
});
