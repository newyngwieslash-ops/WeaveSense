import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { chromium } from 'playwright';

const origin='http://127.0.0.1:8194';
// Public fixture token for this isolated QA process only, never a user credential.
const headers={origin,'x-loom-backup-token':'isolated-backup-qa-only-20260911-000001'};
const browser=await chromium.launch();
let restored;
try {
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/inbox');
  const first=page.locator('a[href*="/inbox/"]').first();await first.waitFor();
  const href=await first.getAttribute('href');
  const id=decodeURIComponent(new URL(href,origin).pathname.split('/').pop());
  const title=await first.locator('h2').innerText();
  for (const options of [{method:'GET',headers},{method:'POST',headers:{origin}},{method:'POST',headers:{...headers,origin:'https://evil.invalid'}},{method:'POST',headers,body:'sql=anything'}]) {
    const rejected=await fetch(origin+'/__qa/backup',options);assert.ok([400,403,405].includes(rejected.status));await rejected.body?.cancel();
  }
  const response=await fetch(origin+'/__qa/backup',{method:'POST',headers});
  assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());
  const sha256=createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256,response.headers.get('x-backup-sha256'));
  restored=new PGlite({loadDataDir:new Blob([bytes])});
  assert.equal((await restored.query('select title from items where id=$1',[id])).rows[0].title,title);
  const migrations=(await restored.query('select name from _migrations')).rows.length;
  assert.equal(migrations,19);
  await page.reload();await first.waitFor();
  assert.equal(await first.locator('h2').innerText(),title);
  assert.deepEqual(errors,[]);
  mkdirSync('artifacts/backup-app',{recursive:true});
  const folder=mkdtempSync(resolve('artifacts/backup-app/run-'));
  writeFileSync(join(folder,'snapshot.bin'),bytes,{flag:'wx'});
  const result={ok:true,origin,bytes:bytes.length,sha256,migrations,itemId:id,pageStillReadable:true,errors};
  writeFileSync(join(folder,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({folder,...result},null,2));
} finally {await restored?.close();await browser.close();}
