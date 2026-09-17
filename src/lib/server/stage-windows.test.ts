import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  claimStageWindow,
  finishStageWindow,
  runStageOnce,
  stageWindowKey,
  STAGE_INTERVAL_MINUTES,
  STAGE_CLAIM_TIMEOUT_MINUTES,
} from "./stage-windows.ts";

/**
 * T09: the heavy production stages run on their own persistent windows, so a
 * faster scheduler wake-up cannot multiply ingest/OCR/paid-reconciliation by 30×.
 *
 * The migration itself is applied here (not a hand-written fixture table), so
 * the test fails if the SQL and the code ever disagree.
 */
async function db() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(readFileSync("migrations/0021_stage_windows.sql", "utf8"));
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  return { pg, sql };
}

const rows = async (pg: PGlite) =>
  (await pg.query<{ stage: string; status: string; note: string }>(
    "select stage, window_key, status, note from stage_windows order by stage, window_key",
  )).rows;

test("the window key follows the stage interval, not the tick interval", () => {
  const t = Date.parse("2026-09-16T10:31:00.000Z");
  // A 30-minute stage has two windows per hour; one minute later is the same window.
  assert.equal(stageWindowKey("ingest", t), stageWindowKey("ingest", t + 60_000));
  assert.notEqual(stageWindowKey("ingest", t), stageWindowKey("ingest", t + 30 * 60_000));
  // The same instant in different stages yields different keys.
  assert.notEqual(stageWindowKey("ingest", t), stageWindowKey("extract", t));
});

test("a 60-second wake-up still runs the heavy stages once per their own window", async () => {
  const { pg, sql } = await db();
  // 10:31 — inside the 10:30–11:00 ingest window.
  const base = Date.parse("2026-09-16T10:31:00.000Z");
  let runs = 0;
  const run = async () => { runs += 1; return { ok: true, note: "done" }; };

  // 29 wakes at one-minute intervals stay inside the same 30-minute window
  // (10:31 … 10:59). Under the old 30-minute cadence this was one run; under a
  // 60-second wake-up it must STILL be one run.
  const outcomes = [];
  for (let minute = 0; minute < 29; minute += 1) {
    outcomes.push(await runStageOnce(sql, "ingest", run, base + minute * 60_000));
  }
  assert.equal(runs, 1, "a faster tick must not multiply the heavy stage");
  assert.equal(outcomes.filter((o) => o.ran).length, 1);
  assert.ok(outcomes.slice(1).every((o) => o.reason === "already_ran" || o.reason === "in_flight"));

  // Crossing into the next window (11:00) admits exactly once more.
  const next = await runStageOnce(sql, "ingest", run, base + 29 * 60_000);
  assert.equal(next.ran, true, "the next window must still run");
  assert.equal(runs, 2);
  await pg.close();
});

test("a restart cannot re-run a window already claimed (no in-memory dedupe)", async () => {
  const { pg, sql } = await db();
  const now = Date.parse("2026-09-16T10:31:00.000Z");
  const first = await claimStageWindow(sql, "extract", now);
  assert.equal(first.admitted, true);

  // Simulate a brand-new process: the only shared state is the database row.
  const fromAnotherProcess = await claimStageWindow(sql, "extract", now);
  assert.equal(fromAnotherProcess.admitted, false);
  assert.equal(fromAnotherProcess.reason, "in_flight");
  await pg.close();
});

test("two concurrent claims admit exactly one", async () => {
  const { pg, sql } = await db();
  const now = Date.parse("2026-09-16T10:31:00.000Z");
  const [a, b] = await Promise.all([
    claimStageWindow(sql, "reconcile", now),
    claimStageWindow(sql, "reconcile", now),
  ]);
  assert.equal([a, b].filter((r) => r.admitted).length, 1, "only one claim may win");
  await pg.close();
});

test("a completed window blocks re-entry, and reports why", async () => {
  const { pg, sql } = await db();
  const now = Date.parse("2026-09-16T10:31:00.000Z");
  const first = await runStageOnce(sql, "ingest", async () => ({ ok: true, note: "3 stored" }), now);
  assert.equal(first.ran, true);
  const second = await claimStageWindow(sql, "ingest", now);
  assert.equal(second.admitted, false);
  assert.equal(second.reason, "already_ran");
  const [row] = await rows(pg);
  assert.equal(row.note, "3 stored");
  await pg.close();
});

