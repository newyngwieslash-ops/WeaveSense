import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.3.13';
const BINARY = '/usr/local/bin/opencode';
const PORT = 4096;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function failure(code, status = 400) { return Object.assign(new Error(code), { status }); }
function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw failure('invalid_fields');
}
function boundedString(value, min = 1, max = 128) { return typeof value === 'string' && value.length >= min && value.length <= max; }
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

export async function terminateProcessTree(child) {
  if (!child?.pid) return true;
  if (process.platform !== 'linux') throw failure('linux_process_groups_required', 503);
  const alive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!alive()) return true;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let tries = 0; tries < 20; tries++) { if (!alive()) return true; await delay(50); }
  }
  return !alive();
}

function runtimeEnvironment(root, password) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    TMPDIR: path.join(root, 'temp'), OPENCODE_CONFIG: path.join(root, 'config.json'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_PURE: '1',
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' };
}

export function createRuntimeServer({ stateRoot = '/state', token = process.env.OPENCODE_RUNTIME_TOKEN,
  bridgeURL = process.env.OPENCODE_BRIDGE_URL || 'http://agent-bridge:8792',
  modelName = process.env.OPENCODE_MODEL_NAME || 'research-fixed',
  maxOutputTokens = Number(process.env.OPENCODE_MAX_OUTPUT_TOKENS) || 1800,
  approvedSkillRoot = '/opt/skills', spawnRuntime = spawn, fetchRuntime = fetch,
  terminateTree = terminateProcessTree } = {}) {
  if (!boundedString(token, 16, 512)) throw failure('runtime_token_required');
  const bridge = new URL(bridgeURL);
  if (!['http:', 'https:'].includes(bridge.protocol) || bridge.username || bridge.password || bridge.pathname !== '/' || bridge.search || bridge.hash) throw failure('invalid_bridge_url');
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(modelName)) throw failure('invalid_model_name');
  let active = null, lastStopped = null, closing = false, mutation = false;
  const streams = new Set();
  function authenticated(header) {
    const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(header || '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  function summary(instance) {
    return { instance_id: instance.id, epoch: instance.epoch, run_id: instance.runID,
      version: VERSION, config_digest: instance.digest, status: instance.status,
      profile: instance.profile, skill_snapshot_digest: instance.skillDigest, skill_versions: instance.skillVersions,
      dispatch_state: instance.dispatchState, session_id: instance.session?.id || null, process_running: !!instance.child && instance.child.exitCode === null };
  }
  function bound(input) {
    if (!active || input.instance_id !== active.id || input.epoch !== active.epoch) throw failure('stale_epoch', 409);
    return active;
  }
  async function prepare(input) {
    exactKeys(input, ['run_id', 'grant', 'claim_token', ...(input?.profile !== undefined ? ['profile'] : [])]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/.test(input.run_id || '') || !/^[a-zA-Z0-9._~-]{16,2048}$/.test(input.grant || '') || !/^[a-zA-Z0-9._~-]{16,2048}$/.test(input.claim_token || '')) throw failure('invalid_prepare');
    // Profile is a trusted host enum; the browser/model can never pick one.
    const profile = input.profile === undefined ? 'research' : input.profile;
    if (profile !== 'research' && profile !== 'assistant') throw failure('invalid_profile');
    const binding = hash(JSON.stringify({ run_id: input.run_id, grant: input.grant, claim_token: input.claim_token, profile }));
    if (active) {
      if (active.binding === binding && active.status !== 'stopping') return summary(active);
      throw failure('runtime_busy', 409);
    }
    await mkdir(stateRoot, { recursive: true });
    const root = await mkdtemp(path.join(stateRoot, 'run-'));
    try {
      for (const dir of ['work', 'home', 'config', 'data', 'cache', 'state', 'temp']) await mkdir(path.join(root, dir));
      // Pre-seed the opencode plugin dependency cache: with a cold cache,
      // config loading runs `opencode install` (bun add) for
      // @opencode-ai/plugin against the package registry on every session
      // bootstrap — the registry is unreachable in this sandbox and bun's
      // retries block POST /session past the forward timeout
      // (runtime_session_failed). Seeding BOTH scanned directories (the
      // global cache and the per-run config dir) with a stub matching the
      // pinned version makes needsInstall()/BunProc.install() return
      // immediately; no plugins are configured, so the module is never
      // imported.
      for (const base of [path.join(root, 'cache', 'opencode'), path.join(root, 'config', 'opencode')]) {
        const pluginDir = path.join(base, 'node_modules', '@opencode-ai', 'plugin');
        await mkdir(pluginDir, { recursive: true });
        await writeFile(path.join(base, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': VERSION } }));
        await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ name: '@opencode-ai/plugin', version: VERSION, main: 'index.js' }));
        await writeFile(path.join(pluginDir, 'index.js'), 'module.exports = {};\n');
      }
      const skillPath = path.join(root, 'approved-skills');
      const skillInstructions = [], skillVersions = {};
      // Each profile renders its own explicit manifest; digests cover exactly
      // what that profile mounts (§4.3).
      const skillNames = profile === 'assistant' ? ['project-assistant'] : ['briefing-writing', 'cross-source-check', 'industry-analysis'];
      for (const name of skillNames) {
        let original;
        try {
          const dir = path.join(approvedSkillRoot, name), file = path.join(dir, 'SKILL.md');
          if ((await lstat(dir)).isSymbolicLink() || (await lstat(file)).isSymbolicLink() || JSON.stringify(await readdir(dir)) !== '["SKILL.md"]') throw new Error('unapproved_package');
          original = await readFile(file, 'utf8');
          if (Buffer.byteLength(original) > 32768) throw new Error('skill_too_large');
        }
        catch { throw failure('required_skill_missing', 503); }
        skillVersions[name] = hash(`${name}/SKILL.md${original}`);
        if (name === 'briefing-writing') continue;
        const rendered = profile === 'assistant' ? original
          : original.replaceAll('search_items', 'corpus_search_items').replaceAll('get_item', 'corpus_get_item');
        await mkdir(path.join(skillPath, name), { recursive: true });
        await writeFile(path.join(skillPath, name, 'SKILL.md'), rendered, { mode: 0o600 });
        skillInstructions.push(rendered);
      }
      const agentPrompt = profile === 'assistant'
        ? 'You are the read-only project assistant. Gather data ONLY with the host read tools. Never invoke shell, external websites, sub-agents or write files. Propose every write as a structured action in your final JSON for host-side approval.\n' + skillInstructions.join('\n')
        : 'Research only the approved corpus using corpus_search_items and corpus_get_item. Never invoke shell, external websites, sub-agents or write files. Return the requested structured AgentResult JSON.\n' + skillInstructions.join('\n');
      // opencode 1.3.13 keys MCP tools as sanitize(serverKey) + '_' +
      // sanitize(toolName) in MCP.tools() (older bundles used ':'). The
      // assistant permission map lists BOTH spellings so '*': 'deny' can
      // never filter the model's read surface regardless of the bundle's
      // keying; unmatched names stay denied.
      const assistantToolNames = [
        'project_overview', 'list_keywords', 'list_sources', 'search_items', 'get_item',
        'list_notes', 'get_note', 'list_collection_jobs', 'get_collection_job',
        'get_research_status', 'get_operation', 'get_service_status',
      ];
      const assistantTools = Object.fromEntries(assistantToolNames.flatMap(name => [
        [`corpus_${name}`, 'allow'], [`corpus:${name}`, 'allow'],
      ]));
      const config = { $schema: 'https://opencode.ai/config.json', model: `bridge/${modelName}`, small_model: `bridge/${modelName}`,
        enabled_providers: ['bridge'], plugin: [], share: 'disabled', autoupdate: false, compaction: { auto: false, prune: false },
        permission: profile === 'assistant'
          ? { '*': 'deny', ...assistantTools, skill: { '*': 'deny', 'project-assistant': 'allow' } }
          : { '*': 'deny', corpus_search_items: 'allow', 'corpus:search_items': 'allow', corpus_get_item: 'allow', 'corpus:get_item': 'allow', skill: { '*': 'deny', 'industry-analysis': 'allow', 'cross-source-check': 'allow' } },
        default_agent: profile === 'assistant' ? 'assistant' : 'research', skills: { paths: [skillPath] },
        agent: { [profile === 'assistant' ? 'assistant' : 'research']: { mode: 'primary', steps: 16, prompt: agentPrompt }, title: { disable: true }, summary: { disable: true }, compaction: { disable: true }, explore: { disable: true }, general: { disable: true } },
        provider: { bridge: { npm: '@ai-sdk/openai-compatible', name: 'Trusted research bridge', options: { baseURL: `${bridge.origin}/v1`, apiKey: input.grant }, models: { [modelName]: { name: modelName, limit: { context: 32768, output: maxOutputTokens } } } } },
        mcp: { corpus: { type: 'remote', url: `${bridge.origin}/mcp`, oauth: false, enabled: true, headers: { Authorization: `Bearer ${input.grant}` } } } };
      const serialized = JSON.stringify(config);
      await writeFile(path.join(root, 'config.json'), serialized, { mode: 0o600 });
      // Hash a redacted config so status exposes no reusable credential digest.
      const publicConfig = structuredClone(config); publicConfig.provider.bridge.options.apiKey = '[grant]'; publicConfig.mcp.corpus.headers.Authorization = 'Bearer [grant]';
      publicConfig.skills.paths = ['[approved-skills]']; publicConfig.approved_skill_versions = skillVersions;
      active = { id: randomUUID(), epoch: randomUUID(), root, runID: input.run_id, binding, profile,
        status: 'prepared', dispatchState: 'prepared', password: randomUUID(), child: null, digest: hash(JSON.stringify(publicConfig)),
        skillVersions, skillDigest: hash(Object.entries(skillVersions).map(([name, version]) => `${name}\0${version}\n`).join('')) };
      lastStopped = null;
      return summary(active);
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  }
  async function start(instance) {
    if (instance.status === 'running') return summary(instance);
    if (instance.status !== 'prepared') throw failure('runtime_not_prepared', 409);
    instance.child = spawnRuntime(BINARY, ['serve', '--hostname', '127.0.0.1', '--port', String(PORT)],
      { cwd: path.join(instance.root, 'work'), env: runtimeEnvironment(instance.root, instance.password), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    instance.child.on('error', () => { instance.status = 'failed'; });
    // Drain child output without forwarding prompt/config/credential data.
    instance.child.stdout?.on('data', () => {}); instance.child.stderr?.on('data', () => {});
    instance.child.on('exit', () => { if (instance.status === 'running') instance.status = 'failed'; });
    const expires = Date.now() + 30000;
    while (Date.now() < expires) {
      if (instance.child.exitCode !== null || instance.status === 'failed') throw failure('runtime_start_failed', 503);
      try {
        const res = await fetchRuntime(`http://127.0.0.1:${PORT}/global/health`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${instance.password}`).toString('base64')}` }, signal: AbortSignal.timeout(1000) });
        if (res.status === 200) {
          const health = await res.json();
          if (health.version !== VERSION || health.healthy !== true) { instance.status = 'failed'; throw failure('runtime_version_mismatch', 503); }
          instance.status = 'running'; return summary(instance);
        }
      } catch (error) { if (error.message === 'runtime_version_mismatch') throw error; }
      await delay(100);
    }
    instance.status = 'failed'; throw failure('runtime_start_timeout', 503);
  }
  async function stop(instance) {
    instance.status = 'stopping';
    for (const stream of streams) { stream.abort(); } streams.clear();
    if (!await terminateTree(instance.child)) throw failure('process_tree_stop_unconfirmed', 503);
    const result = { ...summary(instance), status: 'stopped', dispatch_state: 'aborted', process_running: false, stopped: true };
    // Preserve the opencode diagnostic log (contains LLM/MCP errors the
    // wrapper never sees) under /state/logs/<run_id>.log before wiping the
    // run dir; /state is a tmpfs that survives until the container stops.
    try {
      const logDir = path.join(instance.root, 'data', 'opencode', 'log');
      const entries = await readdir(logDir);
      const logName = entries.sort().pop();
      if (logName) {
        const keep = path.join(stateRoot, 'logs');
        await mkdir(keep, { recursive: true });
        await writeFile(path.join(keep, `${instance.runID}.log`), await readFile(path.join(logDir, logName)));
      }
    } catch { /* diagnostics only: never block the stop flow */ }
    await rm(instance.root, { recursive: true, force: true }); active = null; lastStopped = result;
    return result;
  }
  function forwardInput(input) {
    exactKeys(input, ['instance_id', 'epoch', 'method', 'path', 'body']);
    const instance = bound(input);
    if (instance.status !== 'running') throw failure('runtime_not_running', 409);
    const route = input.path, method = input.method;
    if (typeof route !== 'string' || !['GET', 'POST'].includes(method)) throw failure('invalid_forward');
    const read = method === 'GET' && (['/session/status', '/event'].includes(route) || /^\/session\/ses_[a-zA-Z0-9]+\/message(?:\/msg_[a-zA-Z0-9]+)?$/.test(route));
    const create = method === 'POST' && route === '/session';
    const prompt = method === 'POST' && /^\/session\/ses_[a-zA-Z0-9]+\/prompt_async$/.test(route);
    const abort = method === 'POST' && /^\/session\/ses_[a-zA-Z0-9]+\/abort$/.test(route);
    if (!read && !create && !prompt && !abort) throw failure('forbidden_runtime_route');
    const sessionID = route.match(/^\/session\/(ses_[a-zA-Z0-9]+)\//)?.[1];
    if (sessionID && sessionID !== instance.session?.id) throw failure('foreign_session');
    if (read && input.body !== undefined) throw failure('invalid_forward_body');
    if (create) { exactKeys(input.body || {}, ['title']); if (input.body?.title !== undefined && !boundedString(input.body.title, 1, 200)) throw failure('invalid_session_title'); }
    if (abort) exactKeys(input.body || {}, []);
    if (prompt) {
      exactKeys(input.body, ['parts', 'messageID', 'agent', 'model']);
      const expectedAgent = instance.profile === 'assistant' ? 'assistant' : 'research';
      if (input.body.agent !== undefined && input.body.agent !== expectedAgent) throw failure('invalid_agent');
      if (input.body.model !== undefined) {
        exactKeys(input.body.model, ['providerID', 'modelID']);
        if (input.body.model.providerID !== 'bridge' || input.body.model.modelID !== modelName) throw failure('invalid_model');
      }
      if (input.body.messageID !== undefined) throw failure('client_message_id_unsupported');
      if (!Array.isArray(input.body.parts) || input.body.parts.length !== 1) throw failure('invalid_prompt_parts');
      exactKeys(input.body.parts[0], ['type', 'text']);
      if (input.body.parts[0].type !== 'text' || !boundedString(input.body.parts[0].text, 1, 256 * 1024)) throw failure('invalid_prompt_text');
    }
    return { instance, prompt, create, stream: route === '/event', route, method, body: prompt ? { ...input.body, agent: instance.profile === 'assistant' ? 'assistant' : 'research', model: { providerID: 'bridge', modelID: modelName } } : input.body };
  }
  async function forward(input, req, res) {
    const target = forwardInput(input), controller = new AbortController();
    if (target.create && target.instance.session) { json(res, target.instance.session); return; }
    if (target.create && target.instance.sessionCreating) throw failure('session_prepare_busy', 409);
    if (target.create) target.instance.sessionCreating = true;
    if (target.prompt) {
      if (target.instance.dispatchState !== 'prepared') throw failure('prompt_already_dispatched', 409);
      target.instance.dispatchState = 'dispatching';
    }
    streams.add(controller);
    res.on('close', () => controller.abort());
    let upstream;
    try {
      upstream = await fetchRuntime(`http://127.0.0.1:${PORT}${target.route}`, { method: target.method,
        headers: { authorization: `Basic ${Buffer.from(`opencode:${target.instance.password}`).toString('base64')}`, ...(target.body ? { 'content-type': 'application/json' } : {}) },
        ...(target.body ? { body: JSON.stringify(target.body) } : {}), signal: target.stream ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      if (target.prompt) target.instance.dispatchState = upstream.status === 204 ? 'submitted' : 'dispatch_unknown';
      if (upstream.status === 204) { res.writeHead(204); res.end(); return; }
      const contentType = upstream.headers.get('content-type') || '';
      if (target.stream) {
        if (!contentType.includes('text/event-stream') || upstream.status !== 200) throw failure('invalid_runtime_event_stream', 502);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        await new Promise((resolve, reject) => { const stream = Readable.fromWeb(upstream.body); stream.on('error', reject); res.on('close', resolve); stream.on('end', resolve); stream.pipe(res); });
        return;
      }
      if (!contentType.includes('application/json')) throw failure('runtime_non_json', 502);
      let text = ''; const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        text += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw failure('runtime_response_too_large', 502);
      }
      text += decoder.decode();
      const parsed = JSON.parse(text);
      if (target.create && upstream.status === 200) {
        if (!/^ses_[a-zA-Z0-9]+$/.test(parsed.id || '')) throw failure('invalid_runtime_session', 502);
        target.instance.session = parsed;
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(text);
    } catch (error) {
      if (target.prompt && target.instance.dispatchState === 'dispatching') target.instance.dispatchState = 'dispatch_unknown';
      if (res.headersSent) res.destroy(); else throw failure(error.status ? error.message : 'runtime_transport_failed', error.status || 502);
    } finally { controller.abort(); streams.delete(controller); if (target.create) target.instance.sessionCreating = false; }
  }
  const server = createServer(async (req, res) => {
    if (!authenticated(req.headers.authorization)) return json(res, { error: 'unauthorized' }, 401);
    try {
      if (closing) throw failure('runtime_closing', 503);
      const url = new URL(req.url, 'http://wrapper');
      if (req.method === 'GET' && url.pathname === '/health' && !url.search) return json(res, { healthy: true, version: VERSION });
      if (req.method === 'GET' && url.pathname === '/status') {
        if ([...url.searchParams.keys()].some((key) => !['instance_id', 'epoch'].includes(key))) throw failure('invalid_status');
        const identity = Object.fromEntries(url.searchParams);
        if (!active && lastStopped?.instance_id === identity.instance_id && lastStopped.epoch === identity.epoch) return json(res, lastStopped);
        return json(res, summary(bound(identity)));
      }
      if (req.method !== 'POST' || url.search || !['/prepare', '/start', '/stop', '/forward'].includes(url.pathname)) throw failure('not_found', 404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw failure('json_required');
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 300 * 1024) throw failure('request_too_large', 413); chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('invalid_json'); }
      if (url.pathname === '/forward') return await forward(input, req, res);
      if (mutation) throw failure('runtime_operation_busy', 409);
      mutation = true;
      try {
        if (url.pathname === '/prepare') return json(res, await prepare(input));
        exactKeys(input, ['instance_id', 'epoch']);
        if (url.pathname === '/stop' && !active && lastStopped?.instance_id === input.instance_id && lastStopped.epoch === input.epoch) return json(res, lastStopped);
        const instance = bound(input);
        json(res, url.pathname === '/start' ? await start(instance) : await stop(instance));
      } finally { mutation = false; }
    } catch (error) { if (!res.headersSent) json(res, { error: error.status ? error.message : 'runtime_internal_error' }, error.status || 500); else res.destroy(); }
  });
  return { server, listen: (port = 4097, host = '0.0.0.0') => new Promise((resolve) => server.listen(port, host, resolve)),
    async close() { closing = true; if (active) await stop(active); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createRuntimeServer();
  await app.listen();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { try { await app.close(); process.exit(0); } catch { process.exit(1); } });
}
