import { telegramMessageId } from './cursor.ts';
import { parseTelegramHandle } from '../telegram-handle.ts';
import type { Sql } from '../db.ts';
import { normalizeWechatUrl } from '../wechat-canonical.ts';

type Row = Record<string, any>;
type Change = { from: string; to: string; external_id: string; old_external_id: string };
type Conflict = { item_ids: string[]; reason: string };
export type IdentityRepairOptions = {
  workersStopped?: boolean;
  rewriteCheckpoint?: (payload: string, from: string, to: string) => Promise<string>;
};

/** One resumable page, dry-run by default. Keep URLs, UUIDs and cursors untouched. */
export async function backfillWechatUrlKeys(sql: Pick<Sql,'transaction'>, sourceId: string,
  apply = false, options: Pick<IdentityRepairOptions,'workersStopped'> = {}) {
  if (apply && options.workersStopped !== true) throw new Error('workers_stopped_assertion_required');
  return sql.transaction(async tx => {
    const [source] = await tx.query<Row>('select * from sources where id=$1 for update',[sourceId]);
    if (!source || source.platform !== 'wechat') throw new Error('wechat_source_required');
    if (apply && (source.enabled || source.status === 'running')) throw new Error('pause_source_before_identity_merge');
    // ponytail: 500 rows per explicit maintenance run; repeat until remaining=false.
    const rows = await tx.query<{id:string;url:string}>(`select id,url from items
      where source_id=$1 and platform='wechat' and normalized_wechat_url is null order by id limit 500`,[sourceId]);
    const conflicts: {item_id:string;reason:string}[] = [];
    for (const row of rows) {
      let key = '';
      try { key=normalizeWechatUrl(row.url); }
      catch { conflicts.push({item_id:row.id,reason:'invalid_wechat_url'}); }
      if (apply) await tx.query('update items set normalized_wechat_url=$2 where id=$1',[row.id,key]);
    }
    const remaining = (await tx.query(`select id from items where source_id=$1 and platform='wechat'
      and normalized_wechat_url is null limit 1`,[sourceId])).length>0;
    const report = {source_id:sourceId,processed:rows.length,applied:apply,remaining,conflicts};
    await tx.query(`insert into collection_identity_conflicts(source_id,kind,evidence) values($1,'wechat_url_backfill',$2::jsonb)`,[sourceId,JSON.stringify(report)]);
    return report;
  });
}

/** Only schema-defined links change. Quotes, evidence tokens and hashes are history. */
function rebindJson(input: any, shape: 'request' | 'events' | 'response', from: string, to: string) {
  const value = structuredClone(input);
  const item = (record: any, key = 'item_id') => {
    if (record && typeof record === 'object' && !Array.isArray(record) && record[key] === from) record[key] = to;
  };
  const list = (entries: any, key = 'item_id') => {
    if (entries === undefined || entries === null) return;
    if (!Array.isArray(entries)) throw new Error('unknown_agent_json_shape');
    for (const entry of entries) item(entry,key);
  };
  if (shape === 'request') { item(value); list(value?.sources); }
  if (shape === 'events') {
    if (!Array.isArray(value)) throw new Error('unknown_agent_json_shape');
    for (const event of value) if (event?.type === 'evidence' && event.origin === 'internal') item(event);
  }
  if (shape === 'response') {
    list(value?.evidence); list(value?.verified_evidence); list(value?.citations,'id');
  }
  // Refuse unknown structured references; do not mistake old UUIDs in prose or
  // immutable evidence_id tokens for item links and replace arbitrary strings.
  function check(node: any, depth = 0): void {
    if (depth > 64) throw new Error('unknown_agent_json_shape');
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === 'item_id' && child === from) || (key === 'item_ids' && Array.isArray(child) && child.includes(from))) {
        throw new Error('unknown_agent_reference');
      }
      check(child,depth+1);
    }
  }
  check(value);
  return value;
}

