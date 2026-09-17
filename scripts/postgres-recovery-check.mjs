#!/usr/bin/env node
/**
 * T03: PostgreSQL backup/restore copy tool, verified on an isolated database.
 *
 * Scope, on purpose:
 *   - Creates only its own tagged resources and refuses to touch anything else.
 *   - Never accepts a production DSN by default: it *derives* its connection
 *     from a container it created, so pointing it at a live database would take
 *     deliberate edits to this file.
 *   - Defaults to reporting a failure without deleting the scene (the caller
 *     decides cleanup), so a failed restore keeps its evidence.
 *
 * What it proves end to end: isolated PG + real migrations + business rows →
 * `pg_dump` to a non-git directory → SHA-256 + migration inventory in a manifest
 * → `pg_restore` into a *second* database → per-table counts and ordered-row
 * digests match the same snapshot point.
 *
 * What it deliberately does NOT do: capture a running SQLite file, back up
 * MinIO objects or Telethon sessions (those are runbook procedures, T03 step 6),
 * and never a live/production database (T22).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import pg from "pg";
import {
  assertRestoreTargetIsNew,
  assertTaggedResource,
  exitStatusFor,
} from "./restore-policy.mjs";

const PASSWORD = "review-only-local";
const USER = "postgres";
const SOURCE_DB = "review";
const RESTORE_DB = "review_restored";
const reportRoot = resolve("artifacts/production-readiness/pg-recovery");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Fixed verification rows: a material, a reference, an analysis and a pending job. */
const FIXTURES = `
insert into sources(id,platform,name) values('t03-source','rss','T03隔离恢复材料');
insert into items(id,source_id,platform,external_id,title,body,author,url,media_type,matched_keywords,published_at)
values
 ('t03-item-a','t03-source','rss','t03-a','恢复核对条目A','正文：良率97%。TAIL-T03-A','作者A','https://example.invalid/a','article','["恢复"]','2026-09-15T02:00:00Z'),
 ('t03-item-b','t03-source','rss','t03-b','恢复核对条目B','正文：返工率3%。','作者B','https://example.invalid/b','article','[]','2026-09-15T03:00:00Z');
insert into analyses(id,item_id,summary,topics,insights,tags) values('t03-analysis','t03-item-a','恢复摘要97%','["恢复"]','良率证据','[]');
insert into knowledge_notes(id,title,content,item_ids) values('t03-note','T03恢复简报','引用恢复条目A','["t03-item-a"]');
insert into extract_jobs(id,item_id,kind,status) values('t03-ocr','t03-item-b','ocr','pending');
`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function docker(args, options) {
  const result = run("docker", args, options);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed (${result.status}): ${(result.stderr || result.stdout).slice(-800)}`);
  }
  return result.stdout.trim();
}

/** Dump/restore inside the container so credentials never reach argv or logs. */
function psqlInContainer(name, database, sql) {
  return docker(["exec", "-i", name, "psql", "-v", "ON_ERROR_STOP=1", "-U", USER, "-d", database, "-f", "-"], {
    input: sql,
  });
}

async function tableSummary(client, database) {
  const tables = (
    await client.query(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
  ).rows.map((r) => r.tablename);
  const summary = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/, `unexpected table name: ${table}`);
    const rows = (
      await client.query(
        `select row_to_json(t)::text as row from "${table}" t order by row_to_json(t)::text`,
      )
    ).rows.map((r) => r.row);
    summary[table] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
  }
  return summary;
}

async function connect(port, database) {
  const client = new pg.Client({ host: "127.0.0.1", port, user: USER, password: PASSWORD, database });
  await client.connect();
  return client;
}

function freePort() {
  const result = run(process.execPath, [
    "-e",
    "const n=require('node:net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});",
  ]);
  return Number(result.stdout.trim());
}

const name = `loom-t03-${Date.now().toString(36)}`;
mkdirSync(reportRoot, { recursive: true });
const backupDir = mkdtempSync(join(reportRoot, "run-"));
const archive = join(backupDir, "source.dump");
const manifestPath = join(backupDir, "manifest.json");
let port;
let containerStarted = false;

try {
  // ---- isolated source database: tagged container, loopback port, own name
  port = freePort();
  docker([
    "run", "--detach", "--name", name, "--label", "loom.readiness.t03=isolated",
    "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `POSTGRES_DB=${SOURCE_DB}`,
    "-p", `127.0.0.1:${port}:5432`, "postgres:16-alpine",
  ]);
  containerStarted = true;

  const sourceClient = await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        return await connect(port, SOURCE_DB);
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error("isolated PG did not become reachable");
  })();

  // ---- real migrations, real business rows
  await sourceClient.query(
    "create table if not exists _migrations(name text primary key, applied_at timestamptz not null default now())",
  );
  const migrationFiles = readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort();
  for (const file of migrationFiles) {
    await sourceClient.query("begin");
    try {
      await sourceClient.query(readFileSync(join("migrations", file), "utf8"));
      await sourceClient.query("insert into _migrations(name) values($1)", [file]);
      await sourceClient.query("commit");
    } catch (err) {
      await sourceClient.query("rollback");
      throw err;
    }
  }
  await sourceClient.query(FIXTURES);

  // ---- failure scenarios first: a refusal must not silently succeed
  const failures = {};

  // (1) refuse to overwrite an existing restore target
  psqlInContainer(name, SOURCE_DB, `create database ${RESTORE_DB}`);
  const existingTargets = (
    await sourceClient.query("select datname from pg_database where datname = $1", [RESTORE_DB])
  ).rows.map((r) => r.datname);
  assert.deepEqual(existingTargets, [RESTORE_DB], "the pre-created target should exist");
  assert.throws(
    () => assertRestoreTargetIsNew(existingTargets, RESTORE_DB),
    /restore_target_exists/,
    "an existing restore target must be refused",
  );
  failures.overwriteExistingTarget = "rejected as designed: restore_target_exists";
  await sourceClient.query(`drop database ${RESTORE_DB}`);

  // (2) a corrupted backup must be rejected, not half-restored
  writeFileSync(join(backupDir, "corrupt.dump"), Buffer.from("not-a-postgres-dump"), { flag: "wx" });
  const corrupt = spawnSync("docker", [
    "exec", "-i", name, "pg_restore", "--list", "-",
  ], { input: Buffer.from("not-a-postgres-dump"), windowsHide: true, timeout: 60000 });
  assert.notEqual(corrupt.status, 0, "a corrupt archive must not list/restore cleanly");
  failures.corruptArchive = `rejected as designed (exit ${corrupt.status})`;

  // (3) a wrong resource label must be refused rather than reported as success
  assertTaggedResource(
    docker(["inspect", "--format", '{{index .Config.Labels "loom.readiness.t03"}}', name]),
  );
  assert.throws(
    () => assertTaggedResource(undefined),
    /resource_label_mismatch/,
    "an unlabelled (foreign or missing) resource must be refused",
  );
  failures.wrongResourceTag = "rejected as designed: resource_label_mismatch";

  // ---- snapshot point: stop accepting writes, then dump
  const sourceSummary = await tableSummary(sourceClient, SOURCE_DB);
  const migrationList = (
    await sourceClient.query("select name from _migrations order by name")
  ).rows.map((r) => r.name);
  await sourceClient.end();

  const dumped = docker([
    "exec", name, "pg_dump", "-U", USER, "-d", SOURCE_DB, "--format=custom", "--no-owner", "--no-acl",
  ], { maxBuffer: 256 * 1024 * 1024 });

  // pg_dump writes binary to stdout; spawnSync with encoding utf8 would corrupt it,
  // so re-run capturing bytes.
  const dumpBytes = spawnSync("docker", [
    "exec", name, "pg_dump", "-U", USER, "-d", SOURCE_DB, "--format=custom", "--no-owner", "--no-acl",
  ], { windowsHide: true, timeout: 180000, maxBuffer: 256 * 1024 * 1024 }).stdout;
  assert.ok(Buffer.isBuffer(dumpBytes) && dumpBytes.length > 0, "pg_dump produced no bytes");
  writeFileSync(archive, dumpBytes, { flag: "wx" });
  assert.ok(dumped !== null);

  const manifest = {
    createdAt: new Date().toISOString(),
    sha256: hash(dumpBytes),
    bytes: dumpBytes.length,
    postgresVersion: docker(["exec", name, "pg_dump", "--version"]).trim(),
    sourceDatabase: SOURCE_DB,
    migrations: migrationList,
    tables: sourceSummary,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx" });

  // ---- restore into a second database, then compare at the same snapshot point
  psqlInContainer(name, SOURCE_DB, `create database ${RESTORE_DB}`);
  const restored = spawnSync("docker", [
    "exec", "-i", name, "pg_restore", "-U", USER, "-d", RESTORE_DB, "--exit-on-error", "--no-owner", "--no-acl",
  ], { input: dumpBytes, windowsHide: true, timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(restored.status, 0, `pg_restore failed: ${String(restored.stderr).slice(-800)}`);

  const restoredClient = await connect(port, RESTORE_DB);
  const restoredSummary = await tableSummary(restoredClient, RESTORE_DB);
  assert.deepEqual(restoredSummary, sourceSummary, "restored copy diverged from the snapshot");
  const restoredNote = (
    await restoredClient.query("select title, content, item_ids from knowledge_notes where id='t03-note'")
  ).rows[0];
  assert.equal(restoredNote.title, "T03恢复简报");
  const restoredAnalysis = (
    await restoredClient.query("select summary from analyses where item_id='t03-item-a'")
  ).rows[0];
  assert.equal(restoredAnalysis.summary, "恢复摘要97%");
  const restoredPending = (
    await restoredClient.query("select count(*)::int as n from extract_jobs where status='pending'")
  ).rows[0];
  assert.equal(restoredPending.n, 1, "pending extract job did not survive the restore");
  await restoredClient.end();

  const result = {
    ok: true,
    container: name,
    port,
    backupDir,
    archive,
    sha256: manifest.sha256,
    bytes: manifest.bytes,
    migrations: migrationList.length,
    tables: Object.keys(restoredSummary).length,
    rows: Object.values(restoredSummary).reduce((total, t) => total + t.count, 0),
    failureScenarios: failures,
    restoredReadback: {
      note: restoredNote.title,
      analysis: restoredAnalysis.summary,
      pendingExtractJobs: restoredPending.n,
    },
  };
  writeFileSync(join(backupDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  const failure = { ok: false, container: name, port, backupDir, error: String(err?.message || err) };
  writeFileSync(join(backupDir, "result.json"), JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure, null, 2));
  // Keep the scene: a failed restore must leave its evidence behind.
  process.exit(1);
} finally {
  if (containerStarted) {
    // Only this batch's tagged container is removed; a failed run keeps it.
    const ok = existsSync(join(backupDir, "result.json")) &&
      JSON.parse(readFileSync(join(backupDir, "result.json"), "utf8")).ok === true;
    if (ok && process.env.LOOM_T03_KEEP !== "1") {
      docker(["rm", "--force", "--volumes", name], { stdio: "pipe" });
    } else {
      console.error(`[t03] kept container ${name} for inspection (LOOM_T03_KEEP or failure)`);
    }
  }
}
