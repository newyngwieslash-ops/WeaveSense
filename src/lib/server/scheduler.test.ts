import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { claimSource, finishItemInsert } from "./scheduler-atomic.ts";

test("concurrent source claims allow only one worker through", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table sources (
    id text primary key,
    enabled boolean not null,
    status text not null,
    last_error text not null
  )`);
  await pg.query("insert into sources values ($1, true, 'idle', 'old')", ["source-1"]);
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };

  let arrived = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const contender = async () => {
    arrived += 1;
    if (arrived === 2) release();
    await barrier;
    return claimSource(sql, "source-1");
  };
  const claims = await Promise.all([contender(), contender()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const row = await pg.query<{ status: string; last_error: string }>(
    "select status, last_error from sources where id = $1", ["source-1"],
  );
  assert.deepEqual(row.rows, [{ status: "running", last_error: "" }]);
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