/** Dry-run by default; apply requires stopped workers and a disabled source. */
export async function reconcileTelegramIdentities(sql: Pick<Sql,'transaction'>, sourceId: string, apply = false, options: IdentityRepairOptions = {}) {
  if (apply && options.workersStopped !== true) throw new Error('workers_stopped_assertion_required');
  return sql.transaction(async tx => {
    // ponytail: bounded maintenance locks all known reference tables. A large
    // corpus needs a dedicated maintenance window; locks cannot stop in-memory work.
    await tx.query(`lock table sources, items, media_objects, extract_jobs, analyses,
      knowledge_notes, ai_jobs, ai_runs, agent_checkpoints in share row exclusive mode`);
    const [source] = await tx.query<Row>('select * from sources where id=$1',[sourceId]);
    if (!source || source.platform !== 'telegram') throw new Error('telegram_source_required');
    if (apply && (source.enabled || source.status === 'running')) throw new Error('pause_source_before_identity_merge');
    const handle = parseTelegramHandle(source.handle) || parseTelegramHandle(source.url);
    if (!handle) throw new Error('invalid_telegram_handle');
    const rows = await tx.query<Row>('select * from items where source_id=$1 order by id limit 10001',[sourceId]);
    if (rows.length > 10000) throw new Error('identity_maintenance_scope_limit');
    const changes: Change[] = [], conflicts: Conflict[] = [];
    const references: Record<string,unknown> = {};
    const groups = new Map<string,Row[]>();
    const prepared = new Map<string,{ runs:Row[]; jobs:Row[]; checkpoints:Row[]; snapshots:Row }>();
    for (const row of rows) {
      const id = telegramMessageId(row.external_id,handle);
      if (!id) { conflicts.push({item_ids:[row.id],reason:'invalid_telegram_identity'}); continue; }
      groups.set(id,[...(groups.get(id) ?? []),row]);
    }
    const merges = [...groups.values()].reduce((total,group)=>total+Math.max(0,group.length-1),0);
    // An in-place external-ID rekey leaves every UUID reference intact.
    const allCheckpoints = merges ? await tx.query<Row>('select * from agent_checkpoints order by check_point_id limit 101') : [];
    if (allCheckpoints.length > 100 || merges * allCheckpoints.length > 1000) throw new Error('identity_maintenance_scope_limit');
    for (const [externalId,group] of groups) {
      const keeper = group.find(row=>row.external_id===externalId) ?? group[0];
      const groupIds = group.map(row=>row.id);
      // Compare native timestamps across the whole group, retaining database precision.
      const publicationConflict = group.length > 1 && (await tx.query<{ conflict: boolean }>(
        'select count(distinct published_at)>1 as conflict from items where id=any($1::text[])',[groupIds]))[0].conflict;
      for (const row of group) {
        if (row.id===keeper.id && row.external_id===externalId) continue;
        changes.push({from:row.id,to:keeper.id,external_id:externalId,old_external_id:row.external_id});
        if (row.id===keeper.id) continue;
        const refs: Row = {};
        const snapshots: Row = {from:row,to:keeper};
        for (const table of ['media_objects','extract_jobs','analyses','ai_jobs']) {
          snapshots[table] = await tx.query(`select * from ${table} where item_id=$1 order by id`,[row.id]);
          refs[table] = snapshots[table].map((entry:Row)=>entry.id);
        }
        snapshots.knowledge_notes = await tx.query(`select * from knowledge_notes where item_ids ? $1`,[row.id]);
        refs.knowledge_notes = snapshots.knowledge_notes.map((entry:Row)=>entry.id);
        // Search is conservative candidate selection, never a text replacement.
        const runs = await tx.query<Row>(`select * from ai_runs where strpos(request_json::text,$1)>0
          or strpos(coalesce(response_json::text,''),$1)>0 or strpos(events_json::text,$1)>0
          or id in(select run_id from ai_jobs where item_id=$1)
          or id in(select run_id from analyses where item_id=$1)
          or id=any($2::text[])`,[row.id,allCheckpoints.map(cp=>cp.run_id)]);
        const jobs = await tx.query<Row>(`select * from ai_jobs where item_id=$1 or strpos(payload::text,$1)>0`,[row.id]);
        // Pending native tool arguments can be the only reference. Inspect every
        // checkpoint within the explicit maintenance cap; never skip opaque blobs.
        const checkpoints = allCheckpoints;
        refs.ai_runs = runs.map(run=>run.id);
        refs.ai_jobs = jobs.map(job=>job.id);
        refs.agent_checkpoints = checkpoints.map(cp=>({id:cp.check_point_id,runtime:cp.runtime_version,schema:cp.schema_version}));
        references[row.id] = refs;
        snapshots.ai_runs = runs; snapshots.ai_jobs = jobs;
        snapshots.agent_checkpoints = checkpoints.map(cp=>({...cp,payload_base64:Buffer.from(cp.payload).toString('base64'),payload:undefined}));
        const targetCollisions = await tx.query(`select target_key from extract_jobs where item_id=any($1::text[]) group by target_key having count(*)>1`,[groupIds]);
        const mediaCollisions = await tx.query(`select source_url from media_objects where item_id=any($1::text[]) group by source_url having count(*)>1`,[groupIds]);
        const jobCollisions = await tx.query(`select material_hash,policy_version from ai_jobs where item_id=any($1::text[]) group by material_hash,policy_version having count(*)>1`,[groupIds]);
        const activeJobs = await tx.query(`select id from ai_jobs where (item_id=any($1::text[]) or id=any($2::text[]))
          and status='running' and (lease_until is null or lease_until>clock_timestamp())`,[groupIds,jobs.map(job=>job.id)]);
        const activeExtracts = await tx.query(`select id from extract_jobs where item_id=any($1::text[]) and status='running'`,[groupIds]);
        const activeRuns = await tx.query(`select id from ai_runs where id=any($1::text[]) and status='running'
          and not exists(select 1 from ai_jobs j where j.run_id=ai_runs.id and j.lease_until<=clock_timestamp())`,[runs.map(run=>run.id)]);
        const contentConflict = publicationConflict || ['title','body','author','media_type'].some(key=>row[key] && keeper[key] && String(row[key])!==String(keeper[key]));
        let reason = contentConflict ? 'different_message_content' : mediaCollisions.length ? 'media_source_collision' : targetCollisions.length ? 'extract_target_collision'
          : jobCollisions.length ? 'ai_job_collision' : activeJobs.length || activeExtracts.length || activeRuns.length ? 'active_writer' : '';
        if (!reason) {
          try {
            const nextRuns = runs.map<Row>(run=>({...run,
              request_json:rebindJson(run.request_json,'request',row.id,keeper.id),
              events_json:rebindJson(run.events_json,'events',row.id,keeper.id),
              response_json:rebindJson(run.response_json,'response',row.id,keeper.id)}))
              .filter((run,index)=>['request_json','events_json','response_json'].some(key=>JSON.stringify(run[key])!==JSON.stringify(runs[index][key])));
            const nextJobs = jobs.map(job=>({...job,payload:rebindJson(job.payload,'request',row.id,keeper.id)}))
              .filter((job,index)=>JSON.stringify(job.payload)!==JSON.stringify(jobs[index].payload));
            const nextCheckpoints: Row[] = [];
            for (const cp of checkpoints) {
              if (!options.rewriteCheckpoint || cp.runtime_version!=='eino-v0.9.19' || String(cp.schema_version)!=='1') throw new Error('checkpoint_rebind_unsupported');
              const original = Buffer.from(cp.payload);
              if (original.length>256*1024) throw new Error('checkpoint_rebind_unsupported');
              const encoded = await options.rewriteCheckpoint(original.toString('base64'),row.id,keeper.id);
              const decoded = Buffer.from(encoded,'base64');
              if (!decoded.length || decoded.length>256*1024 || decoded.toString('base64')!==encoded) throw new Error('checkpoint_rebind_unsupported');
              if (!decoded.equals(original)) nextCheckpoints.push({...cp,payload:decoded});
            }
            snapshots.ai_runs = runs.filter(run=>nextRuns.some(next=>next.id===run.id));
            snapshots.agent_checkpoints = snapshots.agent_checkpoints.filter((cp:Row)=>nextCheckpoints.some(next=>next.check_point_id===cp.check_point_id));
            prepared.set(row.id,{runs:nextRuns,jobs:nextJobs,checkpoints:nextCheckpoints,snapshots});
          } catch { reason='unsupported_agent_reference_or_checkpoint'; }
        }
        if (reason) conflicts.push({item_ids:groupIds,reason});
      }
    }
    const report = {source_id:sourceId,changes,conflicts,references,applied:false};
    await tx.query(`insert into collection_identity_conflicts(source_id,kind,evidence) values($1,$2,$3::jsonb)`,
      [sourceId,conflicts.length?'telegram_conflict':'telegram_plan',JSON.stringify(report)]);
    if (!apply) return report;
    const blocked = new Set(conflicts.flatMap(conflict=>conflict.item_ids));
    for (const change of changes) {
      if (blocked.has(change.from) || blocked.has(change.to)) continue;
      if (change.from===change.to) {
        await tx.query('update items set external_id=$2 where id=$1',[change.from,change.external_id]);
        continue;
      }
      const planned = prepared.get(change.from)!;
      const loser = planned.snapshots.from;
      await tx.query(`insert into collection_identity_merges(source_id,old_item_id,new_item_id,snapshot)
        values($1,$2,$3,$4::jsonb)`,[sourceId,change.from,change.to,JSON.stringify(planned.snapshots)]);
      for (const table of ['media_objects','extract_jobs','analyses','ai_jobs']) {
        await tx.query(`update ${table} set item_id=$2 where item_id=$1`,[change.from,change.to]);
      }
      await tx.query(`update knowledge_notes set item_ids=(select jsonb_agg(case when value=$1 then $2 else value end order by ord)
        from jsonb_array_elements_text(item_ids) with ordinality x(value,ord)) where item_ids ? $1`,[change.from,change.to]);
      // Re-read under the maintenance lock: the same run may reference two
      // different duplicate groups, so a prior group's rewrite must survive.
      for (const run of await tx.query<Row>('select * from ai_runs where id=any($1::text[])',[planned.runs.map(run=>run.id)])) {
        await tx.query(`update ai_runs set request_json=$2::jsonb,events_json=$3::jsonb,response_json=$4::jsonb where id=$1`,
          [run.id,JSON.stringify(rebindJson(run.request_json,'request',change.from,change.to)),
            JSON.stringify(rebindJson(run.events_json,'events',change.from,change.to)),JSON.stringify(rebindJson(run.response_json,'response',change.from,change.to))]);
      }
      for (const job of await tx.query<Row>('select * from ai_jobs where id=any($1::text[])',[planned.jobs.map(job=>job.id)])) {
        await tx.query(`update ai_jobs set payload=$2::jsonb where id=$1`,[job.id,JSON.stringify(rebindJson(job.payload,'request',change.from,change.to))]);
      }
      for (const cp of planned.checkpoints) {
        const [current] = await tx.query<Row>('select payload from agent_checkpoints where check_point_id=$1',[cp.check_point_id]);
        const original = planned.snapshots.agent_checkpoints.find((entry:Row)=>entry.check_point_id===cp.check_point_id).payload_base64;
        const payload = Buffer.from(current.payload).toString('base64')===original ? cp.payload
          : Buffer.from(await options.rewriteCheckpoint!(Buffer.from(current.payload).toString('base64'),change.from,change.to),'base64');
        await tx.query(`update agent_checkpoints set payload=$2 where check_point_id=$1`,[cp.check_point_id,payload]);
        const [saved] = await tx.query<Row>('select payload from agent_checkpoints where check_point_id=$1',[cp.check_point_id]);
        if (!Buffer.from(saved.payload).equals(payload)) throw new Error('identity_checkpoint_write_mismatch');
      }
      for (const field of ['title','body','author','url','thumbnail_url']) await tx.query(`update items set ${field}=coalesce(nullif(${field},''),$2) where id=$1`,[change.to,loser[field]]);
      await tx.query(`update items as survivor set media_urls=(select coalesce(jsonb_agg(distinct value),'[]'::jsonb) from jsonb_array_elements(survivor.media_urls || $2::jsonb)),
        matched_keywords=(select coalesce(jsonb_agg(distinct value),'[]'::jsonb) from jsonb_array_elements(survivor.matched_keywords || $3::jsonb)),
        extra=$4::jsonb || survivor.extra,
        published_at=coalesce(survivor.published_at,loser.published_at),
        collected_at=least(survivor.collected_at,loser.collected_at)
        from items as loser where survivor.id=$1 and loser.id=$5`,
        [change.to,JSON.stringify(loser.media_urls),JSON.stringify(loser.matched_keywords),JSON.stringify(loser.extra),change.from]);
      for (const table of ['media_objects','extract_jobs','analyses','ai_jobs']) {
        if ((await tx.query(`select id from ${table} where item_id=$1 limit 1`,[change.from])).length) throw new Error('identity_reference_remains');
      }
      if ((await tx.query(`select id from knowledge_notes where item_ids ? $1`,[change.from])).length) throw new Error('identity_reference_remains');
      // Validate all known rewritten JSON paths again, without matching prose.
      for (const run of await tx.query<Row>('select * from ai_runs where id=any($1::text[])',[planned.runs.map(run=>run.id)])) {
        for (const [key,shape] of [['request_json','request'],['events_json','events'],['response_json','response']] as const) {
          if (JSON.stringify(rebindJson(run[key],shape,change.from,change.to))!==JSON.stringify(run[key])) throw new Error('identity_reference_remains');
        }
      }
      await tx.query('delete from items where id=$1',[change.from]);
    }
    return {...report,applied:changes.some(change=>!blocked.has(change.from) && !blocked.has(change.to))};
  });
}
