#!/usr/bin/env node
/**
 * T19: end-to-end UI verification on an isolated instance, dev and built.
 *
 * It owns the whole stack for the duration: a tagged PostgreSQL container, the
 * migrations, the fixtures for the interactions under test, a dev server, then
 * the built output. Nothing touches the user's environments (8182/8080) or the
 * manual-test container (55191/55192).
 *
 * Fixtures are inserted by this script directly through `pg` — not through a
 * production endpoint — so no app code exists only to serve QA.
 *
 * Checks (see scripts/readiness-ui.mjs for the browser side):
 *   T08 keyword/job states, T11 long body tail, T12 extraction refusal,
 *   T15 library vs external citation labelling; desktop + 390x844 each.
 *
 * Usage: node --experimental-strip-types scripts/readiness-e2e.mjs [--keep]
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import net from "node:net";
import pg from "pg";
import { offlineEnv } from "./readiness-offline.mjs";

const PASSWORD = "review-only-local";
const DB = "review";
const KEEP = process.argv.includes("--keep");
const outDir = resolve("artifacts/production-readiness/ui");
mkdirSync(outDir, { recursive: true });
mkdirSync("screenshots", { recursive: true });

const runId = Date.now().toString(36);
const containerName = `loom-t19-${runId}`;
const report = { runId, checks: [], children: [], ok: false };

function freePort() {
  return new Promise((done) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

function docker(args) {
  const result = spawnSync("docker", args, { env: offlineEnv(process.env), encoding: "utf8", windowsHide: true, timeout: 600_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || "").slice(-500)}`);
  return result.stdout.trim();
}

async function waitForHttp(url, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const up = await fetch(url).then((response) => response.ok).catch(() => false);
    if (up) {
      await new Promise((r) => setTimeout(r, 300)); // let the first paint settle
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** The fixtures the four checks need. */
function fixtures(longBody) {
  return `
    insert into sources (id, platform, name, adapter, feed_url, handle, status, enabled, last_error, interval_minutes)
      values ('qa-readiness','rss','就绪验收材料','rss','https://example.invalid/feed.xml','','idle',false,'',10)
      on conflict (id) do nothing;
    insert into items (id, source_id, platform, external_id, title, body, author, url, media_type, published_at)
      values ('qa-readiness-long','qa-readiness','rss','readiness-long','长正文尾部证据','${longBody.replace(/'/g, "''")}','验收','https://example.invalid/long','article','2026-09-16T02:00:00Z')
      on conflict (id) do nothing;
    insert into items (id, source_id, platform, external_id, title, body, author, url, media_type, published_at)
      values ('qa-readiness-ref','qa-readiness','rss','readiness-ref','引用材料','库内证据文本','验收','https://example.invalid/ref','article','2026-09-16T03:00:00Z')
      on conflict (id) do nothing;
    -- T08: one keyword whose external sources ALL failed, and one scoped to a
    -- local-only platform (which must NOT be reported as an external failure).
    insert into keywords (id, phrase, platforms, interval_minutes, enabled, status, last_error, notes, hits)
      values ('qa-readiness-kw-fail','固态电池','["rss"]'::jsonb,10,true,'error',
              '外部检索全部失败（google_news_zh、google_news_en、hacker_news：http_error）','',0)
      on conflict (id) do update set last_error = excluded.last_error, status = excluded.status;
    insert into keywords (id, phrase, platforms, interval_minutes, enabled, status, last_error, notes, hits)
      values ('qa-readiness-kw-local','电池','["wechat"]'::jsonb,10,true,'ok','','外部无新结果，本地命中 2 条',2)
      on conflict (id) do update set last_error = excluded.last_error, status = excluded.status;
    -- Jobs: the same three states a keyword run can produce.
    insert into jobs (id, source_id, platform, status, kind, items_found, items_new, error, started_at, finished_at)
      values ('qa-readiness-job-fail','src_kw_radar','rss','error','keyword',0,0,
              '外部检索全部失败（google_news_zh、google_news_en、hacker_news：http_error）',
              '2026-09-16T04:00:00Z','2026-09-16T04:00:05Z')
      on conflict (id) do nothing;
    insert into jobs (id, source_id, platform, status, kind, items_found, items_new, error, started_at, finished_at)
      values ('qa-readiness-job-partial','src_kw_radar','rss','ok','keyword',3,1,
              '部分来源失败（hacker_news：rate_limited）',
              '2026-09-16T04:05:00Z','2026-09-16T04:05:05Z')
      on conflict (id) do nothing;
    insert into jobs (id, source_id, platform, status, kind, items_found, items_new, error, started_at, finished_at)
      values ('qa-readiness-job-ok','src_kw_radar','rss','ok','keyword',2,2,'',
              '2026-09-16T04:10:00Z','2026-09-16T04:10:05Z')
      on conflict (id) do nothing;
    -- T12: an oversized image target that was refused, never "extracted".
    insert into media_objects (id, item_id, source_url, kind, status, public_url, content_type, bytes, error)
      values ('qa-readiness-media','qa-readiness-ref','https://example.invalid/big.jpg','image','error',
              'https://example.invalid/big.jpg','image/jpeg',0,'media_too_large')
      on conflict (id) do nothing;
    insert into extract_jobs (id, item_id, media_id, target_key, kind, status, error, attempts)
      values ('qa-readiness-extract','qa-readiness-ref','qa-readiness-media','qa-readiness-media','ocr','error',
              'media_too_large',1)
      on conflict (item_id, target_key) do update set error = excluded.error, status = excluded.status;
  `;
}

