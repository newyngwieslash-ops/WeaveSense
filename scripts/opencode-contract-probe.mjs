import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = fileURLToPath(new URL('../validation/agent/opencode/', import.meta.url));
export const digest = (input) => createHash('sha256').update(input).digest('hex');

// Whitelist instead of inheriting provider keys, login state or runtime flags.
export function isolatedEnvironment(root, port, config, parent = process.env) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (parent[name]) env[name] = parent[name];
  }
  return { ...env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'home', 'roaming'), LOCALAPPDATA: path.join(root, 'home', 'local'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    OPENCODE_CONFIG: config, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
    OPENCODE_SERVER_PASSWORD: 'offline-probe-password', OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_PROBE_PORT: String(port) };
}

export async function resolveBinary(override = process.env.OPENCODE_PROBE_BINARY) {
  if (override) { await access(override).catch(() => { throw new Error('runtime_missing'); }); return override; }
  if (process.platform === 'win32') {
    const base = path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', 'opencode-ai');
    for (const relative of ['bin/.opencode', 'node_modules/opencode-windows-x64/bin/opencode.exe', 'node_modules/opencode-windows-x64-baseline/bin/opencode.exe']) {
      const candidate = path.join(base, relative);
      try { await access(candidate); return candidate; } catch { /* next installed platform binary */ }
    }
  } else {
    for (const entry of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(entry, 'opencode');
      try { await access(candidate); return candidate; } catch { /* next PATH entry */ }
    }
  }
  throw new Error('runtime_missing: set OPENCODE_PROBE_BINARY to the actual executable');
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function body(req) { req.setEncoding('utf8'); let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text || '{}'); }
const json = (res, value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) { const value = await fn(); if (value) return value; await pause(100); }
  throw new Error('probe_timeout');
}

