import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  claimSource,
  claimKeyword,
  failSourceClaim,
  failKeywordClaim,
  completeSourceClaim,
  completeKeywordClaim,
  selectDueCollections,
  clearConfigurationFailure,
} from "./scheduler-atomic.ts";
import { fairCollectionQueue } from "./cron.ts";

test("persisted retries fence scheduled/manual workers, survive reopen, and success resets failures", async () => {
  let pg = new PGlite();
  await pg.waitReady;
  for (const table of ["sources", "keywords"])
    await pg.exec(
      `create table ${table} (id text primary key, enabled boolean default true, status text default 'idle', last_error text default '', last_scanned_at timestamptz, interval_minutes int default 30, claim_token text default '', claimed_at timestamptz, last_external_id text default '', last_published_at timestamptz, has_more boolean default false, hits int default 0)`,
    );
  await pg.exec(readFileSync("migrations/0023_collection_retry.sql", "utf8"));
  const sql = {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  await pg.exec("insert into sources(id) values ('s'); insert into keywords(id) values ('k')");
  assert.ok(await claimSource(sql, "s", "old"));
  const retryAt = Date.now() + 48 * 3600000;
  assert.equal(
    await failSourceClaim(
      sql,
      "s",
      "old",
      Object.assign(new Error("HTTP 429"), { code: "rate_limited", status: 429, retryAt }),
    ),
    true,
  );
  const snapshot = await pg.dumpDataDir();
  await pg.close();
  pg = new PGlite({ loadDataDir: snapshot });
  await pg.waitReady;
  assert.equal(await claimSource(sql, "s", "new"), null);
  assert.equal(await claimSource(sql, "s", "manual", true), null);
  assert.equal((await selectDueCollections(sql, 10)).sources.length, 0);
  await clearConfigurationFailure(sql, "sources", "s");
  assert.equal(await claimSource(sql, "s", "manual", true), null);
  const [row] = await sql.query<any>("select * from sources where id='s'");
  assert.ok(new Date(row.next_attempt_at).getTime() >= retryAt);
  assert.equal(row.consecutive_failures, 1);
  await pg.exec("update sources set next_attempt_at=now()-interval '1 second'");
  assert.ok(await claimSource(sql, "s", "new"));
  assert.equal(await completeSourceClaim(sql, "s", "old", "bad", null), false);
  assert.equal(await failSourceClaim(sql, "s", "old", "timeout"), false);
  assert.equal(await completeSourceClaim(sql, "s", "new", "good", null), true);
  const [ok] = await sql.query<any>("select * from sources where id='s'");
  assert.equal(ok.consecutive_failures, 0);
  assert.equal(ok.next_attempt_at, null);
  assert.equal(ok.last_error_code, "");
  assert.ok(ok.last_success_at);
  assert.equal(await claimSource(sql, "s", "scheduled"), null);
  assert.ok(await claimSource(sql, "s", "manual", true));
  assert.ok(await claimKeyword(sql, "k", "k1"));
  await failKeywordClaim(
    sql,
    "k",
    "k1",
    Object.assign(new Error("HTTP 403"), { status: 403, code: "http_error" }),
  );
  const [kw] = await sql.query<any>("select * from keywords where id='k'");
  assert.ok(new Date(kw.next_attempt_at).getTime() > Date.now() + 5 * 3600000);
  assert.equal(kw.last_error_code, "config_error");
  assert.equal(await claimKeyword(sql, "k", "manual", true), null);
  await clearConfigurationFailure(sql, "keywords", "k");
  assert.ok(await claimKeyword(sql, "k", "k2", true));
  await completeKeywordClaim(sql, "k", "k2", "", 0);
  assert.equal(
    (await sql.query<any>("select consecutive_failures from keywords"))[0].consecutive_failures,
    0,
  );
  // Retry cadence supersedes ordinary 30-minute cadence, with bounded positive jitter.
  for (const [index, minutes] of [1, 5, 15, 60, 60].entries()) {
    await sql.query(
      "update sources set claim_token='retry', status='running', consecutive_failures=$1, next_attempt_at=null where id='s'",
      [index],
    );
    await failSourceClaim(
      sql,
      "s",
      "retry",
      Object.assign(new Error("timeout"), { code: "timeout" }),
    );
    const [delay] = await sql.query<{ minutes: number }>(
      "select extract(epoch from (next_attempt_at-last_scanned_at))/60 as minutes from sources where id='s'",
    );
    assert.ok(Number(delay.minutes) >= minutes && Number(delay.minutes) <= minutes * 1.2);
  }
  await pg.exec(`insert into sources(id,last_scanned_at,interval_minutes) values
    ('older-scan',now()-interval '40 minutes',39),('more-overdue',now()-interval '20 minutes',1);
    insert into sources(id,has_more,last_scanned_at) values('continuation',true,now()-interval '2 minutes');
    insert into sources(id,next_attempt_at) values('cold',now()+interval '5 minutes');`);
  const selected = await selectDueCollections(sql, 10);
  assert.deepEqual(
    selected.sources.map((r) => r.id),
    ["more-overdue", "older-scan"],
  );
  assert.deepEqual(
    selected.backfill.map((r) => r.id),
    ["continuation"],
  );
  await pg.exec(
    "update sources set enabled=false where id='cold'; update sources set enabled=true where id='cold'",
  );
  assert.equal(await claimSource(sql, "cold", "manual", true), null);
  assert.ok(await claimSource(sql, "continuation", "page"));
  assert.equal(await completeKeywordClaim(sql, "k", "obsolete", "", 0), false);
  await pg.close();
});

test("fair queue reserves keyword and continuation work, with borrowed unused capacity", () => {
  const normal = Array.from({ length: 20 }, (_, n) => ({ id: `n${n}` }));
  const backfill = Array.from({ length: 20 }, (_, n) => ({ id: `b${n}` }));
  const keywords = Array.from({ length: 20 }, (_, n) => ({ id: `k${n}` }));
  const queue = fairCollectionQueue(normal, backfill, keywords, 12);
  assert.equal(queue.length, 12);
  assert.equal(queue.filter((x) => x.kind === "keyword").length, 2);
  assert.equal(queue.filter((x) => x.row.id.startsWith("b")).length, 2);
  assert.deepEqual(
    fairCollectionQueue([], backfill, [], 5).map((x) => x.row.id),
    ["b0", "b1", "b2", "b3", "b4"],
  );
});
