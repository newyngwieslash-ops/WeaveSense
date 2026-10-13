#!/usr/bin/env node
/** GitHub releases pilot: existing collector/scheduler, disposable DB only.
 * --self-check is synthetic. Live modes are explicit, finite, and stop on error.
 * No application source configuration is installed or enabled by this script.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createServer } from 'vite';
import { offlineEnv } from '../../scripts/readiness-offline.mjs';
import { isMainModule } from '../../scripts/with-app-env.mjs';

const ownPath = fileURLToPath(import.meta.url);
const cfgPath = fileURLToPath(new URL('./github-release-sources.json', import.meta.url));
const sources = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
const repos = ['Panniantong/Agent-Reach', 'h4ckf0r0day/obscura', 'jina-ai/reader'];
const HOUR = 3600000, STEP = 3 * HOUR, DURATION = 72 * HOUR;
const modes = ['--self-check', '--snapshot', '--observe-72h'];
assert.equal(sources.length, 3);
assert.equal(new Set(sources.map(s => s.id)).size, 3);
for (const [i, s] of sources.entries()) {
  assert.equal(s.handle, repos[i]);
  assert.equal(s.id, ['src_github_agent_reach_releases', 'src_github_obscura_releases', 'src_github_jina_reader_releases'][i]);
  assert.equal(s.feed_url, `https://github.com/${repos[i]}/releases.atom`);
  assert.equal(s.url, `https://github.com/${repos[i]}`);
  assert.equal(s.enabled, false);
  assert.equal(s.platform, 'rss'); assert.equal(s.adapter, 'rss'); assert.equal(s.interval_minutes, 180);
}
const asArray = value => value == null ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
// Independent identity-only oracle. Existing A05 observer auto-starts on import,
// so do not import that CLI; a main-module guard is needed before safe reuse.
function reference(xml) {
  if (XMLValidator.validate(xml) !== true) throw new Error('reference_invalid_xml');
  const doc = parser.parse(xml);
  if (!doc.feed) throw new Error('reference_not_atom');
  const entries = asArray(doc.feed.entry).map(entry => ({
    raw_id: typeof entry.id === 'string' && entry.id ? entry.id : null,
    public_url: asArray(entry.link).find(link => link?.['@_rel'] === 'alternate')?.['@_href'] ?? null,
    title: typeof entry.title === 'string' ? entry.title : null,
    updated: entry.updated ?? null, published: entry.published ?? null,
  }));
  const groups = new Map();
  for (const entry of entries) {
    entry.normalized_id = entry.raw_id?.slice(0, 320) ?? null;
    if (entry.normalized_id) {
      if (!groups.has(entry.normalized_id)) groups.set(entry.normalized_id, []);
      groups.get(entry.normalized_id).push(entry.raw_id);
    }
  }
  const collisions = [...groups].filter(([, raw]) => new Set(raw).size > 1).map(([id, raw]) => ({ id, raw }));
  const missing = entries.flatMap((entry, i) => entry.raw_id === null ? [i] : []);
  return { raw_entry_count: entries.length, entries, ids: [...groups.keys()],
    incomparable_entry_indexes: missing, normalization_collisions: collisions,
    upstream_duplicate_ids: [...groups].filter(([, raw]) => raw.length > 1).map(([id, raw]) => ({ id, raw })),
    incomparable: missing.length > 0 || collisions.length > 0 };
}
function errorCode(message) {
  if (!message) return '';
  const http = /^HTTP (\d{3})$/.exec(message);
  if (http) return `http_${http[1]}`;
  if (/abort|interrupted/i.test(message)) return 'interrupted';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  return /^[a-z][a-z0-9_]+$/.test(message) ? message : 'collector_failed';
}
function fixture(source, tags) {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><title>synthetic ${source.handle}</title>${tags.map((tag, i) =>
    `<entry><id>tag:github.com,2008:Repository/fixture-${source.id}/${tag}</id><title>synthetic-${tag}</title>` +
    `<updated>2026-10-13T00:00:0${tag === 'v2' ? 2 : i}Z</updated><link rel="alternate" href="${source.url}/releases/tag/fixture-${tag}"/>` +
    `<author><name>fixture-author</name></author><content type="html">&lt;p&gt;synthetic release notes ${tag}&lt;/p&gt;</content></entry>`).join('')}</feed>`;
}
const PUBLIC = { async lookup() { return [{ address: '93.184.216.34', family: 4 }]; } };
const chunks = text => (async function* () { yield Buffer.from(text); })();
function fixtureIo(xml, status = 200, headers = {}) {
  let calls = 0;
  return { resolver: PUBLIC, transport: async () => { calls++; return { status, headers: { 'content-type': 'application/atom+xml', ...headers }, body: chunks(xml) }; }, count: () => calls };
}
async function selfCheck(collectSource, runSourceJob, sql, policy) {
  let requests = 0;
  for (const s of sources) {
    const disabledIo = fixtureIo(fixture(s, ['v1']));
    assert.equal((await runSourceJob(s.id, 'manual', disabledIo)).error, '已停用');
    assert.equal(disabledIo.count(), 0);
    await sql.query('update sources set enabled=true where id=$1', [s.id]);
    for (const [tags, expected] of [[['v1'], 1], [['v1'], 0], [['v2', 'v1'], 1]]) {
      const xml = fixture(s, tags), io = fixtureIo(xml);
      const result = await runSourceJob(s.id, 'manual', io);
      assert.equal(result.error, ''); assert.equal(result.items_new, expected); requests += io.count();
      const stored = await sql.query('select external_id,url,body from items where source_id=$1', [s.id]);
      assert.equal(stored.length, tags.length);
      assert.ok(reference(xml).ids.every(id => stored.some(row => row.external_id === id)));
      assert.ok(stored.every(row => row.url.startsWith(`${s.url}/releases/tag/fixture-`) && row.body.includes('synthetic release notes')));
      const [job] = await sql.query('select coverage from jobs where source_id=$1 order by started_at desc limit 1', [s.id]);
      assert.equal(job.coverage.window_only, true); assert.equal(job.coverage.complete, false);
    }
    const emptyIo = fixtureIo(fixture(s, []));
    const batch = await collectSource(s, emptyIo);
    assert.equal(batch.items.length, 0); assert.equal(batch.coverage.note, 'empty_window');
    assert.deepEqual(batch.meta, { provider: '', attempts: ['rss'], paid_call: false });
    requests += emptyIo.count();
    for (const status of [401, 403, 429, 503]) {
      const io = fixtureIo('fixture failure', status);
      await assert.rejects(() => collectSource(s, io), new RegExp(`HTTP ${status}`));
      assert.equal(io.count(), 1); requests += io.count();
    }
    let timeoutCalls = 0;
    await assert.rejects(() => collectSource(s, { resolver: PUBLIC, transport: async () => { timeoutCalls++; throw new Error('timeout'); } }), /timeout/);
    assert.equal(timeoutCalls, 1); requests += timeoutCalls;
    const oversized = fixtureIo(fixture(s, ['v1']));
    await assert.rejects(() => collectSource(s, { ...oversized, maxBytes: 32 }), /response_too_large/);
    assert.equal(oversized.count(), 1); requests += oversized.count();
    const malformed = fixtureIo('<feed><entry>');
    await assert.rejects(() => collectSource(s, malformed), /invalid_feed_xml/); requests += malformed.count();
    const html = fixtureIo('<html><body>Login challenge</body></html>');
    await assert.rejects(() => collectSource(s, html), /invalid_feed_root/); requests += html.count();
    let deniedCalls = 0;
    await assert.rejects(() => collectSource(s, { resolver: { async lookup() { return [{ address: '198.18.0.2', family: 4 }]; } },
      transport: async () => { deniedCalls++; throw new Error('must not connect'); } }), /blocked_address/);
    assert.equal(deniedCalls, 0);
    const redirect = fixtureIo('', 302, { location: 'http://127.0.0.1/private' });
    await assert.rejects(() => collectSource(s, redirect), /blocked_address/);
    assert.equal(redirect.count(), 1); requests += redirect.count();
  }
  const long = 'x'.repeat(320);
  const edge = reference(`<feed><entry><title>missing</title></entry><entry><id>${long}a</id></entry><entry><id>${long}b</id></entry></feed>`);
  assert.deepEqual(edge.incomparable_entry_indexes, [0]);
  assert.equal(edge.normalization_collisions.length, 1);
  assert.equal(edge.entries[1].raw_id, `${long}a`);
  assert.equal(edge.entries[1].normalized_id, long);
  assert.equal(edge.incomparable, true);
  const successfulIo = { resolver: PUBLIC, transport: async url => {
    const source = sources.find(s => url.href === s.feed_url);
    assert.ok(source); requests++;
    return { status: 200, headers: { 'content-type': 'application/atom+xml' }, body: chunks(fixture(source, ['v2', 'v1'])) };
  } };
  const snapshot = await observe(runSourceJob, sql, policy, '--snapshot', successfulIo);
  assert.equal(snapshot.attempted_source_jobs, 3); assert.equal(snapshot.successful_source_jobs, 3);
  assert.equal(snapshot.comparable_responses, 3); assert.equal(snapshot.completed_rounds, 1);
  assert.equal(snapshot.missing_reference_ids, 0); assert.equal(snapshot.fatal_error, null);
  assert.equal(snapshot.observed_hours, 0); assert.equal(snapshot.acceptance, 'pending');
  for (const row of readFileSync(join(snapshot.evidence_dir, 'rounds.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)) {
    assert.equal(row.reference.entries.length, 2);
    assert.ok(row.reference.entries.every(entry => entry.raw_id.includes('fixture-') && entry.public_url.includes('/releases/tag/fixture-')));
    assert.equal(createHash('sha256').update(readFileSync(join(snapshot.evidence_dir, row.raw_atom_file))).digest('hex'), row.response_sha256);
    assert.equal(row.cursor_before.last_external_id, row.cursor_after.last_external_id);
    assert.deepEqual(row.meta, { provider: '', attempts: ['rss'], paid_call: false });
    assert.equal(row.coverage.window_only, true);
  }
  // Exercise the actual observer's fail-stop path with the production scheduler.
  for (const io of [fixtureIo('synthetic failure', 429, { 'retry-after': '3600' }),
    fixtureIo('<html><body>synthetic challenge</body></html>')]) {
    const summary = await observe(runSourceJob, sql, policy, '--snapshot', io);
    assert.equal(summary.attempted_source_jobs, 1);
    assert.equal(summary.successful_source_jobs, 0);
    assert.equal(summary.comparable_responses, 0);
    assert.equal(summary.missing_reference_ids, null);
    assert.equal(summary.acceptance, 'pending');
    assert.equal(io.count(), 1, 'first failed job prevents the next source and any retry');
    requests += io.count();
    const [row] = readFileSync(join(summary.evidence_dir, 'rounds.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(row.evidence_kind, 'synthetic_fixture');
    if (row.response_hops[0].status === 429) {
      assert.equal(row.error_code, 'http_429'); assert.equal(row.collection_error, 'HTTP 429');
      assert.equal(row.response_hops[0].retry_after, '3600');
      assert.equal(row.comparison_error, null); assert.equal(row.capture_error, null);
      assert.deepEqual(row.meta, { provider: '', attempts: ['rss'], paid_call: false });
    } else {
      assert.equal(row.collection_error, 'invalid_feed_root');
      assert.equal(row.comparison_error, 'reference_not_atom');
      assert.equal(row.raw_atom_file, null);
    }
  }
  const denied = { resolver: { async lookup() { return [{ address: '198.18.0.2', family: 4 }]; } },
    transport: async () => { throw new Error('preflight must prevent transport'); } };
  const preflight = await observe(runSourceJob, sql, policy, '--snapshot', denied);
  assert.equal(preflight.preflight_error, 'blocked_address');
  assert.equal(preflight.attempted_source_jobs, 0); assert.equal(preflight.http_requests, 0);
  assert.equal(preflight.observed_hours, 0); assert.equal(preflight.missing_reference_ids, null);
  const stopInput = new PassThrough();
  try {
    const stopped = await observe(runSourceJob, sql, policy, '--snapshot', {
      input: stopInput, resolver: { async lookup() {
        stopInput.write('st'); await delay(0); stopInput.write('op\n');
        return PUBLIC.lookup();
      } }, transport: async () => { throw new Error('fragmented stop must prevent transport'); },
    });
    assert.equal(stopped.interruption, 'interrupted');
    assert.equal(stopped.attempted_source_jobs, 0); assert.equal(stopped.http_requests, 0);
    assert.equal(stopInput.listenerCount('data'), 0, 'stop reader releases its input listener');
    assert.equal(stopInput.readableFlowing, false, 'stop reader leaves input paused');
  } finally { stopInput.destroy(); }
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')).map(s => s.enabled), [false, false, false]);
  console.log(JSON.stringify({ mode: 'self-check', offline: 'passed', synthetic_transport_calls: requests,
    real_http_requests: 0, live_gate: 'pending', observed_hours: 0, config_enabled: sources.map(s => s.enabled) }));
}
async function observe(runSourceJob, sql, policy, mode, testIo = null) {
  const rounds = mode === '--observe-72h' ? 25 : 1;
  const outRoot = resolve('artifacts/collection-capability/github-pilot'); mkdirSync(outRoot, { recursive: true });
  const out = mkdtempSync(join(outRoot, testIo ? 'synthetic-' : rounds === 1 ? 'snapshot-' : '72h-'));
  const evidenceKind = testIo ? 'synthetic_fixture' : 'public_upstream';
  const abort = new AbortController(), rows = [];
  let interruption = '', fatal = '', preflightError = '', preflightMessage = '', requests = 0, attempted = 0;
  const stop = () => { interruption = 'interrupted'; abort.abort(); };
  const onInput = input => { if (String(input).trim() === 'stop') stop(); };
  const input = testIo?.input ?? (!testIo ? process.stdin : null);
  const lines = input ? createInterface({ input, crlfDelay: Infinity }) : null;
  lines?.on('line', onInput);
  if (!testIo) {
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }
  let startedAt = new Date().toISOString(), start = performance.now(), summary;
  try {
    try {
      await policy.resolvePublicAddresses('github.com', testIo?.resolver, [], AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]));
    } catch (error) {
      preflightMessage = error.message; preflightError = errorCode(preflightMessage); throw error;
    }
    for (const s of sources) await sql.query('update sources set enabled=true where id=$1', [s.id]);
    startedAt = new Date().toISOString(); start = performance.now();
    const request = testIo?.transport ?? policy.pinnedTransport({ signals: { abortSignal: abort.signal } });
    observation: for (let round = 0; round < rounds; round++) {
      if (abort.signal.aborted) break;
      const scheduled = start + STEP * round;
      if (scheduled > performance.now()) await delay(scheduled - performance.now(), undefined, { signal: abort.signal });
      if (round && performance.now() - scheduled > 300000) { interruption = 'schedule_late'; break; }
      for (const s of sources) {
        if (abort.signal.aborted) break observation;
        if (round && performance.now() - scheduled > 300000) { interruption = 'schedule_late'; break observation; }
        const before = new Set((await sql.query('select external_id from items where source_id=$1', [s.id])).map(row => row.external_id));
        const [cursorBefore] = await sql.query('select last_external_id,last_published_at from sources where id=$1', [s.id]);
        let captured = null, bytes = 0, complete = false, transportError = '', captureError = '';
        const pieces = [], hops = [];
        const transport = async (url, options) => {
          requests++;
          const hop = { hostname: url.hostname, status: null, retry_after: null };
          hops.push(hop);
          let response;
          try { response = await request(url, options); } catch (error) { transportError = error.message; throw error; }
          hop.status = response.status;
          const retryAfter = String(response.headers?.['retry-after'] ?? '');
          hop.retry_after = /^(\d{1,10}|[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT)$/.test(retryAfter) ? retryAfter : null;
          if (response.status < 200 || response.status >= 300) return response;
          const upstream = response.body;
          return { ...response, body: (async function* () {
            try {
              for await (const chunk of upstream) { bytes += chunk.byteLength; if (bytes <= policy.TEXT_MAX_BYTES) pieces.push(Buffer.from(chunk)); yield chunk; }
              complete = true;
            } catch (error) { captureError = error.message; throw error; }
          })() };
        };
        const jobStart = performance.now();
        attempted++;
        const result = await runSourceJob(s.id, 'incremental', { transport, resolver: testIo?.resolver });
        const stored = await sql.query('select external_id,url,extra from items where source_id=$1', [s.id]);
        const after = stored.map(row => row.external_id);
        const duplicates = await sql.query('select external_id,count(*)::int as n from items where source_id=$1 group by external_id having count(*)>1', [s.id]);
        const [cursorAfter] = await sql.query('select last_external_id,last_published_at from sources where id=$1', [s.id]);
        let ref = null, comparisonError = '', rawAtomFile = null;
        if (complete && bytes <= policy.TEXT_MAX_BYTES) {
          captured = Buffer.concat(pieces);
          try {
            ref = reference(captured.toString('utf8'));
            rawAtomFile = `round-${round}-${s.id}.xml`; writeFileSync(join(out, rawAtomFile), captured);
            if (ref.incomparable) comparisonError = 'reference_incomparable';
          } catch (error) { comparisonError = error.message; }
        } else if (hops.some(hop => hop.status >= 200 && hop.status < 300)) captureError ||= 'incomplete_response';
        const missing = ref && !ref.incomparable ? ref.ids.filter(id => !after.includes(id)) : null;
        if (missing?.length || duplicates.length) comparisonError ||= 'reference_mismatch';
        const [job] = await sql.query('select coverage,status,provider,attempts,paid_call,error from jobs where source_id=$1 order by started_at desc limit 1', [s.id]);
        const collectionError = result.error || (!job || job.status !== 'ok' ? 'job_not_successful' : '');
        if (!collectionError && !ref) comparisonError ||= 'response_not_captured';
        const row = { evidence_kind: evidenceKind, source_id: s.id, feed_url: s.feed_url, round,
          scheduled_at: new Date(Date.parse(startedAt) + STEP * round).toISOString(), finished_at: new Date().toISOString(),
          duration_ms: Math.round(performance.now() - jobStart), response_hops: hops, captured_bytes: bytes,
          response_bytes: complete ? bytes : null, response_sha256: captured ? createHash('sha256').update(captured).digest('hex') : null,
          raw_atom_file: rawAtomFile, reference: ref, stored_items: stored, new_ids: after.filter(id => !before.has(id)),
          missing_ids: missing, duplicates, cursor_before: cursorBefore, cursor_after: cursorAfter,
          job_status: job?.status ?? null, coverage: job?.coverage ?? null,
          meta: job ? { provider: job.provider, attempts: job.attempts, paid_call: job.paid_call } : null,
          upstream_error: transportError || null, capture_error: captureError || null,
          collection_error: collectionError || null, comparison_error: comparisonError || null,
          error_code: errorCode(collectionError || transportError || captureError || comparisonError), upstream_outside_window: 'unobservable' };
        rows.push(row); appendFileSync(join(out, 'rounds.jsonl'), JSON.stringify(row) + '\n');
        if (row.error_code) { fatal = row.error_code; break observation; }
      }
    }
  } catch (error) { if (!abort.signal.aborted && !preflightError) fatal = error.message; }
  finally {
    const elapsed = performance.now() - start;
    const successful = rows.filter(row => row.job_status === 'ok' && !row.collection_error);
    const comparable = rows.filter(row => row.reference && !row.reference.incomparable);
    const clean = rows.length === rounds * 3 && rows.every(row => !row.error_code);
    const newObserved = successful.length ? sources.every(s => successful.some(row => row.source_id === s.id && row.round > 0 && row.new_ids.length > 0)) : null;
    summary = { mode, evidence_kind: evidenceKind,
      acceptance: !testIo && rounds === 25 && elapsed >= DURATION && clean && newObserved && !interruption && !fatal && !preflightError ? 'passed' : 'pending',
      snapshot_available: rounds === 1 && !testIo && clean && !fatal && !preflightError && !interruption,
      started_at: startedAt, finished_at: new Date().toISOString(), duration_ms: Math.round(elapsed),
      observed_hours: !testIo && successful.length ? elapsed / HOUR : 0, planned_source_jobs: rounds * 3,
      attempted_source_jobs: attempted, recorded_source_jobs: rows.length, successful_source_jobs: rows.length ? successful.length : null,
      completed_rounds: Array.from({ length: rounds }, (_, i) => i).filter(i => rows.filter(row => row.round === i && !row.error_code).length === 3).length,
      comparable_responses: comparable.length,
      missing_reference_ids: rows.length && comparable.length === rows.length ? rows.reduce((n, row) => n + row.missing_ids.length, 0) : null,
      http_requests: testIo ? 0 : requests, synthetic_transport_calls: testIo ? requests : 0,
      interruption: interruption || null, fatal_error: fatal || null, preflight_error: preflightError || null, preflight_message: preflightMessage || null,
      new_arrival_observed_for_all_sources: newObserved, costs: { service_fees: 'unmeasured', operator: 'unmeasured' },
      upstream_outside_window: 'unobservable', evidence_dir: out };
    try {
      writeFileSync(join(out, 'summary.json.tmp'), JSON.stringify(summary, null, 2)); renameSync(join(out, 'summary.json.tmp'), join(out, 'summary.json'));
      if (!testIo) { console.log(JSON.stringify(summary)); if (fatal || preflightError || interruption || (rounds === 25 && summary.acceptance !== 'passed')) process.exitCode = 1; }
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      lines?.off('line', onInput); lines?.close(); input?.pause();
    }
  }
  return summary;
}
async function isolatedMain(mode) {
  assert.equal(process.env.LOOM_GITHUB_PILOT_CHILD, '1', 'internal child only');
  assert.equal(process.env.DATABASE_URL, undefined, 'application DB forbidden');
  assert.equal(process.env.LOOM_RUNTIME_MODE, 'test');
  assert.equal(process.env.LOOM_EGRESS_CIDRS, '');
  const vite = await createServer({ configFile: false, logLevel: 'silent', resolve: { alias: { '@': resolve('src') } }, server: { middlewareMode: true } });
  let db;
  try {
    db = await vite.ssrLoadModule('/src/lib/db.ts');
    const sql = await db.getSql();
    const { collectSource } = await vite.ssrLoadModule('/src/lib/server/collectors/index.ts');
    const { runSourceJob } = await vite.ssrLoadModule('/src/lib/server/scheduler.ts');
    const policy = await vite.ssrLoadModule('/src/lib/server/outbound-policy.ts');
    assert.equal((await sql.query('select count(*)::int as n from sources'))[0].n, 0, 'new isolated PGLite required');
    for (const s of sources) await sql.query('insert into sources(id,platform,name,handle,url,feed_url,adapter,enabled,interval_minutes,notes) values($1,$2,$3,$4,$5,$6,$7,false,$8,$9)',
      [s.id,s.platform,s.name,s.handle,s.url,s.feed_url,s.adapter,s.interval_minutes,s.notes]);
    if (mode === '--self-check') await selfCheck(collectSource, runSourceJob, sql, policy);
    else await observe(runSourceJob, sql, policy, mode);
  } finally { try { await vite.close(); } finally { if (db) await (await db.getPglite()).close(); } }
}
async function main() {
  const args = process.argv.slice(2);
  const childMode = args.includes('--isolated-child') && process.env.LOOM_GITHUB_PILOT_CHILD === '1';
  const choices = args.filter(flag => modes.includes(flag));
  if (choices.length !== 1 || args.length !== (childMode ? 2 : 1)) {
    console.error('usage: node validation/collection/github-release-observation.mjs --self-check | --snapshot | --observe-72h');
    process.exitCode = 2; return;
  }
  if (childMode) { await isolatedMain(choices[0]); return; }
  const child = spawn(process.execPath, [ownPath, choices[0], '--isolated-child'], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
    env: offlineEnv(process.env, { LOOM_GITHUB_PILOT_CHILD: '1', LOOM_RUNTIME_MODE: 'test', AI_ENGINE: 'legacy', DATABASE_URL: undefined, LOOM_EGRESS_CIDRS: '',
      LOOM_MODEL_CONFIG: resolve('artifacts/collection-capability/no-model-config.json'), NODE_ENV: 'test', AUTO_ANALYZE: 'false', EXTRACT_AUTO: 'false',
      AGENT_WORKER_ENABLED: 'false', AGENT_ASYNC_RESEARCH_ENABLED: 'false', AGENT_OPENCODE_WORKER_ENABLED: 'false',
      AGENT_ASSISTANT_ENABLED: 'false', AGENT_ASSISTANT_ACTIONS_ENABLED: 'false', XAI_API_KEY: '' }) });
  const forward = data => { if (!child.stdin.destroyed) child.stdin.write(data); };
  const stopChild = () => forward('stop\n');
  process.on('SIGINT', stopChild); process.on('SIGTERM', stopChild);
  process.stdin.on('data', forward); process.stdin.resume();
  child.stdin.on('error', () => { /* child closed its input during cleanup */ });
  const cleanup = () => {
    process.stdin.off('data', forward); process.stdin.pause();
    process.off('SIGINT', stopChild); process.off('SIGTERM', stopChild);
  };
  child.on('error', error => { cleanup(); console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { cleanup(); process.exitCode = code ?? 1; });
}
if (isMainModule(import.meta.url)) await main();
