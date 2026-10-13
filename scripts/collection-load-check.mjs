#!/usr/bin/env node
/**
 * T17: offline capacity check — 100 and 1000 sources through the REAL pipeline.
 *
 * What it exercises (not a simulation of it):
 *   - the real `tickDueSources` scheduler path, real migrations, a real PostgreSQL;
 *   - the real per-source insert/merge code (`runSourceJob` -> `persistHit`-style
 *     upsert) so duplicate rules and cursor advances are the production ones;
 *   - a stub **transport** only, so no network is touched. Feeds are generated
 *     in-process, which is exactly the seam T06 introduced.
 *
 * What the plan asks it to record: due-to-start P50/P95, wall time, oldest wait,
 * failure/deferred counts, duplicate rate and DB growth — at 100 sources, then at
 * 1000, with a **fresh isolated database each pass** so the second run does not
 * inherit the first's rows.
 *
 * Honest scope note: this is a *burst* measurement, not a 72 h / 7 day soak. The
 * plan separates those (T23), and no fast run here may be reported as endurance
 * evidence.
 *
 * Usage:
 *   node --experimental-strip-types scripts/collection-load-check.mjs --sources 100 --entries 60
 *   node --experimental-strip-types scripts/collection-load-check.mjs --sources 1000
 *   ... --keep        # keep the container for inspection
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const PASSWORD = "review-only-local";
const DB = "review";
const reportRoot = resolve("artifacts/production-readiness/load");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const SOURCE_COUNT = Number(arg("--sources", "100"));
const ENTRY_COUNT = Number(arg("--entries", "60"));
const SEED = Number(arg("--seed", "20260916"));
const KEEP = process.argv.includes("--keep");
assert.ok(Number.isSafeInteger(SOURCE_COUNT) && SOURCE_COUNT > 0 && SOURCE_COUNT <= 5000, "invalid --sources");
assert.ok(Number.isSafeInteger(ENTRY_COUNT) && ENTRY_COUNT > 0 && ENTRY_COUNT <= 1000, "invalid --entries");
assert.ok(Number.isSafeInteger(SEED), "invalid --seed");

/** Deterministic PRNG so a run is reproducible from its seed. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 600_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || "").slice(-600)}`);
  return result.stdout.trim();
}

function freePort() {
  const r = spawnSync(process.execPath, ["-e",
    "const n=require('node:net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"],
    { encoding: "utf8", windowsHide: true });
  return Number(r.stdout.trim());
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

/** One feed body per source; `round` selects which items that round carries. */
function feedFor(index, round) {
  const items = [];
  for (let i = 0; i < ENTRY_COUNT; i += 1) {
    const serial = round * ENTRY_COUNT + i;
    items.push(
      `<item><title>源${index} 第${round}轮 条目${i}</title>` +
      `<link>https://example.invalid/s${index}/i${serial}</link>` +
      `<guid>s${index}-i${serial}</guid>` +
      `<description>正文 ${index} ${serial} 电池 良率</description>` +
      `<pubDate>Tue, 15 Sep 2026 02:00:00 GMT</pubDate></item>`,
    );
  }
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>源${index}</title>${items.join("")}</channel></rss>`;
}

/**
 * A transport that answers each feed request from the current round.
 *
 * The source index comes from the REQUESTED url (`/s<index>/feed.xml`), not from
 * a call counter: using the counter made every request look like a different
 * source, so a replay of identical content produced new rows and the duplicate
 * check could not pass. That is exactly the kind of harness bug this script's own
 * assertions are meant to catch.
 */
function stubTransport(currentRound) {
  let calls = 0;
  let feedCalls = 0;
  const slowCalls = [];
  const transport = async (url) => {
    calls += 1;
    const round = currentRound.value;
    // The keyword jobs query the search endpoints (Google News, HN, B 站). Those
    // are NOT the point of a collection-load check, and answering them with an
    // RSS body made B 站's JSON parser fail — correctly reported as
    // `invalid_response` by T08, but pure noise here. They get an empty, valid,
    // per-endpoint answer instead.
    if (!/\/s\d+\//.test(url.href)) {
      const isBili = url.hostname.includes("bilibili");
      return {
        status: 200,
        headers: { "content-type": isBili ? "application/json" : "application/rss+xml" },
        body: new Response(isBili
          ? JSON.stringify({ code: 0, data: { result: [] } })
          : '<?xml version="1.0"?><rss version="2.0"><channel><title>empty</title></channel></rss>').body,
      };
    }
    feedCalls += 1;
    const index = Number(/\/s(\d+)\//.exec(url.href)?.[1] ?? 0);
    // Slow sources: a deterministic minority answers slowly, so a fast source
    // must not be starved by a slow one (the plan's explicit requirement).
    const slow = calls % 97 === 0;
    if (slow) {
      slowCalls.push(index);
      await new Promise((r) => setTimeout(r, 120));
    }
    return {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
      body: new Response(feedFor(index, round)).body,
    };
  };
  return { transport, calls: () => calls, feedCalls: () => feedCalls, slowCalls: () => slowCalls };
}

const resolver = { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } };

async function migrate(client) {
  await client.query("create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())");
  const files = readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort();
  for (const file of files) {
    await client.query("begin");
    try {
      await client.query(readFileSync(join("migrations", file), "utf8"));
      await client.query("insert into _migrations(name) values($1)", [file]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  return files.length;
}

async function main() {
  mkdirSync(reportRoot, { recursive: true });
  const out = mkdtempSync(join(reportRoot, `run-${SOURCE_COUNT}-`));
  const name = `loom-t17-${SOURCE_COUNT}-${Date.now().toString(36)}`;
  const port = freePort();
  let client;
  let started = false;
  let vite;
  const memorySamples = [];
  const memory = () => { const sample = { elapsed_ms: Math.round(performance.now() - memoryStart), ...process.memoryUsage() }; memorySamples.push(sample); return sample; };
  const memoryStart = performance.now();
  const memoryTimer = setInterval(memory, 100);
  memory();
  try {
    docker(["run", "--detach", "--name", name, "--label", "loom.readiness.t17=isolated",
      "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `POSTGRES_DB=${DB}`,
      "-p", `127.0.0.1:${port}:5432`, "postgres:16-alpine"]);
    started = true;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: PASSWORD, database: DB });
        await client.connect();
        break;
      } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert.ok(client, "isolated PG did not come up");
    const migrations = await migrate(client);

    // The scheduler resolves its database through `getSql()`, which reads
    // `DATABASE_URL`. Without this the app would silently use its in-process
    // PGLite fallback and every row would land in a different (empty) database —
    // which is exactly what the first run of this script did.
    process.env.DATABASE_URL = `postgresql://postgres:${PASSWORD}@127.0.0.1:${port}/${DB}`;

    // The real scheduler and the real upsert path, loaded through Vite so the
    // `@/` aliases resolve (bare Node would fail on resolution, not on logic).
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: false, logLevel: "silent",
      resolve: { alias: { "@": resolve("src") } },
      server: { middlewareMode: true },
    });
    const { tickDueSources } = await vite.ssrLoadModule("/src/lib/server/scheduler.ts");

    // ---- seed the sources
    const random = rng(SEED);
    const values = [];
    const params = [];
    for (let i = 0; i < SOURCE_COUNT; i += 1) {
      params.push(`src-${i}`, `源 ${i}`, `https://example.invalid/s${i}/feed.xml`);
      const at = params.length;
      values.push(`($${at - 2}, 'rss', $${at - 1}, 'rss', $${at}, '', 'idle', true, '', 10)`);
      void random;
    }
    await client.query(
      `insert into sources (id, platform, name, adapter, feed_url, handle, status, enabled, last_error, interval_minutes)
       values ${values.join(",")}`,
      params,
    );
    // Two keywords so the keyword half of a tick is exercised as well.
    await client.query(
      `insert into keywords (id, phrase, platforms, interval_minutes, enabled, status, notes)
       values ('kw-1','电池','[]'::jsonb,10,true,'idle',''), ('kw-2','良率','[]'::jsonb,10,true,'idle','')`,
    );

    const counts = async () => {
      // node-postgres returns a result object; read `.rows` explicitly.
      const { rows } = await client.query(
        `select (select count(*) from items)::int as items,
                (select count(*) from jobs)::int as jobs,
                (select count(*) from sources where last_scanned_at is not null)::int as scanned`);
      return rows[0];
    };

    const round = { value: 1 };
    const { transport, calls, feedCalls, slowCalls } = stubTransport(round);

    /** Run one pass of ticks until the due set drains, recording due-to-start. */
    async function pass(label, nextRound) {
      // Advancing the round is what makes the second pass carry NEW items
      // (serial = round*ENTRY_COUNT + i), so two complete ID sets prove
      // incremental collection across distinct upstream responses.
      if (nextRound !== undefined) round.value = nextRound;
      // A burst cannot wait out each source's 10-minute interval, so due-ness is
      // simulated by ageing `last_scanned_at`. This is a harness action, and it is
      // precisely equivalent to the wall clock advancing — the due-time query the
      // scheduler runs is the production one either way.
      await client.query(
        `update sources set last_scanned_at = now() - interval '1 hour'
          where id like 'src-%' and adapter = 'rss'`);
      await client.query(
        `update keywords set last_scanned_at = now() - interval '1 hour'`);
      const startedAt = Date.now();
      const memoryBefore = memory();
      const stats = { ticks: 0, ran: 0, items_new: 0, errors: 0, deferred: 0 };
      // Each tick handles TICK_LIMIT sources; loop until a tick reports no work.
      for (let guard = 0; guard < 5000; guard += 1) {
        const before = Date.now();
        // tickDueSources(limit, cronBudget, io) — the seam is the THIRD argument;
        // passing it second would be swallowed as a budget option and the real
        // network transport would be used (which is why the first attempt showed
        // zero transport calls and all-error sources).
        const result = await tickDueSources(200, {}, { resolver, transport });
        stats.ticks += 1;
        stats.ran += result.ran;
        stats.items_new += result.items_new;
        stats.errors += result.errors;
        stats.deferred += result.deferred;
        void before;
        if (result.ran === 0) break;
      }
      const timingRows = (await client.query(`select extract(epoch from (started_at - $1::timestamptz))*1000 as wait_ms from jobs where source_id like 'src-%' and started_at >= $1::timestamptz`, [new Date(startedAt).toISOString()])).rows;
      const waits = timingRows.map((row) => Number(row.wait_ms));
      return { label, ms: Date.now() - startedAt, ...stats, source_jobs: waits.length,
        due_to_start_p50_ms: percentile(waits, 0.5), due_to_start_p95_ms: percentile(waits, 0.95), oldest_wait_ms: Math.max(0, ...waits),
        node_memory_before: memoryBefore, node_memory_after: memory() };
    }

    const before1 = await counts();
    const pass1 = await pass("round 1", 1);
    const after1 = await counts();
    assert.equal(Number((await client.query("select count(*)::int as n from items where source_id like 'src-%'")).rows[0].n), SOURCE_COUNT * ENTRY_COUNT);

    const round2 = await pass("round 2", 2);
    const after2 = await counts();

    // A third pass re-reading the SAME content as round 2 must add nothing.
    const replay = await pass("replay (same content, expect 0 new)", 2);
    const after3 = await counts();

    // Duplicate check: every item's (source, external_id) must be unique because
    // of the schema constraint; what we verify is that re-running adds nothing.
    const duplicates = Number((await client.query(
      `select count(*)::int as n from (
         select source_id, external_id from items group by source_id, external_id having count(*) > 1
       ) d`)).rows[0].n);
    assert.equal(duplicates, 0, "no duplicate (source, external_id) may exist");

    const persistedRows = (await client.query("select source_id,external_id from items where source_id like 'src-%' order by source_id,external_id")).rows;
    const storedBySource = new Map();
    for (const row of persistedRows) {
      if (!storedBySource.has(row.source_id)) storedBySource.set(row.source_id, []);
      storedBySource.get(row.source_id).push(row.external_id);
    }
    const sourceChecks = Array.from({ length: SOURCE_COUNT }, (_, index) => {
      const expectedIds = [1, 2].flatMap((round) => Array.from({ length: ENTRY_COUNT }, (_, i) => `s${index}-i${round * ENTRY_COUNT + i}`));
      const storedIds = storedBySource.get(`src-${index}`) ?? [];
      const missing = expectedIds.filter((id) => !storedIds.includes(id));
      assert.equal(storedIds.length, ENTRY_COUNT * 2, `source ${index} persisted entry count`);
      assert.deepEqual(missing, [], `source ${index} missing upstream fixture IDs`);
      return { source_id: `src-${index}`, upstream_ids: expectedIds, persisted_ids: storedIds, returned_by_upstream: expectedIds.length,
        persisted: storedIds.length, missing_ids: missing, missing: missing.length };
    });
    assert.equal(pass1.items_new, SOURCE_COUNT * ENTRY_COUNT);
    assert.equal(round2.items_new, SOURCE_COUNT * ENTRY_COUNT);
    assert.equal(replay.items_new, 0, "replaying round two must add zero");
    assert.equal(after3.items, after2.items);
    assert.ok(calls() <= SOURCE_COUNT * 3 + 100, "keyword fixtures must keep total requests bounded");
    assert.equal(feedCalls(), SOURCE_COUNT * 3, "exactly one feed request per source per pass");
    for (const pass of [pass1, round2, replay]) {
      assert.equal(pass.errors, 0);
      assert.equal(pass.source_jobs, SOURCE_COUNT);
    }
    const coverageRows = (await client.query("select source_id,coverage,status from jobs where source_id like 'src-%' order by source_id,started_at")).rows;
    assert.ok(coverageRows.every((job) => job.coverage?.window_only === true), "RSS jobs keep their finite-window coverage");
    writeFileSync(join(out, "source-ids.json"), JSON.stringify(sourceChecks, null, 2));
    memory();
    writeFileSync(join(out, "memory-samples.json"), JSON.stringify(memorySamples, null, 2));

    const perSource = Number((await client.query(
      `select coalesce(round(avg(n), 2), 0)::float as avg_n from (
         select source_id, count(*) as n from items group by source_id) t`)).rows[0].avg_n);
    // Two full fixture rounds per source (the radar source
    // holds keyword hits, so it is excluded from the per-source figure).
    const perRealSource = Number((await client.query(
      `select coalesce(round(avg(n), 2), 0)::float as avg_n from (
         select source_id, count(*) as n from items
          where source_id like 'src-%' group by source_id) t`)).rows[0].avg_n);

    const dbSize = Number((await client.query(
      "select pg_database_size(current_database())::bigint as bytes")).rows[0].bytes);

    const result = {
      ok: true,
      sources: SOURCE_COUNT,
      entries_per_response: ENTRY_COUNT,
      returned_by_upstream: SOURCE_COUNT * ENTRY_COUNT * 3,
      distinct_upstream_ids: SOURCE_COUNT * ENTRY_COUNT * 2,
      persisted: persistedRows.length, missing: 0,
      window_status: "window_only", source_job_statuses: [...new Set(coverageRows.map((job) => job.status))],
      feed_transport_calls: feedCalls(), slow_source_calls: slowCalls(),
      sample_feed_bytes: Buffer.byteLength(feedFor(0, 1)),
      node_memory_sample_peak: Object.fromEntries(["rss", "heapUsed", "external", "arrayBuffers"].map((key) => [key, Math.max(...memorySamples.map((sample) => sample[key]))])),
      node_memory_scope: "100ms samples of this Node process only; not PostgreSQL or whole-machine peak",
      evidence_dir: out,
      seed: SEED,
      migrations,
      transport_calls: calls(),
      round1: pass1,
      round2,
      replay,
      items_before: before1.items,
      items_after_round1: after1.items,
      items_after_round2: after2.items,
      items_after_replay: after3.items,
      jobs: after2.jobs,
      duplicate_pairs: duplicates,
      avg_items_per_source: perSource,
      avg_items_per_real_source: perRealSource,
      db_bytes: dbSize,
      note: "burst measurement only; not endurance evidence (see T23)",
    };
    writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    writeFileSync(join(out, "result.json"), JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error), out }, null, 2));
    process.exitCode = 1;
  } finally {
    clearInterval(memoryTimer);
    if (vite) await vite.close();
    if (client) { try { await client.end(); } catch { /* already closed */ } }
    if (started) {
      if (process.exitCode !== 1 && !KEEP) docker(["rm", "--force", "--volumes", name]);
      else console.error(`[t17] kept container ${name}`);
    }
    process.exit(process.exitCode ?? 0);
  }
}

// Fresh runtime allowlist excludes ambient DB/model/provider configuration.
if (!process.argv.includes("--isolated-child")) {
  const { offlineEnv } = await import("./readiness-offline.mjs");
  const child = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2), "--isolated-child"], {
    stdio: "inherit", windowsHide: true,
    env: offlineEnv(process.env, { LOOM_RUNTIME_MODE: "test", AI_ENGINE: "legacy", DATABASE_URL: undefined,
      LOOM_MODEL_CONFIG: resolve("artifacts/collection-capability/no-model-config.json"),
      AUTO_ANALYZE: "false", EXTRACT_AUTO: "false", AGENT_WORKER_ENABLED: "false", AGENT_ASYNC_RESEARCH_ENABLED: "false",
      AGENT_OPENCODE_WORKER_ENABLED: "false", AGENT_ASSISTANT_ENABLED: "false", AGENT_ASSISTANT_ACTIONS_ENABLED: "false", XAI_API_KEY: "" }),
  });
  process.exit(child.status ?? 1);
} else main();