async function main() {
  try {
  assert.ok(!readdirSync(".").some(name => /^\.env(?:\.|$)/.test(name)), "offline UI checks refuse root dotenv files");
  const modelConfig = resolve(`artifacts/readiness-ui-unused-${runId}.local.json`);
  assert.ok(!existsSync(modelConfig), "offline model config must not exist");
  const pgPort = await freePort();
  const appPort = await freePort();
  const builtPort = await freePort();
  assert.ok(![8182, 8080, 55192, 55191].includes(appPort), "reserved port");

  docker(["run", "--detach", "--name", containerName, "--label", "loom.readiness.t19=isolated",
    "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `POSTGRES_DB=${DB}`,
    "-p", `127.0.0.1:${pgPort}:5432`, "postgres:16-alpine"]);
  report.container = { name: containerName, port: pgPort };

  let client;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      client = new pg.Client({ host: "127.0.0.1", port: pgPort, user: "postgres", password: PASSWORD, database: DB });
      await client.connect();
      break;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  assert.ok(client, "isolated PG did not come up");

  // Migrations: the real files, in order.
  await client.query("create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())");
  const { readFileSync } = await import("node:fs");
  const migrations = readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort();
  for (const file of migrations) {
    await client.query("begin");
    try {
      await client.query(readFileSync(join("migrations", file), "utf8"));
      await client.query("insert into _migrations(name) values($1)", [file]);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  }
  report.migrations = migrations.length;

  // T11 fixture: >12,000 characters with a unique tail marker.
  const longBody = `${"正文段落。".repeat(1100)}${"补充说明。".repeat(1400)}TAIL-READINESS-12500`;
  assert.ok(longBody.length > 12_000);
  await client.query(fixtures(longBody));
  report.fixtures = "inserted";

  const databaseUrl = `postgresql://postgres:${PASSWORD}@127.0.0.1:${pgPort}/${DB}`;
  const env = offlineEnv(process.env, {
    DATABASE_URL: databaseUrl,
    AI_ENGINE: "legacy",
    AUTO_ANALYZE: "false",
    EXTRACT_AUTO: "false",
    AGENT_ASYNC_RESEARCH_ENABLED: "false",
    AGENT_WORKER_ENABLED: "false",
    AGENT_OPENCODE_WORKER_ENABLED: "false",
    AGENT_ASSISTANT_ENABLED: "false",
    AGENT_ASSISTANT_ACTIONS_ENABLED: "false",
    ARTICLE_READER_ENABLED: "false",
    ARTICLE_READER_ALLOWED_HOSTS: "",
    LOOM_MODEL_CONFIG: modelConfig,
    XAI_API_KEY: "",
    VITE_AUTH_ENABLED: "false",
  });

  const npm = (script, port) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `npm run ${script} -- --host 127.0.0.1 --port ${port} --strictPort`],
      { cwd: resolve("."), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const log = [];
    child.stdout.on("data", (c) => log.push(String(c)));
    child.stderr.on("data", (c) => log.push(String(c)));
    report.children.push({ script, port, pid: child.pid });
    return { child, log };
  };

  const stop = (child) => {
    if (!child || child.exitCode !== null) return;
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { env: offlineEnv(process.env), windowsHide: true, stdio: "ignore" });
  };

  const dev = npm("dev", appPort);
  await waitForHttp(`http://127.0.0.1:${appPort}/knowledge`, 240_000);
  report.dev = { port: appPort };

  // ---- dev checks
  const devRun = spawnSync(process.execPath,
    ["scripts/readiness-ui.mjs", `http://127.0.0.1:${appPort}`, "dev"],
    { encoding: "utf8", windowsHide: true, timeout: 900_000, env: offlineEnv(process.env) });
  report.checks.push({ mode: "dev", exit: devRun.status, stdout: devRun.stdout?.slice(-1200), stderr: devRun.stderr?.slice(-1200) });
  stop(dev.child);
  assert.equal(devRun.status, 0, `dev UI checks failed: ${devRun.stderr?.slice(-800)}`);

  // ---- built checks: same source, production output
  const build = spawnSync("cmd.exe", ["/d", "/s", "/c", "npm run build"],
    { cwd: resolve("."), env, encoding: "utf8", windowsHide: true, timeout: 1_800_000 });
  report.build = { exit: build.status };
  assert.equal(build.status, 0, `build failed: ${(build.stdout || "").slice(-800)}`);

  const built = npm("preview", builtPort);
  await waitForHttp(`http://127.0.0.1:${builtPort}/knowledge`, 240_000);
  report.built = { port: builtPort };
  const builtRun = spawnSync(process.execPath,
    ["scripts/readiness-ui.mjs", `http://127.0.0.1:${builtPort}`, "built"],
    { encoding: "utf8", windowsHide: true, timeout: 900_000, env: offlineEnv(process.env) });
  report.checks.push({ mode: "built", exit: builtRun.status, stdout: builtRun.stdout?.slice(-1200), stderr: builtRun.stderr?.slice(-1200) });
  stop(built.child);
  assert.equal(builtRun.status, 0, `built UI checks failed: ${builtRun.stderr?.slice(-800)}`);

  report.ok = true;
  writeFileSync(join(outDir, `run-${runId}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, container: containerName, dev: appPort, built: builtPort, checks: report.checks.length }, null, 2));
  await client.end();
  } catch (error) {
  report.error = String(error?.message ?? error);
  writeFileSync(join(outDir, `run-${runId}.json`), JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ ok: false, error: report.error, out: outDir }, null, 2));
  process.exitCode = 1;
} finally {
  if (!KEEP) {
    try { docker(["rm", "--force", "--volumes", containerName]); } catch { /* already gone */ }
  } else {
    console.error(`[t19] kept container ${containerName}`);
  }
  process.exit(process.exitCode ?? 0);
  }
}

await main();
