import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import pg from 'pg';
import { chromium } from 'playwright';

const origin = process.argv[2] || 'http://127.0.0.1:8186';
assert.ok(['http://127.0.0.1:8186', 'http://127.0.0.1:8187', 'http://127.0.0.1:8188'].includes(origin));
const tag = new URL(origin).port;
const id = randomUUID().replaceAll('-',''), long = `tailqa${id}`, changed = `changeqa${id}`;
const config = 'artifacts/search-qa/model.local.json';
const db = new pg.Client({host:'127.0.0.1',port:60000,user:'postgres',password:'offline-followup-only',database:'followup'});
const calls = [], errors = [];
let browser, configCreated = false;
const fake = http.createServer(async (req,res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.method, 'POST');
    req.setEncoding('utf8');
    let body = ''; for await(const chunk of req) { body += chunk; assert.ok(body.length < 500000); }
    const prompt = JSON.parse(body).messages[1].content;
    const sources = JSON.parse(prompt.split('素材 JSON：')[1]);
    assert.ok(sources.every(s => [long,changed].includes(s.item_id)), 'Only this run fixtures allowed');
    const source = sources.find(s => s.text.includes('TAIL-973')) ?? sources[0];
    const quote = source.text.includes('TAIL-973') ? 'TAIL-973：返工率3%。' : source.text.slice(0,80);
    const analysis = prompt.includes('"summary"');
    calls.push({analysis, itemIds:sources.map(s=>s.item_id),quote});
    const common = {citations:[{evidence_id:source.evidence_id,quote}],insufficient_evidence:false};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(analysis
      ? {...common,summary:quote,topics:[],entities:[],insights:'隔离假模型',tags:[]}
      : {...common,title:'尾部离线验证',content:quote})}}]}));
  } catch(e) {errors.push(e.message);res.statusCode=500;res.end('offline fixture failed');}
});
try {
  await db.connect();
  await db.query("insert into items(id,source_id,platform,external_id,title,body,media_type,published_at) select $1,source_id,platform,$1,$1,body || $2,media_type,published_at from items where id='qa-long'",[long,' proof'+id]);
  await db.query("insert into items(id,source_id,platform,external_id,title,body) values($1,'qa-followup','rss',$1,$1,'原始结论：良率97%。')",[changed]);
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));
  mkdirSync('artifacts/search-qa',{recursive:true}); mkdirSync('screenshots',{recursive:true});
  writeFileSync(config,JSON.stringify({baseURL:`http://127.0.0.1:${fake.address().port}/v1`,model:'offline-material-qa',apiKey:'offline-only'}),{flag:'wx'});
  configCreated=true;
  browser=await chromium.launch();
  const page=await browser.newPage({viewport:{width:1280,height:844}});
  page.on('pageerror',e=>errors.push(e.message));
  const analyze = async itemId => {
    await page.goto(origin+'/inbox/'+itemId);
    await page.locator('article').waitFor();
    const count = (await db.query('select id from analyses where item_id=$1',[itemId])).rowCount;
    await page.getByTestId('analyze-button').click();
    await page.getByText('已写入知识层',{exact:true}).waitFor();
    assert.equal((await db.query('select id from analyses where item_id=$1',[itemId])).rowCount,count+1);
  };
  await analyze(long);
  await page.getByText('部分覆盖：只分析了截取片段，不是全文。',{exact:true}).waitFor();
  await page.screenshot({path:`screenshots/material-${tag}-partial.png`});
  await page.goto(origin+'/knowledge');
  await page.locator(`a[href="/inbox/${long}"]`).first().waitFor();
  await page.locator('#q').fill('proof'+id);
  await page.getByRole('button',{name:'提问',exact:true}).click();
  await page.getByText('已写入知识库',{exact:true}).waitFor();
  const note = (await db.query("select n.*,r.response_json from knowledge_notes n join ai_runs r on r.id=n.run_id where n.content like '%TAIL-973%' order by n.created_at desc limit 1")).rows[0];
  assert.ok(note);
  assert.equal(note.response_json.result.coverage,'partial');
  assert.ok(note.response_json.verified_evidence.some(s=>s.item_id===long && s.text.includes('TAIL-973')));
  await page.reload();
  await page.getByText('TAIL-973：返工率3%。',{exact:true}).first().waitFor();
  await analyze(changed);
  await db.query("update items set body='当前结论：良率96%。' where id=$1",[changed]);
  await page.reload();
  await page.locator('article').getByText('当前结论：良率96%。',{exact:true}).waitFor();
  await analyze(changed);
  await page.locator('aside').getByText('当前结论：良率96%。',{exact:true}).waitFor();
  const revisions=(await db.query('select a.id,a.summary,r.material_hash,r.model_calls from analyses a join ai_runs r on r.id=a.run_id where a.item_id=$1 order by a.created_at',[changed])).rows;
  assert.equal(revisions.length,2);
  assert.notEqual(revisions[0].material_hash,revisions[1].material_hash);
  assert.ok(revisions[0].summary.includes('97%') && revisions[1].summary.includes('96%'));
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
  await page.screenshot({path:`screenshots/material-${tag}-revision-mobile.png`});
  assert.equal(calls.length,4);
  assert.deepEqual(errors,[]);
  writeFileSync(`screenshots/material-${tag}.json`,JSON.stringify({origin,long,changed,calls,revisions,errors},null,2));
  console.log('PASS: 4 local fake requests; partial analysis, tail question and reload, 97->96 page regeneration and different fingerprints, history preserved');
} finally {
  await browser?.close();
  await db.end();
  await new Promise(r=>fake.close(r));
  if(configCreated) unlinkSync(config);
}
