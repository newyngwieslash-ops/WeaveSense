#!/usr/bin/env node
/** Five public seed feeds only: one bounded snapshot or finite 13-round / 24h observation. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { offlineEnv } from "../../scripts/readiness-offline.mjs";

const sourceIds = ["src_rss_qbitai", "src_rss_ifanr", "src_rss_sspai", "src_rss_solidot", "src_rss_bbc"];
const TWO_HOURS = 2 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const valueOf = (value) => typeof value === "string" ? value : typeof value?.["#text"] === "string" ? value["#text"] : "";
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

// Independent identity-only oracle: entries without guid/id/link remain incomparable.
// It intentionally does not reproduce production title/date/media/body parsing.
export function referenceIds(xml) {
  if (XMLValidator.validate(xml) !== true) throw new Error("reference_invalid_xml");
  const doc = parser.parse(xml);
  let entries;
  if (doc.rss) entries = asArray((doc.rss.channel ?? doc.rss).item);
  else if (doc.feed) entries = asArray(doc.feed.entry);
  else if (doc["rdf:RDF"]) entries = asArray(doc["rdf:RDF"].item);
  else throw new Error("reference_invalid_root");
  const rawIds = entries.map((entry) => {
    const links = asArray(entry.link);
    const alternate = links.find((link) => link?.["@_rel"] === "alternate" && link["@_href"]);
    const link = alternate ?? links.find((link) => valueOf(link) || link?.["@_href"]);
    return valueOf(entry.guid) || valueOf(entry.id) || valueOf(link) || link?.["@_href"] || null;
  });
  const normalized = rawIds.map((id) => id === null ? null : id.slice(0, 320));
  const groups = new Map();
  normalized.forEach((id, index) => { if (id !== null) { if (!groups.has(id)) groups.set(id, []); groups.get(id).push(rawIds[index]); } });
  return {
    raw_entry_count: entries.length,
    raw_ids: rawIds,
    ids: [...groups.keys()],
    incomparable_entry_indexes: normalized.flatMap((id, i) => id === null ? [i] : []),
    upstream_duplicate_ids: [...groups].filter(([, raw]) => raw.length > 1).map(([id, raw]) => ({ id, raw })),
    normalization_collisions: [...groups].filter(([, raw]) => new Set(raw).size > 1).map(([id, raw]) => ({ id, raw })),
  };
}

async function* capturedBody(body, limit, capture) {
  for await (const chunk of body) {
    capture.bytes += chunk.byteLength;
    if (capture.bytes <= limit) capture.chunks.push(Buffer.from(chunk));
    yield chunk; // production publicFetch still enforces the actual cap and cancels.
  }
  capture.complete = true;
}

function listenForStop(input, stop) {
  const onInput = (line) => { if (line.trim() === "stop") stop("stdin_stop"); };
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", onInput);
  return () => { lines.off("line", onInput); lines.close(); input.pause(); };
}

async function selfCheck() {
  const inputCases = [
    { chunks: ["st", "op\n"], stopped: true },
    { chunks: ["ignore\nstop\n"], stopped: true },
    { chunks: ["st", "op\r", "\n"], stopped: true },
    { chunks: ["  stop  \n"], stopped: true },
    { chunks: ["STOP\n", "stopping\n"], stopped: false },
    { chunks: ["ignore\n"], stopped: false },
  ];
  for (const { chunks, stopped } of inputCases) {
    const input = new PassThrough();
    const abort = new AbortController();
    const cleanup = listenForStop(input, (reason) => abort.abort(reason));
    try {
      for (const chunk of chunks) { input.write(chunk); await sleep(0); }
      assert.equal(abort.signal.aborted, stopped, `stop handler for ${JSON.stringify(chunks)}`);
      if (stopped) assert.equal(abort.signal.reason, "stdin_stop");
    } finally { cleanup(); }
    assert.equal(input.listenerCount("data"), 0, "stop reader releases its input listener");
    assert.equal(input.readableFlowing, false, "stop reader leaves input paused");
    input.write("stop\n");
    assert.equal(abort.signal.aborted, stopped, "cleanup prevents further stop handling");
    input.destroy();
  }
  const xml = `<rss><channel>${Array.from({ length: 60 }, (_, i) => `<item><guid>id-${i}</guid></item>`).join("")}</channel></rss>`;
  assert.equal(referenceIds(xml).ids.length, 60);
  const long = "x".repeat(320);
  const result = referenceIds(`<rss><channel><item><guid>${long}a</guid></item><item><guid>${long}b</guid></item><item><title>no identity</title></item></channel></rss>`);
  assert.equal(result.raw_entry_count, 3);
  assert.deepEqual(result.incomparable_entry_indexes, [2]);
  assert.equal(result.normalization_collisions.length, 1);
  assert.deepEqual(referenceIds('<feed><entry><id>atom-1</id></entry><entry><link rel="self" href="self"/><link rel="alternate" href="alt"/></entry></feed>').ids, ["atom-1", "alt"]);
  assert.throws(() => referenceIds("<html/>"), /reference_invalid_root/);
  const capture = { bytes: 0, chunks: [], complete: false };
  let cancelled = false;
  const body = (async function* () { try { yield Buffer.from("abc"); yield Buffer.from("def"); } finally { cancelled = true; } })();
  const stream = capturedBody(body, 4, capture);
  assert.equal((await stream.next()).value.toString(), "abc");
  assert.equal((await stream.next()).value.toString(), "def");
  assert.equal(capture.bytes, 6);
  assert.equal(Buffer.concat(capture.chunks).toString(), "abc", "capture never retains oversized data");
  await stream.return();
  assert.equal(cancelled, true, "cancelling the capped reader closes upstream body");
  assert.equal(capture.complete, false, "interrupted response is never comparable");
  const success = { bytes: 0, chunks: [], complete: false };
  for await (const _chunk of capturedBody((async function* () { yield Buffer.from("xml"); })(), 4, success)) { /* consume */ }
  assert.equal(success.complete, true);
  assert.equal(Buffer.concat(success.chunks).toString(), "xml");
  console.log("public-feed-observation reference/capture + 6 stop-input cases self-check passed");
}

