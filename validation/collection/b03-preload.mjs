import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { migratedDatabase } from './jobs-qa-preload.mjs';
import { QA_ROOT } from './b03-postgres-build.mjs';
import { ARTICLE_HOST, CONCURRENT_BODY, readerFixture, seedArticleFixtures } from './b03-fixtures.mjs';

// Inert outside the explicit isolated Vite child; no production module imports or hooks.
if (process.env.B03_QA_PRELOAD === 'true' && /[\\/]vite[\\/]bin[\\/]vite\.js$/.test(process.argv[1] ?? '')) {
  assert.equal(process.env.LOOM_RUNTIME_MODE, 'test');
  for (const name of ['AUTO_ANALYZE','EXTRACT_AUTO','AGENT_WORKER_ENABLED','AGENT_ASYNC_RESEARCH_ENABLED','AGENT_OPENCODE_WORKER_ENABLED','AGENT_ASSISTANT_ENABLED','AGENT_ASSISTANT_ACTIONS_ENABLED']) assert.equal(process.env[name], 'false');
  assert.equal(process.env.AI_ENGINE, 'legacy');
  assert.equal(process.env.ARTICLE_READER_ALLOWED_HOSTS, ARTICLE_HOST);
  const controlDir = resolve(process.env.B03_QA_CONTROL_DIR ?? '');
  assert.ok(controlDir.startsWith(resolve(QA_ROOT) + sep), 'control directory must be QA-owned');
  mkdirSync(controlDir, { recursive: true });
  const metrics = { requests: [], dns: [], unexpected: [], active: 0 };
  const saveMetrics = () => { writeFileSync(join(controlDir, 'network.tmp'), JSON.stringify(metrics, null, 2)); renameSync(join(controlDir, 'network.tmp'), join(controlDir, 'network.json')); };
  const dsn = process.env.DATABASE_URL?.trim();
  let sql;
  if (dsn) {
    const parsed = new URL(dsn);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.match(parsed.pathname, /^\/b03_(dev|built|concurrency)$/);
    assert.equal(parsed.username, 'postgres');
    assert.equal(parsed.password, 'review-only-local');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: dsn }); await client.connect();
    sql = { async query(text, values) { return client.query(text, values); } };
    // Real PostgreSQL schema must already be migrated by the actual migration command.
    assert.ok((await sql.query("select name from _migrations where name='0019_agent_material_revision.sql'")).rows.length);
  } else {
    assert.equal(globalThis.__pgliteInstance__, undefined);
    const database = migratedDatabase(); globalThis.__pgliteInstance__ = database; sql = await database;
  }
  // Only one process seeds a given fresh database; sibling native-PG concurrency process opts out.
  if (process.env.B03_QA_SKIP_SEED !== 'true') await seedArticleFixtures(sql);

  dns.lookup = async (hostname, options) => {
    if (![ARTICLE_HOST, 'r.jina.ai'].includes(hostname)) {
      metrics.unexpected.push({ kind: 'dns', hostname }); saveMetrics(); throw new Error('qa_unexpected_dns');
    }
    assert.equal(options.all, true);
    metrics.dns.push({ hostname, at: Date.now() }); saveMetrics();
    return [{ address: '93.184.216.34', family: 4 }];
  };
  https.request = function controlledRequest(options, callback) {
    const request = new EventEmitter();
    let timer, idleTimer, response, closed = false, started = false;
    const record = { path: options.path, startedAt: Date.now(), destroyed: false, responseClosed: false };
    const fail = error => queueMicrotask(() => request.destroy(error));
    const resetIdle = () => { if (idleTimer) clearTimeout(idleTimer); if (request.idleMs) idleTimer = setTimeout(() => request.idleCallback(), request.idleMs); };
    request.setTimeout = (ms, fn) => { request.idleMs = ms; request.idleCallback = fn; return request; };
    request.destroy = error => {
      if (closed) return request;
      closed = true; clearTimeout(timer); clearTimeout(idleTimer);
      options.signal?.removeEventListener('abort', abort);
      record.destroyed = true; record.elapsedMs = Date.now() - record.startedAt;
      if (started) metrics.active -= 1;
      response?.destroy(error); saveMetrics();
      if (error) request.emit('error', error);
      request.emit('close'); return request;
    };
    const abort = () => request.destroy(options.signal.reason instanceof Error ? options.signal.reason : new Error('aborted'));
    request.end = () => {
      try {
        assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, 'r.jina.ai');
        assert.equal(Number(options.port), 443); assert.equal(options.method, 'GET');
        assert.equal(options.headers.Accept, 'application/json'); assert.equal(options.headers['x-retain-images'], 'none');
        assert.ok(options.signal); assert.equal(typeof options.lookup, 'function');
        assert.ok(String(options.path).startsWith('/https://' + ARTICLE_HOST + '/'));
        const target = new URL(String(options.path).slice(1));
        const fixture = readerFixture(target.href);
        started = true; metrics.requests.push(record); metrics.active += 1; saveMetrics();
        options.lookup('r.jina.ai', { all: true }, (error, entries) => {
          if (error) return fail(error);
          assert.deepEqual(entries, [{ address: '93.184.216.34', family: 4 }]);
          if (options.signal.aborted) return abort();
          options.signal.addEventListener('abort', abort, { once: true }); resetIdle();
          timer = setTimeout(() => {
            if (closed) return;
            response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'application/json' };
            // The real async iterator still observes errors; listener prevents an early destroy from becoming an unhandled EventEmitter error.
            response.on('error', () => {});
            response.once('close', () => { record.responseClosed = true; saveMetrics(); });
            callback(response);
            if (fixture.kind === 'timeout') {
              const drip = () => { if (closed) return; response.write(' '); resetIdle(); timer = setTimeout(drip, 250); };
              drip(); // Never synthesize timeout: real reader/publicFetch composed 20s signal must stop this stream.
            } else {
              setImmediate(() => {
                if (closed) return;
                response.end(fixture.response); record.completed = true; record.elapsedMs = Date.now() - record.startedAt;
                clearTimeout(idleTimer); options.signal.removeEventListener('abort', abort); metrics.active -= 1; started = false; saveMetrics();
              });
            }
          }, Number(process.env.B03_QA_NETWORK_DELAY_MS ?? 350));
        });
      } catch (error) { metrics.unexpected.push({ kind: 'https', path: String(options.path), error: error.message }); saveMetrics(); fail(error); }
      return request;
    };
    return request;
  };
  syncBuiltinESMExports(); saveMetrics();

  const consumed = new Set(); let chain = Promise.resolve();
  const scan = () => {
    for (const name of readdirSync(controlDir)) {
      if (!/^request-[a-f0-9-]{36}\.json$/.test(name) || consumed.has(name)) continue;
      consumed.add(name);
      chain = chain.then(async () => {
        const id = name.slice(8, -5), ack = { ok: false };
        try {
          const bytes = readFileSync(join(controlDir, name)); assert.ok(bytes.length <= 2048);
          const command = JSON.parse(bytes); assert.equal(command.id, id);
          if (command.op === 'state') {
            ack.result = { rows: (await sql.query("select id,body,material_version,extra,pipeline_status from items where id like 'qa-b03-%' order by id")).rows,
              counts: (await sql.query(`select
                (select count(*)::int from analyses where item_id like 'qa-b03-%') as analyses,
                (select count(*)::int from extract_jobs where item_id like 'qa-b03-%') as extract_jobs,
                (select count(*)::int from ai_jobs) as ai_jobs,
                (select count(*)::int from ai_runs) as ai_runs`)).rows[0],
              extracts: (await sql.query("select id,item_id,kind,status,result_text from extract_jobs where item_id like 'qa-b03-%' order by id")).rows,
              analyses: (await sql.query("select id,item_id,summary from analyses where item_id like 'qa-b03-%' order by id")).rows, metrics };
          } else if (command.op === 'change-material') {
            assert.match(command.itemId, /^qa-b03-conflict-(1280|390)$/);
            ack.result = (await sql.query('update items set body=$2 where id=$1 returning id,body,material_version', [command.itemId, CONCURRENT_BODY])).rows;
            assert.equal(ack.result.length, 1);
          } else if (command.op === 'reader-enabled') {
            assert.equal(typeof command.enabled, 'boolean'); process.env.ARTICLE_READER_ENABLED = String(command.enabled); ack.result = { enabled: command.enabled };
          } else throw new Error('unknown_control_operation');
          ack.ok = true;
        } catch (error) { ack.error = error.message; }
        const temp = join(controlDir, 'response-' + id + '.tmp'); writeFileSync(temp, JSON.stringify(ack)); renameSync(temp, join(controlDir, 'response-' + id + '.json'));
      });
    }
  };
  watch(controlDir, scan); scan();
  writeFileSync(join(controlDir, 'preload-ready.json'), JSON.stringify({ pid: process.pid, backend: dsn ? 'postgres' : 'pglite', ready: true }));
}
