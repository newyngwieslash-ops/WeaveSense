// Preparation only: importing this module seeds nothing and starts no app/network/test.
export const ARTICLE_HOST = 'article.qa.example';
export const SCRIPT_TEXT = '<script>globalThis.__B03_SCRIPT_EXECUTED__ = true</script>';
export const ORIGINAL_BODY = 'B03 原始 Feed 正文，必须在预览和失败后保持不变。';
export const CONCURRENT_BODY = 'B03 CONCURRENT-CONTENT 新材料，不得被旧候选覆盖。';
export const LONG_TOKEN = 'B03_LONG_TOKEN_' + 'x'.repeat(2048) + '_END';
export const CANDIDATE_BODY = 'B03 CANDIDATE-BEGIN\n公开原文事实一。\n' + SCRIPT_TEXT + '\n公开原文事实二。\n' + LONG_TOKEN + '\nB03 CANDIDATE-END';
export const OFFLINE_READER_ENV = Object.freeze({
  ARTICLE_READER_ENABLED: 'true', ARTICLE_READER_ALLOWED_HOSTS: ARTICLE_HOST,
  AI_ENGINE: 'legacy', AUTO_ANALYZE: 'false', EXTRACT_AUTO: 'false',
  AGENT_WORKER_ENABLED: 'false', AGENT_ASYNC_RESEARCH_ENABLED: 'false',
  AGENT_OPENCODE_WORKER_ENABLED: 'false', AGENT_ASSISTANT_ENABLED: 'false',
  AGENT_ASSISTANT_ACTIONS_ENABLED: 'false', XAI_API_KEY: '', DATABASE_URL: '', LOOM_RUNTIME_MODE: 'test',
});

export function articleFixtures(width) {
  return ['success', 'conflict', 'timeout', 'malformed', 'blocked', 'complete'].map(kind => ({
    id: `qa-b03-${kind}-${width}`, kind, title: `B03 ${kind} ${width}`,
    url: `https://${kind === 'blocked' ? 'outside.qa.example' : ARTICLE_HOST}/${kind}/${width}`,
    body: ORIGINAL_BODY, extra: { body_complete: kind === 'complete' },
  }));
}

export async function seedArticleFixtures(pg) {
  const { materialFingerprint } = await import('../../src/lib/server/agent-context.ts');
  const { mapAgentItem } = await import('../../src/lib/server/agent-retrieval.ts');
  await pg.query("insert into sources(id,platform,name,enabled,url) values('qa-b03','rss','B03 原文读取验收',false,$1)", [`https://${ARTICLE_HOST}/`]);
  for (const width of [1280, 390]) for (const fixture of articleFixtures(width)) {
    await pg.query(`insert into items(id,source_id,platform,external_id,title,body,url,media_type,extra)
      values($1,'qa-b03','rss',$1,$2,$3,$4,'article',$5::jsonb)`,
      [fixture.id, fixture.title + (fixture.kind === 'success' ? ' &amp; raw fingerprint' : ''), fixture.body, fixture.url, JSON.stringify(fixture.extra)]);
    if (fixture.kind === 'success') {
      await pg.query(`insert into media_objects(id,item_id,source_url,kind,status) values($1,$2,$3,'image','remote')`,
        [fixture.id + '-media', fixture.id, `https://${ARTICLE_HOST}/image/${width}`]);
      await pg.query(`insert into extract_jobs(id,item_id,media_id,target_key,kind,status,result_text) values($1,$2,$3,$3,'ocr','ok',$4)`,
        [fixture.id + '-ocr', fixture.id, fixture.id + '-media', 'B03 PRESERVED-OCR']);
      const [raw] = (await pg.query('select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id=$1', [fixture.id])).rows;
      const hash = materialFingerprint(mapAgentItem(raw));
      await pg.query(`insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,model)
        values($1,$1,'analyze_item','legacy','offline',$2,'offline','{}','succeeded','offline',now()+interval '1 hour','offline-fixture')`, [fixture.id + '-run', hash]);
      await pg.query(`insert into analyses(id,item_id,summary,model,run_id) values($1,$2,$3,'offline-fixture',$4)`,
        [fixture.id + '-analysis', fixture.id, 'B03 HISTORICAL-ANALYSIS', fixture.id + '-run']);
    }
  }
  await pg.query("insert into app_meta(key,value) values('seeded','1') on conflict(key) do update set value='1'");
}

// Fixed seam lookup table. Timeout must stream until the real 20s deadline aborts;
// it must not replace or shorten the production deadline in the reader/publicFetch.
export function readerFixture(target) {
  const url = new URL(target);
  if (url.hostname !== ARTICLE_HOST) throw new Error('unexpected_reader_fixture_target');
  const kind = url.pathname.split('/')[1];
  if (!['success', 'conflict', 'timeout', 'malformed', 'complete'].includes(kind)) throw new Error('unexpected_reader_fixture_path');
  return { kind, response: kind === 'malformed' ? '{broken-json' : JSON.stringify({
    data: { title: 'B03 controlled public article', url: url.href, content: CANDIDATE_BODY },
  }) };
}
