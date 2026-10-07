#!/usr/bin/env node
// Explicit fake-only AB transport smoke: no quality claim, no supplier credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { fakeReply } from './e2e.mjs';
import { createLiveAdapter } from './live-eval-adapter.mjs';
import { livePlan } from '../../../scripts/agent-quality-live.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, description) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch { /* owned service starting */ } await pause(200); }
  throw Error('timeout: ' + description);
}
async function freePort() {
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}

export async function runLiveAdapterSmoke() {
  const id = randomUUID(), suffix = id.slice(0, 8), schema = 'oc_live_' + id.replaceAll('-', '');
  const out = resolve('.repo', 'live-adapter-smoke-' + id); mkdirSync(out, { recursive: true });
  const result = { validation: 'actual_adapter_fake_AB_smoke', model_quality_evaluated: false, paid_calls: 0, calls: [], observations: [], passed: false };
  const names = { database: 'loom-live-pg-' + suffix, app: 'loom-live-app-' + suffix, eino: 'loom-live-eino-' + suffix };
  const network = 'loom-live-' + suffix, label = 'weavesense.validation=agent-quality-live';
  const containers = []; let createdNetwork = false, db, adapter, model;
  const env = { ...process.env, XAI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', VERCEL: '', VITE_AUTH_ENABLED: 'false', LOOM_RUNTIME_MODE: 'test' };
  const command = (exe, args, extra = {}) => execFileSync(exe, args, { cwd: process.cwd(), env: { ...env, ...extra }, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  const docker = (...args) => command('docker', args).trim();
  const launch = (name, args) => { docker('run', '-d', '--name', name, '--label', label, '--label', 'weavesense.live-smoke=' + suffix, '--network', network, '--network-alias', name, ...args); containers.push(name); };
  try {
    const base = 'public.ecr.aws/docker/library/node:22.22.3-bookworm-slim';
    docker('image', 'inspect', base); docker('image', 'inspect', 'postgres:16-alpine');
    const bundle = readFileSync('.vercel/output/functions/__server.func/index.mjs');
    result.built_sha256 = createHash('sha256').update(bundle).digest('hex');
    writeFileSync(resolve(out, 'index.mjs'), bundle);
    cpSync('validation/agent/opencode/live-adapter-server.mjs', resolve(out, 'server.mjs'));
    cpSync('workers/agent/skills', resolve(out, 'skills'), { recursive: true });
    command('go', ['-C', 'workers/agent', 'build', '-trimpath', '-o', resolve(out, 'agent-linux'), './cmd/agent'], { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' });
    writeFileSync(resolve(out, 'Dockerfile'), `FROM ${base}\nWORKDIR /app\nCOPY index.mjs server.mjs ./\nCOPY --chmod=755 agent-linux /usr/local/bin/agent\nCOPY skills /app/skills\nUSER node\n`);
    const image = 'weavesense-live-adapter-smoke:' + suffix;
    result.image = image; result.image_id = docker('build', '--network=none', '-q', '-t', image, out);
    docker('network', 'create', '--label', label, '--label', 'weavesense.live-smoke=' + suffix, network); createdNetwork = true;
    const pgPort = await freePort(), appPort = await freePort(), goPort = await freePort(), token = 'offline-' + id;
    launch(names.database, ['-p', `127.0.0.1:${pgPort}:5432`, '-e', 'POSTGRES_PASSWORD=review-only-local', '-e', 'POSTGRES_DB=review', 'postgres:16-alpine']);
    const database = { host: '127.0.0.1', port: pgPort, user: 'postgres', password: 'review-only-local', database: 'review', container: names.database };
    await until(async () => { const c = new pg.Client(database); try { await c.connect(); return true; } finally { await c.end(); } }, 'owned postgres');
    db = new pg.Client(database); await db.connect(); await db.query(`create schema ${schema}`); await db.query(`set search_path to ${schema}`);
    const localDSN = new URL(`postgresql://127.0.0.1:${pgPort}/review`); localDSN.username = database.user; localDSN.password = database.password; localDSN.searchParams.set('options', '-c search_path=' + schema);
    command(process.execPath, ['scripts/migrate.mjs'], { DATABASE_URL: localDSN.href });
    await db.query("insert into sources(id,platform,name) values('s','rss','离线验证材料')");
    await db.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('battery','s','rss','battery','Battery 良率材料','Battery 证据：量产良率为 97%。',clock_timestamp())");
    model = http.createServer(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, 'Bearer ' + token); assert.equal(req.url, '/v1/chat/completions');
        req.setEncoding('utf8');
        let raw = ''; for await (const chunk of req) { raw += chunk; assert.ok(raw.length < 1024 * 1024); }
        const input = JSON.parse(raw), answer = fakeReply(input); assert.equal(Boolean(input.stream), false);
        result.calls.push({ role: answer.role });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'offline-' + result.calls.length, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer.content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      } catch (error) { result.model_error = String(error); res.writeHead(500); res.end('fixture_rejected'); }
    });
    await new Promise(r => model.listen(0, '127.0.0.1', r));
    const shared = { AGENT_MODEL_NAME: 'offline-model', AGENT_SERVICE_TOKEN: token, AGENT_DATA_TOKEN: token, AGENT_EXECUTE_TIMEOUT_MS: '120000', AGENT_WORKER_ENABLED: 'true' };
    const flags = values => Object.entries(values).flatMap(([key, value]) => ['-e', key + '=' + value]);
    launch(names.eino, ['-p', `127.0.0.1:${goPort}:8791`, ...flags({ ...shared, AGENT_LISTEN_ADDR: '0.0.0.0:8791', AGENT_DATA_URL: `http://${names.app}:8080/api/internal/agent-data`, AGENT_SKILLS_DIR: '/app/skills', AGENT_MODEL_BASE_URL: `http://host.docker.internal:${model.address().port}/v1`, AGENT_MODEL_API_KEY: token, AGENT_MODEL_TIMEOUT_MS: '30000' }), image, '/usr/local/bin/agent']);
    const readyURL = `http://127.0.0.1:${goPort}/readyz`;
    const ready = await until(async () => { const r = await fetch(readyURL); return r.ok && r.json(); }, 'Eino ready');
    assert.match(ready.skill_snapshot_digest, /^[a-f0-9]{64}$/); assert.equal(result.calls.length, 0);
    const containerDSN = new URL(localDSN); containerDSN.hostname = names.database; containerDSN.port = '5432';
    launch(names.app, ['-p', `127.0.0.1:${appPort}:8080`, ...flags({ ...shared, DATABASE_URL: containerDSN.href, AI_ENGINE: 'legacy', AUTO_ANALYZE: 'false', EXTRACT_AUTO: 'false', AGENT_ASYNC_RESEARCH_ENABLED: 'true', AGENT_RESEARCH_RUNTIME: 'eino', AGENT_RESEARCH_REVIEW: 'enforce', AGENT_OPENCODE_WORKER_ENABLED: 'false', AGENT_SERVICE_URL: `http://${names.eino}:8791`, AGENT_SKILL_SNAPSHOT_DIGEST: ready.skill_snapshot_digest, LOOM_RUNTIME_MODE: 'test' }), image, 'node', '/app/server.mjs']);
    const appURL = `http://127.0.0.1:${appPort}/`;
    await until(async () => (await fetch(new URL('knowledge', appURL))).ok, 'built app');
    const databaseFile = resolve(out, 'database.local.json'); writeFileSync(databaseFile, JSON.stringify(database));
    const config = { arms: ['A', 'B'], experiment_id: id, database_file: databaseFile, schema, containers: names, services: { app_url: appURL, eino_ready_url: readyURL },
      model_profile: { model: 'offline-model', model_revision: 'offline-model', input_per_million: 0.01, output_per_million: 0.02, price_version: 'offline-smoke-v1' },
      skill_snapshot_digest: ready.skill_snapshot_digest, execution_timeout_ms: 120000, queue_ttl_ms: 30000, experiment_budget_cny: 1, repetitions: 1, validation_only: true };
    const cases = [{ id: 'battery', question: 'Battery 发布', source_ids: ['battery'] }];
    adapter = await createLiveAdapter(config, null);
    const prepared = await adapter.prepare(config, cases);
    assert.equal(prepared.model_source, 'unit_test_fake'); assert.equal(prepared.trusted_ledger, true);
    result.prepared = prepared;
    for (const task of livePlan(config, cases, 1).filter(t => t.comparison === 'same_producer_budget')) {
      const row = await adapter.execute(task, config, prepared); result.observations.push({ group: task.group, ...row });
      assert.equal(row.status, 'succeeded'); assert.equal(row.condition_verified, true); assert.equal(row.duplicate_execution, false);
      assert.equal(row.candidate.content, 'Battery 材料记载量产良率为 97%。'); assert.equal(row.reservation_state, 'settled');
      assert.ok(row.model_calls.length > 0); assert.ok(row.model_calls.every(c => c.state === 'completed' && Number(c.input_tokens) === 100 && Number(c.output_tokens) === 20));
      assert.equal(row.model_calls.filter(c => c.role === 'reviewer').length, task.group === 'B' ? 1 : 0);
      if (task.group === 'B') { assert.equal(row.review_valid, true); assert.equal(row.review_blocked, false); }
      assert.ok(Math.abs(row.actual_cost_cny - row.model_calls.length * 0.0000014) < 1e-12);
      assert.equal((await db.query('select count(*)::int as n from knowledge_notes where run_id=$1', [row.run_id])).rows[0].n, 1);
    }
    assert.equal(result.calls.length, result.observations.reduce((n, r) => n + r.model_calls.length, 0));
    assert.equal(result.model_error, undefined); result.passed = true;
  } finally {
    if (adapter) await adapter.close(); if (db) await db.end();
    for (const name of containers.reverse()) {
      try { writeFileSync(resolve(out, name + '.log'), docker('logs', name)); } catch { /* capture is best effort */ }
      docker('rm', '-f', '-v', name);
    }
    if (createdNetwork) docker('network', 'rm', network);
    if (model) await new Promise(r => model.close(r));
    result.cleaned = containers.every(name => !docker('ps', '-aq', '--filter', 'name=^' + name + '$'));
    writeFileSync(resolve(out, 'verdict.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ out, passed: result.passed, cleaned: result.cleaned, fake_calls: result.calls.length, paid_calls: 0 }));
  }
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assert.deepEqual(process.argv.slice(2), ['--run'], 'explicit --run required');
  await runLiveAdapterSmoke();
}
