import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { offlineEnv, OFFLINE_DEFAULTS } from '../../scripts/readiness-offline.mjs';
import { pendingMigrations } from '../../scripts/migration-plan.mjs';
import { OFFLINE_READER_ENV } from './b03-fixtures.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
export const QA_ROOT = join(ROOT, 'artifacts/collection-capability/ui');
export const NPM_CLI = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
export function safeEnv(overrides = {}) {
  return offlineEnv(process.env, { ...OFFLINE_DEFAULTS, ...OFFLINE_READER_ENV,
    ARTICLE_READER_ENABLED: 'false', SUBTITLE_ENABLED: 'false', SUBTITLE_URL: '', SUBTITLE_SERVICE_TOKEN: '', LOOM_MODEL_CONFIG: join(QA_ROOT, 'never-created-model.local.json'),
    AGENT_MODEL_API_KEY: '', AGENT_MODEL_BASE_URL: '', AGENT_DATA_TOKEN: '', AGENT_SERVICE_TOKEN: '',
    OPENCODE_WORKER_TOKEN: '', OPENCODE_BRIDGE_CONTROL_TOKEN: '', WECHAT_GATEWAY_URL: '', WECHAT_GATEWAY_TOKEN: '',
    ...overrides });
}

// Caller can use databases while the owned container is alive; finally always removes this exact container.
export async function withPostgresBuild(callback = async () => {}) {
  assert.ok(existsSync(NPM_CLI));
  assert.ok(!readdirSync(ROOT).some(name => name === '.env' || name.startsWith('.env.')), 'refusing root dotenv');
  assert.ok(!existsSync(join(QA_ROOT, 'never-created-model.local.json')));
  const name = 'loom-b03-qa-' + randomUUID(), directory = join(QA_ROOT, name);
  mkdirSync(directory, { recursive: true });
  const report = { container: name, children: [], ok: false }, base = safeEnv();
  const save = () => writeFileSync(join(directory, 'postgres-build.json'), JSON.stringify(report, null, 2));
  const docker = args => {
    const result = spawnSync('docker', args, { env: base, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(result.status, 0, 'owned docker ' + args[0] + ': ' + result.stderr.slice(-500)); return result.stdout.trim();
  };
  const npm = async (script, env, tag) => {
    const fd = openSync(join(directory, tag + '.log'), 'w');
    const child = spawn(process.execPath, [NPM_CLI, 'run', script], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', fd, fd] }); closeSync(fd);
    const record = { script, tag, pid: child.pid, exited: false }; report.children.push(record); save();
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    record.exited = true; record.exit = code; save(); assert.equal(code, 0, tag + ' failed');
  };
  let admin;
  try {
    docker(['run', '--detach', '--pull=never', '--name', name, '--label', 'loom.b03.qa=isolated',
      '-e', 'POSTGRES_PASSWORD=review-only-local', '-e', 'POSTGRES_DB=review', '-p', '127.0.0.1::5432', 'postgres:16-alpine']);
    report.created = true; save();
    const ports = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]));
    assert.equal(ports['5432/tcp'][0].HostIp, '127.0.0.1');
    const port = Number(ports['5432/tcp'][0].HostPort); assert.ok(port > 0); report.port = port;
    const dsn = database => `postgresql://postgres:review-only-local@127.0.0.1:${port}/${database}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      const client = new pg.Client({ connectionString: dsn('review') });
      try { await client.connect(); admin = client; break; }
      catch { await client.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    assert.ok(admin, 'owned PostgreSQL not ready');
    assert.equal((await admin.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='_migrations'")).rows[0].n, 0);
    // Real npm build must perform its own db:migrate; no pre-application of SQL.
    await npm('build', safeEnv({ DATABASE_URL: dsn('review') }), 'real-npm-build');
    const expected = pendingMigrations(readdirSync(join(ROOT, 'migrations')), []).map(row => row.name);
    const actual = (await admin.query('select name from _migrations order by name')).rows.map(row => row.name).sort((a,b) => a.localeCompare(b));
    assert.deepEqual(actual, expected); report.buildMigrationNames = actual;
    const databases = {};
    for (const mode of ['dev', 'built', 'concurrency']) {
      const database = 'b03_' + mode; await admin.query('create database ' + database);
      databases[mode] = dsn(database);
      await npm('db:migrate', safeEnv({ DATABASE_URL: databases[mode] }), 'migrate-' + mode);
    }
    await callback({ databases, directory, report, save }); report.ok = true;
  } catch (error) { report.error = error.message; throw error; }
  finally {
    await admin?.end().catch(() => {});
    if (report.created) {
      try { docker(['rm', '--force', '--volumes', name]); report.removed = true; }
      catch (error) { report.cleanupError = error.message; }
      const check = spawnSync('docker', ['inspect', name], { env: base, encoding: 'utf8', windowsHide: true });
      report.removalVerified = check.status !== 0 && /No such (object|container)/i.test(check.stderr);
    }
    if (report.created && !report.removalVerified) report.ok = false;
    save(); console.log(JSON.stringify({ report: join(directory, 'postgres-build.json'), ok: report.ok, removalVerified: report.removalVerified }));
  }
  if (report.created && !report.removalVerified) throw new Error(report.cleanupError ?? 'owned PostgreSQL cleanup failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], '--run', 'explicit GO/--run required'); await withPostgresBuild();
}
