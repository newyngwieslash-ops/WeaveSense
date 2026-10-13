import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { previewArticleWith, adoptArticleWith, restoreArticleWith, articleAvailability } from "./article-enrichment.ts";
import { mergeExistingItem } from "./scheduler-atomic.ts";
import { beginRun, validateEvidenceSnapshot } from "./agent-runs.ts";
import { evidenceSourceFor } from "./agent-context.ts";
import { mapAgentItem } from "./agent-retrieval.ts";
import { loadCheckpoint, saveCheckpoint } from "./agent-checkpoints.ts";
import type { FetchIo } from "./http.ts";
import type { Queryable, Sql } from "../db.ts";

async function setup(t: { after: (fn: () => unknown) => void }) {
  const pg = new PGlite(); await pg.waitReady; t.after(() => pg.close());
  for (const name of ["0002_schema.sql", "0003_keywords.sql", "0004_production.sql", "0011_ai_runs.sql", "0012_ai_jobs.sql",
    "0013_agent_checkpoints.sql", "0014_agent_integrity.sql", "0015_agent_budget_reservations.sql", "0016_agent_terminal_states.sql",
    "0017_agent_call_receipts.sql", "0018_agent_checkpoint_facts.sql", "0019_agent_material_revision.sql", "0020_agent_daily_admission.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql: Pick<Sql, "query" | "transaction"> = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) { return (await pg.query<T>(text, params)).rows; },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    },
  };
  await sql.query("insert into sources(id,platform,name) values('s','rss','信源')");
  await sql.query(`insert into items(id,source_id,platform,external_id,title,body,author,url,pipeline_status,extra,matched_keywords)
    values('item-1','s','rss','e1','标题 &amp; 原样',E'摘要 &amp; 原样\n\n[OCR:image]\n识别\n\n[ASR:audio]\n转写','作者',
      'https://example.org/article','analyzed','{"body_complete":false,"kept":true}','["原词"]')`);
  const previous = [process.env.ARTICLE_READER_ENABLED, process.env.ARTICLE_READER_ALLOWED_HOSTS];
  process.env.ARTICLE_READER_ENABLED = "true"; process.env.ARTICLE_READER_ALLOWED_HOSTS = "example.org";
  t.after(() => {
    for (const [index, key] of ["ARTICLE_READER_ENABLED", "ARTICLE_READER_ALLOWED_HOSTS"].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  });
  const row = async () => (await sql.query<Record<string, any>>("select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id='item-1'"))[0];
  return { pg, sql, row };
}

function fixtureIo(body = "完整候选正文：良率提升。", onFetch?: () => Promise<void>): FetchIo {
  return {
    resolver: { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } },
    transport: async () => {
      await onFetch?.();
      return { status: 200, headers: { "content-type": "application/json" },
        body: new Response(JSON.stringify({ data: { title: "文章", url: "https://example.org/canonical", content: body } })).body! };
    },
  };
}

test("real candidate adoption preserves tails, advances trigger version, invalidates checkpoint, and restores once", async t => {
  const f = await setup(t); const original = await f.row();
  await f.sql.query("insert into keywords(id,phrase,enabled) values('new','良率',true),('off','完整',false)");
  await f.sql.query("insert into analyses(id,item_id,summary) values('history','item-1','历史分析')");
  const material = mapAgentItem(original);
  const source = evidenceSourceFor(material, { start: 0, end: Array.from(material.body).length, text: material.body }, "full");
  const runId = randomUUID();
  await beginRun(f.sql, { id: runId, requestId: randomUUID(), mode: "research", provider: "eino", inputHash: "h", materialHash: "m",
    policyVersion: "loom-agent-v1", requestJson: { sources: [source] }, claimToken: "claim", expiresAt: new Date(Date.now()+60000).toISOString() });
  assert.equal(await saveCheckpoint(f.sql, { runId, checkPointId: "cp", claimToken: "claim", sequence: 1,
    schemaVersion: "1", runtimeVersion: "eino-v0.9.19", payload: Buffer.from("opaque") }), "ok");
  assert.equal((await loadCheckpoint(f.sql, { runId, checkPointId: "cp", runtimeVersion: "eino-v0.9.19" })).ok, true);
  let calls = 0;
  const io = fixtureIo(undefined, async () => { calls++; });
  const candidate = await previewArticleWith({ sql: f.sql, itemId: "item-1", io });
  assert.equal(candidate.cached, false); assert.equal(candidate.materialVersion, 0);
  assert.equal((await f.row()).body, original.body); assert.equal(Number((await f.row()).material_version), 0);
  assert.equal((await previewArticleWith({ sql: f.sql, itemId: "item-1", io })).cached, true);
  assert.equal(calls, 1, "canonical reader URL must not break original URL cache binding");
  await assert.rejects(adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: "0".repeat(64), expectedVersion: 0 }), /article_candidate_stale/);
  const adopted = await adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion: 0 });
  assert.equal(adopted.materialVersion, 1);
  const current = await f.row();
  assert.equal(current.body, candidate.body + "\n\n[OCR:image]\n识别\n\n[ASR:audio]\n转写");
  assert.equal(current.title, original.title); assert.equal(current.extra.article_previous_body, original.body);
  assert.equal(current.extra.article_previous_complete, false); assert.equal(current.extra.article_adopted_version, 1);
  assert.equal(current.extra.article_candidate, undefined); assert.equal(current.extra.article_claim_token, undefined);
  assert.equal(current.pipeline_status, "ingested"); assert.equal(current.extra.body_complete, true);
  assert.deepEqual(current.matched_keywords, ["原词", "良率"]);
  assert.equal((await f.sql.query("select * from analyses")).length, 1);
  assert.equal((await f.sql.query("select * from ai_jobs")).length, 0, "adoption must not auto-enqueue paid models");
  assert.deepEqual(await loadCheckpoint(f.sql, { runId, checkPointId: "cp", runtimeVersion: "eino-v0.9.19" }), { ok: false, error: "checkpoint_input_changed" });
  assert.deepEqual(await f.sql.transaction(tx => validateEvidenceSnapshot(tx, [{ ...source, origin: "internal" }])), { ok: false, error: "input_changed" });
  await assert.rejects(adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion: 0 }), /article_conflict/);
  await assert.rejects(adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion: 1 }), /article_candidate_stale/);
  await mergeExistingItem(f.sql, "item-1", { title: "", body: "Feed摘要", author: "", url: "", media_type: "article", media_urls: [],
    thumbnail_url: "", views: null, likes: null, published_at: null, extra: { body_complete: false, article_state: "error" } }, []);
  assert.equal((await f.row()).body, current.body); assert.equal((await f.row()).extra.article_state, "adopted");
  const restored = await restoreArticleWith({ sql: f.sql, itemId: "item-1", expectedVersion: 1 });
  assert.equal(restored.materialVersion, 2); assert.equal((await f.row()).body, original.body);
  assert.equal((await f.row()).extra.body_complete, false); assert.equal((await f.row()).extra.article_state, "restored");
  assert.equal((await f.row()).extra.article_candidate, undefined); assert.equal((await f.row()).pipeline_status, "ingested");
  await assert.rejects(restoreArticleWith({ sql: f.sql, itemId: "item-1", expectedVersion: 2 }), /article_conflict/);
});

