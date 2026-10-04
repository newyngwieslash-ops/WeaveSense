import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const { checkpointRebinder } = await import(new URL('../../../scripts/reconcile-collection-identities.mjs',import.meta.url).href);
import { initialScanState } from './cursor.ts';
import { createServer } from 'vite';

test(`real scheduler pagination and identity repair (${process.env.T06_CHECKPOINT_REBINDER ? 'native codec subprocess' : 'recorded native codec'})`, async () => {
  process.env.TELEGRAM_WORKER_URL = 'http://synthetic-worker:8787';
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ configFile:false, logLevel:'silent', resolve:{alias:{'@':path.resolve('src')}}, server:{middlewareMode:true} });
  let failPageTwo = true;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/health')) return Response.json({ok:true,authorized:true,state:'ready'});
    assert.ok(String(input).endsWith('/v1/history'));
    const body = JSON.parse(String(init?.body));
    requests.push(body.min_id);
    if(body.min_id === '180' && failPageTwo) { failPageTwo = false; return Response.json({error:'timeout'}, {status:504}); }
    const ids = Array.from({length:250}, (_,i)=>String(i+101)).filter(id=>BigInt(id)>BigInt(body.min_id)).slice(0,80);
    return Response.json({items:ids.map(id=>({external_id:id,title:id,body:id,author:'channel',url:`https://t.me/channel/${id}`,media_type:'text',media_urls:[],thumbnail_url:'',views:null,likes:null,published_at:null,extra:{}})),last_id:ids.at(-1) ?? body.min_id, has_more:ids.length===80});
  };
  try {
    const {getSql} = await vite.ssrLoadModule('/src/lib/db.ts');
    const sql = await getSql();
    const {runSourceJob} = await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    await sql.query(`insert into sources(id,platform,name,handle,adapter,last_external_id) values('t06','telegram','synthetic','channel','telegram_web','100')`);
    const savedIds:string[] = [];
    const first = await runSourceJob('t06');
    assert.equal(first.error,'');
    let [source] = await sql.query(`select * from sources where id='t06'`);
    assert.equal(source.last_external_id,'180');
    assert.equal(source.has_more,true);
    assert.equal((await runSourceJob('t06')).error.includes('timeout'),true);
    [source] = await sql.query(`select * from sources where id='t06'`);
    assert.equal(source.last_external_id,'180');
    assert.equal(source.has_more,true);
    for(let round=0;round<3;round++) assert.equal((await runSourceJob('t06')).error,'');
    savedIds.push(...(await sql.query(`select external_id from items where source_id='t06'`)).map((r:{external_id:string})=>r.external_id));
    assert.deepEqual([...new Set(savedIds)].sort((a,b)=>Number(a)-Number(b)),Array.from({length:250},(_,i)=>String(i+101)));
    assert.equal(savedIds.length,250);
    assert.deepEqual(requests,['100','180','180','260','340']);
    [source] = await sql.query(`select * from sources where id='t06'`);
    assert.equal(source.last_external_id,'350');
    assert.equal(source.has_more,false);
    const ids = ['00123','123'];
    const io = { resolver:{async lookup(){ return [{address:'93.184.216.34',family:4}]; }}, transport:async()=>({status:200,headers:{},body:new Response(`<rss><channel>${ids.map(id=>`<item><guid>${id}</guid><title>${id}</title></item>`).join('')}</channel></rss>`).body}) };
    await sql.query(`insert into sources(id,platform,name,handle) values('fresh-rss','rss','fresh','https://example.invalid/feed'),('legacy-rss','rss','legacy','https://example.invalid/feed')`);
    assert.equal((await runSourceJob('fresh-rss','manual',io)).error,'');
    assert.deepEqual((await sql.query(`select external_id from items where source_id='fresh-rss' order by external_id`)).map((r:any)=>r.external_id),ids);
    await sql.query(`insert into items(id,source_id,platform,external_id,title) values('old-rss','legacy-rss','rss','123','legacy')`);
    ids.shift();
    assert.equal((await runSourceJob('legacy-rss','manual',io)).error,'');
    ids.unshift('00123');
    assert.match((await runSourceJob('legacy-rss','manual',io)).error,/identity_conflict/);
    assert.deepEqual(await sql.query(`select id,external_id,title from items where source_id='legacy-rss'`),[{id:'old-rss',external_id:'123',title:'legacy'}]);
    assert.equal((await sql.query(`select last_external_id from sources where id='legacy-rss'`))[0].last_external_id,'');
    const {reconcileTelegramIdentities} = await vite.ssrLoadModule('/src/lib/server/collection-identity.ts');
    await sql.query(`insert into sources(id,platform,name,handle,enabled) values('merge-tg','telegram','merge','channel',false)`);
    await sql.query(`insert into items(id,source_id,platform,external_id,title) values('legacy-tg','merge-tg','telegram','channel/900','same'),('canonical-tg','merge-tg','telegram','900','same'),('single-tg','merge-tg','telegram','channel/901','single')`);
    await sql.query(`insert into media_objects(id,item_id) values('media-t06','legacy-tg')`);
    await sql.query(`insert into extract_jobs(id,item_id,media_id,kind,target_key) values('extract-t06','legacy-tg','media-t06','ocr','media-t06')`);
    await sql.query(`insert into analyses(id,item_id) values('analysis-t06','legacy-tg')`);
    await sql.query(`insert into knowledge_notes(id,title,content,item_ids) values('note-t06','note','body','["legacy-tg","single-tg"]')`);
    await assert.rejects(()=>reconcileTelegramIdentities(sql,'merge-tg',true),/workers_stopped_assertion_required/);
    const report = await reconcileTelegramIdentities(sql,'merge-tg');
    assert.equal(report.conflicts.length,0);
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='merge-tg'`))[0].n,3);
    await reconcileTelegramIdentities(sql,'merge-tg',true,{workersStopped:true});
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='merge-tg'`))[0].n,2);
    for(const table of ['media_objects','extract_jobs','analyses']) assert.equal((await sql.query(`select item_id from ${table} where item_id='canonical-tg'`)).length,1);
    assert.deepEqual((await sql.query(`select item_ids from knowledge_notes where id='note-t06'`))[0].item_ids,['canonical-tg','single-tg']);
    assert.equal((await sql.query(`select external_id from items where id='single-tg'`))[0].external_id,'901');
    assert.equal((await sql.query(`select count(*)::int n from collection_identity_merges`))[0].n,1);
    assert.equal((await reconcileTelegramIdentities(sql,'merge-tg',true,{workersStopped:true})).changes.length,0);
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/checkpoint-rebind-native.json',import.meta.url),'utf8'));
    const old = fixture.from_item_id, kept = fixture.to_item_id;
    const rewriteCheckpoint = process.env.T06_CHECKPOINT_REBINDER
      ? checkpointRebinder(process.env.T06_CHECKPOINT_REBINDER)
      : async(payload:string,from:string,to:string)=>{assert.ok([fixture.before_base64,fixture.after_base64].includes(payload));assert.equal(from,old);assert.equal(to,kept);return fixture.after_base64;};
    await sql.query(`insert into sources(id,platform,name,handle,enabled) values('agent-tg','telegram','merge','channel',false)`);
    await sql.query(`insert into items(id,source_id,platform,external_id,title) values($1,'agent-tg','telegram','channel/1000','same'),($2,'agent-tg','telegram','1000','same')`,[old,kept]);
    const evidenceId = `item:${old}:immutable:0:4`;
    const request = {item_id:old,sources:[{item_id:old}],question:`original ${old}`};
    const events = [{type:'evidence',origin:'internal',item_id:old,evidence_id:evidenceId,text:`quote ${old}`}];
    const response = {evidence:[{item_id:old,evidence_id:evidenceId}],verified_evidence:events,citations:[{id:old}],result:{citations:[{evidence_id:evidenceId,quote:`quote ${old}`}]},_completion:{digest:'unchanged'}};
    await sql.query(`insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,events_json,response_json)
      values('run-t06','request-t06','research','eino','input','material','v1',$1::jsonb,'failed','claim',now()+interval '1 hour',$2::jsonb,$3::jsonb)`,[JSON.stringify(request),JSON.stringify(events),JSON.stringify(response)]);
    await sql.query(`insert into ai_jobs(id,item_id,material_hash,policy_version,status,run_id,payload) values('ai-job-t06',$1,'material','v1','failed','run-t06',$2::jsonb)`,[old,JSON.stringify(request)]);
    await sql.query(`insert into agent_checkpoints(check_point_id,run_id,claim_token,sequence,schema_version,runtime_version,payload,model_call_count,evidence_event_count)
      values('checkpoint-t06','run-t06','claim',1,'1','eino-v0.9.19',$1,1,1)`,[Buffer.from(fixture.before_base64,'base64')]);
    await sql.query(`insert into agent_checkpoints(check_point_id,run_id,claim_token,sequence,schema_version,runtime_version,payload) values('unchanged-checkpoint-t06','run-t06','claim',2,'1','eino-v0.9.19',$1)`,[Buffer.from(fixture.after_base64,'base64')]);
    const prior = await sql.query(`select * from agent_checkpoints where check_point_id='checkpoint-t06'`);
    const refused = await reconcileTelegramIdentities(sql,'agent-tg',true,{workersStopped:true,rewriteCheckpoint:async()=>{throw new Error('unsupported');}});
    assert.equal(refused.applied,false);
    assert.equal(refused.conflicts[0].reason,'unsupported_agent_reference_or_checkpoint');
    assert.deepEqual(await sql.query(`select * from agent_checkpoints where check_point_id='checkpoint-t06'`),prior);
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='agent-tg'`))[0].n,2);
    await sql.query(`update sources set enabled=true where id='agent-tg'`);
    await assert.rejects(()=>reconcileTelegramIdentities(sql,'agent-tg',true,{workersStopped:true,rewriteCheckpoint}),/pause_source/);
    await sql.query(`update sources set enabled=false where id='agent-tg'`);
    await sql.query(`update agent_checkpoints set payload=$1 where check_point_id='checkpoint-t06'`,[Buffer.from('{"schema":1,"runtime":"unsupported","state":"AA=="}')]);
    const unknownBefore=await sql.query(`select * from agent_checkpoints where check_point_id='checkpoint-t06'`);
    const unknownResult=await reconcileTelegramIdentities(sql,'agent-tg',true,{workersStopped:true,rewriteCheckpoint});
    assert.equal(unknownResult.applied,false);
    assert.equal(unknownResult.conflicts[0].reason,'unsupported_agent_reference_or_checkpoint');
    assert.deepEqual(await sql.query(`select * from agent_checkpoints where check_point_id='checkpoint-t06'`),unknownBefore);
    assert.equal((await sql.query(`select item_id from ai_jobs where id='ai-job-t06'`))[0].item_id,old);
    await sql.query(`update agent_checkpoints set payload=$1 where check_point_id='checkpoint-t06'`,[Buffer.from(fixture.before_base64,'base64')]);
    await sql.query(`create function t06_fail_rebind() returns trigger language plpgsql as $$ begin raise exception 'synthetic_rebind_failure'; end $$`);
    await sql.query(`create trigger t06_fail_rebind before update on ai_runs for each row execute function t06_fail_rebind()`);
    await assert.rejects(()=>reconcileTelegramIdentities(sql,'agent-tg',true,{workersStopped:true,rewriteCheckpoint}),/synthetic_rebind_failure/);
    assert.equal((await sql.query(`select item_id from ai_jobs where id='ai-job-t06'`))[0].item_id,old);
    assert.deepEqual(await sql.query(`select * from agent_checkpoints where check_point_id='checkpoint-t06'`),prior);
    assert.equal((await sql.query(`select count(*)::int n from collection_identity_merges where old_item_id=$1`,[old]))[0].n,0);
    await sql.query(`drop trigger t06_fail_rebind on ai_runs`);
    const repaired = await reconcileTelegramIdentities(sql,'agent-tg',true,{workersStopped:true,rewriteCheckpoint});
    assert.deepEqual(repaired.conflicts,[]);
    assert.equal(repaired.applied,true);
    assert.equal((await sql.query(`select item_id from ai_jobs where id='ai-job-t06'`))[0].item_id,kept);
    const [run] = await sql.query(`select * from ai_runs where id='run-t06'`);
    assert.equal(run.request_json.item_id,kept);
    assert.equal(run.request_json.sources[0].item_id,kept);
    assert.equal(run.request_json.question,request.question);
    assert.equal(run.events_json[0].item_id,kept);
    assert.equal(run.events_json[0].evidence_id,evidenceId);
    assert.equal(run.response_json.citations[0].id,kept);
    assert.equal(run.response_json.verified_evidence[0].item_id,kept);
    assert.deepEqual(run.response_json.result,response.result);
    assert.equal(run.response_json._completion.digest,'unchanged');
    const [cp] = await sql.query(`select * from agent_checkpoints where check_point_id='checkpoint-t06'`);
    const envelope = JSON.parse(Buffer.from(cp.payload).toString('utf8'));
    assert.equal(envelope.evidence[0].item_id,kept);
    assert.equal(envelope.evidence[0].evidence_id,evidenceId);
    assert.equal(envelope.evidence[0].text,`quote ${old}`);
    assert.equal(cp.model_call_count,1);
    assert.equal(cp.evidence_event_count,1);
    assert.equal(cp.claim_token,'claim');
    assert.equal(cp.sequence,1);
    const [archive] = await sql.query(`select snapshot from collection_identity_merges where old_item_id=$1`,[old]);
    assert.equal(archive.snapshot.agent_checkpoints[0].payload_base64,fixture.before_base64);
    assert.equal(archive.snapshot.agent_checkpoints.length,1);
    assert.equal(Buffer.from((await sql.query(`select payload from agent_checkpoints where check_point_id='unchanged-checkpoint-t06'`))[0].payload).toString('base64'),fixture.after_base64);

    for (const kind of ['extract','ai','active']) {
      const sourceId=`conflict-${kind}`, oldId=`${kind}-old`, keptId=`${kind}-kept`;
      await sql.query(`insert into sources(id,platform,name,handle,enabled) values($1,'telegram','conflict','channel',false)`,[sourceId]);
      await sql.query(`insert into items(id,source_id,platform,external_id,title) values($1,$3,'telegram','channel/2000','same'),($2,$3,'telegram','2000','same')`,[oldId,keptId,sourceId]);
      if(kind==='extract') await sql.query(`insert into extract_jobs(id,item_id,kind,target_key) values('ce-old',$1,'ocr','body'),('ce-new',$2,'ocr','body')`,[oldId,keptId]);
      if(kind==='ai') await sql.query(`insert into ai_jobs(id,item_id,material_hash,policy_version,status) values('ca-old',$1,'same','v1','queued'),('ca-new',$2,'same','v1','queued')`,[oldId,keptId]);
      if(kind==='active') await sql.query(`insert into extract_jobs(id,item_id,kind,target_key,status) values('active-extract',$1,'ocr','body','running')`,[oldId]);
      const beforeItems=await sql.query(`select * from items where source_id=$1 order by id`,[sourceId]);
      const outcome=await reconcileTelegramIdentities(sql,sourceId,true,{workersStopped:true});
      assert.equal(outcome.applied,false);
      assert.equal(outcome.conflicts[0].reason,kind==='extract'?'extract_target_collision':kind==='ai'?'ai_job_collision':'active_writer');
      assert.deepEqual(await sql.query(`select * from items where source_id=$1 order by id`,[sourceId]),beforeItems);
    }

    await sql.query(`insert into sources(id,platform,name,handle,adapter,enabled,scan_state) values('backfill','telegram','backfill','channel','telegram_web',false,'{"bootstrap":"backfill","boundary":"100"}')`);
    assert.equal((await runSourceJob('backfill')).error,'已停用');
    await sql.query(`insert into items(id,source_id,platform,external_id,title) values('web-stable','backfill','telegram','channel/101','101')`);
    await sql.query(`insert into media_objects(id,item_id,object_key) values('web-media','web-stable','historical/object/key')`);
    await sql.query(`update sources set enabled=true where id='backfill'`);
    assert.equal((await runSourceJob('backfill')).items_new,79);
    assert.equal((await sql.query(`select external_id from items where id='web-stable'`))[0].external_id,'101');
    assert.equal((await sql.query(`select item_id from media_objects where id='web-media'`))[0].item_id,'web-stable');
    await sql.query(`update sources set enabled=false where id='backfill'`);
    const paused=await sql.query(`select scan_state,last_external_id,has_more from sources where id='backfill'`);
    assert.equal((await runSourceJob('backfill')).error,'已停用');
    assert.deepEqual(await sql.query(`select scan_state,last_external_id,has_more from sources where id='backfill'`),paused);
    await sql.query(`update sources set enabled=true where id='backfill'`);
    for(let round=0;round<3;round++) assert.equal((await runSourceJob('backfill')).error,'');
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='backfill'`))[0].n,250);

    // A partial item-save failure must never advance the page checkpoint.
    await sql.query(`insert into sources(id,platform,name,handle,adapter,last_external_id) values('fail-page','telegram','failure','channel','telegram_web','100')`);
    assert.equal((await runSourceJob('fail-page')).error,'');
    await sql.query(`create function t06_fail_item() returns trigger language plpgsql as $$ begin
      if new.source_id='fail-page' and new.external_id='220' then raise exception 'synthetic_insert_failure'; end if; return new; end $$`);
    await sql.query(`create trigger t06_fail_item before insert on items for each row execute function t06_fail_item()`);
    assert.match((await runSourceJob('fail-page')).error,/synthetic_insert_failure/);
    assert.equal((await sql.query(`select last_external_id from sources where id='fail-page'`))[0].last_external_id,'180');
    await sql.query(`drop trigger t06_fail_item on items`);
    for(let round=0;round<3;round++) assert.equal((await runSourceJob('fail-page')).error,'');
    assert.equal((await sql.query(`select count(*)::int n from items where source_id='fail-page'`))[0].n,250);

    await sql.query(`insert into sources(id,platform,name,handle,adapter,last_external_id) values('service-page','telegram','services','channel','telegram_web','100')`);
    globalThis.fetch=async(input)=>String(input).endsWith('/health') ? Response.json({ok:true,authorized:true,state:'ready'}) : Response.json({items:[],last_id:'180',has_more:true});
    assert.equal((await runSourceJob('service-page')).error,'');
    assert.equal((await sql.query(`select last_external_id from sources where id='service-page'`))[0].last_external_id,'180');
    assert.match((await runSourceJob('service-page')).error,/invalid_response/);
    assert.equal((await sql.query(`select last_external_id from sources where id='service-page'`))[0].last_external_id,'180');

    // External-ID-only repairs keep their UUID and never need opaque checkpoint decoding.
    await sql.query(`insert into sources(id,platform,name,handle,enabled) values('rekey-only','telegram','rekey','channel',false)`);
    await sql.query(`insert into items(id,source_id,platform,external_id,title) values('stable-uuid','rekey-only','telegram','channel/3000','same')`);
    await sql.query(`insert into agent_checkpoints(check_point_id,run_id,claim_token,sequence,schema_version,runtime_version,payload)
      select 'irrelevant-'||n,'run-t06','claim',n+2,'unknown','unknown',decode('000102','hex') from generate_series(1,101) n`);
    const untouchedCheckpoints=await sql.query(`select * from agent_checkpoints order by check_point_id`);
    const inPlace=await reconcileTelegramIdentities(sql,'rekey-only',true,{workersStopped:true});
    assert.equal(inPlace.applied,true);
    assert.deepEqual(inPlace.conflicts,[]);
    assert.deepEqual(await sql.query(`select id,external_id from items where source_id='rekey-only'`),[{id:'stable-uuid',external_id:'3000'}]);
    assert.deepEqual(await sql.query(`select * from agent_checkpoints order by check_point_id`),untouchedCheckpoints);

    assert.deepEqual(initialScanState(undefined),{bootstrap:'latest'});
    assert.deepEqual(initialScanState({bootstrap:'backfill',boundary:'9007199254740993'}),{bootstrap:'backfill',boundary:'9007199254740993'});
    for(const value of [{bootstrap:'backfill',boundary:'channel/100'},{bootstrap:'backfill',boundary:100},{bootstrap:'backfill',boundary:'x123'},null]) assert.throws(()=>initialScanState(value),/invalid_scan_state/);



  } finally {
    await vite.close();
    globalThis.fetch=originalFetch;
    delete process.env.TELEGRAM_WORKER_URL;
    const pg = await (globalThis as any).__pgliteInstance__;
    if(pg) await pg.close();
    delete (globalThis as any).__pgliteInstance__;
  }
});