test("a failed window is not retried inside the same window", async () => {
  const { pg, sql } = await db();
  const now = Date.parse("2026-09-16T10:31:00.000Z");
  let attempts = 0;
  const failing = async () => { attempts += 1; return { ok: false, note: "provider_5xx" }; };

  assert.equal((await runStageOnce(sql, "ingest", failing, now)).ran, true);
  const retry = await claimStageWindow(sql, "ingest", now);
  assert.equal(retry.admitted, false, "an immediately-retried paid stage is a spend loop");
  assert.equal(retry.reason, "already_failed");
  assert.equal(attempts, 1);

  // The next window does try again.
  assert.equal((await runStageOnce(sql, "ingest", failing, now + 30 * 60_000)).ran, true);
  assert.equal(attempts, 2);
  await pg.close();
});

test("a stage that throws is recorded as failed, not left claimed", async () => {
  const { pg, sql } = await db();
  const now = Date.parse("2026-09-16T10:31:00.000Z");
  const outcome = await runStageOnce(sql, "extract", async () => { throw new Error("boom"); }, now);
  assert.equal(outcome.ran, true);
  assert.equal(outcome.result?.ok, false);
  const [row] = await rows(pg);
  assert.equal(row.status, "failed");
  assert.match(row.note, /boom/);
  await pg.close();
});

test("a stale claim from a killed process is reclaimable after the timeout", async () => {
  const { pg, sql } = await db();
  const now = Date.parse("2026-09-16T10:31:00.000Z");
  const first = await claimStageWindow(sql, "reconcile", now);
  assert.equal(first.admitted, true);

  // Still fresh: no takeover.
  assert.equal((await claimStageWindow(sql, "reconcile", now + 60_000)).admitted, false);

  // Past the timeout the owner is presumed dead, so a new process may take over
  // in the SAME window — otherwise a crash would silently skip a whole period.
  const later = now + (STAGE_CLAIM_TIMEOUT_MINUTES + 1) * 60_000;
  const taken = await claimStageWindow(sql, "reconcile", later);
  assert.equal(taken.admitted, true);
  await pg.close();
});

test("an unknown stage cannot be claimed", async () => {
  const { pg, sql } = await db();
  await assert.rejects(
    // @ts-expect-error deliberately outside the closed set
    () => claimStageWindow(sql, "anything", Date.now()),
    /invalid_stage/,
  );
  await pg.close();
});

test("finishing a stage never invents a window", async () => {
  const { pg, sql } = await db();
  await finishStageWindow(sql, "ingest", "ingest:1999-01-01T00:00:00.000Z", { ok: true });
  assert.deepEqual(await rows(pg), [], "no row may be created by a finish call");
  await pg.close();
});

test("the WeChat source convention stays at 60 minutes, independent of the wake-up", () => {
  // The plan requires the 60-minute WeChat source agreement to be untouched by
  // the scheduler wake-up change. Sources keep their own interval_minutes; the
  // wake-up only decides how promptly a due source is noticed.
  //
  // Asserted against the seed source text rather than the module: seed.ts imports
  // `@/...` aliases that bare Node cannot resolve, so importing it here would be a
  // module-resolution failure, not a statement about the cadence.
  const seed = readFileSync("src/lib/server/seed.ts", "utf8");
  // Slice at each `id: "..."` so a block runs to the next entry regardless of
  // how the fields inside are formatted.
  const blocks = seed.split(/\n\s*id: "/).slice(1);
  const wechatBlocks = blocks.filter((block) => /platform: "wechat"/.test(block.split(/\n\s*id: "/)[0]));
  assert.ok(wechatBlocks.length > 0, "expected seeded WeChat sources");
  for (const block of wechatBlocks) {
    const entry = block.split(/\n\s*id: "/)[0];
    const interval = /interval_minutes: (\d+)/.exec(entry)?.[1];
    assert.equal(interval, "60", `a WeChat source drifted off the 60-minute agreement: ${interval}`);
  }
});

test("the stage intervals keep their documented values", () => {
  // A regression here is the 30× frequency change the plan forbids.
  assert.equal(STAGE_INTERVAL_MINUTES.ingest, 30);
  assert.equal(STAGE_INTERVAL_MINUTES.extract, 30);
  assert.ok(STAGE_INTERVAL_MINUTES.reconcile >= 1440, "the paid reconciliation window is daily at most");
});