test("mixed subtitle OCR ASR tails survive common merge and article adoption; later subtitle blocks restore", async t => {
  const f = await setup(t);
  const tail = "[字幕: en; manual]\ncaption\n\n[OCR:image]\n识别\n\n[ASR:audio]\n转写";
  await f.sql.query("update items set body=$1,extra=extra || $2::jsonb where id='item-1'", ["摘要\n\n"+tail, JSON.stringify({transcript_digest:"kept",transcript_object_key:"private/kept"})]);
  const before=await f.row();
  const candidate=await previewArticleWith({sql:f.sql,itemId:"item-1",io:fixtureIo()});
  const adopted=await adoptArticleWith({sql:f.sql,itemId:"item-1",digest:candidate.digest,expectedVersion:Number(before.material_version)});
  assert.equal((await f.row()).body,candidate.body+"\n\n"+tail);
  assert.equal((await f.row()).extra.transcript_digest,"kept");
  await f.sql.query("update items set body=body||E'\\n\\n[字幕: zh-Hans; manual]\\n新字幕' where id='item-1'");
  await assert.rejects(restoreArticleWith({sql:f.sql,itemId:"item-1",expectedVersion:adopted.materialVersion}),/article_conflict/);
});

test("fetch admission, lease expiry and token fencing survive material races without HTTP transactions", async t => {
  const f = await setup(t); let release!: () => void; let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const candidate = previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo(undefined, async () => { started(); await waiting; }) });
  await began;
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() }), /article_busy/);
  await f.sql.query("insert into items(id,source_id,platform,external_id,url) values('item-2','s','rss','e2','https://example.org/two')");
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-2", io: fixtureIo() }), /article_busy/);
  await f.sql.query("update items set body=body||E'\n新OCR' where id='item-1'");
  release(); await assert.rejects(candidate, /article_conflict/);
  assert.ok((await f.row()).body.endsWith("新OCR")); assert.equal((await f.row()).extra.article_candidate, undefined);
  assert.equal((await f.row()).extra.article_claim_token, undefined);
  await f.sql.query(`update items set extra=extra || '{"article_claim_token":"other","article_claimed_at":"2000-01-01T00:00:00.000Z"}'::jsonb where id='item-1'`);
  const renewed = await previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() });
  assert.equal(renewed.materialVersion, 1);
  await f.sql.query(`update items set extra=(extra - 'article_candidate') || $1::jsonb where id='item-1'`,
    [JSON.stringify({ article_claim_token: "active", article_claimed_at: new Date().toISOString() })]);
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() }), /article_busy/);
  assert.equal((await f.row()).extra.article_claim_token, "active");
  await f.sql.query("update items set extra=extra - 'article_claim_token' - 'article_claimed_at' where id='item-1'");
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo(undefined, async () => {
    await f.sql.query(`update items set extra=extra || $1::jsonb where id='item-1'`,
      [JSON.stringify({ article_claim_token: "replacement", article_claimed_at: new Date().toISOString() })]);
  }) }), /article_conflict/);
  assert.equal((await f.row()).extra.article_claim_token, "replacement", "old release must not clear newer lease");
});

