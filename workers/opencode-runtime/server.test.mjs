import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeServer } from './server.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'weavesense-wrapper-test-'));
  const calls = []; let stopped = false;
  const runtime = new EventEmitter();
  runtime.pid = 999999; runtime.exitCode = null;
  runtime.stdout = new EventEmitter(); runtime.stderr = new EventEmitter();
  const app = createRuntimeServer({ stateRoot: root, token: 'control-fixture-token', bridgeURL: 'http://bridge:8792', modelName: 'fixture',
    approvedSkillRoot: fileURLToPath(new URL('../agent/skills/', import.meta.url)),
    spawnRuntime(binary, args, config) {
      // Each run gets a fresh child: the fixture reuses one EventEmitter for
      // exit events, but exitCode must reset per spawned instance.
      calls.push({ binary, args, config });
      runtime.exitCode = null;
      return runtime;
    },
    fetchRuntime: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(url.endsWith('/global/health') ? { healthy: true, version: '1.3.13' } : url.endsWith('/session') ? { id: 'ses_fixture' } : true), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    terminateTree: async () => { stopped = true; runtime.exitCode = 0; runtime.emit('exit', 0); return true; }, ...options });
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, method = 'GET', body, auth = true) {
    const res = await fetch(url + route, { method, headers: { ...(auth ? { authorization: 'Bearer control-fixture-token' } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  }
  const prepare = async () => request('/prepare', 'POST', { run_id: 'run-fixture', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant-fixture' });
  return { app, calls, request, prepare, root, stopped: () => stopped };
}

test('prepare binds one slot to wrapper-generated epoch and rejects host path/command options', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/prepare', 'POST', { run_id: 'run-fixture', grant: 'opaque-run-grant-fixture', claim_token: 'claim-fixture-token', cwd: '/etc' })).status, 400);
  assert.equal((await f.request('/prepare', 'POST', { run_id: '../escape', grant: 'opaque-run-grant-fixture', claim_token: 'claim-fixture-token' })).status, 400);
  const prepared = await f.prepare(); assert.equal(prepared.status, 200);
  assert.match(prepared.body.epoch, /^[0-9a-f-]{36}$/);
  assert.equal((await f.prepare()).body.instance_id, prepared.body.instance_id);
  assert.equal((await f.request('/prepare', 'POST', { run_id: 'other-run', grant: 'opaque-run-grant-fixture', claim_token: 'claim-fixture-token' })).status, 409);
  const status = await f.request(`/status?instance_id=${prepared.body.instance_id}&epoch=${prepared.body.epoch}`);
  assert.equal(JSON.stringify(status).includes('opaque-run-grant'), false);
});

test('start uses only fixed binary args, fresh HOME/XDG and no inherited control/provider credentials', async (t) => {
  const f = await fixture(t); const { body: prepared } = await f.prepare();
  assert.equal((await f.request('/start', 'POST', prepared)).status, 400, 'only identity fields are valid start input');
  const identity = { instance_id: prepared.instance_id, epoch: prepared.epoch };
  assert.equal((await f.request('/start', 'POST', identity)).status, 200);
  const spawned = f.calls.find((c) => c.binary);
  assert.equal(spawned.binary, '/usr/local/bin/opencode');
  assert.deepEqual(spawned.args, ['serve', '--hostname', '127.0.0.1', '--port', '4096']);
  assert.ok(spawned.config.cwd.startsWith(f.root));
  assert.ok(spawned.config.env.HOME.startsWith(f.root));
  assert.equal(spawned.config.env.OPENCODE_RUNTIME_TOKEN, undefined);
  assert.equal(spawned.config.env.OPENAI_API_KEY, undefined);
  assert.equal(spawned.config.detached, true);
  assert.equal((await f.request('/start', 'POST', identity)).status, 200);
  assert.equal(f.calls.filter((c) => c.binary).length, 1);
});

test('unauthenticated, stale epochs and non-research runtime routes cannot forward', async (t) => {
  const f = await fixture(t); const { body: p } = await f.prepare();
  const identity = { instance_id: p.instance_id, epoch: p.epoch };
  assert.equal((await f.request('/health', 'GET', undefined, false)).status, 401);
  await f.request('/start', 'POST', identity);
  for (const target of ['/file/content?path=/etc/passwd', '/config', '/auth/openai', '/session/ses_fixture/shell', '/session/ses_fixture/message?directory=/etc', 'http://evil/', '/global/upgrade', '/event?directory=/etc']) {
    assert.equal((await f.request('/forward', 'POST', { ...identity, method: 'GET', path: target })).status, 400, target);
  }
  assert.equal((await f.request('/forward', 'POST', { ...identity, epoch: 'stale', method: 'POST', path: '/session', body: { title: 'fixture' } })).status, 409);
  assert.equal((await f.request('/forward', 'POST', { ...identity, method: 'POST', path: '/session', body: { permissions: [{ permission: '*', action: 'allow' }] } })).status, 400);
  assert.equal((await f.request('/forward', 'POST', { ...identity, method: 'POST', path: '/session/ses_fixture/prompt_async', body: { parts: [{ type: 'file', url: 'file:///etc/passwd' }] } })).status, 400);
});

test('stop confirms full process-tree termination before releasing the slot', async (t) => {
  let confirmed = false;
  const f = await fixture(t, { terminateTree: async () => confirmed });
  const { body: p } = await f.prepare(); const identity = { instance_id: p.instance_id, epoch: p.epoch };
  await f.request('/start', 'POST', identity);
  assert.equal((await f.request('/stop', 'POST', identity)).status, 503);
  assert.equal((await f.request('/prepare', 'POST', { run_id: 'next-fixture', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant-fixture' })).status, 409);
  confirmed = true;
  assert.equal((await f.request('/stop', 'POST', identity)).status, 200);
  const replay = await f.request('/stop', 'POST', identity);
  assert.equal(replay.status, 200); assert.equal(replay.body.stopped, true);
  const stoppedStatus = await f.request(`/status?instance_id=${p.instance_id}&epoch=${p.epoch}`);
  assert.equal(stoppedStatus.body.status, 'stopped'); assert.equal(stoppedStatus.body.process_running, false);
  assert.equal((await f.request('/prepare', 'POST', { run_id: 'next-fixture', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant-fixture' })).status, 200);
  assert.equal((await f.request('/stop', 'POST', identity)).status, 409);
});

test('one session and one prompt are bound to the active run and enforce fixed model', async (t) => {
  const f = await fixture(t); const { body: p } = await f.prepare(); const identity = { instance_id: p.instance_id, epoch: p.epoch };
  await f.request('/start', 'POST', identity);
  const create = { ...identity, method: 'POST', path: '/session', body: { title: 'Research' } };
  assert.equal((await f.request('/forward', 'POST', create)).body.id, 'ses_fixture');
  assert.equal((await f.request('/forward', 'POST', create)).body.id, 'ses_fixture');
  assert.equal(f.calls.filter((c) => c.url?.endsWith('/session')).length, 1);
  const prompt = { ...identity, method: 'POST', path: '/session/ses_fixture/prompt_async', body: { parts: [{ type: 'text', text: 'Research approved sources.' }] } };
  const res = await fetch(`http://127.0.0.1:${f.app.server.address().port}/forward`, { method: 'POST', headers: { authorization: 'Bearer control-fixture-token', 'content-type': 'application/json' }, body: JSON.stringify(prompt) });
  assert.equal(res.status, 204);
  assert.equal((await f.request('/forward', 'POST', prompt)).status, 409);
  const forwarded = f.calls.find((c) => c.url?.endsWith('/prompt_async'));
  assert.deepEqual(JSON.parse(forwarded.options.body).model, { providerID: 'bridge', modelID: 'fixture' });
  assert.equal((await f.request('/forward', 'POST', { ...identity, method: 'GET', path: '/session/ses_other/message' })).status, 400);
  const status = await f.request(`/status?instance_id=${p.instance_id}&epoch=${p.epoch}`);
  assert.equal(status.body.dispatch_state, 'submitted');
});

test('uncertain prompt transport never permits resubmission', async (t) => {
  const f = await fixture(t, { fetchRuntime: async (url) => {
    if (url.endsWith('/prompt_async')) throw new Error('lost ACK');
    return new Response(JSON.stringify(url.endsWith('/global/health') ? { healthy: true, version: '1.3.13' } : { id: 'ses_fixture' }), { headers: { 'content-type': 'application/json' } });
  } });
  const { body: p } = await f.prepare(); const identity = { instance_id: p.instance_id, epoch: p.epoch };
  await f.request('/start', 'POST', identity);
  await f.request('/forward', 'POST', { ...identity, method: 'POST', path: '/session', body: {} });
  const prompt = { ...identity, method: 'POST', path: '/session/ses_fixture/prompt_async', body: { parts: [{ type: 'text', text: 'Research.' }] } };
  assert.equal((await f.request('/forward', 'POST', prompt)).status, 502);
  assert.equal((await f.request(`/status?instance_id=${p.instance_id}&epoch=${p.epoch}`)).body.dispatch_state, 'dispatch_unknown');
  assert.equal((await f.request('/forward', 'POST', prompt)).status, 409);
});

test('missing approved Skill fails before runtime or model execution', async (t) => {
  const f = await fixture(t, { approvedSkillRoot: '/missing-approved-skills' });
  const prepared = await f.prepare(); assert.equal(prepared.status, 503); assert.equal(prepared.body.error, 'required_skill_missing');
  assert.equal(f.calls.length, 0);
});

test('newline credentials are rejected before header construction', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/prepare', 'POST', { run_id: 'run-fixture', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant\nfixture' })).status, 400);
});

test('concurrent session creation cannot create a second remote session', async (t) => {
  let enter, release, remoteSessions = 0;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { fetchRuntime: async (url) => {
    if (url.endsWith('/session')) { remoteSessions++; enter(); await gate; }
    return new Response(JSON.stringify(url.endsWith('/global/health') ? { healthy: true, version: '1.3.13' } : { id: 'ses_fixture' }), { headers: { 'content-type': 'application/json' } });
  } });
  const { body: p } = await f.prepare(); const identity = { instance_id: p.instance_id, epoch: p.epoch };
  await f.request('/start', 'POST', identity);
  const payload = { ...identity, method: 'POST', path: '/session', body: {} };
  const first = f.request('/forward', 'POST', payload);
  await entered;
  assert.equal((await f.request('/forward', 'POST', payload)).status, 409);
  release(); assert.equal((await first).status, 200); assert.equal(remoteSessions, 1);
});

test('stable redacted config binds all approved raw skills and caps model output', async (t) => {
  const f = await fixture(t); const first = (await f.prepare()).body;
  const versions = {};
  for (const name of ['briefing-writing', 'cross-source-check', 'industry-analysis']) {
    const rel = `${name}/SKILL.md`;
    const raw = await readFile(new URL(`../agent/skills/${rel}`, import.meta.url));
    versions[name] = createHash('sha256').update(rel).update(raw).digest('hex');
  }
  const digest = createHash('sha256').update(Object.entries(versions).map(([name, version]) => `${name}\0${version}\n`).join('')).digest('hex');
  assert.deepEqual(first.skill_versions, versions); assert.equal(first.skill_snapshot_digest, digest);
  await f.request('/start', 'POST', {instance_id:first.instance_id,epoch:first.epoch});
  const spawned = f.calls.find(c=>c.binary);
  const config = JSON.parse(await readFile(spawned.config.env.OPENCODE_CONFIG, 'utf8'));
  assert.equal(config.provider.bridge.models.fixture.limit.output, 1800);
  await f.request('/stop', 'POST', {instance_id:first.instance_id,epoch:first.epoch});
  const second = (await f.prepare()).body;
  assert.equal(second.config_digest, first.config_digest);
});

// --- Task 8: assistant profile (plan §4.3) ---------------------------------

test('profile defaults to research; assistant profile renders its own skill and tools', async (t) => {
  const f = await fixture(t);
  // Omitted profile stays strictly research (echoed explicitly in summary).
  const research = (await f.prepare()).body;
  assert.equal(research.profile, 'research');
  await f.request('/stop', 'POST', { instance_id: research.instance_id, epoch: research.epoch });
  // Assistant profile prepares with the project-assistant skill only.
  const assistant = (await f.request('/prepare', 'POST', { run_id: 'run-assistant', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant-fixture', profile: 'assistant' })).body;
  assert.equal(assistant.profile, 'assistant');
  assert.deepEqual(Object.keys(assistant.skill_versions), ['project-assistant']);
  await f.request('/start', 'POST', { instance_id: assistant.instance_id, epoch: assistant.epoch });
  // The spawn call is the second binary entry (first was the research start).
  const spawned = f.calls.filter((c) => c.binary).pop();
  const config = JSON.parse(await readFile(spawned.config.env.OPENCODE_CONFIG, 'utf8'));
  assert.equal(config.default_agent, 'assistant');
  assert.equal(config.permission['*'], 'deny');
  assert.equal(config.permission['corpus:search_items'], 'allow', 'assistant allows both key spellings');
  assert.ok(config.permission['corpus_project_overview'] === 'allow', 'assistant read tools allowed (underscore keying)');
  assert.ok(config.permission['corpus:project_overview'] === 'allow', 'assistant read tools allowed (colon keying)');
  assert.equal(config.permission.skill['project-assistant'], 'allow');
  await f.request('/stop', 'POST', { instance_id: assistant.instance_id, epoch: assistant.epoch });
});

test('unknown profiles are refused before any runtime work', async (t) => {
  const f = await fixture(t);
  const res = await f.request('/prepare', 'POST', { run_id: 'run-x', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant-fixture', profile: 'admin' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('research instance cannot dispatch with the assistant agent and vice versa', async (t) => {
  const f = await fixture(t);
  const { body: p } = await f.prepare();
  const identity = { instance_id: p.instance_id, epoch: p.epoch };
  await f.request('/start', 'POST', identity);
  await f.request('/forward', 'POST', { ...identity, method: 'POST', path: '/session', body: {} });
  const prompt = { ...identity, method: 'POST', path: '/session/ses_fixture/prompt_async', body: { parts: [{ type: 'text', text: 'Hi' }], agent: 'assistant' } };
  assert.equal((await f.request('/forward', 'POST', prompt)).status, 400, 'research profile rejects assistant agent');
  await f.request('/stop', 'POST', identity);
  // Assistant profile rejects the research agent. (The prior dispatch already
  // consumed the one-shot slot, so the fresh run below uses its own slot.)
  const a = (await f.request('/prepare', 'POST', { run_id: 'run-assistant2', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant-fixture', profile: 'assistant' })).body;
  const aid = { instance_id: a.instance_id, epoch: a.epoch };
  await f.request('/start', 'POST', aid);
  await f.request('/forward', 'POST', { ...aid, method: 'POST', path: '/session', body: {} });
  const rprompt = { ...aid, method: 'POST', path: '/session/ses_fixture/prompt_async', body: { parts: [{ type: 'text', text: 'Hi' }], agent: 'research' } };
  assert.equal((await f.request('/forward', 'POST', rprompt)).status, 400, 'assistant profile rejects research agent');
});

test('assistant skill digest covers its own manifest only', async (t) => {
  const f = await fixture(t);
  const a = (await f.request('/prepare', 'POST', { run_id: 'run-assistant3', claim_token: 'claim-fixture-token', grant: 'opaque-run-grant-fixture', profile: 'assistant' })).body;
  const rel = 'project-assistant/SKILL.md';
  const raw = await readFile(new URL(`../agent/skills/${rel}`, import.meta.url));
  const version = createHash('sha256').update(rel).update(raw).digest('hex');
  assert.equal(a.skill_versions['project-assistant'], version);
  assert.equal(a.skill_snapshot_digest, createHash('sha256').update(`project-assistant\0${version}\n`).digest('hex'));
});