async function observe() {
  const snapshot = process.argv.includes("--snapshot");
  assert.ok(snapshot !== process.argv.includes("--observe-24h"), "choose exactly --snapshot or --observe-24h");
  const root = resolve("artifacts/collection-capability/public-observation");
  mkdirSync(root, { recursive: true });
  const out = mkdtempSync(join(root, snapshot ? "snapshot-" : "24h-"));
  let startedAt = new Date().toISOString();
  let start = performance.now();
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim();
  const rounds = snapshot ? 1 : 13;
  const abort = new AbortController();
  let interrupted = "";
  const stop = (signal) => { interrupted = signal; abort.abort(); };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const cleanupInput = listenForStop(process.stdin, stop);
  console.log(JSON.stringify({ event: "observation_started", observer_pid: process.pid, wrapper_pid: process.ppid, mode: snapshot ? "snapshot" : "observe-24h", evidence_dir: out }));
  const rows = [];
  let vite;
  let db;
  let fatal = "";
  try {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: false, logLevel: "silent", resolve: { alias: { "@": resolve("src") } }, server: { middlewareMode: true } });
    db = await vite.ssrLoadModule("/src/lib/db.ts");
    const sql = await db.getSql();
    const { runSourceJob } = await vite.ssrLoadModule("/src/lib/server/scheduler.ts");
    const { SOURCES } = await vite.ssrLoadModule("/src/lib/server/seed.ts");
    const { pinnedTransport, TEXT_MAX_BYTES } = await vite.ssrLoadModule("/src/lib/server/outbound-policy.ts");
    const sources = sourceIds.map((id) => SOURCES.find((source) => source.id === id));
    assert.ok(sources.every((source) => source?.adapter === "rss" && source.live), "five seed RSS sources required");
    for (const source of sources) {
      await sql.query(`insert into sources (id,platform,name,adapter,feed_url,handle,url,status,enabled,last_error,interval_minutes)
        values ($1,'rss',$2,'rss',$3,$4,$5,'idle',true,'',120)`, [source.id, source.name, source.feed_url, source.handle, source.url]);
    }
    assert.equal((await sql.query("select count(*)::int as n from sources"))[0].n, 5);
    startedAt = new Date().toISOString();
    start = performance.now();
    const request = pinnedTransport({ signals: { abortSignal: abort.signal } });
    for (let round = 0; round < rounds && !abort.signal.aborted; round += 1) {
      const scheduled = start + round * TWO_HOURS;
      if (scheduled > performance.now()) await sleep(scheduled - performance.now(), undefined, { signal: abort.signal });
      if (round > 0 && performance.now() - scheduled > 5 * 60 * 1000) { interrupted = "schedule_late_no_catchup"; break; }
      // ponytail: sequential five-source observation; parallelize only for a larger explicitly approved source set.
      for (const source of sources) {
        if (abort.signal.aborted) break;
        const at = performance.now();
        const before = await sql.query("select external_id from items where source_id=$1 order by external_id", [source.id]);
        const [cursorBefore] = await sql.query("select last_external_id from sources where id=$1", [source.id]);
        const beforeJobs = new Set((await sql.query("select id from jobs where source_id=$1", [source.id])).map((job) => job.id));
        const hops = [];
        let capture;
        const transport = async (url, options) => {
          const response = await request(url, options);
          const hop = { url: url.href, status: response.status, content_type: response.headers["content-type"] ?? "", location: response.headers.location ?? null };
          hops.push(hop);
          if (response.status < 200 || response.status >= 300) return response;
          capture = { chunks: [], bytes: 0, complete: false, hop };
          const current = capture;
          return { ...response, body: capturedBody(response.body, TEXT_MAX_BYTES, current) };
        };
        const result = await runSourceJob(source.id, "incremental", { transport });
        const after = await sql.query("select external_id from items where source_id=$1 order by external_id", [source.id]);
        const job = (await sql.query("select id,status,items_found,items_new,error,coverage from jobs where source_id=$1", [source.id])).find((candidate) => !beforeJobs.has(candidate.id));
        const [cursorAfter] = await sql.query("select last_external_id from sources where id=$1", [source.id]);
        const duplicates = await sql.query("select external_id,count(*)::int as n from items where source_id=$1 group by external_id having count(*)>1", [source.id]);
        let reference = null;
        let referenceError = "";
        let sha = null;
        if (capture?.complete && capture.bytes <= TEXT_MAX_BYTES) {
          const bytes = Buffer.concat(capture.chunks);
          sha = createHash("sha256").update(bytes).digest("hex");
          const xmlFile = `round-${round}-${source.id}.xml`;
          writeFileSync(join(out, xmlFile), bytes);
          try { reference = { ...referenceIds(bytes.toString("utf8")), response_file: xmlFile }; }
          catch (error) { referenceError = error.message; }
        }
        const storedIds = after.map((item) => item.external_id);
        const beforeIds = new Set(before.map((item) => item.external_id));
        const missing = reference ? reference.ids.filter((id) => !storedIds.includes(id)) : null;
        const comparable = reference !== null && reference.incomparable_entry_indexes.length === 0 && reference.normalization_collisions.length === 0;
        const row = {
          revision, run_id: out.split(/[\\/]/).at(-1), source_id: source.id, feed_url: source.feed_url, round,
          scheduled_at: new Date(Date.parse(startedAt) + round * TWO_HOURS).toISOString(),
          started_at: new Date(Date.now() - (performance.now() - at)).toISOString(), finished_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - at),
          response_hops: hops, response_bytes: capture?.bytes ?? null, response_sha256: sha,
          reference, returned_by_upstream: reference?.raw_entry_count ?? null,
          persisted_ids: storedIds, persisted: storedIds.length, newly_persisted_ids: storedIds.filter((id) => !beforeIds.has(id)),
          missing_ids: missing, missing: missing?.length ?? null, duplicates,
          comparison_status: comparable ? "comparable" : "incomparable",
          window_status: job?.coverage?.window_only ? "window_only" : job?.coverage?.complete ? "complete" : "incomplete_or_unknown",
          upstream_window_outside: "unobservable", job, result, source_cursor_before: cursorBefore.last_external_id, source_cursor_after: cursorAfter.last_external_id,
          error_code: result.error || referenceError || (!capture?.complete ? "response_not_captured" : ""),
        };
        rows.push(row);
        appendFileSync(join(out, "rounds.jsonl"), `${JSON.stringify(row)}\n`);
        console.log(JSON.stringify({ source_id: source.id, round, returned_by_upstream: row.returned_by_upstream, persisted: row.persisted, missing: row.missing, comparison_status: row.comparison_status, error_code: row.error_code }));
        capture = undefined; // raw response bytes stay on disk, not in the 24-hour row history.
      }
    }
  } catch (error) { if (!abort.signal.aborted) fatal = String(error?.message ?? error); }
  finally {
    const elapsed = performance.now() - start;
    const allRounds = rows.length === rounds * 5;
    const comparable = rows.every((row) => row.comparison_status === "comparable");
    const clean = rows.every((row) => !row.error_code && row.missing === 0 && row.duplicates.length === 0);
    const summary = {
      revision, mode: snapshot ? "snapshot" : "observe-24h", started_at: startedAt, finished_at: new Date().toISOString(), actual_duration_ms: Math.round(elapsed),
      planned_rounds: rounds, completed_rounds: Math.floor(rows.length / 5), source_jobs: rows.length, planned_source_jobs: rounds * 5,
      acceptance: !snapshot && elapsed >= DAY && allRounds && comparable && clean && !interrupted && !fatal ? "passed" : "pending",
      interrupted: interrupted || null, fatal_error: fatal || null,
      sources: sourceIds.map((id) => {
        const matches = rows.filter((row) => row.source_id === id);
        return { source_id: id, successful_jobs: matches.filter((row) => !row.error_code).length, failed_jobs: matches.filter((row) => row.error_code).length,
          incomparable_rounds: matches.filter((row) => row.comparison_status !== "comparable").length,
          observed_unique_ids: [...new Set(matches.flatMap((row) => row.reference?.ids ?? []))], missing_ids: matches.some((row) => row.comparison_status === "comparable") ? [...new Set(matches.flatMap((row) => row.missing_ids ?? []))] : null, duplicate_pairs: matches.flatMap((row) => row.duplicates), window_statuses: [...new Set(matches.map((row) => row.window_status))], coverage_notes: [...new Set(matches.map((row) => row.job?.coverage?.note).filter(Boolean))] };
      }),
      upstream_window_outside: "unobservable", note: "snapshot is availability evidence only; pending 24h observation is not endurance acceptance", evidence_dir: out,
    };
    writeFileSync(join(out, "summary.json.tmp"), JSON.stringify(summary, null, 2));
    renameSync(join(out, "summary.json.tmp"), join(out, "summary.json"));
    console.log(JSON.stringify(summary, null, 2));
    if (vite) await vite.close();
    if (db) { try { await (await db.getPglite()).close(); } catch { /* initialization failure is recorded above */ } }
    cleanupInput();
    process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate);
    if (fatal || !allRounds || !clean || !comparable) process.exitCode = 1;
  }
}

if (process.argv.includes("--self-check")) await selfCheck();
else if (!process.argv.includes("--isolated-child")) {
  const child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2), "--isolated-child"], {
    stdio: "inherit", windowsHide: true,
    env: offlineEnv(process.env, { LOOM_RUNTIME_MODE: "test", AI_ENGINE: "legacy", DATABASE_URL: undefined,
      LOOM_MODEL_CONFIG: resolve("artifacts/collection-capability/no-model-config.json"),
      AUTO_ANALYZE: "false", EXTRACT_AUTO: "false", AGENT_WORKER_ENABLED: "false", AGENT_ASYNC_RESEARCH_ENABLED: "false",
      AGENT_OPENCODE_WORKER_ENABLED: "false", AGENT_ASSISTANT_ENABLED: "false", AGENT_ASSISTANT_ACTIONS_ENABLED: "false", XAI_API_KEY: "" }),
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { if (process.platform !== "win32") child.kill(signal); });
  console.log(JSON.stringify({ event: "observer_child_started", wrapper_pid: process.pid, observer_pid: child.pid }));
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else await observe();