test("disabled, unsupported, unsafe ingress and cancelled reader leave material untouched", async t => {
  const f = await setup(t); const original = await f.row(); let calls = 0;
  const io = fixtureIo(undefined, async () => { calls++; throw new DOMException("aborted", "AbortError"); });
  process.env.ARTICLE_READER_ENABLED = "false";
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io }), /article_disabled/);
  process.env.ARTICLE_READER_ENABLED = "true";
  for (const id of ["", "unsafe id", "../item-1", "https://example.org/item", "a".repeat(161)]) {
    await assert.rejects(previewArticleWith({ sql: f.sql, itemId: id, io }), /article_invalid_id/);
  }
  assert.deepEqual(articleAvailability({ media_type: "video", platform: "youtube", url: original.url }), { available: false, reason: "article_unsupported" });
  assert.deepEqual(articleAvailability({ media_type: "article", platform: "wechat", url: original.url }), { available: false, reason: "article_wechat_gateway_required" });
  for (const url of ["https://example.org/article?token=a", "https://example.org/article#secret", "http://example.org/article", "https://localhost/article", "https://a:b@example.org/article"]) {
    assert.equal(articleAvailability({ media_type: "article", platform: "rss", url }).available, false);
  }
  process.env.ARTICLE_READER_ALLOWED_HOSTS = "*.example.org";
  assert.equal(articleAvailability({ media_type: "article", platform: "rss", url: original.url }).available, false);
  process.env.ARTICLE_READER_ALLOWED_HOSTS = "example.org";
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io }), /article_timeout/);
  assert.equal(calls, 1); assert.equal((await f.row()).body, original.body);
  assert.equal(Number((await f.row()).material_version), 0); assert.equal((await f.row()).extra.article_claim_token, undefined);
  assert.equal((await f.row()).extra.article_error, "article_timeout");
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo(undefined, async () => {
    throw new Error("https://example.org/private?secret=never-return-this");
  }) }), /article_read_failed/);
  assert.equal((await f.row()).extra.article_error, "article_read_failed");
  assert.equal((await f.row()).body, original.body);
  // Admission also releases on failure; a subsequent attempt can proceed.
  await previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() });
});

