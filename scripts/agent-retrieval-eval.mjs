import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { retrieveAgentItems } from '../src/lib/server/agent-retrieval.ts';
import { selectResearchSeeds } from '../src/lib/server/agent-context.ts';

const port=Number(process.env.REVIEW_PG_PORT);
assert.ok(Number.isInteger(port)&&port>=1024,'REVIEW_PG_PORT must point to the isolated validation PG');
const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',password:'review-only-local',database:'review'});
await client.connect();
const schema='retrieval_'+randomUUID().replaceAll('-','');
const sql={query:async (text,params=[]) => (await client.query(text,params)).rows};
const fixture=JSON.parse(readFileSync(new URL('../validation/agent/retrieval-cases.json',import.meta.url),'utf8'));
const corpus=fixture.corpus.map(row=>({...row,published_at:'2026-09-07T01:00:00Z'}));
for(let i=0;i<80;i++) corpus.push({id:`stress-noise-${i}`,title:'无关近日报告',body:'battery general market',author:'noise',published_at:'2026-09-07T02:00:00Z'});
corpus.push({id:'tail-proof',title:'battery quantum separator',body:'背景。'.repeat(9000)+'quantum separator 提升良率至 97%。',author:'lab',published_at:'2026-09-07T00:00:00Z'});
corpus.push({id:'outside',title:'quantum separator',body:'区间外不应出现',author:'lab',published_at:'2026-09-08T00:00:00Z'});
const cases=[...fixture.cases,{id:'tail-and-cap',query:'battery quantum separator',expected_ids:['tail-proof'],quote:'quantum separator 提升良率至 97%。',range:{from:'2026-09-07T00:00:00Z',to:'2026-09-08T00:00:00Z'}},
 {id:'absent',query:'zzxyqv-no-answer-314159',expected_ids:[],none:true}];
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const results=[];
try {
 await client.query(`create schema ${schema}`);await client.query(`set search_path to ${schema}`);
 await client.query(readFileSync(new URL('../migrations/0002_schema.sql',import.meta.url),'utf8'));
 await client.query("insert into sources(id,platform,name) values('s','rss','离线评测')");
 for(const row of corpus) await client.query("insert into items(id,source_id,platform,external_id,title,body,author,published_at) values($1,'s','rss',$1,$2,$3,$4,$5)",[row.id,row.title,row.body,row.author,row.published_at]);
 for(const c of cases) {
  const start=performance.now();const found=await retrieveAgentItems(sql,c.query,c.range??null);
  const selected=selectResearchSeeds(found.items,c.query),baseline=selectResearchSeeds(found.items);
  const expected=new Set(c.expected_ids);
  results.push({id:c.id,candidate_recall:expected.size?[...expected].filter(id=>found.candidates.some(r=>r.id===id)).length/expected.size:1,
   final_recall:expected.size?[...expected].filter(id=>found.items.some(r=>r.id===id)).length/expected.size:1,
   none_false_positive:c.none?found.items.length:0,
   quote_covered:c.quote?selected.sources.some(s=>s.text.includes(c.quote)):null,
   baseline_quote_covered:c.quote?baseline.sources.some(s=>s.text.includes(c.quote)):null,
   scope_violations:c.range?found.candidates.filter(r=>Date.parse(r.published_at)<Date.parse(c.range.from)||Date.parse(r.published_at)>=Date.parse(c.range.to)).length:0,
   selected_chars:selected.sources.reduce((n,s)=>n+Array.from(s.text).length,0),baseline_chars:baseline.sources.reduce((n,s)=>n+Array.from(s.text).length,0),returned_bytes:Buffer.byteLength(JSON.stringify(selected.sources)),partial_ratio:selected.sources.filter(s=>s.coverage==='partial').length/Math.max(1,selected.sources.length),elapsed_ms:performance.now()-start,
   candidates:found.candidates.map(r=>r.id),selected:found.items.map(r=>r.id)});
 }
 const codeFiles=['src/lib/server/agent-retrieval.ts','src/lib/server/agent-context.ts'];
 const commit=execFileSync('git',[...(existsSync('.git')?[]:['--git-dir=.repo','--work-tree=.']),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const workspaceFiles=['src','workers/agent','scripts','migrations'].flatMap(dir=>readdirSync(dir,{recursive:true}).map(name=>`${dir}/${String(name).replaceAll('\\','/')}`)).filter(f=>/\.(?:ts|tsx|mjs|go|mod|sum|sql)$/.test(f)).sort();
 const workspaceHash=hash(workspaceFiles.map(f=>[f,hash(readFileSync(f))]));
 const out={method:'production retrieveAgentItems SQL -> rankRetrievedItems -> selectResearchSeeds',corpus_size:corpus.length,corpus_hash:hash(corpus),code_hash:hash(codeFiles.map(f=>[f,hash(readFileSync(f,'utf8'))])),
  commit,workspace_hash:workspaceHash,thresholds:{scope_violations:0,none_false_positive:0,tail_quote_coverage:true,tail_candidate_recall:1,selection_recall_non_regression:true},results,model_answer_quality:'not evaluated; no model calls'};
 writeFileSync('validation/agent/implementation-v3-2026-09-08/retrieval-sql.json',JSON.stringify(out,null,2));
 writeFileSync('validation/agent/implementation-v3-2026-09-08/retrieval-corpus.json',JSON.stringify({corpus,cases},null,2));
 assert.ok(results.every(r=>r.scope_violations===0&&r.none_false_positive===0));
 assert.equal(results.find(r=>r.id==='tail-and-cap').quote_covered,true);
 assert.equal(results.find(r=>r.id==='tail-and-cap').candidate_recall,1);
 assert.ok(results.every(r=>r.selected_chars===r.baseline_chars && (!r.baseline_quote_covered || r.quote_covered)), 'same budgets; no labeled quote regression');
 console.log(JSON.stringify({corpus:corpus.length,cases:cases.length,thresholds:'passed',tail:results.find(r=>r.id==='tail-and-cap')},null,2));
} finally {await client.query(`drop schema ${schema} cascade`);await client.end();}
