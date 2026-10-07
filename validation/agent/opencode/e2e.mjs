#!/usr/bin/env node
// Explicit --run is required: importing / --check never starts processes or calls models.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';

const checkIds = ['support', 'scope', 'conflicts', 'source_independence', 'uncertainty'];
const correct = 'Battery 材料记载量产良率为 97%。';
const incorrect = '本材料证明所有产线良率均为 100%。';

export function fakeReply(body) {
  assert.equal(body.model, 'offline-model');
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 1800);
  const messages = body.messages ?? [];
  const reviewer = messages[0]?.content?.startsWith('Independently review the candidate');
  if (reviewer) {
    assert.deepEqual(messages.map(m => m.role), ['system', 'user'], 'independent reviewer receives no producer conversation');
    assert.ok(!body.tools?.length, 'reviewer may not use tools');
    const input = JSON.parse(messages[1].content), blocked = input.question.includes('审核阻断');
    assert.equal(input.candidate.content, blocked ? incorrect : correct);
    assert.ok(input.evidence.length > 0, 'review requires real evidence from the app');
    for (const name of ['candidate_digest', 'evidence_digest', 'policy_digest']) assert.match(input[name], /^[a-f0-9]{64}$/);
    return { role: 'reviewer', content: { schema_version: 1, run_id: input.run_id,
      candidate_digest: input.candidate_digest, evidence_digest: input.evidence_digest, policy_digest: input.policy_digest,
      checks: checkIds.map(id => ({ id, status: blocked && id === 'support' ? 'fail' : 'pass' })),
      findings: blocked ? [{ code: 'unsupported_certainty', severity: 'blocking', claim: incorrect,
        evidence_ids: [input.evidence[0].evidence_id], reason: '材料只记载 97%，不支持所有产线达到 100%。', suggestion: '限制结论到材料中的数值与范围。' }] : [] } };
  }
  const textOf = m => typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? '').join('\n') : '';
  const prompt = messages.map(textOf).join('\n');
  if (body.stream) {
    const supplied = messages.map(textOf).find(text => text.includes('Supplied data: '));
    assert.ok(supplied, 'native runtime must receive the actual host research input');
    const input = JSON.parse(supplied.slice(supplied.indexOf('Supplied data: ') + 'Supplied data: '.length));
    assert.ok(input.sources?.length, 'native producer requires retrieved host evidence');
    const count = messages.filter(m => m.role === 'tool').length;
    const tool = count === 0 ? ['corpus_search_items', { query: 'Battery' }] : count === 1 ? ['corpus_get_item', { item_id: 'battery' }] : null;
    return { role: 'producer', hold: input.question.includes('运行取消'), ...(tool ? { toolCall: { id: `fixture-tool-${count}`, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } } } : {}),
      content: { content: input.question.includes('审核阻断') ? incorrect : correct,
        citations: [{ evidence_id: input.sources[0].evidence_id, quote: input.sources[0].text }], insufficient_evidence: false, coverage: 'full', warnings: [] } };
  }
  const evidence = /evidence_id=([^\s]+)[^\n]*\n[^\n]*\n([^\n]+)/.exec(prompt);
  assert.ok(evidence, 'producer must receive a real retrieved evidence receipt');
  return { role: 'producer', hold: prompt.includes('运行取消'), content: {
    content: prompt.includes('审核阻断') ? incorrect : correct,
    citations: [{ evidence_id: evidence[1], quote: evidence[2] }], insufficient_evidence: false } };
}

export function checkFixtures() {
  const input = { run_id: randomUUID(), question: 'Battery 审核阻断', candidate: { content: incorrect }, evidence: [{ evidence_id: 'item:battery' }],
    candidate_digest: 'a'.repeat(64), evidence_digest: 'b'.repeat(64), policy_digest: 'c'.repeat(64) };
  const review = { model: 'offline-model', max_tokens: 1800, messages: [{ role: 'system', content: 'Independently review the candidate' }, { role: 'user', content: JSON.stringify(input) }] };
  const blocked = fakeReply(review);
  assert.equal(blocked.content.checks[0].status, 'fail'); assert.equal(blocked.content.findings[0].severity, 'blocking');
  input.question = 'Battery 发布'; input.candidate.content = correct; review.messages[1].content = JSON.stringify(input);
  assert.equal(fakeReply(review).content.findings.length, 0);
  assert.throws(() => fakeReply({ ...review, tools: [{}] }), /reviewer may not use tools/);
  const producer = fakeReply({ model: 'offline-model', max_tokens: 1800, messages: [{ role: 'user', content: 'Question: Battery\n#1 evidence_id=item:battery coverage=full item_id=battery\nBattery\n量产良率为 97%。' }] });
  assert.equal(producer.content.citations[0].quote, '量产良率为 97%。');
  assert.throws(() => fakeReply({ model: 'offline-model', max_tokens: 1800, messages: [] }), /real retrieved evidence/);
  return { ok: true, checks: 5, browser: 'not_run', runtime: 'not_run', model: 'local authored fixtures only' };
}