test("restoration refuses fresh extraction and adoption rollback never loses the old body", async t => {
  const f = await setup(t); const original = await f.row();
  const candidate = await previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() });
  await f.pg.exec(`create function reject_article_adoption() returns trigger language plpgsql as $$begin
    if new.extra->>'article_state'='adopted' then raise exception 'injected adoption rollback'; end if; return new; end$$;
    create trigger reject_article_adoption before update on items for each row execute function reject_article_adoption()`);
  await assert.rejects(adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion: 0 }), /injected adoption rollback/);
  assert.equal((await f.row()).body, original.body); assert.equal(Number((await f.row()).material_version), 0);
  assert.equal((await f.row()).extra.article_candidate, candidate.body);
  await f.sql.query("drop trigger reject_article_adoption on items");
  const adopted = await adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion: 0 });
  await f.sql.query("insert into extract_jobs(id,item_id,kind,status,result_text) values('fresh','item-1','ocr','ok','新识别')");
  assert.equal(Number((await f.row()).material_version), adopted.materialVersion+1);
  await assert.rejects(restoreArticleWith({ sql: f.sql, itemId: "item-1", expectedVersion: adopted.materialVersion }), /article_conflict/);
  await assert.rejects(restoreArticleWith({ sql: f.sql, itemId: "item-1", expectedVersion: adopted.materialVersion+1 }), /article_conflict/);
  assert.equal((await f.row()).extra.body_complete, true);
});

test("invalid candidate size and unsafe versions fail closed; existing complete body cannot be replaced", async t => {
  const f = await setup(t); const original = await f.row();
  const candidate = await previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() });
  await f.sql.query(`update items set extra=jsonb_set(extra,'{article_candidate}',$1::jsonb) where id='item-1'`, [JSON.stringify("文".repeat(700000))]);
  await assert.rejects(adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion: 0 }), /article_invalid_body/);
  assert.equal((await f.row()).body, original.body);
  for (const expectedVersion of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion }), /article_conflict/);
    await assert.rejects(restoreArticleWith({ sql: f.sql, itemId: "item-1", expectedVersion }), /article_conflict/);
  }
  await f.sql.query(`update items set material_version=9007199254740993 where id='item-1'`);
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() }), /article_conflict/);
  await f.sql.query(`update items set material_version=0,extra=extra || '{"body_complete":true}'::jsonb where id='item-1'`);
  const complete = await f.row();
  assert.deepEqual(articleAvailability({ media_type: complete.media_type, platform: complete.platform, url: complete.url, extra: complete.extra }),
    { available: false, reason: "article_already_complete" });
  await assert.rejects(previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo() }), /article_already_complete/);
  await assert.rejects(adoptArticleWith({ sql: f.sql, itemId: "item-1", digest: candidate.digest, expectedVersion: 0 }), /article_already_complete/);
  assert.equal((await f.row()).body, original.body);
});

