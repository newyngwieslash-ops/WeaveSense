import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { claimSource, completeSourceClaim, finishItemInsert } from "./scheduler-atomic.ts";

async function sourceDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table sources (
    id text primary key,
    enabled boolean not null,
    status text not null,
    last_error text not null,
    last_external_id text not null default '',
    last_published_at timestamptz,
    last_scanned_at timestamptz,
    claim_token text not null default '',
    claimed_at timestamptz
  )`);
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  return { pg, sql };
}

test("concurrent source claims allow only one worker through", async () => {
  const { pg, sql } = await sourceDb();
  await pg.query("insert into sources (id, enabled, status, last_error) values ($1, true, 'idle', 'old')", ["source-1"]);

  let arrived = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const contender = async (token: string) => {
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    return claimSource(sql, "source-1", token);
  };
  const claims = await Promise.all([contender("job-1"), contender("job-2")]);
  assert.equal(claims.filter(Boolean).length, 1);
  const row = await pg.query<{ status: string; last_error: string; claim_token: string }>(
    "select status, last_error, claim_token from sources where id = $1", ["source-1"],
  );
  assert.equal(row.rows[0]?.status, "running");
  assert.equal(row.rows[0]?.last_error, "");
  assert.ok(["job-1", "job-2"].includes(row.rows[0]?.claim_token ?? ""));
  await pg.close();
});

test("expired source claims are recoverable and completion is token-bound", async () => {
  const { pg, sql } = await sourceDb();
  await pg.query(
    `insert into sources (id, enabled, status, last_error, last_external_id, claim_token, claimed_at)
     values ($1, true, 'running', 'old error', 'old-cursor', 'old-job', now() - interval '16 minutes')`,
    ["source-1"],
  );
  const reclaimed = await claimSource(sql, "source-1", "new-job");
  assert.equal(reclaimed?.claim_token, "new-job");
  await pg.query("update sources set last_error = 'new-worker-state' where id = $1", ["source-1"]);

  assert.equal(await completeSourceClaim(sql, "source-1", "old-job", "stale-cursor", null), false);
  let current = await pg.query<{ status: string; claim_token: string; last_external_id: string; last_error: string }>(
    "select status, claim_token, last_external_id, last_error from sources where id = $1", ["source-1"],
  );
  assert.deepEqual(current.rows, [{ status: "running", claim_token: "new-job",
    last_external_id: "old-cursor", last_error: "new-worker-state" }]);

  assert.equal(await completeSourceClaim(sql, "source-1", "new-job", "new-cursor", null), true);
  current = await pg.query<{ status: string; claim_token: string; last_external_id: string; last_error: string }>(
    "select status, claim_token, last_external_id, last_error from sources where id = $1", ["source-1"],
  );
  assert.deepEqual(current.rows, [{ status: "ok", claim_token: "",
    last_external_id: "new-cursor", last_error: "" }]);
  await pg.close();
});

test("a conflicted item insert never enqueues media", async () => {
  let enqueued = 0;
  const inserted = await finishItemInsert([], ["https://img.example/cover.jpg"], "image", async () => {
    enqueued += 1;
  });
  assert.equal(inserted, false);
  assert.equal(enqueued, 0);
});
