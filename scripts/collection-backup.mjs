#!/usr/bin/env node
/** Operator CLI, not a service: Node >=22.16, Docker CLI, Python + locked Telethon requirements.
 * The operator closes ingress, drains and stops EVERY writer first. This tool
 * verifies labelled stopped containers, empty in-flight queues, exclusive SQLite
 * writer locks and PG table locks; it never stops services or activates a schedule.
 * Dedicated MinIO credentials/bucket and no external writers are prerequisites.
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, basename, relative, isAbsolute, parse } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import pg from 'pg';
import { assertRestoreTargetIsNew, assertTaggedResource } from './restore-policy.mjs';
import { offlineEnv } from './readiness-offline.mjs';
import { isMainModule } from './with-app-env.mjs';

const LIMIT = 256 * 1024 * 1024;
const MAGIC = Buffer.from('LOOMBACKUP1');
const ROLES = ['app', 'scheduler', 'telethon', 'gateway'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
function check(ok, code) { if (!ok) fail(code); }
function fields(value, names) { check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...names].sort().join(','), 'backup_manifest_fields'); }
function identifier(value) { check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value), 'backup_identifier'); return value; }
function objectKey(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\:?%]/.test(value) && ![...value].some(c=>c.charCodeAt(0)<32)
    && value.split('/').every(p => p && p !== '.' && p !== '..')
    && !/(?:\.session(?:-.*)?|\.env|\.key|\.pem)$/i.test(value), 'backup_object_key');
  return value;
}
function same(a, b, code) { check(JSON.stringify(a) === JSON.stringify(b), code); }
function run(command, args, input, extraEnv = {}) {
  const result = spawnSync(command, args, { input, windowsHide: true, timeout: 180000, maxBuffer: LIMIT,
    env: offlineEnv(process.env, extraEnv) });
  // Never print subprocess args/stderr: a provider can echo secrets even when stdin carries them.
  check(!result.error && result.status === 0, 'backup_subprocess_failed');
  return result.stdout;
}
const docker = (args, input) => run('docker', args, input);
function inspected(container) { return JSON.parse(docker(['inspect', identifier(container)]))[0]; }

/** Check each ancestor; realpath alone would silently accept a junction. */
export function noSymlinks(path) {
  const absolute = resolve(path); const root = parse(absolute).root;
  let cursor = root;
  for (const part of relative(root, absolute).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) { check(!lstatMissingLink(cursor), 'backup_symlink'); break; }
    check(!lstatSync(cursor).isSymbolicLink(), 'backup_symlink');
  }
  return absolute;
}
function lstatMissingLink(path) { try { return lstatSync(path).isSymbolicLink(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export function newChild(parent, name) {
  check(typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/.test(name) && name !== '..', 'backup_path');
  parent = noSymlinks(parent); check(lstatSync(parent).isDirectory(), 'backup_path');
  const child = resolve(realpathSync(parent), name);
  check(dirname(child) === realpathSync(parent), 'backup_path');
  check(!existsSync(child) && !lstatMissingLink(child), 'restore_target_exists');
  assertRestoreTargetIsNew(readdirSync(parent), name);
  return child;
}
function outside(child, parent) { const rel = relative(resolve(parent), resolve(child)); return rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || rel === '..' || isAbsolute(rel); }

/** NTFS DACL is checked, not inferred from chmod. Only current SID + SYSTEM. */
export function restrictPath(path, create = false) {
  noSymlinks(path);
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $p=$env:LOOM_BACKUP_ACL_PATH; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $sys=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); $item=Get-Item -LiteralPath $p; ${create ? `$acl=if($item.PSIsContainer){[System.Security.AccessControl.DirectorySecurity]::new()}else{[System.Security.AccessControl.FileSecurity]::new()}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($s in @($sid,$sys)){ $r=if($item.PSIsContainer){[System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{[System.Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow')}; $acl.AddAccessRule($r) }; Set-Acl -LiteralPath $p -AclObject $acl;` : ''} $a=Get-Acl -LiteralPath $p; if(-not $a.AreAccessRulesProtected -and $item.PSIsContainer){throw 'ACL inheritance'}; $rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); foreach($r in $rules){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid.Value,$sys.Value)){throw 'broad ACL'}}; if($a.Owner -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().Name -and $a.Owner -ne $sid.Value){throw 'foreign owner'}; Write-Output 'restricted-current-user-and-system'`;
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], undefined, { LOOM_BACKUP_ACL_PATH: resolve(path) });
    return 'NTFS-current-SID-and-SYSTEM';
  }
  if (create) chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
  const stat = lstatSync(path); check((stat.mode & 0o077) === 0 && stat.uid === process.getuid(), 'backup_permissions');
  return 'POSIX-owner-only';
}
export function privateDirectory(parent, name) {
  const path = newChild(parent, name); mkdirSync(path, { mode: 0o700 }); restrictPath(path, true); return path;
}
export function initKey(parent, name) {
  const dir = privateDirectory(parent, name); const path = join(dir, 'encryption.key');
  writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); restrictPath(path); return path;
}
function loadKey(path, destinations) {
  noSymlinks(path); restrictPath(dirname(path)); restrictPath(path);
  check(outside(path, process.cwd()) && destinations.every(dir => outside(path, dir)), 'backup_key_not_separate');
  const key = readFileSync(path); check(key.length === 32, 'backup_key_size'); return key;
}
export function seal(payload, key) {
  const plain = Buffer.from(JSON.stringify(payload)); check(plain.length <= LIMIT, 'backup_size_limit');
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(MAGIC);
  return Buffer.concat([MAGIC, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
export function unseal(bytes, key) {
  try {
    check(bytes.length > MAGIC.length + 28 && bytes.length <= LIMIT + 64 && bytes.subarray(0, MAGIC.length).equals(MAGIC), 'bad');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
    decipher.setAAD(MAGIC); decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 12, -16)), decipher.final()]).toString('utf8'));
  } catch { fail('backup_authentication_failed'); }
}
export function validatePayload(payload, expected) {
  fields(payload, ['manifest','files']); const m = payload.manifest;
  fields(m, ['version','generation','createdAt','resources','schema','files']);
  check(m.version === 1, 'backup_version'); identifier(m.generation);
  check(typeof m.createdAt === 'string' && new Date(m.createdAt).toISOString() === m.createdAt, 'backup_timestamp');
  fields(m.resources, ['database','bucket']); identifier(m.resources.database); identifier(m.resources.bucket);
  same(m.resources, expected.resources, 'backup_resource_mismatch');
  check(Array.isArray(m.schema) && m.schema.length > 0 && m.schema.every(s => /^\d{4}_[a-z0-9_]+\.sql$/.test(s)), 'backup_schema');
  same(m.schema, expected.schema, 'backup_schema_mismatch');
  check(Array.isArray(m.files) && Array.isArray(payload.files) && m.files.length === payload.files.length, 'backup_files');
  const kinds = []; const keys = new Set(); let total = 0;
  const bytes = m.files.map((f, i) => {
    fields(f, f.kind === 'object' ? ['name','kind','objectKey','bytes','sha256'] : ['name','kind','bytes','sha256']);
    check(f.name === `${i}.bin` && ['postgres','sqlite','session','object'].includes(f.kind), 'backup_file_path');
    if (f.kind === 'object') { objectKey(f.objectKey); check(!keys.has(f.objectKey), 'backup_duplicate_object'); keys.add(f.objectKey); }
    else kinds.push(f.kind);
    check(typeof payload.files[i] === 'string', 'backup_file_encoding');
    const b = Buffer.from(payload.files[i], 'base64'); total += b.length;
    check(b.toString('base64') === payload.files[i] && Number.isSafeInteger(f.bytes) && f.bytes === b.length && sha256(b) === f.sha256 && total <= LIMIT, 'backup_hash_or_size');
    return b;
  });
  same(kinds.sort(), ['postgres','session','sqlite'], 'backup_required_resources');
  check(bytes[m.files.findIndex(f => f.kind === 'postgres')].subarray(0,5).toString() === 'PGDMP', 'backup_pg_format');
  return bytes;
}

export function assertStoppedWriters(containers, group) {
  const roles = new Set();
  for (const c of containers) {
    assertTaggedResource(c.Config.Labels?.['loom.backup.group'], group);
    const role = c.Config.Labels?.['loom.backup.role'];
    check(role && !['postgres','minio'].includes(role), 'backup_writer_role'); roles.add(role);
    check(c.State.Status === 'exited' && !c.State.Running && !c.State.Paused && !c.State.Restarting, 'backup_writers_active');
  }
  check(ROLES.every(r => roles.has(r)), 'backup_writer_missing');
}
function checkWriters(config) {
  const ids = docker(['ps','-aq','--filter',`label=loom.backup.group=${identifier(config.group)}`]).toString().trim().split(/\s+/).filter(Boolean);
  const writers = ids.map(inspected).filter(c => !['postgres','minio'].includes(c.Config.Labels?.['loom.backup.role']));
  assertStoppedWriters(writers, config.group);
}
function service(config, role, port) {
  const c = inspected(config[role].container);
  assertTaggedResource(c.Config.Labels?.['loom.backup.group'], config.group);
  assertTaggedResource(c.Config.Labels?.['loom.backup.role'], role);
  check(c.State.Running && !c.State.Paused && !c.State.Restarting, 'backup_resource_not_running');
  const published = c.NetworkSettings.Ports?.[`${port}/tcp`] ?? [];
  const address = config[role].host; const selectedPort = config[role].port;
  check(address === '127.0.0.1' && published.some(p => p.HostIp === address && Number(p.HostPort) === selectedPort), 'backup_endpoint_not_owned_loopback');
}
function secret(envName) { check(typeof envName === 'string' && /^LOOM_BACKUP_[A-Z_]+$/.test(envName) && process.env[envName], 'backup_secret_missing'); return process.env[envName]; }
function clientFor(config, database) {
  return new pg.Client({host:config.postgres.host,port:config.postgres.port,user:identifier(config.postgres.user),
    password:secret(config.postgres.passwordEnv),database:identifier(database),connectionTimeoutMillis:10000,statement_timeout:60000});
}
async function pgSummary(client) {
  const names = (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r => r.tablename);
  const result = {};
  for (const name of names) {
    check(/^[a-z_][a-z0-9_]*$/.test(name), 'backup_table_name');
    const rows = (await client.query(`select row_to_json(t)::text as row from "${name}" t order by row_to_json(t)::text`)).rows.map(r => r.row);
    result[name] = { count: rows.length, sha256: sha256(JSON.stringify(rows)) };
  }
  return result;
}
export function sqliteSummary(db) {
  const tables = db.prepare("select name,sql from sqlite_master where type='table' order by name").all();
  const result = {};
  for (const {name,sql} of tables) {
    check(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name), 'backup_sqlite_table');
    const rows = db.prepare(`select * from "${name}"`).all().map(row => JSON.stringify(row, (_, v) => typeof v === 'bigint' ? `${v}n` : v)).sort();
    result[name] = { schema: sha256(sql), count: rows.length, sha256: sha256(JSON.stringify(rows)) };
  }
  return result;
}
async function drain(client) {
  const connections = (await client.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()")).rows[0].n;
  check(connections === 0, 'backup_database_clients_active');
  for (const [table, condition] of [['sources',"status='running'"],['keywords',"status='running'"],['media_objects',"status='running'"],
    ['extract_jobs',"status='running'"],['ai_jobs',"status='running'"],['ai_runs',"status='running'"],['stage_windows',"status='claimed'"],['ai_budget_reservations',"status='reserved'"]]) {
    check((await client.query(`select count(*)::int n from ${table} where ${condition}`)).rows[0].n === 0, 'backup_inflight_work');
  }
}

// Existing MinIO SDK, configured over stdin so credentials never enter argv.
// ponytail: bounded in-memory archives (256 MiB incl base64); use streaming AEAD
// + multipart/object inventory at larger installations, never remove the cap.
const MINIO_PROGRAM = `import sys,json,base64,io,hashlib
from minio import Minio
from urllib3 import PoolManager,Timeout
try:
 c=json.load(sys.stdin); m=Minio(c['endpoint'],access_key=c['access'],secret_key=c['secret'],secure=False,http_client=PoolManager(timeout=Timeout(connect=5,read=30),retries=False)); b=c['bucket']; op=c['op']
 if op=='exists': out=m.bucket_exists(b)
 elif op=='create':
  if m.bucket_exists(b): raise Exception('exists')
  m.make_bucket(b); out=True
 elif op=='put':
  data=base64.b64decode(c['data'],validate=True); m.put_object(b,c['key'],io.BytesIO(data),len(data)); out=True
 else:
  out=[]; total=0
  for o in sorted(m.list_objects(b,recursive=True),key=lambda x:x.object_name):
   if o.size>268435456: raise Exception('size')
   r=m.get_object(b,o.object_name)
   try: data=r.read(268435457)
   finally: r.close(); r.release_conn()
   total+=len(data)
   if total>268435456 or len(data)!=o.size: raise Exception('size')
   out.append({'key':o.object_name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),**({'data':base64.b64encode(data).decode()} if op=='read' else {})})
 print(json.dumps(out,separators=(',',':')))