test("identical text still revises confirmed completeness once per action and cache expires after 24h", async t => {
  const f = await setup(t); const body = "正文 &amp; 原样";
  await f.sql.query("update items set body=$1 where id='item-1'", [body]);
  // Match PG bigint-string parsing as well as the real PGlite bigint trigger result.
  const sql = { ...f.sql, async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return f.sql.transaction(tx => fn({ async query<R>(text: string, params: unknown[] = []): Promise<R[]> {
      const rows = await tx.query<Record<string, unknown>>(text, params);
      return rows.map(row => row.material_version == null ? row : { ...row, material_version: String(row.material_version) }) as R[];
    } }));
  } };
  let calls = 0; const io = fixtureIo(body, async () => { calls++; });
  const first = await previewArticleWith({ sql, itemId: "item-1", io });
  assert.equal(first.materialVersion, 1);
  await f.sql.query("update items set extra=jsonb_set(extra,'{article_fetched_at}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id='item-1'");
  const expired = await previewArticleWith({ sql, itemId: "item-1", io });
  assert.equal(expired.cached, false); assert.equal(calls, 2);
  assert.equal((await previewArticleWith({ sql, itemId: "item-1", io })).cached, true); assert.equal(calls, 2);
  process.env.ARTICLE_READER_ENABLED = "false";
  const adopted = await adoptArticleWith({ sql, itemId: "item-1", digest: expired.digest, expectedVersion: 1 });
  assert.equal(adopted.materialVersion, 2); assert.equal((await f.row()).body, body);
  assert.equal((await f.row()).extra.article_adopted_version, 2); assert.equal((await f.row()).extra.body_complete, true);
  const restored = await restoreArticleWith({ sql, itemId: "item-1", expectedVersion: 2 });
  assert.equal(restored.materialVersion, 3); assert.equal((await f.row()).body, body);
  assert.equal((await f.row()).extra.body_complete, false);
});

for (const otherLease of [false, true]) test(`delayed initial read reuses a candidate ${otherLease ? "while another process still owns its lease" : "another preview finished before admission"}`, async t => {
  const f = await setup(t); let release!: () => void; let read!: () => void; let delayed = false; let calls = 0;
  const captured = new Promise<void>(resolve => { read = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const sql: Queryable = { async query<R>(text: string, params: unknown[] = []): Promise<R[]> {
    const rows = await f.sql.query<R>(text, params);
    if (!delayed && text.startsWith("select * from items")) {
      delayed = true; read(); await waiting;
    }
    return rows;
  } };
  const delayedPreview = previewArticleWith({ sql, itemId: "item-1", io: fixtureIo("迟到候选不可覆盖", async () => { calls++; }) });
  await captured;
  let first;
  try {
    first = await previewArticleWith({ sql: f.sql, itemId: "item-1", io: fixtureIo("正在确认的候选", async () => { calls++; }) });
    if (otherLease) {
      // Database state of an independent process between candidate persistence and its token-fenced release.
      await f.sql.query(`update items set extra=extra || $1::jsonb where id='item-1'`,
        [JSON.stringify({ article_claim_token: "other-process", article_claimed_at: new Date().toISOString() })]);
    }
  } finally { release(); }
  const resumed = await delayedPreview;
  assert.equal(calls, 1, "stale initial snapshot must not authorize a duplicate reader request");
  assert.equal(first.cached, false); assert.equal(resumed.cached, true);
  assert.equal(resumed.digest, first.digest); assert.equal(resumed.materialVersion, first.materialVersion);
  assert.equal((await f.row()).extra.article_digest, first.digest);
  assert.equal((await f.row()).extra.article_claim_token, otherLease ? "other-process" : undefined);
});

test("delayed initial read distinguishes changed material, URL and completeness from cache admission", async t => {
  const f = await setup(t); let calls = 0;
  for (const [statement, code] of [
    ["update items set body=body||'修订正文' where id='item-1'", "article_conflict"],
    ["update items set url='https://example.org/new-url' where id='item-1'", "article_conflict"],
    ["update items set extra=extra||'{\"body_complete\":true}'::jsonb where id='item-1'", "article_already_complete"],
  ]) {
    let release!: () => void; let read!: () => void; let delayed = false;
    const captured = new Promise<void>(resolve => { read = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const sql: Queryable = { async query<R>(text: string, params: unknown[] = []): Promise<R[]> {
      const rows = await f.sql.query<R>(text, params);
      if (!delayed && text.startsWith("select * from items")) { delayed = true; read(); await waiting; }
      return rows;
    } };
    const pending = previewArticleWith({ sql, itemId: "item-1", io: fixtureIo(undefined, async () => { calls++; }) });
    await captured;
    try { await f.sql.query(statement); } finally { release(); }
    await assert.rejects(pending, new RegExp(code));
  }
  assert.equal(calls, 0); assert.equal((await f.row()).extra.article_candidate, undefined);
  assert.equal((await f.row()).extra.article_claim_token, undefined);
});
