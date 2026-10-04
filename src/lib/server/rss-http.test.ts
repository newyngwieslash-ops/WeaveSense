import assert from 'node:assert/strict';
import test from 'node:test';
import * as rss from './rss.ts';
import { fetchText, fetchJson, type FetchIo } from './http.ts';
import { publicFetch } from './outbound-policy.ts';
import { createHash } from 'node:crypto';

const feedUrl = 'https://feed.example/feed';
const source = { id: 'rss-http', platform: 'rss' as const };
const xml = '<rss><channel><item><guid>0001</guid><title>one</title></item></channel></rss>';
const modified = 'Wed, 01 Oct 2025 00:00:00 GMT';
const resolver = { async lookup() { return [{ address: '93.184.216.34', family: 4 }]; } };

test('previous parser scope cannot reuse conditional validators after timestamp metadata correction', async () => {
  const oldScope=createHash('sha256').update(JSON.stringify([feedUrl,'rss','raw-v1-body-v2'])).digest('hex');
  let headers:Record<string,string>={};
  const result=await rss.fetchRssBatch(feedUrl,{...source,feed_etag:'"old"',feed_last_modified:modified,feed_validator_identity:oldScope},
    {resolver,transport:async(_url,options)=>{headers=options.headers ?? {};return {status:200,headers:{},body:new Response(xml).body!};}});
  assert.equal(headers['If-None-Match'],undefined);assert.equal(headers['If-Modified-Since'],undefined);
  assert.notEqual(result.feed_validator_identity,oldScope);assert.equal(result.items[0].external_id,'0001');
});

test('real RSS wrapper sends committed validators and skips XML parse on 304', async () => {
  const headers: Record<string, string>[] = [];
  let parses = 0;
  const parse: typeof rss.parseFeedXml = (...args) => { parses++; return rss.parseFeedXml(...args); };
  const io: FetchIo = { resolver, transport: async (_url, options) => {
    headers.push(options.headers ?? {});
    return { status: headers.length === 1 ? 200 : 304,
      headers: { etag: '"v1"', 'last-modified': modified }, body: new Response(xml).body! };
  } };
  const first = await rss.fetchRssBatch(feedUrl, source, io, parse);
  assert.equal(first.items[0].external_id, '0001');
  assert.deepEqual(first.feed_validators, { etag: '"v1"', last_modified: modified });
  assert.equal(parses, 1);
  parses = 0;
  const second = await rss.fetchRssBatch(feedUrl, { ...source, feed_etag: '"v1"',
    feed_last_modified: modified, feed_validator_identity: first.feed_validator_identity }, io, parse);
  assert.equal(headers[1]['If-None-Match'], '"v1"');
  assert.equal(headers[1]['If-Modified-Since'], modified);
  assert.equal(second.not_modified, true);
  assert.equal(second.items.length, 0);
  assert.equal(parses, 0);
});

test('304 is opt-in; text/json/default fetch refuse it and RSS still enforces SSRF', async () => {
  let cancelled = 0;
  const io: FetchIo = { resolver, transport: async () => ({ status: 304, headers: {},
    body: new ReadableStream({ cancel() { cancelled++; } }) }) };
  for (const request of [() => publicFetch(feedUrl, io), () => fetchText(feedUrl, 1000, undefined, {}, io),
    () => fetchJson(feedUrl, 1000, io)]) await assert.rejects(request, { status: 304, code: 'http_error' });
  assert.equal((await publicFetch(feedUrl, { ...io, allowNotModified: true })).status, 304);
  assert.equal(cancelled, 4);
  await assert.rejects(() => rss.fetchRssBatch('http://127.0.0.1/feed', source, io), { code: 'blocked_address' });
});

test('RSS 304 preserves absent validators, skips the body, and rejects unsolicited 304', async () => {
  let reads = 0, destroyed = 0;
  const io: FetchIo = { resolver, transport: async () => ({ status: 304, headers: {}, body: {
    async *[Symbol.asyncIterator]() { reads++; throw new Error('304_body_must_not_be_read'); },
    destroy() { destroyed++; },
  } }) };
  const saved = { ...source, feed_etag: '"v1"', feed_last_modified: modified,
    feed_validator_identity: rss.feedValidatorIdentity(feedUrl, 'rss') };
  const result = await rss.fetchRssBatch(feedUrl, saved, io);
  assert.deepEqual(result.feed_validators, { etag: '"v1"', last_modified: modified });
  assert.equal((await rss.fetchRssBatch(feedUrl, { ...saved, feed_etag: '' }, io)).not_modified, true);
  await assert.rejects(() => rss.fetchRssBatch(feedUrl, source, io), { code: 'invalid_response' });
  assert.equal(reads, 0);
  assert.equal(destroyed, 3);
});

