#!/usr/bin/env node
/** Fixed public-article bookkeeping. Inert by default; no item, config or credential writes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineEnv } from "../../scripts/readiness-offline.mjs";
import { isMainModule } from "../../scripts/with-app-env.mjs";

const sharedStatus = "not_attempted_due_to_shared_provider_block";
const manifest = JSON.parse(readFileSync(new URL("./article-reader-samples.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));

function validateSamples(document) {
  assert.equal(document.samples.length, 20);
  assert.equal(document.siteCount, 3);
  assert.deepEqual(document.verifiedSupportedHostnames, []);
  assert.equal(new Set(document.samples.map(sample => sample.url)).size, 20);
  assert.equal(new Set(document.samples.map(sample => sample.id)).size, 20);
  for (const sample of document.samples) {
    const url = new URL(sample.url);
    assert.equal(url.protocol, "https:");
    assert.ok(!url.search && !url.hash && !url.username && !url.password && !url.port);
    assert.equal(url.hostname, sample.sourceHostname);
    assert.ok(document.proposedReferenceHostnames.includes(url.hostname));
    assert.equal(sample.reference.middleFacts.length, 3);
    assert.equal(sample.reference.literalOpening, null);
    assert.equal(sample.reference.literalEnding, null);
    assert.equal(sample.reference.manual_reference_required, true);
    assert.equal(sample.originalFeed.status, "unknown");
    assert.equal(sample.originalFeed.body, null);
    assert.equal(sample.originalHostDns, "not_probed_for_this_sample");
    assert.equal(sample.reader.requestStatus, sharedStatus);
    assert.equal(sample.reader.verifiedComplete, "unknown");
  }
  return document.samples;
}

function rowFor(sample, status = sharedStatus) {
  return { id: sample.id, url: sample.url, title: sample.title,
    original_feed_status: "unknown", original_feed_body: null,
    original_host_dns: status === sharedStatus ? "not_probed_for_this_sample" : "unknown",
    request_status: status, candidate_usable: "unknown", verified_complete: "unknown",
    manual_reference_required: true, adopted: false };
}

function report(document, rows, networkExecuted) {
  const attempted = rows.filter(row => ["reader_returned", "reader_failed"].includes(row.request_status)).length;
  const returned = rows.filter(row => row.request_status === "reader_returned").length;
  return { mode: networkExecuted ? "bounded_actual_reader" : "prior_shared_barrier_bookkeeping",
    network_executed: networkExecuted, samples: rows, evidence: document.sharedReaderBarrier.evidence,
    metrics: { samples: rows.length, attempted, reader_returned: returned,
      request_return_rate: networkExecuted && attempted ? returned / attempted : null,
      candidate_usable_rate: null, verified_complete_rate: null, error_page_false_pass_rate: null },
    verified_supported_hostnames: [], live_passed: false, deployed: false };
}

function blockedReport(document) {
  return report(document, validateSamples(document).map(sample =>
    ({ ...rowFor(sample), exception: "prior_shared_reader_barrier" })), false);
}

function interruptedReport(document) {
  const value = blockedReport(document);
  value.mode = "child_interrupted_or_failed";
  value.network_executed = null;
  value.metrics.attempted = null;
  value.metrics.reader_returned = null;
  for (const row of value.samples) {
    row.request_status = "unknown_due_to_child_interrupt";
    row.exception = "child_interrupted_or_failed";
  }
  return value;
}
function safeError(error) {
  const text = String(error?.message ?? "");
  return /^(?:article_[a-z_]+|blocked_address|blocked_host|dns_no_answer|timeout|HTTP \d{3}|too_many_redirects)$/.test(text)
    ? text : error?.name === "TimeoutError" ? "timeout" : "reader_failed";
}

async function readSamples(document, reader, now = Date.now) {
  const samples = validateSamples(document);
  const allowedHosts = new Set(samples.map(sample => sample.sourceHostname)); // validation-only, no production config
  const rows = [];
  const deadline = now() + 40000; // each real read is bounded at 20s; parent child is capped at 60s
  let barrier = null;
  for (const sample of samples) {
    if (barrier || now() >= deadline) {
      rows.push({ ...rowFor(sample, barrier ? "not_attempted_due_to_ambiguous_reader_barrier" : "not_attempted_due_to_batch_deadline"),
        ...(barrier ? { stopped_after_error: barrier, stopped_after_error_stage: "unknown_original_or_provider" }
          : { exception: "batch_deadline" }) });
      continue;
    }
    try {
      const candidate = await reader(sample.url, { allowedHosts });
      rows.push({ ...rowFor(sample, "reader_returned"), candidate_digest: candidate.digest,
        candidate_bytes: Buffer.byteLength(candidate.body, "utf8"),
        candidate_hostname: new URL(candidate.sourceUrl).hostname });
      // Receipt/length/paraphrase matching is never proof of usable or complete body.
    } catch (error) {
      const code = safeError(error);
      rows.push({ ...rowFor(sample, "reader_failed"), exception: code, failure_stage: "unknown_original_or_provider" });
      // Conservative batch stop: the code does not identify original-host versus provider validation.
      if (["blocked_address", "blocked_host", "dns_no_answer", "HTTP 401", "HTTP 403"].includes(code)) barrier = code;
    }
  }
  return report(document, rows, true);
}

async function selfCheck() {
  const blocked = blockedReport(manifest);
  assert.equal(blocked.samples.length, 20);
  assert.equal(blocked.metrics.attempted, 0);
  for (const key of ["request_return_rate", "candidate_usable_rate", "verified_complete_rate", "error_page_false_pass_rate"])
    assert.equal(blocked.metrics[key], null);
  const interrupted = interruptedReport(manifest);
  assert.equal(interrupted.network_executed, null);
  assert.equal(interrupted.metrics.attempted, null);
  assert.ok(interrupted.samples.every(row => row.request_status === "unknown_due_to_child_interrupt"));
  const duplicate = structuredClone(manifest);
  duplicate.samples[1].url = duplicate.samples[0].url;
  assert.throws(() => validateSamples(duplicate));
  const fabricatedFeed = structuredClone(manifest);
  fabricatedFeed.samples[0].originalFeed.status = "missing";
  assert.throws(() => validateSamples(fabricatedFeed));
  const paraphraseAsLiteral = structuredClone(manifest);
  paraphraseAsLiteral.samples[0].reference.literalOpening = paraphraseAsLiteral.samples[0].reference.openingParaphrase;
  assert.throws(() => validateSamples(paraphraseAsLiteral));
  for (const failure of ["dns_no_answer", "blocked_address", "blocked_host", "HTTP 401", "HTTP 403"]) {
    let calls = 0;
    const denied = await readSamples(manifest, async () => { calls++; throw new Error(failure); });
    assert.equal(calls, 1, `${failure} must stop after the first reader failure`);
    assert.equal(denied.metrics.attempted, 1);
    assert.equal(denied.samples[0].request_status, "reader_failed");
    assert.equal(denied.samples[0].exception, failure);
    assert.equal(denied.samples[0].failure_stage, "unknown_original_or_provider");
    assert.equal(denied.samples[0].original_host_dns, "unknown");
    assert.ok(denied.samples.slice(1).every(row =>
      row.request_status === "not_attempted_due_to_ambiguous_reader_barrier" &&
      row.stopped_after_error === failure && row.stopped_after_error_stage === "unknown_original_or_provider" &&
      row.exception === undefined &&
      row.original_host_dns === "unknown"));
    assert.equal(denied.metrics.verified_complete_rate, null);
  }
  const candidate = await readSamples(manifest, async url => ({ body: "fixture only", digest: "fixture",
    sourceUrl: url, title: "fixture only" }));
  assert.equal(candidate.metrics.reader_returned, 20);
  assert.ok(candidate.samples.every(row => row.verified_complete === "unknown" && row.candidate_usable === "unknown"));
  assert.equal(candidate.live_passed, false);
  let tick = 0;
  const expired = await readSamples(manifest, async () => { assert.fail("deadline must prevent reader call"); },
    () => tick++ === 0 ? 0 : 40000);
  assert.equal(expired.metrics.attempted, 0);
  assert.ok(expired.samples.every(row => row.request_status === "not_attempted_due_to_batch_deadline"));
  assert.equal(safeError(new Error("message with credentials")), "reader_failed");
  console.log(JSON.stringify({ self_check: "passed", network_executed: false, samples: 20,
    note: "Controlled bookkeeping fixtures are not public-reader acceptance." }));
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.every(arg => ["--self-check", "--run", "--network-changed", "--isolated-child"].includes(arg)),
    "unsupported argument");
  if (args.includes("--self-check")) return selfCheck();
  if (!args.includes("--run")) return console.log(JSON.stringify(blockedReport(manifest), null, 2));
  if (!args.includes("--network-changed")) {
    console.error("known_shared_reader_barrier: --run requires --network-changed after policy-valid network recovery; no request made");
    process.exitCode = 2;
    return;
  }
  if (!args.includes("--isolated-child")) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url),
      "--run", "--network-changed", "--isolated-child"], {
      env: offlineEnv(process.env, { LOOM_MODEL_CONFIG: fileURLToPath(new URL("./no-model-config.json", import.meta.url)),
        LOOM_EGRESS_CIDRS: undefined, ARTICLE_READER_ENABLED: "false", ARTICLE_READER_ALLOWED_HOSTS: "" }),
      encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.error || child.status !== 0) {
      console.log(JSON.stringify({ ...interruptedReport(manifest),
        note: "Partial network progress is unknown; no completed live acceptance." }, null, 2));
      process.exitCode = 1;
    }
    return;
  }
  assert.equal(Object.keys(process.env).filter(key => process.env[key] &&
    /(?:API_KEY|COOKIE|PASSWORD|SECRET|TOKEN|DATABASE_URL|NODE_OPTIONS|LOOM_EGRESS_CIDRS)/i.test(key)).length, 0,
    "reader validation must not inherit credentials or egress overrides");
  const { readArticle } = await import("../../src/lib/server/article-reader.ts");
  console.log(JSON.stringify(await readSamples(manifest, readArticle), null, 2));
}

if (isMainModule(import.meta.url)) await main();
