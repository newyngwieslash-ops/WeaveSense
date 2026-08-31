import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  enqueueReconciliationSources,
  processReconciliationQueue,
  RECONCILIATION_QUEUE_CONCURRENCY,
} from "./reconciliation-queue.ts";
import { mergeExistingItem } from "./scheduler-atomic.ts";
import { parseFeedXml } from "./rss-parser.ts";

async function migrateQueue(pg: PGlite): Promise<void> {
  for (const migration of ["0006_reconciliation_queue.sql", "0008_reconciliation_queue_retry.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
}

test("0008 upgrades the published 0006 queue without losing existing rows", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(readFileSync(new URL("../../../migrations/0006_reconciliation_queue.sql", import.meta.url), "utf8"));
  await pg.query("insert into reconciliation_queue (source_id,attempts,last_error) values ('legacy',2,'retry')");
  await pg.exec(readFileSync(new URL("../../../migrations/0008_reconciliation_queue_retry.sql", import.meta.url), "utf8"));
  const row = (await pg.query<{ source_id: string; attempts: number; last_error: string;
    updated_at: Date; next_attempt_at: Date }>("select * from reconciliation_queue where source_id='legacy'"))
    .rows[0];
  assert.equal(row?.source_id, "legacy");
  assert.equal(row?.attempts, 2);
  assert.equal(row?.last_error, "retry");
  assert.ok(row?.updated_at);
  assert.ok(row?.next_attempt_at);
  await pg.close();
});

test("reconciliation queue is idempotent, bounded, and retries failures next tick", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await migrateQueue(pg);
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };

  await enqueueReconciliationSources(sql, ["wx-1", "wx-2", "wx-1"]);
  await enqueueReconciliationSources(sql, ["wx-2"]);
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from reconciliation_queue")).rows[0]?.n, 2);

  let now = 0;
  const first = await processReconciliationQueue(sql, async (sourceId) => {
    now += 10;
    return { source_id: sourceId, items_found: 1, items_new: 1, error: "" };
  }, { deadlineMs: 25, reserveMs: 20, now: () => now });
  assert.deepEqual(first, { processed: 1, succeeded: 1, failed: 0, deferred: 1, results: [
    { source_id: "wx-1", items_found: 1, items_new: 1, error: "" },
  ] });

  const failed = await processReconciliationQueue(sql, async (sourceId) => ({
    source_id: sourceId, items_found: 0, items_new: 0, error: "provider secret",
  }), { deadlineMs: 50, reserveMs: 20, now: () => now });
  assert.deepEqual(failed, { processed: 1, succeeded: 0, failed: 1, deferred: 1, results: [
    { source_id: "wx-2", items_found: 0, items_new: 0, error: "reconcile_scan_failed" },
  ] });
  assert.deepEqual((await pg.query("select source_id, attempts, last_error from reconciliation_queue" )).rows,
    [{ source_id: "wx-2", attempts: 1, last_error: "reconcile_scan_failed" }]);

  const backedOff = await processReconciliationQueue(sql, async (sourceId) => ({
    source_id: sourceId, items_found: 2, items_new: 1, error: "",
  }), { deadlineMs: 50, reserveMs: 20, now: () => now });
  assert.equal(backedOff.processed, 0);
  assert.equal(backedOff.deferred, 1);
  await pg.query("update reconciliation_queue set next_attempt_at = now() - interval '1 minute'");
  const retried = await processReconciliationQueue(sql, async (sourceId) => ({
    source_id: sourceId, items_found: 2, items_new: 1, error: "",
  }), { deadlineMs: 50, reserveMs: 20, now: () => now });
  assert.equal(retried.succeeded, 1);
  assert.equal(retried.deferred, 0);
  await pg.close();
});

test("batch enqueue is atomic when a later source violates the queue schema", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await migrateQueue(pg);
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  await assert.rejects(enqueueReconciliationSources(sql, ["wx-good", "unsafe source"]));
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from reconciliation_queue"))
    .rows[0]?.n, 0);
  await enqueueReconciliationSources(sql, ["wx-good", "wx-good"]);
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from reconciliation_queue"))
    .rows[0]?.n, 1);
  await pg.close();
});

test("detail outbox rescan merges the existing canonical row before deleting its queue entry", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql", "0003_keywords.sql", "0006_reconciliation_queue.sql",
    "0008_reconciliation_queue_retry.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query(`insert into items
    (id,source_id,platform,external_id,title,body,thumbnail_url,extra,matched_keywords)
    values ('item-1','wx-1','wechat','wx:canonical','旧标题',
      E'列表摘要\\n\\n[OCR:image-1]\\n已有识别结果','','{"kept":true,"body_complete":false}','["已有词"]')`);
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  await enqueueReconciliationSources(sql, ["wx-1"]);
  const result = await processReconciliationQueue(sql, async (sourceId) => {
    const [detail] = parseFeedXml(`<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:loom="https://loom.local/ns"><entry><id>wx:canonical</id><title>新标题</title>
      <published>2026-08-29T08:00:00.000Z</published>
      <link rel="alternate" href="https://mp.weixin.qq.com/s/detail"/>
      <content type="html"><![CDATA[<p>付费详情完整正文</p>]]></content>
      <loom:provider>dajiala</loom:provider><loom:body_complete>true</loom:body_complete>
      </entry></feed>`, sourceId, "wechat");
    await mergeExistingItem(sql, "item-1", detail, ["新词"]);
    return { source_id: sourceId, items_found: 1, items_new: 0, error: "" };
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.deferred, 0);
  const row = (await pg.query<{ body: string; thumbnail_url: string; extra: Record<string, unknown>;
    matched_keywords: string[] }>("select body,thumbnail_url,extra,matched_keywords from items where id='item-1'"))
    .rows[0];
  assert.equal(row?.body, "付费详情完整正文\n\n[OCR:image-1]\n已有识别结果");
  assert.deepEqual(row?.extra, { kept: true, platform: "wechat", provider: "dajiala",
    body_complete: true });
  assert.deepEqual(row?.matched_keywords, ["已有词", "新词"]);
  assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from items where external_id='wx:canonical'"))
    .rows[0]?.n, 1);

  await mergeExistingItem(sql, "item-1", { title: "再次扫描", body: "列表正文", author: "",
    url: "", media_type: "article", media_urls: [], thumbnail_url: "", views: null, likes: null,
    published_at: null, extra: { provider: "primary", body_complete: false } }, []);
  assert.equal((await pg.query<{ body: string }>("select body from items where id='item-1'"))
    .rows[0]?.body, "付费详情完整正文\n\n[OCR:image-1]\n已有识别结果");
  assert.equal((await pg.query<{ complete: boolean }>(
    "select (extra->>'body_complete')::boolean as complete from items where id='item-1'"))
    .rows[0]?.complete, true);
  await pg.close();
});

test("reconciliation queue runs its two due sources concurrently", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await migrateQueue(pg);
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  await enqueueReconciliationSources(sql, ["one", "two"]);
  let active = 0;
  let peak = 0;
  const result = await processReconciliationQueue(sql, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { items_found: 1, items_new: 0, error: "" };
  });
  assert.equal(RECONCILIATION_QUEUE_CONCURRENCY, 2);
  assert.equal(peak, 2);
  assert.equal(result.succeeded, 2);
  await pg.close();
});
