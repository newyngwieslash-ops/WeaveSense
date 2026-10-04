#!/usr/bin/env node
// Operator-only maintenance: never discovers configuration or runs migrations.
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { reconcileTelegramIdentities } from '../src/lib/server/collection-identity.ts';
import { isMainModule } from './with-app-env.mjs';
import { offlineEnv } from './readiness-offline.mjs';

/** @param {string} executable */
export function checkpointRebinder(executable) {
  if (!isAbsolute(executable)) throw new Error('absolute_codec_executable_required');
  /** @param {string} payload @param {string} from @param {string} to */
  return async (payload,from,to) => {
    const request = JSON.stringify({payload_base64:payload,from_item_id:from,to_item_id:to});
    if (Buffer.byteLength(request)>354000) throw new Error('checkpoint_rebind_unsupported');
    const result = spawnSync(executable,[],{input:request,encoding:'utf8',windowsHide:true,
      timeout:10000,maxBuffer:354000,env:offlineEnv(process.env),shell:false});
    if (result.error || result.status!==0 || result.stderr) throw new Error('checkpoint_rebind_unsupported');
    let output;
    try { output=JSON.parse(result.stdout); } catch { throw new Error('checkpoint_rebind_unsupported'); }
    if (!output || typeof output!=='object' || Array.isArray(output) || Object.keys(output).length!==1 ||
      typeof output.payload_base64!=='string') throw new Error('checkpoint_rebind_unsupported');
    const decoded=Buffer.from(output.payload_base64,'base64');
    if (!decoded.length || decoded.length>256*1024 || decoded.toString('base64')!==output.payload_base64) throw new Error('checkpoint_rebind_unsupported');
    return output.payload_base64;
  };
}

async function main() {
  const args=process.argv.slice(2);
  const source=args[args.indexOf('--source')+1];
  const apply=args.includes('--apply');
  const workersStopped=args.includes('--workers-stopped');
  if (!args.includes('--source') || !source || source.startsWith('--')) throw new Error('source_required');
  if (apply && !workersStopped) throw new Error('workers_stopped_assertion_required');
  if (!process.env.DATABASE_URL) throw new Error('explicit_database_url_required');
  const codecIndex=args.indexOf('--checkpoint-rebinder');
  const rewriteCheckpoint=codecIndex<0 ? undefined : checkpointRebinder(args[codecIndex+1]??'');
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try {
    const result=await reconcileTelegramIdentities({transaction:async fn=>{
      const client=await pool.connect();
      try {
        await client.query('begin');
        const result=await fn({query:async (text,params)=>(await client.query(text,params)).rows});
        await client.query('commit');
        return result;
      } catch(error) {await client.query('rollback');throw error;} finally {client.release();}
    }},source,apply,{workersStopped,rewriteCheckpoint});
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
    if(result.conflicts.length)process.exitCode=2;
  } finally {await pool.end();}
}
if(isMainModule(import.meta.url)) main().catch(()=>{process.stderr.write('collection_identity_reconciliation_refused\n');process.exitCode=1;});
