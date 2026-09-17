#!/usr/bin/env node
/**
 * T16: operations status + alert rules.
 *
 * The rules are pure (`evaluateAlerts`), so they are tested directly: what counts
 * as stale, what is a warning versus an alert, and that "no backup yet" is a
 * different condition from "backup too old" (the plan asks for exactly that split).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { evaluateAlerts, STAGE_MAX_AGE_MINUTES, BACKUP_MAX_AGE_HOURS } from "./operations-status.mjs";

const healthy = {
  now: Date.now(),
  stages: { collection: 5, ingest: 10, extract: 20, reconciliation: 100 },
  oldestQueueMinutes: 2,
  unknownSpend: { count: 0, amount: 0 },
  backupAgeHours: 1,
};

test("a healthy system raises nothing", () => {
  assert.deepEqual(evaluateAlerts(healthy), []);
});

test("a stale stage is named, and the others stay quiet", () => {
  const alerts = evaluateAlerts({ ...healthy, stages: { ...healthy.stages, extract: STAGE_MAX_AGE_MINUTES.extract + 1 } });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "stage_stale:extract");
  assert.equal(alerts[0].level, "alert");
});

test("a stage that never succeeded is a warning, not a false alert", () => {
  const alerts = evaluateAlerts({ ...healthy, stages: { ...healthy.stages, ingest: null } });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "stage_never_succeeded:ingest");
  assert.equal(alerts[0].level, "warning");
});

test("a stage a deployment does not report at all is ignored", () => {
  const alerts = evaluateAlerts({ ...healthy, stages: { collection: 5 } });
  assert.deepEqual(alerts, [], "absent stages must not be invented");
});

test("a queue backlog is an alert distinct from stage staleness", () => {
  const alerts = evaluateAlerts({ ...healthy, oldestQueueMinutes: 600 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "queue_backlog");
});

test("unknown paid spend is reported as a warning, never silently zeroed", () => {
  const alerts = evaluateAlerts({ ...healthy, unknownSpend: { count: 2, amount: 0.22 } });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "unknown_spend");
  assert.match(alerts[0].detail, /0\.22/);
  assert.equal(alerts[0].level, "warning");
});

test("a missing backup and a stale backup are different conditions", () => {
  const missing = evaluateAlerts({ ...healthy, backupAgeHours: null });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].code, "backup_missing");

  const stale = evaluateAlerts({ ...healthy, backupAgeHours: BACKUP_MAX_AGE_HOURS + 1 });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].code, "backup_stale");
});

test("several problems are reported together, not one at a time", () => {
  const alerts = evaluateAlerts({
    ...healthy,
    stages: { ...healthy.stages, collection: 999 },
    oldestQueueMinutes: 999,
    unknownSpend: { count: 1, amount: 0.08 },
    backupAgeHours: null,
  });
  assert.deepEqual(alerts.map((a) => a.code).sort(),
    ["backup_missing", "queue_backlog", "stage_stale:collection", "unknown_spend"]);
});

test("the script exits non-zero only when an alert (not a warning) is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "t16-"));
  const run = (extra = []) => spawnSync(process.execPath,
    ["scripts/operations-status.mjs", "--pglite", ...extra],
    { encoding: "utf8", windowsHide: true, timeout: 120_000 });

  // With no data: a fresh isolated database has no stage rows, so nothing is
  // stale... except the backup, which is genuinely absent and must alert.
  const noBackup = run();
  assert.equal(noBackup.status, 1, "a missing backup must fail the check");
  const report = JSON.parse(noBackup.stdout);
  assert.ok(report.alerts.some((a) => a.code === "backup_missing"));
  assert.equal(report.read_only, true);

  // With a fresh backup supplied, a fresh database is healthy: exit 0.
  writeFileSync(join(dir, "backup.dump"), "x");
  const withBackup = run(["--backup-dir", dir]);
  assert.equal(withBackup.status, 0, withBackup.stdout);
  assert.deepEqual(JSON.parse(withBackup.stdout).alerts, []);

  // An aged backup is stale, and that is distinct from missing.
  const old = new Date(Date.now() - (BACKUP_MAX_AGE_HOURS + 5) * 3_600_000);
  utimesSync(join(dir, "backup.dump"), old, old);
  const stale = run(["--backup-dir", dir]);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).alerts[0].code, "backup_stale");
});

test("an alert run writes only structured data to the chosen local sink", () => {
  const dir = mkdtempSync(join(tmpdir(), "t16-sink-"));
  const result = spawnSync(process.execPath,
    ["scripts/operations-status.mjs", "--pglite", "--alerts", dir],
    { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.alerts_file && report.alerts_file.startsWith(dir));
  // No external channel is contacted: the plan requires the user to name one first.
  assert.ok(!JSON.stringify(report).match(/https?:\/\//), "no URL may appear in the report");
});
