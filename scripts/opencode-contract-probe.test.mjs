import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isolatedEnvironment, resolveBinary, digest } from './opencode-contract-probe.mjs';

test('probe cannot inherit real credentials, OpenCode overrides or home paths', () => {
  const env = isolatedEnvironment('/fixture', 4000, '/fixture/config.json', { PATH: '/bin', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', OPENCODE_CONFIG_CONTENT: 'unsafe', HOME: '/real-home' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.match(env.HOME, /fixture/);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, '1');
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1');
});

test('missing real runtime is a failure, never a skipped pass', async () => {
  await assert.rejects(resolveBinary('/definitely-absent-runtime/opencode'), /runtime_missing/);
});

test('fixture digests are SHA-256', () => {
  assert.equal(digest('fixture'), 'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d');
});

const fixture = async (name) => JSON.parse(await readFile(new URL(`../validation/agent/opencode/${name}`, import.meta.url), 'utf8'));

test('pinned complete OpenAPI and config digests match checked artifacts', async () => {
  const [lock, spec, config] = await Promise.all(['runtime-lock.json', 'openapi.snapshot.json', 'config.fixture.json'].map(fixture));
  assert.equal(lock.version, '1.3.13');
  assert.equal(lock.openapi_sha256, digest(JSON.stringify(spec)));
  assert.equal(lock.config_sha256, digest(JSON.stringify(config)));
  assert.equal(spec.openapi, '3.1.1');
  for (const route of ['/session', '/session/status', '/session/{sessionID}/prompt_async', '/session/{sessionID}/message', '/session/{sessionID}/abort']) assert.ok(spec.paths[route]);
  assert.ok(spec.paths['/session/{sessionID}/prompt_async'].post.responses['204']);
  assert.equal(lock.live_accepted, false);
  assert.equal(lock.isolation.network_isolation_verified, false);
});

test('recorded actual traffic proves research, default-deny and cancellation', async () => {
  const [lock, protocol] = await Promise.all(['runtime-lock.json', 'protocol.fixture.json'].map(fixture));
  assert.equal(lock.model_requests, protocol.modelRequests.length);
  assert.equal(lock.real_paid_model_requests, 0);
  assert.equal(lock.mcp_tool_calls, 2);
  assert.ok(protocol.modelRequests.length <= 10, 'unexpected auxiliary requests');
  assert.ok(protocol.modelRequests.every((r) => r.path === '/v1/chat/completions' && r.body.model === 'fixture'));
  assert.deepEqual(protocol.mcpRequests.filter((r) => r.method === 'tools/call').map((r) => r.params.name), ['search', 'get_item']);
  assert.ok(protocol.exchanges.some((r) => r.route === '/global/health' && r.status === 401));
  assert.ok(protocol.exchanges.some((r) => r.route.endsWith('/prompt_async') && r.status === 204));
  assert.ok(protocol.exchanges.some((r) => r.route.endsWith('/abort') && r.response === true));
  assert.ok(protocol.exchanges.some((r) => r.route.endsWith('/message') && Array.isArray(r.response) && r.response.some((m) => m.parts.some((p) => p.type === 'tool' && p.tool === 'bash' && p.state.status === 'error'))));
  assert.ok(protocol.events.some((e) => e.type === 'server.connected'));
  assert.ok(protocol.events.some((e) => e.type === 'session.status'));
  assert.equal(lock.message_id_idempotency.established, false);
});

test('approved Skill snapshots preserve raw and rendered provenance', async () => {
  const [lock, skills] = await Promise.all(['runtime-lock.json', 'skills.fixture.json'].map(fixture));
  assert.deepEqual(skills.map((s) => s.name).sort(), ['cross-source-check', 'industry-analysis']);
  for (const skill of skills) {
    assert.equal(skill.original_sha256, digest(skill.original));
    assert.equal(skill.rendered_sha256, digest(skill.rendered));
    assert.equal(lock.approved_skills.find((s) => s.name === skill.name).rendered_sha256, skill.rendered_sha256);
  }
  const cross = skills.find((s) => s.name === 'cross-source-check');
  assert.ok(cross.original.includes('search_items'));
  assert.ok(cross.rendered.includes('corpus_search'));
  assert.ok(cross.rendered.includes('corpus_get_item'));
});