test('304 opt-in retains redirect address validation, cancellation, deadline and Retry-After', async () => {
  let calls = 0;
  const redirect: FetchIo = { resolver, transport: async () => {
    calls++;
    return { status: 302, headers: { location: 'http://127.0.0.1/private' }, body: new Response('').body! };
  } };
  await assert.rejects(() => publicFetch(feedUrl, { ...redirect, allowNotModified: true }), { code: 'blocked_address' });
  assert.equal(calls, 1);
  await assert.rejects(() => publicFetch(feedUrl, { allowNotModified: true, timeoutMs: 10,
    resolver: { lookup: () => new Promise(() => {}) }, transport: redirect.transport }), { code: 'timeout' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => publicFetch(feedUrl, { ...redirect, allowNotModified: true, signal: aborted.signal }), { code: 'aborted' });
  assert.equal(calls, 1);
  const start = Date.now();
  await assert.rejects(() => publicFetch(feedUrl, { resolver, allowNotModified: true,
    transport: async () => ({ status: 429, headers: { 'retry-after': '60' }, body: new Response('').body! }) }),
    (error: unknown) => {
      const failure = error as { code: string; status: number; retryAt: number };
      assert.equal(failure.code, 'rate_limited');
      assert.equal(failure.status, 429);
      assert.ok(failure.retryAt >= start + 60_000);
      return true;
    });
});

test('redirected RSS strips representation validators on same-origin and cross-origin changes', async () => {
  for (const target of ['https://feed.example/new-feed', 'https://other.example/new-feed']) {
    let redirected = false, unsolicited = false, finalHeaders: Record<string, string> = {};
    const io: FetchIo = { resolver, transport: async (url, options) => {
      if (!redirected) return { status: 200, headers: { etag: '"v1"', 'last-modified': modified }, body: new Response(xml).body! };
      if (url.href === feedUrl) return { status: 302, headers: { location: target }, body: new Response('').body! };
      finalHeaders = options.headers ?? {};
      return { status: unsolicited || finalHeaders['If-None-Match'] ? 304 : 200, headers: { etag: '"v1"' },
        body: new Response(xml.replace('0001', '0002')).body! };
    } };
    const first = await rss.fetchRssBatch(feedUrl, source, io);
    redirected = true;
    const changed = await rss.fetchRssBatch(feedUrl, { ...source, feed_etag: first.feed_validators!.etag,
      feed_last_modified: first.feed_validators!.last_modified, feed_validator_identity: first.feed_validator_identity }, io);
    assert.equal(changed.items[0]?.external_id, '0002', 'new redirect representation must be parsed even with the same ETag');
    assert.equal(finalHeaders['If-None-Match'], undefined);
    assert.equal(finalHeaders['If-Modified-Since'], undefined);
    assert.equal(changed.not_modified, false);
    unsolicited = true;
    await assert.rejects(() => rss.fetchRssBatch(feedUrl, { ...source, feed_etag: '"v1"',
      feed_validator_identity: first.feed_validator_identity }, io), { code: 'http_error', status: 304 });
  }
});

test('URL/parser identity changes force an unconditional request; empty 200 parses', async () => {
  let headers: Record<string, string> = {}, parses = 0;
  const io: FetchIo = { resolver, transport: async (_url, options) => {
    headers = options.headers ?? {};
    return { status: 200, headers: {}, body: new Response('<rss><channel/></rss>').body! };
  } };
  for (const [url, identity] of [[feedUrl + '?changed=1', rss.feedValidatorIdentity(feedUrl, 'rss')],
    [feedUrl, 'previous-parser']]) {
    const result = await rss.fetchRssBatch(url, { ...source, feed_etag: '"old"',
      feed_last_modified: modified, feed_validator_identity: identity }, io,
      (...args) => { parses++; return rss.parseFeedXml(...args); });
    assert.equal(headers['If-None-Match'], undefined);
    assert.equal(headers['If-Modified-Since'], undefined);
    assert.equal(result.not_modified, false);
    assert.equal(result.items.length, 0);
    assert.deepEqual(result.feed_validators, { etag: '', last_modified: '' });
  }
  assert.equal(parses, 2);
});

test('actual source transaction commits validators only with items/media/job; 304 leaves content unchanged', async () => {
  const { createServer } = await import('vite');
  const { default: path } = await import('node:path');
  const vite = await createServer({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': path.resolve('src') } },
    server: { middlewareMode: true, watch: null } });
  try {
    const { getSql } = await vite.ssrLoadModule('/src/lib/db.ts');
    const sql = await getSql();
    const { runSourceJob, persistCollectedBatch } = await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    const query = sql.query.bind(sql), transaction = sql.transaction.bind(sql);
    await query(`insert into sources(id,platform,name,handle,adapter,last_published_at,last_external_id)
      values('rss-http','rss','rss-http',$1,'rss','2020-01-01T00:00:00Z','old'),
      ('rss-other','rss','rss-other',$1,'rss',null,'')`, [feedUrl]);
    let failure = '', rejectEntry = false, empty = false, noValidators = false;
    const statements: string[] = [], headers: Record<string, string>[] = [], statuses: number[] = [];
    const guarded = (run: typeof query) => async (text: string, params?: unknown[]) => {
      statements.push(text);
      if (failure === 'media' && /insert into media_objects/i.test(text)) throw new Error('injected_media_failure');
      if (failure === 'job' && /update jobs set status/i.test(text) && params?.[1] === 'ok') throw new Error('injected_job_failure');
      return run(text, params);
    };
    sql.query = guarded(query);
    sql.transaction = (fn: any) => transaction((tx: any) => fn({ query: guarded(tx.query.bind(tx)) }));
    const io: FetchIo = { resolver, transport: async (_url, options) => {
      headers.push(options.headers ?? {});
      const status = !rejectEntry && !empty && !noValidators && options.headers?.['If-None-Match'] === '"v1"' ? 304 : 200;
      statuses.push(status);
      return { status, headers: noValidators ? {} : { etag: '"v1"', 'last-modified': modified },
        body: new Response(`<rss><channel>${rejectEntry ? '<item/>' : ''}${empty ? '' :
          '<item><guid>0001</guid><title>one</title><enclosure url="https://media.example/cover.jpg" type="image/jpeg"/></item>'}</channel></rss>`).body! };
    } };
    const validators = () => query(`select feed_etag,feed_last_modified,feed_validator_identity from sources where id='rss-http'`);
    for (const stage of ['media', 'job']) {
      failure = stage;
      await query(`update sources set next_attempt_at=null where id='rss-http'`);
      assert.match((await runSourceJob('rss-http', 'manual', io)).error, /injected_.*_failure/);
      assert.deepEqual(await validators(), [{ feed_etag: '', feed_last_modified: '', feed_validator_identity: '' }]);
      assert.equal((await query(`select count(*)::int n from items where source_id='rss-http'`))[0].n, 0);
      assert.equal(headers.at(-1)!['If-None-Match'], undefined);
    }
    failure = '';
    await query(`update sources set next_attempt_at=null where id='rss-http'`);
    assert.equal((await runSourceJob('rss-http', 'manual', io)).items_new, 1);
    assert.equal(statuses.at(-1), 200);
    assert.equal((await validators())[0].feed_etag, '"v1"');
    assert.equal((await query(`select external_id from items where source_id='rss-http'`))[0].external_id, '0001');
    const content = await query(`select * from items where source_id='rss-http'`);
    await query(`update sources set last_scanned_at='2000-01-01',last_success_at='2000-01-01' where id='rss-http'`);
    statements.length = 0;
    assert.deepEqual(await runSourceJob('rss-http', 'manual', io), { items_found: 0, items_new: 0, error: '' });
    assert.equal(statuses.at(-1), 304);
    assert.equal(headers.at(-1)!['If-None-Match'], '"v1"');
    assert.equal(headers.at(-1)!['If-Modified-Since'], modified);
    assert.deepEqual(await query(`select * from items where source_id='rss-http'`), content);
    assert.equal(statements.some(text => /(?:insert into|update) (?:items|media_objects)/i.test(text)), false);
    const [progress] = await query(`select last_scanned_at,last_success_at,last_published_at,last_external_id from sources where id='rss-http'`);
    assert.equal(new Date(progress.last_published_at).toISOString(), '2020-01-01T00:00:00.000Z');
    assert.equal(progress.last_external_id, 'old');
    assert.ok(new Date(progress.last_scanned_at).getFullYear() > 2000);
    assert.ok(new Date(progress.last_success_at).getFullYear() > 2000);

    assert.equal((await runSourceJob('rss-other', 'manual', io)).items_new, 1);
    assert.equal(headers.at(-1)!['If-None-Match'], undefined, 'validators belong to one source');
    for (const change of ["feed_url='https://feed.example/changed'", "feed_validator_identity='previous-parser'"]) {
      await query(`update sources set ${change} where id='rss-http'`);
      assert.equal((await runSourceJob('rss-http', 'manual', io)).error, '');
      assert.equal(headers.at(-1)!['If-None-Match'], undefined, 'actual collection invalidates changed identity');
      assert.equal((await validators())[0].feed_validator_identity, rss.feedValidatorIdentity('https://feed.example/changed', 'rss'));
    }
    rejectEntry = true;
    assert.equal((await runSourceJob('rss-http', 'manual', io)).items_found, 1);
    assert.deepEqual(await validators(), [{ feed_etag: '', feed_last_modified: '', feed_validator_identity: '' }]);
    rejectEntry = false;
    assert.equal((await runSourceJob('rss-http', 'manual', io)).error, '');
    assert.equal(headers.at(-1)!['If-None-Match'], undefined, 'rejected entry must not disappear behind 304');
    assert.equal((await runSourceJob('rss-http', 'reconcile', io)).error, '');
    assert.equal(headers.at(-1)!['If-None-Match'], undefined, 'reconciliation replays item/media state');

    await query(`update sources set status='running',claim_token='new-owner' where id='rss-http'`);
    const [claimed] = await query(`select * from sources where id='rss-http'`);
    const incomplete = { items: [], meta: { provider: '', attempts: ['rss'], paid_call: false },
      coverage: { complete: false, note: 'page_cap' }, feed_validators: { etag: '"unconsumed"', last_modified: modified },
      feed_validator_identity: claimed.feed_validator_identity };
    await assert.rejects(() => persistCollectedBatch(sql, claimed, 'old-owner', incomplete), /scheduler_lease_lost/);
    assert.deepEqual(await query(`select * from sources where id='rss-http'`), [claimed]);
    await query(`insert into jobs(id,source_id,platform) values('new-owner','rss-http','rss')`);
    await persistCollectedBatch(sql, claimed, 'new-owner', incomplete);
    assert.deepEqual(await validators(), [{ feed_etag: '', feed_last_modified: '', feed_validator_identity: '' }]);
    await query(`update sources set status='running',claim_token='body-owner' where id='rss-http'`);
    await query(`insert into jobs(id,source_id,platform) values('body-owner','rss-http','rss')`);
    const [bodyClaim] = await query(`select * from sources where id='rss-http'`);
    await persistCollectedBatch(sql, bodyClaim, 'body-owner', { ...incomplete,
      coverage: { complete: false, window_only: true, note: 'feed_window' },
      items: rss.parseFeedXml(xml, source.id, 'rss').map(item => ({ ...item, extra: { ...item.extra, body_complete: false } })) });
    assert.deepEqual(await validators(), [{ feed_etag: '', feed_last_modified: '', feed_validator_identity: '' }],
      'an accepted metadata-only body failure is not a completely consumed feed');
    empty = true;
    assert.equal((await runSourceJob('rss-http', 'manual', io)).items_found, 0);
    assert.equal((await validators())[0].feed_etag, '"v1"', 'a valid fully consumed empty 200 can be cached');
    noValidators = true;
    assert.equal((await runSourceJob('rss-http', 'manual', io)).error, '');
    assert.equal((await validators())[0].feed_etag, '', '200 without validators clears old values');
  } finally { await vite.close(); }
});
