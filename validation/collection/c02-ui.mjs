import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { control } from './b03-control.mjs';
import { BASE_BODY, CONCURRENT_BODY, SCRIPT_TEXT, TRANSCRIPT_TEXT, rawTranscript, videoId } from './c02-fixtures.mjs';

export async function checkSubtitles({origin,directory,storage,screenshots,mode,skipTimeouts=false}) {
  const browser=await chromium.launch(),report={mode,timeouts_skipped:skipTimeouts,timeout_evidence:skipTimeouts?{source_sha:'42b508d03b9ac6b4769a8a845afd733cca90af41',report:'docs/operations/collection-capability-acceptance.md#c01c04-scope-and-pending-live-gates'}:null,viewports:[],ok:false,privateChecks:[]};
  const state=()=>control(directory,{op:'state'}),row=(s,id)=>s.rows.find(r=>r.id===id);
  try {
    for(const width of [1280,390]) {
      const page=await browser.newPage({viewport:{width,height:844}}),errors=[],responses=[];
      page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
      page.on('response',response=>{if(new URL(response.url()).origin===origin&&['fetch','xhr'].includes(response.request().resourceType()))responses.push(response.text().then(text=>{assert.ok(!/transcript_object_key|loom-subtitles|\.json3/.test(text),'private reference leaked in serverFn response');}).catch(error=>errors.push(error.message)));});
      await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();
        if(url.hostname==='fonts.googleapis.com'&&url.pathname==='/css2')return route.fulfill({status:200,contentType:'text/css',body:''});
        assert.equal(url.href,'https://grok.com/grok-app-builder/extensions.js');return route.fulfill({status:200,contentType:'application/javascript',body:''});});
      const open=async kind=>{const id=`qa-c02-${kind}-${width}`;await page.goto(origin+'/inbox/'+id,{waitUntil:'domcontentloaded'});await page.getByTestId('item-body').waitFor();return id;};
      const status=async text=>page.getByTestId('subtitle-status').filter({hasText:text}).waitFor({timeout:60000});
      const read=async language=>{await page.locator('#subtitle-language').selectOption(language);const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).origin===origin,{timeout:60000});await page.getByTestId('subtitle-read-button').click();await response;};
      const snap=async label=>{assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1),false);const box=await page.getByTestId('subtitle-read-button').boundingBox();assert.ok(box.width>=44&&box.height>=44);await page.screenshot({path:join(screenshots,`${mode}-${label}-${width}.png`),fullPage:true});};
      const before=await state();await control(directory,{op:'subtitle-enabled',enabled:false});await open('manual');await status('字幕读取尚未启用');assert.equal(await page.getByTestId('subtitle-read-button').isDisabled(),true);assert.equal((await state()).metrics.requests.length,before.metrics.requests.length);
      await control(directory,{op:'subtitle-enabled',enabled:true});const id=await open('manual');assert.equal(await page.getByTestId('analysis-stale').count(),0);
      assert.deepEqual(await page.locator('#subtitle-language option').evaluateAll(nodes=>nodes.map(n=>n.value)),['en','zh-Hans','zh-Hant']);
      await read('en');await status('已读取人工字幕 · en');await page.waitForFunction(()=>document.querySelector('[data-testid="item-body"]')?.textContent.includes('C02 SUBTITLE-END'));
      const first=row(await state(),id);assert.equal(first.body,BASE_BODY+'\n\n[字幕: en; manual]\n'+TRANSCRIPT_TEXT);assert.ok(Number(first.material_version)>Number(row(before,id).material_version));await page.getByTestId('analysis-stale').waitFor();
      assert.equal(await page.evaluate(()=>globalThis.__C02_SCRIPT_EXECUTED__),undefined);assert.equal(await page.getByTestId('item-body').locator('script').count(),0);assert.ok((await page.getByTestId('item-body').innerText()).includes(SCRIPT_TEXT));
      assert.ok((await page.locator('body').innerText()).includes('C02 HISTORICAL-ANALYSIS'));await snap('manual');
      const raw=rawTranscript('manual'),digest=createHash('sha256').update(raw).digest('hex'),key=id+'/'+digest+'.json3';
      assert.equal(first.extra.transcript_digest,digest);assert.equal(storage.readExactObject(key),raw);const anonymous=await storage.anonymousGet(key);assert.equal(anonymous.status,403);assert.match(anonymous.body,/AccessDenied/);report.privateChecks.push({id,authenticatedExactBytes:true,anonymousStatus:403});
      await read('en');await status('已读取人工字幕 · en');assert.equal(row(await state(),id).body,first.body);assert.equal(Number(row(await state(),id).material_version),Number(first.material_version));
      await control(directory,{op:'change-digest',video:videoId('manual',width)});await read('en');await status('正文或字幕已更新，请重新核对');assert.equal(row(await state(),id).body,first.body);
      await page.reload();await status('人工字幕 · en');
      const auto=await open('automatic');await read(width===1280?'zh-Hans':'zh-Hant');await status('已读取自动字幕');assert.equal(row(await state(),auto).extra.transcript_kind,'automatic');await snap('automatic');
      const none=await open('none');await read('en');await status('此视频未提供可用字幕');assert.equal(row(await state(),none).body,BASE_BODY);
      const invalid=await open('invalid');await read('en');await status('字幕节点暂不可用');assert.equal(row(await state(),invalid).body,BASE_BODY);await snap('invalid');
      const conflict=await open('conflict');await read('en');await status('正文或字幕已更新，请重新核对');assert.equal(row(await state(),conflict).body,CONCURRENT_BODY);await snap('conflict');
      storage.removePrivateBucket();const upload=await open('upload');await read('en');await status('字幕节点暂不可用');assert.equal(row(await state(),upload).body,BASE_BODY);storage.recreatePrivateBucket();
      if(mode==='dev'&&width===1280&&!skipTimeouts){const timeout=await open('timeout'),started=Date.now();await read('en');await status('字幕读取超时');assert.ok(Date.now()-started>=49000&&Date.now()-started<60000);const slow=(await state()).metrics.requests.find(r=>r.kind==='timeout');assert.equal(slow.closed,true);assert.equal(row(await state(),timeout).body,BASE_BODY);report.timeoutMs=slow.elapsedMs;await snap('timeout');}
      await page.goto(origin+'/inbox',{waitUntil:'domcontentloaded'});await page.waitForTimeout(500); // Real list serverFn privacy projection, not seeded client data.
      await Promise.all(responses);assert.deepEqual(errors,[]);const after=await state();assert.deepEqual(after.counts,before.counts);assert.equal(after.metrics.active,0);assert.deepEqual(after.metrics.unexpected,[]);
      report.viewports.push({width,errors,countsUnchanged:true,privateProjection:true});await page.close();
    }
    report.ok=true;
  }catch(error){report.error=error.message;throw error;}
  finally{await browser.close();writeFileSync(join(screenshots,mode+'-result.json'),JSON.stringify(report,null,2));}
}
