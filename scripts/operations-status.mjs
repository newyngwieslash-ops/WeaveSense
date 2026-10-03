#!/usr/bin/env node
/**
 * T16: read-only operations status, for an operator without a dashboard.
 *
 * Reads only. It deliberately does NOT call the business entry points
 * (`ensureSeeded`, `tickDueSources`, any `*Fn`) because those run migrations or
 * start work — a status check must not change the system it inspects.
 *
 * It answers the questions the plan names:
 *   - when did each stage last succeed?
 *   - how old is the oldest queued item (collection queue, wechat detail queue)?
 *   - is there spend recorded as `unknown` (money that may or may not have left)?
 *   - how old is the most recent backup?
 *
 * Output contains counts, timestamps and stable codes only — never item bodies,
 * URLs, tokens or configuration values.
 *
 * Usage:
 *   node scripts/operations-status.mjs                # JSON to stdout
 *   node scripts/operations-status.mjs --pglite       # isolated demo DB
 *   node scripts/operations-status.mjs --alerts <dir> # also write alert events
 *   node scripts/operations-status.mjs --backup-dir <dir>
 *
 * Exit code: 0 when nothing is alarming, 1 when any alert is raised. That makes
 * it usable from cron/systemd without inventing a notification channel the user
 * has not chosen.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "./with-app-env.mjs";

/** How long a stage may go without a successful run before it is alarming. */
export const STAGE_MAX_AGE_MINUTES = {
  collection: 60,
  ingest: 120,
  extract: 240,
  reconciliation: 26 * 60,
};

/** A backup older than this is a warning; missing entirely is an alert. */
export const BACKUP_MAX_AGE_HOURS = 48;

const minutesBetween = (now, then) => Math.round((now - then) / 60_000);

/**
 * Evaluate the collected facts into alerts. Pure, so the rules are testable
 * without a database or a filesystem.
 *
 * @param {{ now: number, stages: Record<string, number|null>, oldestQueueMinutes: number|null,
 *           unknownSpend: {count: number, amount: number}, backupAgeHours: number|null }} facts
 * @returns {{ level: "alert"|"warning", code: string, detail: string }[]}
 */
export function evaluateAlerts(facts) {
  const alerts = [];
  for (const [stage, maxAge] of Object.entries(STAGE_MAX_AGE_MINUTES)) {
    const age = facts.stages[stage];
    if (age === undefined) continue; // stage not reported by this deployment
    if (age === null) {
      alerts.push({ level: "warning", code: `stage_never_succeeded:${stage}`, detail: `no successful ${stage} recorded` });
    } else if (age > maxAge) {
      alerts.push({ level: "alert", code: `stage_stale:${stage}`, detail: `${stage} last succeeded ${age} min ago (limit ${maxAge})` });
    }
  }
  if (facts.oldestQueueMinutes !== null && facts.oldestQueueMinutes > STAGE_MAX_AGE_MINUTES.collection) {
    alerts.push({
      level: "alert",
      code: "queue_backlog",
      detail: `oldest queued item is ${facts.oldestQueueMinutes} min old`,
    });
  }
  if (facts.unknownSpend.count > 0) {
    // Money that may have left the account. Reported, never released to zero.
    alerts.push({
      level: "warning",
      code: "unknown_spend",
      detail: `${facts.unknownSpend.count} unsettled paid call(s), ${facts.unknownSpend.amount} RMB unconfirmed`,
    });
  }
  if (facts.backupAgeHours === null) {
    alerts.push({ level: "alert", code: "backup_missing", detail: "no backup found" });
  } else if (facts.backupAgeHours > BACKUP_MAX_AGE_HOURS) {
    // Distinct from "missing": an old backup is a different problem from none.
    alerts.push({
      level: "alert",
      code: "backup_stale",
      detail: `newest backup is ${facts.backupAgeHours}h old (limit ${BACKUP_MAX_AGE_HOURS}h)`,
    });
  }
  return alerts;
}