const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, name, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(100); }
  throw Error('timeout: ' + name);
}
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}
async function body(req) {
  req.setEncoding('utf8');
  let text = ''; for await (const chunk of req) { text += chunk; assert.ok(text.length <= 1024 * 1024); }
  return JSON.parse(text || '{}');
}
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

export async function runHarness(mode = 'dev', runtime = 'eino') {
  assert.ok(['dev', 'built'].includes(mode));
  assert.ok(['eino', 'opencode'].includes(runtime));
  const tag = runtime === 'opencode' ? 'opencode-native' : 'opencode';
  const local = JSON.parse(readFileSync('.repo/opencode-validation-pg.json', 'utf8'));
  assert.equal(local.host, '127.0.0.1'); assert.equal(local.database, 'review'); assert.equal(local.user, 'postgres');
  assert.match(local.container, /^loom-opencode-validation-[a-z0-9-]+$/);
  const inspect = format => execFileSync('docker', ['inspect', local.container, '--format', format], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(inspect('{{index .Config.Labels "weavesense.validation"}}'), 'agent-opencode');
  assert.deepEqual(JSON.parse(inspect('{{json .NetworkSettings.Ports}}'))['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(local.port) }]);
  const id = randomUUID(), schema = 'oc_browser_' + id.replaceAll('-', '');
  const out = resolve('.repo', 'opencode-e2e-' + id); mkdirSync(out, { recursive: true }); mkdirSync('screenshots', { recursive: true });
  const evidence = { mode, runtime, schema, checks: [], calls: [], actions: [], screenshots: [], browser: 'not_run', model: 'local fake only' };
  const children = [], servers = [], logStreams = [];
  const containers = [], networks = [];
  const windows = process.platform === 'win32';
  let db, browser, page, heldResponse, releaseProducer, holdClaims = true;
  const common = { ...process.env, XAI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', VERCEL: '', VITE_AUTH_ENABLED: 'false', LOOM_RUNTIME_MODE: 'test' };
  function command(exe, args, env = common) { return execFileSync(exe, args, { cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  const docker = (...args) => command('docker', args).trim();
  function launch(exe, args, env, label) {
    const p = spawn(exe, args, { env: { ...common, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(resolve(out, label + '.log')); p.stdout.pipe(log); p.stderr.pipe(log); logStreams.push(log); children.push(p); return p;
  }
  function exited(process, label) {
    return new Promise((done, reject) => {
      process.once('error', reject);
      process.once('exit', code => code === 0 ? done() : reject(Error(label + '_failed: ' + code)));
    });
  }
  function stop(p) {
    if (p.exitCode !== null || p.signalCode !== null) return;
    if (windows) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else p.kill('SIGKILL');
  }
  async function serve(handler) {
    const s = http.createServer(handler); servers.push(s); await new Promise(r => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`;
  }
  async function snapshot(name) {
    const path = resolve('screenshots', `${tag}-${mode}-${name}.png`);
    await page.screenshot({ path, fullPage: true }); evidence.screenshots.push(path);
  }
  try {
    db = new pg.Client({ host: local.host, port: local.port, user: local.user, password: local.password, database: local.database }); await db.connect();
    await db.query(`create schema ${schema}`); await db.query(`set search_path to ${schema}`);
    const url = new URL(`postgresql://127.0.0.1:${local.port}/${local.database}`); url.username = local.user; url.password = local.password; url.searchParams.set('options', '-c search_path=' + schema);
    command(process.execPath, ['scripts/migrate.mjs'], { ...common, DATABASE_URL: url.href });
    await db.query("insert into sources(id,platform,name) values('s','rss','离线验证材料')");
    await db.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('battery','s','rss','battery','Battery 良率材料','Battery 证据：量产良率为 97%。',clock_timestamp())");
    const token = 'offline-' + id, appPort = await freePort(), goPort = await freePort();
    const appURL = `http://127.0.0.1:${appPort}`;
    const model = await serve(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, 'Bearer ' + token);
        const input = await body(req), answer = fakeReply(input); evidence.calls.push({ role: answer.role, held: Boolean(answer.hold), stream: Boolean(input.stream) });
        if (answer.hold) { heldResponse = true; await new Promise(r => { releaseProducer = r; }); }
        if (input.stream) {
          assert.equal(input.stream_options?.include_usage, true);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const delta = answer.toolCall ? { role: 'assistant', tool_calls: [{ index: 0, ...answer.toolCall }] } : { role: 'assistant', content: JSON.stringify(answer.content) };
          for (const [part, finish] of [[delta, null], [{}, answer.toolCall ? 'tool_calls' : 'stop']]) res.write('data: ' + JSON.stringify({ id: 'offline-native', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id: 'offline-native', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n');
          res.end('data: [DONE]\n\n'); return;
        }
        json(res, { id: 'offline-' + evidence.calls.length, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer.content) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      } catch (error) { evidence.modelError = String(error); json(res, { error: 'fixture_rejected' }, 500); }
    });
    const gateway = await serve(async (req, res) => {
      try {
        assert.equal(req.headers.authorization, 'Bearer ' + token);
        const payload = await body(req), action = payload.action;
        if (holdClaims && action === 'claim') { res.writeHead(204); res.end(); return; }
        const route = req.url.split('/').at(-1);
        assert.ok(['agent-jobs', 'agent-data', 'agent-review', 'opencode-jobs'].includes(route));
        const remote = await fetch(`${appURL}/api/internal/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(req.headers['x-agent-run-token'] ? { 'x-agent-run-token': req.headers['x-agent-run-token'] } : {}) }, body: JSON.stringify(payload) });
        evidence.actions.push({ route, action, phase: payload.phase, status: remote.status });
        const reply = await remote.text();
        if (action === 'candidate') evidence.lastCandidateEnvelopeKeys = Object.keys(payload.response ?? {});
        if (!remote.ok && action !== 'claim') (evidence.protocolFailures ??= []).push({ route, action, status: remote.status, response: reply.slice(0, 2000) });
        res.writeHead(remote.status, { 'content-type': 'application/json' }); res.end(reply);
      } catch { if (!res.destroyed) json(res, { error: 'test_gateway_unavailable' }, 503); }
    });
    const binary = resolve(out, windows ? 'agent.exe' : 'agent');
    command('go', ['-C', 'workers/agent', 'build', '-o', binary, './cmd/agent'], { ...common, CGO_ENABLED: '0', GOTOOLCHAIN: 'local' });
    launch(binary, [], { AGENT_LISTEN_ADDR: `127.0.0.1:${goPort}`, AGENT_SERVICE_TOKEN: token, AGENT_MODEL_BASE_URL: model + '/v1', AGENT_MODEL_NAME: 'offline-model', AGENT_MODEL_API_KEY: token,
      AGENT_DATA_URL: gateway + '/agent-data', AGENT_DATA_TOKEN: token, AGENT_WORKER_ENABLED: runtime === 'eino' ? 'true' : 'false', AGENT_SKILLS_DIR: resolve('workers/agent/skills'), AGENT_MCP_CONFIG: '', AGENT_MODEL_TIMEOUT_MS: '30000' }, 'worker');
    const ready = await until(async () => { try { const r = await fetch(`http://127.0.0.1:${goPort}/readyz`); return r.ok && r.json(); } catch { return false; } }, 'worker ready');
    assert.match(ready.skill_snapshot_digest, /^[a-f0-9]{64}$/); assert.equal(evidence.calls.length, 0);
    const config = resolve(out, 'model.local.json'); writeFileSync(config, JSON.stringify({ baseURL: model + '/v1', model: 'offline-model', apiKey: token }));
    const env = { DATABASE_URL: url.href, AI_ENGINE: 'legacy', AUTO_ANALYZE: 'false', EXTRACT_AUTO: 'false', AGENT_ASYNC_RESEARCH_ENABLED: 'true', AGENT_WORKER_ENABLED: 'true',
      AGENT_RESEARCH_RUNTIME: runtime, AGENT_RESEARCH_REVIEW: 'enforce', AGENT_OPENCODE_WORKER_ENABLED: runtime === 'opencode' ? 'true' : 'false', OPENCODE_WORKER_TOKEN: token, AGENT_SERVICE_URL: `http://127.0.0.1:${goPort}`, AGENT_SERVICE_TOKEN: token, AGENT_DATA_TOKEN: token,
      AGENT_MODEL_NAME: 'offline-model', AGENT_PRICE_INPUT_RMB_PER_MILLION: '0.01', AGENT_PRICE_OUTPUT_RMB_PER_MILLION: '0.02', AGENT_RESEARCH_DAILY_LIMIT: '20', AGENT_RESEARCH_DAILY_BUDGET_RMB: '20',
      AGENT_SKILL_SNAPSHOT_DIGEST: ready.skill_snapshot_digest, LOOM_MODEL_CONFIG: config, LOOM_MODEL_LOOPBACK_ONLY: 'true', LOOM_MODEL_MANAGE_ALLOWED: 'false' };
    if (runtime === 'opencode') {
      const suffix = id.slice(0, 8), label = `weavesense.fullchain=${suffix}`, image = 'weavesense-opencode-runtime:1.3.13';
      const sandbox = `loom-oc-full-sandbox-${suffix}`, trusted = `loom-oc-full-trusted-${suffix}`;
      const bridge = `loom-oc-full-bridge-${suffix}`, native = `loom-oc-full-runtime-${suffix}`, worker = `loom-oc-full-worker-${suffix}`;
      const control = 'offline-control-' + id, runtimeToken = 'offline-runtime-' + id;
      const restricted = ['--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=768m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m,uid=1000,gid=1000', '--tmpfs', '/state:rw,noexec,nosuid,size=256m,uid=1000,gid=1000'];
      const bridgeBinary = resolve(out, 'agent-bridge-linux'), workerBinary = resolve(out, 'opencode-worker-linux');
      for (const [path, target] of [[bridgeBinary, './cmd/agent-bridge'], [workerBinary, './cmd/opencode-worker']]) command('go', ['-C', 'workers/agent', 'build', '-trimpath', '-o', path, target], { ...common, CGO_ENABLED: '0', GOTOOLCHAIN: 'local', GOOS: 'linux', GOARCH: 'amd64' });
      // Build a tiny trusted test image from the installed pinned runtime base; no bind mounts or downloads.
      const dockerfile = resolve(out, 'Dockerfile.trusted');
      writeFileSync(dockerfile, `FROM ${image}\nCOPY --chmod=755 agent-bridge-linux /usr/local/bin/agent-bridge\nCOPY --chmod=755 opencode-worker-linux /usr/local/bin/opencode-worker\n`);
      const trustedImage = `weavesense-opencode-fullchain:${suffix}`;
      docker('build', '--network=none', '-f', dockerfile, '-t', trustedImage, out);
      docker('network', 'create', '--label', label, '--internal', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', sandbox); networks.push(sandbox);
      docker('network', 'create', '--label', label, trusted); networks.push(trusted);
      const host = value => value.replace('127.0.0.1', 'host.docker.internal');
      docker('run', '-d', '--label', label, '--name', bridge, '--network', trusted, ...restricted,
        '-e', `OPENCODE_BRIDGE_CONTROL_TOKEN=${control}`, '-e', `AGENT_DATA_URL=${host(gateway)}/agent-data`, '-e', `AGENT_DATA_TOKEN=${token}`,
        '-e', `AGENT_MODEL_BASE_URL=${host(model)}/v1`, '-e', `AGENT_MODEL_API_KEY=${token}`, '-e', 'AGENT_MODEL_NAME=offline-model', trustedImage, '/usr/local/bin/agent-bridge'); containers.push(bridge);
      docker('network', 'connect', '--alias', 'agent-bridge', sandbox, bridge);
      docker('run', '-d', '--label', label, '--name', native, '--network', sandbox, ...restricted,
        '-e', `OPENCODE_RUNTIME_TOKEN=${runtimeToken}`, '-e', 'OPENCODE_BRIDGE_URL=http://agent-bridge:8792', '-e', 'OPENCODE_MODEL_NAME=offline-model', image, 'node', '/opt/runtime/server.mjs'); containers.push(native);
      docker('create', '--label', label, '--name', worker, '--network', trusted, ...restricted,
        '-e', `OPENCODE_JOBS_URL=${host(gateway)}/opencode-jobs`, '-e', `OPENCODE_WORKER_TOKEN=${token}`,
        '-e', `OPENCODE_RUNTIME_URL=http://${native}:4097`, '-e', `OPENCODE_RUNTIME_TOKEN=${runtimeToken}`, '-e', 'OPENCODE_BRIDGE_URL=http://agent-bridge:8792',
        '-e', `OPENCODE_BRIDGE_CONTROL_TOKEN=${control}`, '-e', `OPENCODE_REVIEW_URL=http://host.docker.internal:${goPort}/v1/review`, '-e', `AGENT_SERVICE_TOKEN=${token}`,
        '-e', 'OPENCODE_MODEL_NAME=offline-model', trustedImage, '/usr/local/bin/opencode-worker'); containers.push(worker);
      docker('network', 'connect', sandbox, worker); docker('start', worker);
      const inspected = JSON.parse(docker('inspect', native))[0];
      assert.equal(inspected.HostConfig.Binds, null); assert.deepEqual(inspected.HostConfig.PortBindings, {});
      assert.deepEqual(Object.keys(inspected.NetworkSettings.Networks), [sandbox]);
      assert.ok(!inspected.Config.Env.some(v => /^(AGENT_MODEL_API_KEY|AGENT_DATA_TOKEN|OPENCODE_BRIDGE_CONTROL_TOKEN)=/.test(v)));
      const probes = [['bridge', 'agent-bridge', 8792], ['vendor_bypass', 'host.docker.internal', Number(new URL(model).port)], ['app_bypass', 'host.docker.internal', appPort], ['public_egress', '1.1.1.1', 80]];
      const networkChecks = JSON.parse(docker('exec', native, 'node', '--input-type=module', '-e', `import net from 'node:net';const checks=${JSON.stringify(probes)};console.log(JSON.stringify(await Promise.all(checks.map(([name,host,port])=>new Promise(resolve=>{const s=net.connect({host,port});let done=false;const end=allowed=>{if(done)return;done=true;s.destroy();resolve({name,allowed})};s.once('connect',()=>end(true));s.once('error',()=>end(false));s.setTimeout(1200,()=>end(false))})))));`));
      assert.deepEqual(networkChecks.map(check => check.allowed), [true, false, false, false]);
      evidence.native = { runtimeImage: JSON.parse(docker('image', 'inspect', image))[0].Id, label, sandbox, trusted, networkChecks, noRuntimeHostBindsOrPortsOrSupplierKeys: true };
    }
    if (mode === 'built') {
      const build = windows ? launch('cmd.exe', ['/d', '/s', '/c', 'npm run build'], env, 'build') : launch('npm', ['run', 'build'], env, 'build');
      await exited(build, 'isolated_build');
      evidence.checks.push('npm run build succeeded with migration DSN restricted to this disposable schema');
    }
    const script = mode === 'built' ? 'preview' : 'dev';
    if (windows) launch('cmd.exe', ['/d', '/s', '/c', `npm run ${script} -- --host 127.0.0.1 --port ${appPort} --strictPort`], env, 'app');
    else launch('npm', ['run', script, '--', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], env, 'app');
    await until(async () => { try { return (await fetch(appURL + '/knowledge')).ok; } catch { return false; } }, 'app ready', 90000);
    const channel = process.env.PLAYWRIGHT_CHANNEL;
    if (channel) assert.ok(['msedge', 'chrome'].includes(channel), 'unsupported_browser_channel');
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    if (mode === 'dev') {
      // Vite may serve HTML before the first dependency optimization completes.
      // Preserve warmup errors separately; all assertions use a fresh context below.
      const warm = await browser.newPage(), warmup = [];
      warm.on('pageerror', error => warmup.push(String(error)));
      await warm.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
      let hydrated = false;
      for (let attempt = 0; attempt < 3 && !hydrated; attempt++) {
        await warm.goto(appURL + '/knowledge');
        try { await until(() => warm.getByRole('button', { name: '深入研究', exact: true }).isEnabled(), 'development hydration warmup', 15000); hydrated = true; }
        catch (error) { warmup.push(String(error)); }
      }
      evidence.developmentWarmup = warmup; await warm.close();
      assert.ok(hydrated, 'development hydration did not stabilize');
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.goto(appURL + '/knowledge'); await page.getByLabel('向矩阵提问', { exact: true }).waitFor();
    assert.equal(evidence.calls.length, 0, 'page load never calls a model');
    async function submit(question) {
      holdClaims = true;
      const previous = page.url();
      await page.getByRole('button', { name: '深入研究', exact: true }).click();
      await page.getByLabel('向矩阵提问', { exact: true }).fill(question);
      await page.getByRole('button', { name: '提问', exact: true }).click();
      await page.waitForURL(url => url.searchParams.has('job') && url.href !== previous);
      const jobId = new URL(page.url()).searchParams.get('job');
      await until(async () => (await db.query("select 1 from ai_jobs where id=$1 and status='queued'", [jobId])).rows.length, 'queued');
      return jobId;
    }
    async function result(jobId, expected) {
      const row = await until(async () => {
        const r = (await db.query('select j.*,v.state as review_state,v.report_json,n.id as note_id from ai_jobs j left join ai_research_reviews v on v.run_id=j.run_id left join knowledge_notes n on n.run_id=j.run_id where j.id=$1', [jobId])).rows[0];
        return r && !['queued', 'running'].includes(r.status) && r;
      }, 'terminal ' + expected);
      assert.equal(row.status, expected, row.error_code); await page.reload(); await page.getByLabel('深入研究进度').waitFor(); return row;
    }
    const publishedId = await submit('Battery 审核发布测试'); await snapshot('queued-desktop'); holdClaims = false;
    const published = await result(publishedId, 'succeeded'); assert.ok(published.note_id); assert.equal(published.review_state, 'completed');
    const ledger = (await db.query('select role,state,input_tokens::int,output_tokens::int from ai_model_calls where run_id=$1 order by role', [published.run_id])).rows;
    const observedProducers = evidence.calls.filter(call => call.role === 'producer').length;
    assert.ok(observedProducers >= 1 && observedProducers <= 6);
    assert.deepEqual(ledger, [...Array.from({ length: observedProducers }, () => ({ role: 'producer', state: 'completed', input_tokens: 100, output_tokens: 20 })),
      { role: 'reviewer', state: 'completed', input_tokens: 100, output_tokens: 20 }]);
    const reservation = (await db.query('select status,actual_rmb from ai_budget_reservations where job_id=$1', [publishedId])).rows[0];
    assert.equal(reservation.status, 'settled');
    assert.ok(Math.abs(Number(reservation.actual_rmb) - ledger.length * (100 * 0.01 + 20 * 0.02) / 1_000_000) < 1e-12);
    assert.equal((await db.query('select 1 from ai_research_candidates where run_id=$1', [published.run_id])).rows.length, 1);
    evidence.publishedFacts = { ledger, reservation, candidateCount: 1, noteCount: 1 };
    if (runtime === 'opencode') {
      const runFacts = (await db.query('select provider,tool_calls,response_json from ai_runs where id=$1', [published.run_id])).rows[0];
      assert.equal(runFacts.provider, 'opencode');
      assert.equal((await db.query('select count(*)::int as n from ai_tool_calls where run_id=$1 and state=$2', [published.run_id, 'completed'])).rows[0].n, 2);
      assert.equal(runFacts.tool_calls, 2); assert.equal(runFacts.response_json.runtime.tool_calls, 2);
      evidence.publishedFacts.toolCalls = runFacts.tool_calls;
      assert.equal((await db.query('select runtime_version from ai_runtime_bindings where run_id=$1', [published.run_id])).rows[0].runtime_version, '1.3.13');
    }
    await page.getByRole('status').filter({ hasText: '已发布' }).waitFor(); await snapshot('published-desktop');
    evidence.checks.push(`browser queued → governed ${runtime} producer → immutable candidate → independent reviewer → one published note`);
    const blockedId = await submit('Battery 审核阻断测试'); holdClaims = false;
    const blocked = await result(blockedId, 'failed'); assert.equal(blocked.error_code, 'review_blocked'); assert.equal(blocked.note_id, null); assert.equal(blocked.review_state, 'completed');
    await page.getByText(incorrect, { exact: true }).first().waitFor(); await snapshot('blocked-desktop');
    await page.setViewportSize({ width: 390, height: 844 }); await snapshot('blocked-mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    evidence.checks.push('blocking review retains visible unpublished draft and findings; mobile does not overflow');
    await page.setViewportSize({ width: 1280, height: 900 });
    const beforeCancel = evidence.calls.length, queuedCancel = await submit('Battery 排队取消测试');
    await page.getByRole('button', { name: '取消研究', exact: true }).click(); const cancelled = await result(queuedCancel, 'failed'); assert.equal(cancelled.error_code, 'cancelled'); assert.equal(evidence.calls.length, beforeCancel);
    const runningCancel = await submit('Battery 运行取消测试'); holdClaims = false; await until(() => heldResponse, 'producer paused after admission');
    await page.getByRole('button', { name: '取消研究', exact: true }).click(); await page.getByRole('status').filter({ hasText: '正在请求取消' }).waitFor(); await snapshot('cancel-requested');
    const revoked = (await db.query('select r.data_token_hash,j.payload from ai_jobs j join ai_runs r on r.id=j.run_id where j.id=$1', [runningCancel])).rows[0];
    assert.equal(revoked.data_token_hash, ''); assert.equal(revoked.payload.cancel_requested, true); releaseProducer();
    const stopped = await until(async () => (await db.query("select status from ai_jobs where id=$1 and status not in ('queued','running')", [runningCancel])).rows[0], 'worker confirms cancellation');
    assert.notEqual(stopped.status, 'succeeded'); assert.equal((await db.query('select 1 from knowledge_notes n join ai_jobs j on n.run_id=j.run_id where j.id=$1', [runningCancel])).rows.length, 0);
    evidence.checks.push('queued cancel sends no model request; running cancel revokes authority and worker terminates without publication');
    assert.equal(errors.length, 0, errors.join('\n')); assert.equal(evidence.modelError, undefined); assert.equal((await db.query('select count(*)::int as n from knowledge_notes')).rows[0].n, 1);
    const smoke = launch(process.execPath, ['validation/agent/opencode/browser-smoke.mjs', appURL + '/knowledge', `screenshots/${tag}-${mode}-smoke.png`,
      ...(mode === 'built' ? ['--baseline', 'screenshots/opencode-dev-smoke.json'] : [])], { ...env, AGENT_OFFLINE_SMOKE: 'true', LOOM_SMOKE_READY_TEXT: 'Battery 审核发布测试' }, 'browser-smoke');
    await exited(smoke, 'browser_smoke');
    const smokeResult = JSON.parse(readFileSync(`screenshots/${tag}-${mode}-smoke.json`, 'utf8'));
    if (mode === 'built') assert.equal(smokeResult.divergesFromBaseline, false, smokeResult.baselineReasons?.join('\n'));
    evidence.checks.push('project browser-smoke desktop/mobile render and console checks, plus built/dev baseline comparison');
    evidence.browser = 'passed'; evidence.ok = true;
  } catch (error) {
    evidence.ok = false; evidence.error = String(error?.stack ?? error);
    if (runtime === 'opencode') for (const name of containers) { try { writeFileSync(resolve(out, name + '.log'), docker('logs', '--tail', '100', name)); } catch { /* original test error remains authoritative */ } }
    if (page) { await snapshot('failure').catch(() => {}); evidence.failureText = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000); }
    throw error;
  } finally {
    if (releaseProducer) releaseProducer();
    if (browser) await browser.close(); children.reverse().forEach(stop);
    for (const name of containers.reverse()) docker('rm', '-f', name);
    for (const name of networks.reverse()) docker('network', 'rm', name);
    for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
    if (db) { await db.query(`drop schema if exists ${schema} cascade`); await db.end(); }
    for (const s of logStreams) s.end();
    writeFileSync(resolve(out, 'verdict.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath: resolve(out, 'verdict.json') }, null, 2));
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) console.log(JSON.stringify(checkFixtures()));
  else if (process.argv.includes('--run')) await runHarness(process.argv.includes('--built') ? 'built' : 'dev', process.argv.includes('--opencode') ? 'opencode' : 'eino');
  else throw Error('Use --check for pure fixture contracts or --run [--built] for explicit isolated integration execution.');
}