except Exception:
 sys.exit(1)
`;
function minio(config, op, bucket, values = {}) {
  const m = config.minio;
  return JSON.parse(run(config.python, ['-c', MINIO_PROGRAM], JSON.stringify({endpoint:`${m.host}:${m.port}`,access:secret(m.accessEnv),secret:secret(m.secretEnv),bucket,op,...values})));
}
function schemaAtRepository() { return readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort(); }
function expected(config) { return { resources:{database:identifier(config.database),bucket:identifier(config.bucket)},schema:schemaAtRepository() }; }
function pgCommand(config, command, args, input) {
  return docker(['exec',...(input ? ['-i'] : []),identifier(config.postgres.container),command,'-U',identifier(config.postgres.user),...args],input);
}
function checkLocalDatabase(path) { noSymlinks(path); check(lstatSync(path).isFile(), 'backup_database_file'); }
function validateMedia(rows, objects) {
  const byKey = new Map(objects.map(o => [o.key,o]));
  for (const row of rows) {
    const object = byKey.get(objectKey(row.object_key));
    check(object && Number(row.bytes) === object.bytes && row.sha256 === object.sha256, 'backup_media_mismatch');
  }
}
function writeExclusive(path, bytes) { writeFileSync(path, bytes, {flag:'wx',mode:0o600}); restrictPath(path); }
export async function snapshotSqlite(source, destination, fenced = false) {
  checkLocalDatabase(source);
  newChild(dirname(destination),basename(destination));
  const db = new DatabaseSync(source); let guard;
  try {
    check(db.prepare('pragma integrity_check').get().integrity_check === 'ok','backup_sqlite_integrity');
    // A separate BEGIN IMMEDIATE connection holds the writer fence while the
    // backup API reads committed pages (including WAL); no raw live-file copy.
    if (!fenced) { guard = new DatabaseSync(source); guard.exec('pragma busy_timeout=1000; begin immediate'); }
    const before = sqliteSummary(db); await backup(db, destination); restrictPath(destination, true);
    same(sqliteSummary(db),before,'backup_sqlite_changed');
    return before;
  } finally { if (guard) {try {guard.exec('rollback');} finally {guard.close();}} db.close(); }
}
export async function createBackup(config) {
  const started = Date.now(); identifier(config.group); identifier(config.generation);
  service(config,'postgres',5432); service(config,'minio',9000); checkWriters(config);
  const destination = newChild(config.backupRoot,config.generation);
  const key = loadKey(config.keyPath,[config.backupRoot,config.scratchRoot]);
  checkLocalDatabase(config.sqlitePath); checkLocalDatabase(config.sessionPath); restrictPath(config.sessionPath);
  const scratch = privateDirectory(config.scratchRoot,`scratch-${config.generation}`);
  const client = clientFor(config,config.database); await client.connect(); let committed = false;
  const fences = [];
  try {
    await client.query('begin'); await client.query("set local lock_timeout='2s'");
    const tables = (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(r => {check(/^[a-z_][a-z0-9_]*$/.test(r.tablename),'backup_table_name');return r.tablename;});
    await client.query(`lock table ${tables.map(n=>`"${n}"`).join(',')} in share mode`);
    await drain(client);
    for (const path of [config.sqlitePath,config.sessionPath]) {
      const fence=new DatabaseSync(path); fences.push(fence); fence.exec('pragma busy_timeout=1000; begin immediate');
    }
    check(fences[0].prepare("select count(*) n from provider_reservations where status='open'").get().n===0,'backup_gateway_inflight');
    const schema = (await client.query('select name from _migrations order by name')).rows.map(r=>r.name);
    same(schema,schemaAtRepository(),'backup_schema_mismatch');
    const pgBefore = await pgSummary(client);
    const media = (await client.query("select object_key,bytes,sha256 from media_objects where status='stored' order by object_key")).rows;
    const objects = minio(config,'read',config.bucket); objects.forEach(o=>objectKey(o.key)); validateMedia(media,objects);
    // Exactly one successful binary pg_dump; failure never emits a partial archive.
    const dump = pgCommand(config,'pg_dump',['-d',identifier(config.database),'--format=custom','--no-owner','--no-acl']);
    const sqlite = await snapshotSqlite(config.sqlitePath,join(scratch,'gateway.sqlite'),true);
    const session = await snapshotSqlite(config.sessionPath,join(scratch,'telegram.session'),true);
    const local = [dump,readFileSync(join(scratch,'gateway.sqlite')),readFileSync(join(scratch,'telegram.session')),...objects.map(o=>Buffer.from(o.data,'base64'))];
    const manifest = { version:1,generation:config.generation,createdAt:new Date().toISOString(),resources:expected(config).resources,schema,
      files:local.map((b,i)=>({name:`${i}.bin`,kind:['postgres','sqlite','session'][i]??'object',...(i>=3?{objectKey:objects[i-3].key}:{}),bytes:b.length,sha256:sha256(b)})) };
    const payload = {manifest,files:local.map(b=>b.toString('base64'))}; validatePayload(payload,expected(config));
    same(await pgSummary(client),pgBefore,'backup_postgres_changed');
    same(minio(config,'summary',config.bucket),objects.map(({data:_,...o})=>o),'backup_objects_changed');
    same(sqliteSummary(fences[0]),sqlite,'backup_sqlite_changed'); same(sqliteSummary(fences[1]),session,'backup_session_changed');
    checkWriters(config); await client.query('commit'); committed = true;
    const encrypted = seal(payload,key);
    mkdirSync(destination,{mode:0o700}); restrictPath(destination,true);
    writeExclusive(join(destination,'generation.loom-backup'),encrypted);
    // No plaintext manifest or table contents in the generation directory.
    return {ok:true,generation:config.generation,createdAt:manifest.createdAt,bytes:encrypted.length,sha256:sha256(encrypted),
      elapsedSeconds:(Date.now()-started)/1000,permissions:restrictPath(destination),postgres:pgBefore,sqlite,sessionSchema:sha256(JSON.stringify(session)),objects:objects.length};
  } finally {
    for(const fence of fences) {try {fence.exec('rollback');} catch { /* Preserve the original failure when acquiring a fence failed. */ } finally {fence.close();}}
    if (!committed) await client.query('rollback').catch(()=>{}); await client.end();
    for (const name of ['gateway.sqlite','telegram.session']) if (existsSync(join(scratch,name))) unlinkSync(join(scratch,name));
  }
}
export async function restoreBackup(config) {
  const started = Date.now(); service(config,'postgres',5432); service(config,'minio',9000);
  noSymlinks(config.archivePath); restrictPath(dirname(config.archivePath)); restrictPath(config.archivePath);
  check(lstatSync(config.archivePath).isFile() && lstatSync(config.archivePath).size<=LIMIT+64,'backup_size_limit');
  const payload = unseal(readFileSync(config.archivePath),loadKey(config.keyPath,[dirname(config.archivePath),config.restoreRoot,config.scratchRoot]));
  const bytes = validatePayload(payload,expected(config));
  const database = identifier(config.targetDatabase); const bucket = identifier(config.targetBucket);
  check(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket),'backup_bucket_name');
  check(database !== config.database && bucket !== config.bucket,'backup_restore_source');
  const destination = newChild(config.restoreRoot,config.restoreGeneration);
  const admin = clientFor(config,'postgres'); await admin.connect();
  let target;
  try {
    assertRestoreTargetIsNew((await admin.query('select datname from pg_database')).rows.map(r=>r.datname),database);
    assertRestoreTargetIsNew(minio(config,'exists',bucket)?[bucket]:[],bucket);
    const dump = bytes[payload.manifest.files.findIndex(f=>f.kind==='postgres')];
    pgCommand(config,'pg_restore',['--list'],dump);
    // Validate SQLite content before creating any restore resource. Scratch is
    // a new private, tool-owned verification resource, never a user target.
    const scratch = privateDirectory(config.scratchRoot,`verify-${identifier(config.restoreGeneration)}`);
    const summaries = {};
    try {
      for (const kind of ['sqlite','session']) {
        const path = join(scratch,`${kind}.sqlite`); writeExclusive(path,bytes[payload.manifest.files.findIndex(f=>f.kind===kind)]);
        const db = new DatabaseSync(path,{readOnly:true});
        try { check(db.prepare('pragma integrity_check').get().integrity_check==='ok','backup_sqlite_integrity'); summaries[kind]=sqliteSummary(db); }
        finally {db.close();}
      }
      await admin.query(`create database "${database}"`);
      pgCommand(config,'pg_restore',['-d',database,'--exit-on-error','--no-owner','--no-acl'],dump);
      target=clientFor(config,database); await target.connect();
      same((await target.query('select name from _migrations order by name')).rows.map(r=>r.name),payload.manifest.schema,'backup_schema_mismatch');
      const media=(await target.query("select object_key,bytes,sha256 from media_objects where status='stored' order by object_key")).rows;
      const objects=payload.manifest.files.filter(f=>f.kind==='object').map(f=>({key:f.objectKey,bytes:f.bytes,sha256:f.sha256}));
      validateMedia(media,objects);
      minio(config,'create',bucket);
      for(let i=0;i<payload.manifest.files.length;i++) if(payload.manifest.files[i].kind==='object') minio(config,'put',bucket,{key:payload.manifest.files[i].objectKey,data:payload.files[i]});
      same(minio(config,'summary',bucket),objects,'backup_restored_objects');
      mkdirSync(destination,{mode:0o700}); restrictPath(destination,true);
      for(const [kind,name] of [['sqlite','gateway.sqlite'],['session','telegram.session']]) {
        const db=new DatabaseSync(join(scratch,`${kind}.sqlite`),{readOnly:true});
        try {await backup(db,join(destination,name)); restrictPath(join(destination,name));} finally {db.close();}
        const restored=new DatabaseSync(join(destination,name),{readOnly:true});
        try {same(sqliteSummary(restored),summaries[kind],'backup_restored_sqlite');} finally {restored.close();}
      }
      return {ok:true,generation:payload.manifest.generation,elapsedSeconds:(Date.now()-started)/1000,
        snapshotAgeSeconds:(Date.now()-Date.parse(payload.manifest.createdAt))/1000,postgres:await pgSummary(target),sqlite:summaries.sqlite,
        sessionSchema:sha256(JSON.stringify(summaries.session)),objects:objects.length,permissions:restrictPath(destination)};
    } finally {
      for(const kind of ['sqlite','session']) if(existsSync(join(scratch,`${kind}.sqlite`))) unlinkSync(join(scratch,`${kind}.sqlite`));
    }
  } finally {await target?.end();await admin.end();}
}
/** Proposal only: last seven daily + last four ISO-week representatives. */
export function retentionCandidates(generations) {
  const sorted=[...generations].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); const keep=new Set(); const days=new Set(); const weeks=new Set();
  for(const row of sorted) {
    identifier(row.generation); const date=new Date(row.createdAt); check(Number.isFinite(date.valueOf()),'backup_timestamp');
    const day=date.toISOString().slice(0,10); date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7)); const week=date.toISOString().slice(0,10);
    if(!days.has(day)&&days.size<7) {days.add(day);keep.add(row.generation);}
    if(!weeks.has(week)&&weeks.size<4) {weeks.add(week);keep.add(row.generation);}
  }
  return sorted.filter(r=>!keep.has(r.generation)).map(r=>r.generation);
}
async function main() {
  const [action,path,name]=process.argv.slice(2);
  if(action==='init-key') { console.log(JSON.stringify({keyPath:initKey(path,name)})); return; }
  check(['backup','restore','retention-plan'].includes(action),'backup_usage');
  noSymlinks(path); restrictPath(path); const config=JSON.parse(readFileSync(path,'utf8'));
  if(action==='retention-plan') {
    const key=loadKey(config.keyPath,[config.backupRoot]); const generations=[];
    for(const name of readdirSync(config.backupRoot)) {
      const dir=join(config.backupRoot,name); noSymlinks(dir);
      if(!lstatSync(dir).isDirectory()||!existsSync(join(dir,'generation.loom-backup')))continue;
      restrictPath(dir); const payload=unseal(readFileSync(join(dir,'generation.loom-backup')),key);validatePayload(payload,expected(config));
      check(name===payload.manifest.generation,'backup_generation_identity');generations.push(payload.manifest);
    }
    console.log(JSON.stringify({deleteActivated:false,candidates:retentionCandidates(generations)}));return;
  }
  console.log(JSON.stringify(await(action==='backup'?createBackup(config):restoreBackup(config))));
}
if(isMainModule(import.meta.url)) main().catch(error=>{const code=/^(backup_[a-z_]+|restore_target_exists|resource_label_mismatch)$/.test(error?.message)?error.message:'collection_backup_failed';console.error(`${code}; resources retained`);process.exitCode=1;});
