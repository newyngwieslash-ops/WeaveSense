export const VIDEO_KINDS = ['manual','automatic','none','invalid','upload','conflict','timeout'];
export const SCRIPT_TEXT = '<script>globalThis.__C02_SCRIPT_EXECUTED__=true</script>';
export const BASE_BODY = 'C02 ORIGINAL\n\n[OCR:image]\nC02 PRESERVED-OCR\n\n[ASR:audio]\nC02 PRESERVED-ASR';
export const CONCURRENT_BODY = BASE_BODY + '\nC02 CONCURRENT-MATERIAL';
export function videoId(kind, width) {
  const index = VIDEO_KINDS.indexOf(kind); if (index < 0) throw new Error('unknown_fixture_kind');
  return 'C02' + String(index).padStart(2, '0') + String(width).padStart(4, '0') + 'Qa';
}
export function rawTranscript(kind, revision = 0) {
  const chunks = ['C02 SUBTITLE-BEGIN', SCRIPT_TEXT, '良率 fixture', '良率 fixture', 'C02 SUBTITLE-END' + (revision ? '-CHANGED' : '')];
  return JSON.stringify({ events: chunks.map(text => ({ segs: [{ utf8: text }] })) }, null, 1);
}
export const TRANSCRIPT_TEXT = 'C02 SUBTITLE-BEGIN\n' + SCRIPT_TEXT + '\n良率 fixture\nC02 SUBTITLE-END';
export async function seedSubtitleFixtures(sql) {
  const { materialFingerprint } = await import('../../src/lib/server/agent-context.ts');
  const { mapAgentItem } = await import('../../src/lib/server/agent-retrieval.ts');
  await sql.query("insert into sources(id,platform,name,enabled) values('qa-c02','youtube','C02 字幕验收',false)");
  await sql.query("insert into keywords(id,phrase,enabled) values('qa-c02-keyword','良率',true)");
  for (const width of [1280,390]) for (const kind of VIDEO_KINDS) {
    const id = `qa-c02-${kind}-${width}`, video = videoId(kind,width);
    await sql.query(`insert into items(id,source_id,platform,external_id,title,body,url,media_type,extra)
      values($1,'qa-c02','youtube',$2,$3,$4,$5,'video','{}')`,
      [id,'yt:video:'+video,`C02 ${kind} ${width} &amp; raw hash`,BASE_BODY,'https://www.youtube.com/watch?v='+video]);
    for (const extract of ['ocr','asr']) await sql.query(`insert into extract_jobs(id,item_id,target_key,kind,status,result_text)
      values($1,$2,$1,$3,'ok',$4)`,[id+'-'+extract,id,extract,'C02 PRESERVED-'+extract.toUpperCase()]);
    if (['manual','automatic'].includes(kind)) {
      const [raw] = (await sql.query('select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id=$1',[id])).rows;
      await sql.query(`insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at)
        values($1,$1,'analyze_item','legacy','fixture',$2,'offline','{}','succeeded','fixture',now()+interval '1 hour')`,[id+'-run',materialFingerprint(mapAgentItem(raw))]);
      await sql.query("insert into analyses(id,item_id,summary,model,run_id) values($1,$2,'C02 HISTORICAL-ANALYSIS','offline',$3)",[id+'-analysis',id,id+'-run']);
    }
  }
  await sql.query("insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'");
}
