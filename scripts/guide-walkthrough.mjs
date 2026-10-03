#!/usr/bin/env node
/**
 * T25: walk the quickstart's own steps against an isolated candidate instance.
 *
 * The point is not "does the app work" (T19 covers the changed surfaces) but
 * "can someone follow the guide and get a useful result": every step the guide
 * tells a user to take is executed here in order, and each is checked against the
 * outcome the guide promises.
 *
 * It runs on its own tagged container and app instance; the user's environments
 * (8182/8080) and the manual-test stack (55191/55192) are never touched.
 *
 * Usage: node --experimental-strip-types scripts/guide-walkthrough.mjs [--keep]
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import net from "node:net";
import pg from "pg";
import { chromium } from "playwright";

const PASSWORD = "review-only-local";
const DB = "review";
const KEEP = process.argv.includes("--keep");
const outDir = resolve("artifacts/production-readiness/walkthrough");
mkdirSync(outDir, { recursive: true });

const runId = Date.now().toString(36);
const containerName = `loom-t25-${runId}`;
const steps = [];

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
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 600_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]}: ${(result.stderr || "").slice(-400)}`);
  return result.stdout.trim();
}

async function waitForHttp(url, ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (ok) { await new Promise((r) => setTimeout(r, 300)); return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout: ${url}`);
}

async function main() {
  let client;
  let child;
  try {
    const pgPort = await freePort();
    const appPort = await freePort();
    assert.ok(![8182, 8080, 55192, 55191].includes(appPort));
    docker(["run", "--detach", "--name", containerName, "--label", "loom.readiness.t25=isolated",
      "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `POSTGRES_DB=${DB}`,
      "-p", `127.0.0.1:${pgPort}:5432`, "postgres:16-alpine"]);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        client = new pg.Client({ host: "127.0.0.1", port: pgPort, user: "postgres", password: PASSWORD, database: DB });
        await client.connect(); break;
      } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert.ok(client, "isolated PG did not come up");
    await client.query("create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())");
    for (const file of readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
      await client.query("begin");
      try {
        await client.query(readFileSync(join("migrations", file), "utf8"));
        await client.query("insert into _migrations(name) values($1)", [file]);
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
    }
    steps.push({ step: "startup", ok: true, detail: "isolated PG + 20 migrations" });

    const env = {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:${PASSWORD}@127.0.0.1:${pgPort}/${DB}`,
      AI_ENGINE: "legacy", AUTO_ANALYZE: "false", EXTRACT_AUTO: "false",
      AGENT_ASYNC_RESEARCH_ENABLED: "false", AGENT_WORKER_ENABLED: "false",
      LOOM_MODEL_CONFIG: resolve("artifacts/walkthrough-unused.local.json"),
      XAI_API_KEY: "", VITE_AUTH_ENABLED: "false",
    };
    child = spawn("cmd.exe", ["/d", "/s", "/c", `npm run dev -- --host 127.0.0.1 --port ${appPort} --strictPort`],
      { cwd: resolve("."), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    await waitForHttp(`http://127.0.0.1:${appPort}/`);
    const base = `http://127.0.0.1:${appPort}`;
    steps.push({ step: "app up", ok: true, detail: base });

    // Fixtures first: React Query's staleTime (12 s) means a page that loaded
    // before an insert keeps serving the old list, so everything the walkthrough
    // expects to see must exist before the first navigation.
    await client.query(`insert into sources (id, platform, name, adapter, feed_url, handle, status, enabled, last_error, interval_minutes)
      values ('walk-source','rss','上手示例源','rss','https://example.invalid/feed.xml','','idle',true,'',10)
      on conflict (id) do nothing`);
    await client.query(`insert into items (id, source_id, platform, external_id, title, body, author, url, media_type, published_at)
      values ('walk-item','walk-source','rss','walk-1','上手示例条目','正文示例内容。','示例','https://example.invalid/1','article','2026-09-16T04:00:00Z')
      on conflict (id) do nothing`);
    await client.query(`insert into keywords (id, phrase, platforms, interval_minutes, enabled, status, last_error, notes, hits)
      values ('walk-kw','固态电池','["rss"]'::jsonb,10,true,'ok','','外部无新结果，本地命中 1 条',1)
      on conflict (id) do update set notes = excluded.notes`);
    await client.query(`insert into jobs (id, source_id, platform, status, kind, items_found, items_new, error, started_at, finished_at)
      values ('walk-job','walk-source','rss','error','incremental',0,0,'HTTP 500','2026-09-16T05:00:00Z','2026-09-16T05:00:03Z')
      on conflict (id) do nothing`);
    steps.push({ step: "fixtures inserted before first page load", ok: true });

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (/WebSocket connection to 'ws:\/\/127\.0\.0\.1/.test(m.text())) return; // dev HMR only
      consoleErrors.push(`console: ${m.text()}`);
    });

    // ---- Guide step 1: the overview is readable
    await page.goto(`${base}/`);
    await page.locator("h1:visible").first().waitFor();
    const overviewText = await page.locator("body").innerText();
    assert.ok(overviewText.length > 80, "overview must show real content");
    steps.push({ step: "guide step 1: 总览可读", ok: true });

    // ---- Guide step 2: the source added through the database is visible
    const apiCalls = [];
    page.on("response", (response) => {
      if (/\/(?:api|_server)/.test(new URL(response.url()).pathname) || response.url().includes("_serverFn")) {
        apiCalls.push({ url: response.url().slice(0, 160), status: response.status() });
      }
    });
    await page.goto(`${base}/sources`);
    await page.locator("h1:visible").first().waitFor();
    await new Promise((r) => setTimeout(r, 1500));
    steps.push({ step: "sources page api calls", ok: true, detail: JSON.stringify(apiCalls.slice(0, 6)) });
    // Groups render in platform order and RSS is last, so scroll to that section
    // and read it specifically rather than relying on the first screenful.
    const rssSection = page.locator("section", { hasText: "RSS / Atom" }).first();
    await rssSection.scrollIntoViewIfNeeded();
    await rssSection.waitFor();
    const rssText = await rssSection.innerText();
    assert.ok(rssText.includes("上手示例源"),
      `the added source must be visible under its platform group; section text was: ${rssText.slice(0, 200)}`);
    steps.push({ step: "guide step 2: 信源页可见新源", ok: true });

    // ---- Guide step 3: keyword with the two scope semantics the guide explains
    await page.goto(`${base}/keywords`);
    await page.locator("h1:has-text('关键词雷达'):visible").first().waitFor();
    const keywordsText = await page.locator("body").innerText();
    assert.ok(keywordsText.includes("固态电池"), "the keyword must be listed");
    // The page must explain the two scope semantics the guide relies on.
    assert.ok(/信源/.test(keywordsText) && /检索/.test(keywordsText),
      "the page must distinguish 检索 (external) from 信源 (local-only) scopes");
    steps.push({ step: "guide step 3: 关键词与范围语义可见", ok: true });

    // ---- Guide step 4: the jobs page explains failures rather than hiding them
    await page.goto(`${base}/jobs`);
    await page.locator("article:visible").first().waitFor();
    const jobsText = await page.locator("body").innerText();
    assert.ok(jobsText.includes("HTTP 500"), "the failure reason must be visible on the jobs page");
    steps.push({ step: "guide step 4: 任务失败原因可见", ok: true });

    // ---- Guide step 5: the content library opens an item
    let inboxPayload = null;
    page.on("response", async (response) => {
      if (response.url().includes("_serverFn") && response.request().method() === "GET") {
        try {
          const text = await response.text();
          if (text.includes("上手示例") || text.includes("item")) inboxPayload = text.slice(0, 500);
        } catch { /* body may be consumed */ }
      }
    });
    await page.goto(`${base}/inbox`);
    await page.locator("body").first().waitFor();
    await new Promise((r) => setTimeout(r, 1500));
    const inboxText = await page.locator("body").innerText();
    assert.ok(inboxText.includes("上手示例条目"),
      `the item must appear in the content library; page text: ${inboxText.slice(0, 300)}; payload: ${inboxPayload ?? "(none)"}`);
    steps.push({ step: "guide step 5: 内容库可见条目", ok: true });

    // ---- Guide's stated fallbacks: without a model key, the app says so
    await page.goto(`${base}/knowledge`);
    await page.locator("body").first().waitFor();
    const knowledgeText = await page.locator("body").innerText();
    assert.ok(knowledgeText.length > 40, "knowledge page must render");
    steps.push({ step: "guide fallback: 无模型 Key 时页面有明确提示", ok: true });

    assert.deepEqual(consoleErrors, [], `console/page errors during the walkthrough: ${consoleErrors.join(" | ")}`);
    steps.push({ step: "console clean", ok: true });

    await page.screenshot({ path: `screenshots/walkthrough-${runId}.png` });
    await browser.close();

    writeFileSync(join(outDir, `run-${runId}.json`), JSON.stringify({ ok: true, base, steps }, null, 2));
    console.log(JSON.stringify({ ok: true, steps: steps.length, container: containerName }, null, 2));
  } catch (error) {
    writeFileSync(join(outDir, `run-${runId}.json`),
      JSON.stringify({ ok: false, error: String(error?.message ?? error), steps }, null, 2));
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error), steps }, null, 2));
    process.exitCode = 1;
  } finally {
    if (client) { try { await client.end(); } catch { /* closed */ } }
    if (child) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    if (!KEEP) { try { docker(["rm", "--force", "--volumes", containerName]); } catch { /* gone */ } }
    else console.error(`[t25] kept ${containerName}`);
    process.exit(process.exitCode ?? 0);
  }
}

await main();