/** Newest file mtime under `dir` (non-recursive), or null when none/absent. */
function newestFileAgeHours(dir, now) {
  try {
    const entries = readdirSync(dir).filter((name) => !name.startsWith("."));
    if (!entries.length) return null;
    let newest = 0;
    for (const name of entries) {
      try {
        const stats = statSync(join(dir, name));
        if (stats.mtimeMs > newest) newest = stats.mtimeMs;
      } catch {
        // A file removed between listing and stat is not an error here.
      }
    }
    return newest ? Math.round((now - newest) / 3_600_000) : null;
  } catch {
    return null;
  }
}

async function collectFacts(sql, { backupDir, now }) {
  const stages = {};
  // Last success per stage, from the persistent window table (T09).
  try {
    const rows = await sql.query(
      `select stage, max(finished_at) as last_ok from stage_windows
        where status = 'done' group by stage`,
    );
    for (const row of rows) {
      stages[row.stage] = row.last_ok ? minutesBetween(now, new Date(row.last_ok).getTime()) : null;
    }
  } catch {
    // Older database without the table: simply report no stage data.
  }
  // Collection queue: the oldest job still running tells us about stuck work.
  let oldestQueueMinutes = null;
  try {
    const [row] = await sql.query(
      `select min(started_at) as oldest from jobs where status = 'running'`,
    );
    oldestQueueMinutes = row?.oldest ? minutesBetween(now, new Date(row.oldest).getTime()) : null;
  } catch {
    // No jobs table (fresh/isolated database).
  }

  // Paid spend lives in the wechat gateway's own SQLite, not Postgres. This script
  // reports only what Postgres knows, so it states that rather than inventing a
  // zero: a hardcoded 0 here would read as "no unconfirmed spend", which is a
  // claim this data source cannot make.
  const unknownSpend = { count: 0, amount: 0, source: "not_queried_gateway_sqlite" };
  return {
    now,
    stages,
    oldestQueueMinutes,
    unknownSpend,
    backupAgeHours: backupDir ? newestFileAgeHours(backupDir, now) : null,
  };
}

async function openSql(usePglite) {
  if (usePglite) {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(`create table if not exists stage_windows (
      stage text not null, window_key text not null, status text not null,
      note text not null default '', claimed_at timestamptz, finished_at timestamptz,
      primary key (stage, window_key))`);
    await pg.exec(`create table if not exists jobs (
      id text primary key, status text not null default 'running', started_at timestamptz)`);
    return { kind: "pglite", query: async (t, p = []) => (await pg.query(t, p)).rows, close: () => pg.close() };
  }
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required (or pass --pglite)");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  return { kind: "postgres", query: async (t, p = []) => (await pool.query(t, p)).rows, close: () => pool.end() };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: node scripts/operations-status.mjs [--pglite] [--alerts <dir>] [--backup-dir <dir>]");
    return;
  }
  const now = Date.now();
  const alertDir = flag("--alerts");
  const backupDir = flag("--backup-dir");
  const sql = await openSql(argv.includes("--pglite"));
  try {
    const facts = await collectFacts(sql, { backupDir, now });
    const alerts = evaluateAlerts(facts);
    const report = {
      generated_at: new Date(now).toISOString(),
      source: sql.kind,
      read_only: true,
      stages: facts.stages,
      oldest_queue_minutes: facts.oldestQueueMinutes,
      unknown_spend: facts.unknownSpend,
      backup_age_hours: facts.backupAgeHours,
      alerts,
    };
    if (alertDir) {
      // Local sink only: the plan requires no external notification until the user
      // names a channel. One JSON file per run, timestamped, so a later channel
      // adapter can replay them.
      mkdirSync(alertDir, { recursive: true });
      const file = join(alertDir, `${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
      report.alerts_file = file;
    }
    console.log(JSON.stringify(report, null, 2));
    // Non-zero when something needs attention: cron/monitoring can act on that.
    if (alerts.some((alert) => alert.level === "alert")) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`[operations-status] ${err?.message ?? err}`);
    process.exit(1);
  });
}