export async function probe({ binary, persist = true } = {}) {
  binary ||= await resolveBinary();
  const root = await mkdtemp(path.join(tmpdir(), 'weavesense-opencode-probe-'));
  const exchanges = [], modelRequests = [], mcpRequests = [], events = [];
  let eventController, eventTask;
  let runtime, logs = '', mode = 'research', modelStep = 0, existingLock;
  const mcp = await listen(async (req, res) => {
    if (req.method !== 'POST') return res.writeHead(405).end();
    try {
      const input = await body(req); mcpRequests.push(input);
      let result;
      if (input.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'corpus-fixture', version: '1.0.0' } };
      else if (input.method === 'tools/list') result = { tools: [{ name: 'search', description: 'Search approved fixture corpus', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }, { name: 'get_item', description: 'Read an approved corpus item', inputSchema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] } }] };
      else if (input.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ evidence_id: 'fixture-evidence-1', item_id: 'fixture-item-1', text: 'The approved corpus contains exactly one study: cotton moisture improves electrical conductivity.' }) }] };
      else if (input.id !== undefined) result = {};
      if (input.id === undefined) return res.writeHead(202).end();
      json(res, { jsonrpc: '2.0', id: input.id, result });
    } catch (error) { json(res, { error: error.message }, 400); }
  });
  const model = await listen(async (req, res) => {
    try {
      const input = await body(req); modelRequests.push({ path: req.url, body: input });
      assert.ok(modelRequests.length <= 30, 'fixture_model_request_limit');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer offline-fixture-only');
      if (mode === 'hold') { res.on('close', () => {}); return; }
      if (mode === 'error') return json(res, { error: { message: 'fixture_model_error', type: 'invalid_request_error', code: 'fixture_error' } }, 400);
      const step = modelStep++;
      const call = mode === 'denied' && step === 0
        ? { id: 'call_denied', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo denied > forbidden-marker', description: 'Forbidden write' }) } }
        : mode === 'research' && step === 0
          ? { id: 'call_corpus', type: 'function', function: { name: 'corpus_search', arguments: JSON.stringify({ query: 'cotton conductivity' }) } }
          : mode === 'research' && step === 1
            ? { id: 'call_item', type: 'function', function: { name: 'corpus_get_item', arguments: JSON.stringify({ item_id: 'fixture-item-1' }) } } : undefined;
      const content = mode === 'denied' ? 'Forbidden tool was rejected.' : JSON.stringify({ version: '1', outcome: 'succeeded', title: 'Fixture research', body: 'Cotton moisture improves electrical conductivity [1].', citations: [{ evidence_id: 'fixture-evidence-1', item_id: 'fixture-item-1' }] });
      if (!input.stream) return json(res, { id: 'fixture-chat', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: call ? null : content, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      chunk({ role: 'assistant', ...(call ? { tool_calls: [{ index: 0, ...call }] } : { content }) });
      chunk({}, call ? 'tool_calls' : 'stop');
      res.write(`data: ${JSON.stringify({ id: 'fixture-chat', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch (error) { json(res, { error: { message: error.message } }, 400); }
  });
  try {
    const binarySha256 = digest(await readFile(binary));
    try {
      existingLock = JSON.parse(await readFile(path.join(outputDir, 'runtime-lock.json'), 'utf8'));
      if (existingLock.platform === `${process.platform}-${process.arch}`) assert.equal(binarySha256, existingLock.binary_sha256, 'runtime_hash_mismatch: explicitly verify and repin a changed artifact before probing');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const portServer = await listen((_req, res) => res.end()); const port = portServer.server.address().port;
    await new Promise((resolve) => portServer.server.close(resolve));
    const cwd = path.join(root, 'work');
    for (const name of ['work', 'home', 'config', 'data', 'cache', 'state', 'temp']) await mkdir(path.join(root, name), { recursive: true });
    const template = JSON.parse(await readFile(path.join(outputDir, 'config.fixture.json'), 'utf8'));
    const config = structuredClone(template);
    config.provider.probe.options.baseURL = `${model.url}/v1`;
    config.mcp.corpus.url = `${mcp.url}/mcp`;
    const approvedSkills = [];
    const skillDir = path.join(root, 'approved-skills');
    for (const name of ['industry-analysis', 'cross-source-check']) {
      const source = fileURLToPath(new URL(`../workers/agent/skills/${name}/SKILL.md`, import.meta.url));
      const original = await readFile(source, 'utf8');
      const rendered = original.replaceAll('search_items', 'corpus_search').replaceAll('get_item', 'corpus_get_item');
      const target = path.join(skillDir, name); await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'SKILL.md'), rendered);
      approvedSkills.push({ name, source: `workers/agent/skills/${name}/SKILL.md`, original_sha256: digest(original), rendered_sha256: digest(rendered), original, rendered });
    }
    config.skills = { paths: [skillDir] };
    config.agent.research.prompt += '\n' + approvedSkills.map((s) => s.rendered).join('\n');
    // Canary global/project external skills and project config must be ignored.
    for (const parent of [cwd, path.join(root, 'home')]) {
      const canary = path.join(parent, '.agents', 'skills', 'unapproved-canary');
      await mkdir(canary, { recursive: true });
      await writeFile(path.join(canary, 'SKILL.md'), '---\nname: unapproved-canary\ndescription: Must never be discovered\n---\nUNAPPROVED_CANARY\n');
    }
    await writeFile(path.join(cwd, 'opencode.json'), JSON.stringify({ model: 'unapproved-canary/model', plugin: ['unapproved-canary'] }));
    const configPath = path.join(root, 'fixture-config.json'); await writeFile(configPath, JSON.stringify(config));
    const env = isolatedEnvironment(root, port, configPath);
    const version = spawnSync(binary, ['--version'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(version.status, 0, version.stderr); assert.equal(version.stdout.trim(), '1.3.13');
    // Export before starting serve: two Bun runtimes peak above the bounded
    // container memory allowance. Keep fixture HTTP services responsive.
    const generated = await promisify(execFile)(binary, ['generate'], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    const spec = { value: JSON.parse(generated.stdout) };
    assert.equal(spec.value.openapi, '3.1.1');
    runtime = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    runtime.stdout.on('data', (chunk) => { logs += chunk; }); runtime.stderr.on('data', (chunk) => { logs += chunk; });
    runtime.on('error', (error) => { logs += error.message; });
    const base = `http://127.0.0.1:${port}`;
    async function request(route, method = 'GET', payload, authenticate = true) {
      const response = await fetch(base + route, { method, headers: { ...(authenticate ? { authorization: `Basic ${Buffer.from('opencode:offline-probe-password').toString('base64')}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(15000) });
      const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
      exchanges.push({ route, method, request: payload, status: response.status, response: value });
      return { status: response.status, value, contentType: response.headers.get('content-type') };
    }
    const health = await until(async () => { try { const r = await request('/global/health'); return r.status === 200 && r; } catch { if (runtime.exitCode !== null) throw new Error(`runtime_exited: ${logs}`); } }, 30000);
    assert.deepEqual(health.value, { healthy: true, version: '1.3.13' });
    assert.equal((await request('/global/health', 'GET', undefined, false)).status, 401);
    const controlSpec = await request('/doc');
    assert.match(controlSpec.contentType, /json/); assert.equal(controlSpec.value.openapi, '3.1.1');
    // 1.3.13 /doc exports only control-plane routes; the official hidden
    // `generate` command invokes Server.openapi() with instance routes too.
    for (const route of ['/session', '/session/status', '/session/{sessionID}/prompt_async', '/session/{sessionID}/message', '/session/{sessionID}/abort']) assert.ok(spec.value.paths[route], `${route}: ${JSON.stringify(Object.keys(spec.value.paths))}`);
    const actualConfig = (await request('/config')).value;
    assert.deepEqual(actualConfig.permission, template.permission); assert.deepEqual(actualConfig.plugin, []);
    assert.equal(actualConfig.model, 'probe/fixture'); assert.equal(actualConfig.small_model, 'probe/fixture');
    const paths = (await request('/path')).value;
    assert.equal(path.resolve(paths.directory), path.resolve(cwd));
    for (const field of ['home', 'state', 'config']) assert.ok(path.resolve(paths[field]).startsWith(path.resolve(root) + path.sep), `${field} escaped isolation root`);
    const providers = (await request('/provider')).value;
    assert.deepEqual(providers.connected, ['probe']);
    assert.equal((await request('/mcp')).value.corpus.status, 'connected');
    const tools = (await request('/experimental/tool?provider=probe&model=fixture')).value;
    const skills = await request('/skill');
    assert.equal(skills.status, 200);
    assert.deepEqual(skills.value.map((s) => s.name).sort(), ['cross-source-check', 'industry-analysis']);
    eventController = new AbortController();
    const eventResponse = await fetch(base + '/event', { headers: { authorization: `Basic ${Buffer.from('opencode:offline-probe-password').toString('base64')}` }, signal: eventController.signal });
    assert.equal(eventResponse.status, 200); assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);
    eventTask = (async () => {
      let buffered = ''; const decoder = new TextDecoder();
      try {
        for await (const chunk of eventResponse.body) {
          buffered += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = buffered.indexOf('\n\n')) >= 0) {
            const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (data) events.push(JSON.parse(data));
          }
        }
      } catch (error) { if (!eventController.signal.aborted) throw error; }
    })();
    await until(() => events.find((event) => event.type === 'server.connected'));
    async function start(text, selected = 'research', id) {
      mode = selected; modelStep = 0;
      const session = (await request('/session', 'POST', { title: 'Offline contract fixture' })).value;
      assert.match(session.id, /^ses_/);
      const payload = { agent: 'research', model: { providerID: 'probe', modelID: 'fixture' }, ...(id ? { messageID: id } : {}), parts: [{ type: 'text', text }] };
      const submit = await request(`/session/${session.id}/prompt_async`, 'POST', payload);
      assert.equal(submit.status, 204); assert.equal(submit.value, '');
      return { session, payload };
    }
    async function terminal(id) {
      return until(async () => {
        const msgs = (await request(`/session/${id}/message`)).value;
        if (!Array.isArray(msgs)) return false;
        const last = msgs.findLast((m) => m.info.role === 'assistant');
        return last && (last.info.error || (last.info.time.completed && last.info.finish !== 'tool-calls' && last.info.finish !== 'unknown')) && msgs;
      });
    }
    const research = await start('Use corpus_search to research the approved corpus and return a structured report.');
    const messages = await terminal(research.session.id);
    assert.ok(mcpRequests.some((r) => r.method === 'tools/call' && r.params.name === 'search'), `MCP not called: ${JSON.stringify(messages)}`);
    assert.ok(mcpRequests.some((r) => r.method === 'tools/call' && r.params.name === 'get_item'));
    assert.ok(modelRequests[0].body.messages[0].content.includes('corpus_get_item'));
    assert.ok(!modelRequests.some((r) => JSON.stringify(r.body).includes('UNAPPROVED_CANARY')));
    const report = messages.flatMap((m) => m.parts).find((p) => p.type === 'text' && p.text.includes('Fixture research'));
    assert.ok(report); assert.equal(JSON.parse(report.text).title, 'Fixture research');
    const userMessage = messages.find((m) => m.info.role === 'user');
    assert.equal((await request(`/session/${research.session.id}/message/${userMessage.info.id}`)).status, 200);
    const denied = await start('Try the forbidden bash tool.', 'denied');
    const deniedMessages = await terminal(denied.session.id);
    const deniedPart = deniedMessages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.tool === 'bash');
    assert.equal(deniedPart?.state.status, 'error', JSON.stringify(deniedMessages));
    await assert.rejects(access(path.join(cwd, 'forbidden-marker')));
    assert.deepEqual((await request('/permission')).value, []);
    const failed = await start('Return an upstream error.', 'error');
    const errorMessages = await terminal(failed.session.id);
    assert.ok(errorMessages.some((m) => m.info.error?.data?.message?.includes('fixture_model_error')), JSON.stringify(errorMessages));
    const beforeHold = modelRequests.length;
    const held = await start('Hold until abort.', 'hold');
    await until(() => modelRequests.length > beforeHold);
    assert.equal((await request('/session/status')).value[held.session.id].type, 'busy');
    assert.deepEqual((await request(`/session/${held.session.id}/abort`, 'POST')).value, true);
    await until(async () => !(await request('/session/status')).value[held.session.id]);
    assert.equal((await request('/session/not-a-session/message')).status, 400);
    // Reuse a real runtime-generated ID: accepted /^msg.*/ syntax alone does
    // not guarantee chronological ordering of caller-invented IDs.
    const duplicate = await start('Message ID replay fixture.', 'final');
    const duplicateMessages = await terminal(duplicate.session.id);
    await until(async () => !(await request('/session/status')).value[duplicate.session.id]);
    duplicate.payload.messageID = duplicateMessages.find((m) => m.info.role === 'user').info.id;
    const beforeReplay = modelRequests.length;
    assert.equal((await request(`/session/${duplicate.session.id}/prompt_async`, 'POST', duplicate.payload)).status, 204);
    await pause(500);
    await until(async () => !(await request('/session/status')).value[duplicate.session.id]);
    const replayCalls = modelRequests.length - beforeReplay;
    assert.ok(replayCalls <= 1, `unexpected replay fan-out: ${replayCalls}`);
    await until(() => events.some((event) => event.type === 'session.status'));
    eventController.abort(); await eventTask;
    const evidence = { version: '1.3.13', platform: `${process.platform}-${process.arch}`, source: 'npm:opencode-ai@1.3.13', binary_artifact: process.platform === 'win32' ? 'opencode-windows-x64/bin/opencode.exe' : path.basename(binary), license: 'MIT', binary_sha256: binarySha256, config_sha256: digest(JSON.stringify(template)), openapi_sha256: digest(JSON.stringify(spec.value)), observed_at: new Date().toISOString(), offline_feasible: true, live_accepted: false,
      model_protocol: 'OpenAI-compatible /v1/chat/completions SSE, @ai-sdk/openai-compatible', mcp_tools: ['corpus_search', 'corpus_get_item'], prompt_async_status: 204, session_abort_response: true,
      openapi_export: 'opencode generate (complete); /doc contains only control-plane routes in 1.3.13',
      model_requests: modelRequests.length, mcp_tool_calls: mcpRequests.filter((r) => r.method === 'tools/call').length, real_paid_model_requests: 0,
      message_id_idempotency: { established: false, replayed_runtime_generated_message_id_added_model_requests: replayCalls, directive: 'Idle replay observation is insufficient to establish crash/dispatch idempotence; do not automatically resend uncertain submissions or invent arbitrary message IDs.' },
      approved_skills: approvedSkills.map(({ name, source, original_sha256, rendered_sha256 }) => ({ name, source, original_sha256, rendered_sha256 })),
      isolation: { cwd: 'temporary directory outside repository', home_xdg: 'fresh temporary directories', environment: 'allowlisted, no inherited provider credentials', providers_connected: providers.connected, plugins: actualConfig.plugin, discovered_skills: skills.value.map((s) => s.name), ignored_canaries: ['project opencode.json model/plugin', 'project .agents skill', 'home .agents skill'], permissions: actualConfig.permission, network_isolation_verified: false, network: 'host loopback fixture only; OS network isolation NOT proven by this probe' },
      checks: ['health/version', 'Basic authentication', 'actual JSON OpenAPI export', 'session/prompt_async/message/status/abort', 'real fake-model research via remote HTTP MCP', 'default-deny forbidden bash failed without file write', 'structured model error', 'fresh config/provider/plugin/skill discovery with canaries', 'approved research Skill tool-name rendering and digests', 'SSE server.connected/session.status observed', 'same runtime-generated messageID replay observed after idle'],
      limitations: ['Live model quality and costs not evaluated', 'Container network/process isolation requires Task 12 evidence', 'Auxiliary requests must be counted by the trusted model proxy', 'Native direct HTTP file/shell endpoints require host wrapper access control'],
      docs: ['https://opencode.ai/docs/server/', 'https://opencode.ai/docs/config/', 'https://opencode.ai/docs/permissions/', 'https://opencode.ai/docs/mcp-servers/', 'https://raw.githubusercontent.com/anomalyco/opencode/v1.3.13/packages/opencode/src/flag/flag.ts'] };
    if (persist) {
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, 'openapi.snapshot.json'), JSON.stringify(spec.value, null, 2) + '\n');
      await writeFile(path.join(outputDir, 'runtime-lock.json'), JSON.stringify({ ...existingLock, ...evidence }, null, 2) + '\n');
      // Persist actual traffic; fixture-only prompts and dummy auth, never environment dumps.
      await writeFile(path.join(outputDir, 'protocol.fixture.json'), JSON.stringify({ exchanges, modelRequests, mcpRequests, events, tools, logs }, null, 2) + '\n');
      await writeFile(path.join(outputDir, 'skills.fixture.json'), JSON.stringify(approvedSkills, null, 2) + '\n');
      await rm(path.join(outputDir, 'probe.failure.json'), { force: true });
    }
    return evidence;
  } catch (error) {
    const latest = exchanges.findLast((e) => /\/message$/.test(e.route));
    error.message += `\nRuntime log: ${logs.slice(-6000)}\nMode: ${mode}; Model requests: ${modelRequests.length}; Latest message: ${(JSON.stringify(latest?.response?.slice?.(-2)) || '').slice(0, 5000)}; Event types: ${JSON.stringify([...new Set(events.map((e) => e.type))])}`;
    if (persist) await writeFile(path.join(outputDir, 'probe.failure.json'), JSON.stringify({ observed_at: new Date().toISOString(), success: false, error: error.message, exchanges, model_request_count: modelRequests.length, mcp_request_count: mcpRequests.length }, null, 2) + '\n');
    throw error;
  }
  finally {
    eventController?.abort(); if (eventTask) await eventTask.catch(() => {});
    if (runtime && runtime.exitCode === null) { runtime.kill(); await Promise.race([new Promise((resolve) => runtime.once('exit', resolve)), pause(3000)]); }
    model.server.closeAllConnections(); mcp.server.closeAllConnections();
    await Promise.all([new Promise((resolve) => model.server.close(resolve)), new Promise((resolve) => mcp.server.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--offline')) { console.error('Use --offline; real provider calls are never supported by this probe.'); process.exitCode = 2; }
  else { try { console.log(JSON.stringify(await probe(), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
