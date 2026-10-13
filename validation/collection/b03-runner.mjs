import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ROOT, QA_ROOT, HELPER_DIR, NPM_CLI, safeEnv, withPostgresBuild } from './b03-postgres-build.mjs';
import { nativeSchedule } from './b03-native-schedule.mjs';
import { ARTICLE_HOST } from './b03-fixtures.mjs';

assert.equal(process.argv[2], '--run', 'source-stable GO and explicit --run required');
const runId = 'b03-' + randomUUID(), controls = join(QA_ROOT, runId), screenshots = join(ROOT, 'screenshots', runId);
mkdirSync(controls, { recursive: true }); mkdirSync(screenshots, { recursive: true });
const report = { runId, timeouts_skipped: process.argv.includes("--skip-timeouts"), children: [], checks: [], ok: false }, servers = [];
const save = () => writeFileSync(join(controls, 'runner.json'), JSON.stringify(report, null, 2));
async function freePort() {
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  return [8080,8182,55191,55192].includes(port) ? freePort() : port;
}
async function launch(args, env, name) {
  const log = openSync(join(controls, name + '.log'), 'w');
  const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', log, log] }); closeSync(log);
  const record = { name, pid: child.pid, exited: false }; report.children.push(record); save();
  child.once('exit', (code, signal) => { Object.assign(record, { exited: true, code, signal }); save(); });
  child.once('error', error => { record.error = error.message; save(); });
  return { child, record };
}
async function start(mode, dsn, skipSeed = false, extra = {}) {
  const port = await freePort(), control = join(controls, mode), origin = 'http://127.0.0.1:' + port;
  mkdirSync(control, { recursive: true });
  const env = safeEnv({ DATABASE_URL: dsn, ARTICLE_READER_ENABLED: 'true', ARTICLE_READER_ALLOWED_HOSTS: ARTICLE_HOST,
    B03_QA_PRELOAD: 'true', B03_QA_CONTROL_DIR: control, B03_QA_SKIP_SEED: String(skipSeed),
    NODE_OPTIONS: '--import=' + JSON.stringify(pathToFileURL(join(HELPER_DIR, 'b03-preload.mjs')).href), ...extra });
  const handle = await launch([NPM_CLI, 'run', mode === 'built' ? 'preview' : 'dev', '--', '--host', '127.0.0.1', '--port', String(port)], env, mode);
  Object.assign(handle.record, { port, control }); servers.push(handle); save();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    assert.ok(!handle.record.exited && !handle.record.error, mode + ' server exited');
    if (existsSync(join(control, 'preload-ready.json'))) {
      const ready = await new Promise(resolve => { const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => { socket.destroy(); resolve(false); }); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
      if (ready) return { origin, control };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(mode + ' readiness timed out');
}
async function stopServers() {
  // Only exact children created by this invocation. Sandbox denial must be escalated by controller using these recorded PIDs.
  for (const handle of servers) if (!handle.record.exited && handle.child.pid) {
    await new Promise(resolve => { const killer = spawn('taskkill', ['/PID', String(handle.child.pid), '/T', '/F'], { env: safeEnv(), windowsHide: true, stdio: 'ignore' });
      killer.once('error', error => { handle.record.cleanupError = error.message; resolve(); }); killer.once('exit', code => { handle.record.cleanupCode = code; resolve(); }); });
  }
  assert.ok(servers.every(handle => handle.record.exited || handle.record.cleanupCode === 0), "owned app cleanup failed");
}
try {
  await withPostgresBuild(async ({ databases, directory }) => {
    report.postgresBuildDirectory = directory;
    try {
    for (const mode of ['dev', 'built']) {
      const server = await start(mode, databases[mode]);
      const check = await launch(['scripts/readiness-ui.mjs', server.origin, runId + '-' + mode, '--article', '--control-dir', server.control, ...(process.argv.includes('--skip-timeouts') ? ['--skip-timeouts'] : [])], safeEnv(), mode + '-browser');
      const code = await new Promise((resolve, reject) => { check.child.once('error', reject); check.child.once('exit', resolve); });
      assert.equal(code, 0, mode + ' real article UI checks failed'); report.checks.push({ mode, code, ...server }); save();
    }
    if (process.argv.includes('--native-fence')) {
      const first = await start('native-a', databases.concurrency, false, { B03_QA_NETWORK_DELAY_MS: '2000' });
      const second = await start('native-b', databases.concurrency, true, { B03_QA_NETWORK_DELAY_MS: '2000' });
      await nativeSchedule({ first: first.origin, second: second.origin, firstControl: first.control, secondControl: second.control, screenshots });
      report.checks.push({ mode: 'native-multi-process-fence', ok: true });
    }
    } finally { await stopServers(); }
  }); report.ok = true;
} catch (error) { report.error = error.message; throw error; }
finally {
  await stopServers();
  save(); console.log(JSON.stringify({ ok: report.ok, report: join(controls, 'runner.json'), screenshots }));
}
