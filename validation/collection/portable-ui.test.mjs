import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const helpers = ['b03-control', 'b03-fixtures', 'b03-preload', 'b03-postgres-build', 'b03-runner', 'b03-native-schedule', 'jobs-qa-preload', 'c02-fixtures', 'c02-minio', 'c02-preload', 'c02-runner', 'c02-ui', 'c02-worker-fixture'];
test('article/subtitle QA resolves entirely from clean-checkout files', () => {
  for (const name of helpers) {
    const url = new URL('./' + name + '.mjs', import.meta.url);
    assert.ok(existsSync(url), 'missing portable helper: ' + name);
    const source = readFileSync(url, 'utf8');
    assert.ok(!source.includes('.superpowers/'), 'ignored scratch dependency: ' + name);
    for (const [, dependency] of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)['"]/g)) {
      if (dependency.startsWith('.')) assert.ok(existsSync(new URL(dependency, url)), name + ': ' + dependency);
    }
  }
  const ui = readFileSync(new URL('../../scripts/readiness-ui.mjs', import.meta.url), 'utf8');
  assert.ok(!ui.includes('.superpowers/'), 'readiness UI must not depend on ignored scratch');
});

test('portable preloads are inert with safe defaults and valid Node option quoting', async () => {
  const { safeEnv, ROOT } = await import('./b03-postgres-build.mjs');
  const env = safeEnv();
  assert.equal(env.DATABASE_URL, '');
  assert.equal(env.XAI_API_KEY, '');
  for (const name of ['AUTO_ANALYZE', 'EXTRACT_AUTO', 'AGENT_WORKER_ENABLED', 'AGENT_ASYNC_RESEARCH_ENABLED', 'AGENT_OPENCODE_WORKER_ENABLED', 'AGENT_ASSISTANT_ENABLED', 'AGENT_ASSISTANT_ACTIONS_ENABLED', 'ARTICLE_READER_ENABLED', 'SUBTITLE_ENABLED']) assert.equal(env[name], 'false', name);
  assert.ok(env.LOOM_MODEL_CONFIG && !existsSync(env.LOOM_MODEL_CONFIG));
  for (const name of ['b03-preload', 'c02-preload']) {
    const preload = pathToFileURL(fileURLToPath(new URL('./' + name + '.mjs', import.meta.url))).href;
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("inert")'], {
      cwd: ROOT, env: safeEnv({ NODE_OPTIONS: '--import=' + JSON.stringify(preload) }),
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, 'inert');
  }
});
