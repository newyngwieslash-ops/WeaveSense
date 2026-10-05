#!/usr/bin/env node
/**
 * T01: the offline-run wrapper must not leak the parent's real configuration
 * into a test child.
 *
 * The guarantee is a runtime-key allowlist, not "delete the keys we happen to
 * know about": an unknown future secret (WECHAT_GATEWAY_TOKEN, CRON_SECRET, a
 * provider key) must be dropped by default too. Anything a test genuinely
 * needs is passed explicitly through `overrides`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { offlineEnv, offlineChildProcess } from "./readiness-offline.mjs";
import { assertEvidence, assertReferenceSets, unknownMetric } from "./collection-reliability-check.mjs";

test("collection evidence rejects missing, invalid and falsely zero metrics", () => {
  const report = { expected: 2, collected: 2, missing: 0, duplicates: 0,
    delay_p50: 0, delay_p95: 0, retry_recovery_seconds: unknownMetric('not exercised'),
    max_rss_bytes: 1, max_queue_age_seconds: 0, paid_calls: 0, evidence_scope: 'offline' };
  assertEvidence(report);
  for (const key of Object.keys(report)) {
    const omitted = {...report}; delete omitted[key];
    assert.throws(() => assertEvidence(omitted), undefined, `missing ${key}`);
  }
  for (const value of [NaN, Infinity, -1, null, '0', {}, {status:'unknown',reason:''}])
    assert.throws(() => assertEvidence({...report, delay_p95:value}));
  for (const change of [{missing:1}, {duplicates:1}, {collected:1}, {paid_calls:1}, {expected:0}, {delay_p50:2,delay_p95:1}])
    assert.throws(() => assertEvidence({...report,...change}));
});

test("collection reference sets reject missing source, wrong identity and replay duplicates despite matching totals", () => {
  const expected = {'s1':['001','2'], 's2':['3']};
  const rows = [{source_id:'s1',external_id:'001'}, {source_id:'s1',external_id:'2'}, {source_id:'s2',external_id:'3'}];
  assertReferenceSets(expected,rows);
  for (const bad of [rows.slice(0,2),[...rows.slice(0,2),rows[0]],rows.map(r=>({...r,external_id:r.external_id==='001'?'1':r.external_id}))])
    assert.throws(()=>assertReferenceSets(expected,bad));
});

test("combined 331 references reject a same-count opaque RSS identity substitution", () => {
  const reference={pages:Array.from({length:330},(_,i)=>String(i+1)),fault:['001']};
  const rows=Object.entries(reference).flatMap(([source_id,ids])=>ids.map(external_id=>({source_id,external_id})));
  assertReferenceSets(reference,rows);
  const substituted=rows.map(row=>row.source_id==='fault'?{...row,external_id:'1'}:row);
  assert.equal(substituted.length,331);
  assert.throws(()=>assertReferenceSets(reference,substituted),/reference mismatch fault/);
});

test("cleanup rejection still closes every owned resource, persists failure evidence and exits nonzero", () => {
  const probe=offlineChildProcess(process.execPath,['--input-type=module','-e',`
    import {finishEvidence} from './scripts/collection-reliability-check.mjs';
    const report={ok:true},closed=[];
    process.exitCode=await finishEvidence(report,{
      vite:async()=>{closed.push('vite');throw new Error('injected Vite cleanup rejection');},
      minio:async()=>{closed.push('minio');throw new Error('injected MinIO cleanup rejection');},
      postgres:async()=>{closed.push('postgres');}
    },()=>process.stdout.write(JSON.stringify({report,closed})));
  `],process.env);
  assert.equal(probe.status,1,probe.stderr);
  const {report,closed}=JSON.parse(probe.stdout);
  assert.deepEqual(closed,['vite','minio','postgres']);
  assert.equal(report.ok,false);
  assert.deepEqual(report.cleanup_errors.map(error=>error.resource),['vite','minio']);
  assert.match(report.cleanup_errors[1].error,/injected MinIO cleanup rejection/);
});

const parent = {
  PATH: "/usr/bin",
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
  TMP: "C:\\Temp",
  // Real-ish configuration that must never reach an offline child:
  DATABASE_URL: "postgresql://loom:realpw@prod.example.com:5432/loom",
  XAI_API_KEY: "xai-real-key",
  LOOM_MODEL_CONFIG: "C:\\secret\\model.local.json",
  WECHAT_GATEWAY_TOKEN: "gateway-secret",
  CRON_SECRET: "cron-secret",
  SOME_FUTURE_UNKNOWN_SECRET: "unknown-secret",
};

test("keeps only runtime-necessary variables", () => {
  const env = offlineEnv(parent);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.TEMP, "C:\\Temp");
});

test("drops known real configuration and unknown secrets alike", () => {
  const env = offlineEnv(parent);
  for (const key of [
    "DATABASE_URL",
    "WECHAT_GATEWAY_TOKEN",
    "CRON_SECRET",
    "SOME_FUTURE_UNKNOWN_SECRET",
  ]) {
    assert.equal(env[key], undefined, `${key} leaked into the offline env`);
  }
});

test("applies offline-safe defaults", () => {
  const env = offlineEnv(parent);
  assert.equal(env.AUTO_ANALYZE, "false");
  assert.equal(env.EXTRACT_AUTO, "false");
  assert.equal(env.AGENT_WORKER_ENABLED, "false");
  assert.equal(env.AGENT_ASYNC_RESEARCH_ENABLED, "false");
  // Explicitly missing rather than unset: block real model autodiscovery.
  assert.equal(env.LOOM_RUNTIME_MODE, "development");
  assert.ok(env.LOOM_MODEL_CONFIG);
  assert.equal(existsSync(env.LOOM_MODEL_CONFIG), false);
  assert.notEqual(env.LOOM_MODEL_CONFIG, parent.LOOM_MODEL_CONFIG);
  assert.equal(env.XAI_API_KEY, "");
  assert.equal(env.DATABASE_URL, undefined);
});

test("an explicit override is visible and wins over the default", () => {
  const env = offlineEnv(parent, {
    DATABASE_URL: "postgresql://postgres:review-only@127.0.0.1:54176/review",
    AGENT_WORKER_ENABLED: "true",
    LOOM_MODEL_CONFIG: "artifacts/model-settings-qa/model.local.json",
  });
  assert.equal(env.DATABASE_URL, "postgresql://postgres:review-only@127.0.0.1:54176/review");
  assert.equal(env.AGENT_WORKER_ENABLED, "true");
  assert.equal(env.LOOM_MODEL_CONFIG, "artifacts/model-settings-qa/model.local.json");
});

test("a child process never sees the parent's real configuration", () => {
  const probe = offlineChildProcess(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({db:process.env.DATABASE_URL??null,key:process.env.XAI_API_KEY??null,auto:process.env.AUTO_ANALYZE??null,extract:process.env.EXTRACT_AUTO,worker:process.env.AGENT_WORKER_ENABLED,async:process.env.AGENT_ASYNC_RESEARCH_ENABLED,runtime:process.env.LOOM_RUNTIME_MODE,model:process.env.LOOM_MODEL_CONFIG}))"],
    parent,
  );
  assert.equal(probe.status, 0, probe.stderr);
  const seen = JSON.parse(probe.stdout);
  assert.equal(seen.db, null);
  assert.equal(seen.key, "");
  assert.equal(seen.auto, "false");
  for (const key of ["extract", "worker", "async"]) assert.equal(seen[key], "false");
  assert.equal(seen.runtime, "development");
  assert.equal(existsSync(seen.model), false);
});

test("the wrapper never echoes values it drops", () => {
  // A failure message may name a variable, but must not print its value.
  const env = offlineEnv(parent);
  const rendered = JSON.stringify(env);
  for (const secret of ["realpw", "xai-real-key", "gateway-secret", "cron-secret", "unknown-secret"]) {
    assert.ok(!rendered.includes(secret), `value leaked: ${secret}`);
  }
});

test("parent enabled flags cannot suppress safe defaults", () => {
  const env = offlineEnv({ ...parent, AUTO_ANALYZE: "true", EXTRACT_AUTO: "true", AGENT_WORKER_ENABLED: "true", AGENT_ASYNC_RESEARCH_ENABLED: "true", LOOM_RUNTIME_MODE: "production" });
  for (const key of ["AUTO_ANALYZE", "EXTRACT_AUTO", "AGENT_WORKER_ENABLED", "AGENT_ASYNC_RESEARCH_ENABLED"]) assert.equal(env[key], "false");
  assert.equal(env.LOOM_RUNTIME_MODE, "development");
});
