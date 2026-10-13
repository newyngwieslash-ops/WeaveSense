import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { tagCorpusWithPhrase, finishSourceJob, mergeExistingItem } from "./scheduler-atomic.ts";

/**
 * T07: historical keyword tagging must cover the WHOLE corpus, repeatedly and
 * without losing tags under concurrency.
 *
 * The defect this pins down: the old implementation selected candidate rows with
 * `limit 200` and then skipped rows that already had the tag, so a corpus larger
 * than 200 (or one where the first 200 were already tagged) could never complete.
 * Re-running it was a no-op rather than "continue where it left off".
 */

/** An `items` table with the columns the tagging path touches. */
async function itemsDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table items (
    id text primary key,
    platform text not null default 'rss',
    title text not null default '',
    body text not null default '',
    author text not null default '',
    matched_keywords jsonb not null default '[]'::jsonb
  )`);
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  return { pg, sql };
}

test("ordinary feed merge cannot forge article audit, snapshots or leases", async t => {
  const pg = new PGlite(); await pg.waitReady; t.after(() => pg.close());
  for (const name of ["0002_schema.sql", "0003_keywords.sql", "0004_production.sql", "0019_agent_material_revision.sql"]) {
    await pg.exec(await readFile(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = { async query<T>(text: string, params: unknown[] = []) { return (await pg.query<T>(text, params)).rows; } };
  await sql.query(`insert into items(id,source_id,platform,external_id,body,extra)
    values('audit','s','rss','audit','采用的全文','{"body_complete":true,"article_state":"adopted","article_previous_body":"旧正文","article_adopted_version":3}')`);
  await mergeExistingItem(sql, "audit", { title: "", body: "新摘要", author: "", url: "", media_type: "article",
    media_urls: [], thumbnail_url: "", views: null, likes: null, published_at: null,
    extra: { provider: "feed", body_complete: false, article_state: "error", article_previous_body: "恶意正文",
      article_claim_token: "feed-token", article_candidate: "伪造候选", transcript_state: "forged", transcript_object_key: "forged" } }, ["新增词"]);
  const [row] = await sql.query<{ body: string; extra: Record<string, unknown>; material_version: bigint }>("select * from items where id='audit'");
  assert.equal(row.body, "采用的全文"); assert.equal(Number(row.material_version), 0);
  assert.deepEqual(row.extra, { body_complete: true, article_state: "adopted", article_previous_body: "旧正文",
    article_adopted_version: 3, provider: "feed" });
});

/** Insert `count` matching rows plus `nonMatching` rows that must never be tagged. */
async function seed(pg: PGlite, phrase: string, count: number, nonMatching: number, preTagged = 0) {
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < count; i += 1) {
    const tagged = i < preTagged ? JSON.stringify([phrase]) : "[]";
    params.push(`m${i}`, `命中标题${i}`, `包含 ${phrase} 的正文`, tagged);
    const at = params.length;
    values.push(`($${at - 3}, 'rss', $${at - 2}, $${at - 1}, '作者', $${at}::jsonb)`);
  }
  for (let i = 0; i < nonMatching; i += 1) {
    params.push(`n${i}`, `无关标题${i}`, "完全无关的正文", "[]");
    const at = params.length;
    values.push(`($${at - 3}, 'rss', $${at - 2}, $${at - 1}, '作者', $${at}::jsonb)`);
  }
  if (values.length) {
    await pg.query(`insert into items (id, platform, title, body, author, matched_keywords) values ${values.join(",")}`, params);
  }
}

const taggedCount = async (pg: PGlite, phrase: string) =>
  (
    await pg.query<{ n: number }>(
      `select count(*)::int as n from items
       where exists (
         select 1 from jsonb_array_elements_text(matched_keywords) t where t = $1
       )`,
      [phrase],
    )
  ).rows[0].n;

test("450 matching rows with the first 200 already tagged all get tagged", async () => {
  const { pg, sql } = await itemsDb();
  const phrase = "电池";
  await seed(pg, phrase, 450, 50, 200);

  assert.equal(await taggedCount(pg, phrase), 200, "precondition: 200 tagged");
  const tagged = await tagCorpusWithPhrase(sql, phrase);
  assert.equal(tagged, 250, "the remaining 250 rows must be tagged in one call");
  assert.equal(await taggedCount(pg, phrase), 450);

  // Running it again must be a no-op, not a repeat tag.
  assert.equal(await tagCorpusWithPhrase(sql, phrase), 0);
  assert.equal(await taggedCount(pg, phrase), 450);

  // Non-matching rows stay untouched.
  const untagged = (
    await pg.query<{ n: number }>("select count(*)::int as n from items where matched_keywords = '[]'::jsonb")
  ).rows[0].n;
  assert.equal(untagged, 50);
  await pg.close();
});

test("a corpus larger than one page still completes across repeated calls", async () => {
  const { pg, sql } = await itemsDb();
  const phrase = "良率";
  // Well past any single-statement page: proves the update is set-based, not
  // "one page then stop".
  await seed(pg, phrase, 1200, 0);
  const tagged = await tagCorpusWithPhrase(sql, phrase);
  assert.equal(tagged, 1200);
  assert.equal(await taggedCount(pg, phrase), 1200);
  assert.equal(await tagCorpusWithPhrase(sql, phrase), 0);
  await pg.close();
});

test("concurrent tagging of two phrases loses neither tag", async () => {
  const { pg, sql } = await itemsDb();
  await pg.query(
    `insert into items (id, platform, title, body, author, matched_keywords)
     values ('both','rss','电池良率','电池 良率 都出现','作者','[]'::jsonb)`,
  );
  const [a, b] = await Promise.all([
    tagCorpusWithPhrase(sql, "电池"),
    tagCorpusWithPhrase(sql, "良率"),
  ]);
  assert.equal(a + b, 2, "both phrases should report one tag each");
  const { rows } = await pg.query<{ matched_keywords: string[] }>(
    "select matched_keywords from items where id='both'",
  );
  const tags = rows[0].matched_keywords.map((t) => t.toLowerCase()).sort();
  assert.deepEqual(tags, ["电池", "良率"]);
  await pg.close();
});

test("case-insensitive phrases do not double-tag", async () => {
  const { pg, sql } = await itemsDb();
  const phrase = "Battery";
  await pg.query(
    `insert into items (id, platform, title, body, author, matched_keywords)
     values ('upper','rss','BATTERY 报告','正文提到 battery 与 Battery','作者','[]'::jsonb)`,
  );
  assert.equal(await tagCorpusWithPhrase(sql, phrase), 1);
  assert.equal(await tagCorpusWithPhrase(sql, "battery"), 0, "a case variant must not add a second tag");
  const tags = (await pg.query<{ matched_keywords: string[] }>(
    "select matched_keywords from items where id='upper'",
  )).rows[0].matched_keywords;
  assert.equal(tags.length, 1);
  await pg.close();
});

test("Chinese text and literal % and _ are matched without wildcard surprises", async () => {
  const { pg, sql } = await itemsDb();
  await pg.query(
    `insert into items (id, platform, title, body, author, matched_keywords) values
     ('cjk','rss','宁德时代的下一块电池','上海车展的智能驾驶对垒','作者','[]'::jsonb),
     ('percent','rss','增长率 50% 的公司','正文含百分号','作者','[]'::jsonb),
     ('underscore','rss','变量名 a_b 的说明','正文含下划线','作者','[]'::jsonb),
     ('decoy','rss','增长率 50x 的公司','不应被百分号命中','作者','[]'::jsonb)`,
  );

  assert.equal(await tagCorpusWithPhrase(sql, "智能驾驶"), 1);
  assert.equal(await tagCorpusWithPhrase(sql, "50%"), 1, "% must be a literal character, not a wildcard");
  assert.equal(await tagCorpusWithPhrase(sql, "a_b"), 1, "_ must be a literal character, not a wildcard");

  const decoy = (await pg.query<{ matched_keywords: unknown[] }>(
    "select matched_keywords from items where id='decoy'",
  )).rows[0].matched_keywords;
  assert.deepEqual(decoy, []);
  await pg.close();
});

test("a platform scope filters which rows may be tagged", async () => {
  const { pg, sql } = await itemsDb();
  await pg.query(
    `insert into items (id, platform, title, body, author, matched_keywords) values
     ('rss-1','rss','电池进展','rss 材料','作者','[]'::jsonb),
     ('wechat-1','wechat','电池进展','公众号材料','作者','[]'::jsonb)`,
  );

  // Scoped to wechat only: the rss row must not be tagged.
  assert.equal(await tagCorpusWithPhrase(sql, "电池", { platforms: ["wechat"] }), 1);
  const scoped = (await pg.query<{ id: string }>(
    `select id from items
     where exists (select 1 from jsonb_array_elements_text(matched_keywords) t where t = '电池')`,
  )).rows.map((r) => r.id);
  assert.deepEqual(scoped, ["wechat-1"]);

  // An empty scope means "all platforms", so the rss row is picked up next.
  assert.equal(await tagCorpusWithPhrase(sql, "电池", { platforms: [] }), 1);
  await pg.close();
});

test("empty or invalid phrases are refused at the boundary", async () => {
  const { pg, sql } = await itemsDb();
  await seed(pg, "电池", 1, 0);
  for (const phrase of ["", " ", "\t\n", "a"]) {
    await assert.rejects(
      () => tagCorpusWithPhrase(sql, phrase),
      /invalid_phrase/,
      `expected refusal for ${JSON.stringify(phrase)}`,
    );
  }
  await pg.close();
});

test("coverage migration preserves legacy rows and finishSourceJob writes parameterized JSON", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  try {
    await pg.exec(`create table jobs (id text primary key, status text, finished_at timestamptz,
      error text, items_found integer, items_new integer, provider text, attempts jsonb, paid_call boolean);
      insert into jobs (id,status) values ('legacy','ok'),('window','running'),('failed','running')`);
    const migration = await readFile(new URL("../../../migrations/0030_collection_coverage.sql", import.meta.url), "utf8");
    await pg.exec(migration);
    await pg.exec(migration);
    const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    } };
    const meta = { provider: "primary" as const, attempts: ["primary"], paid_call: false };
    const coverage = { complete: false, window_only: true, note: "window_gap" };
    await finishSourceJob(sql, "window", "ok", "", 1, 1, meta, coverage);
    await finishSourceJob(sql, "failed", "error", "failed", 0, 0, meta);
    assert.deepEqual((await pg.query("select id,coverage from jobs order by id")).rows,
      [{ id: "failed", coverage: {} }, { id: "legacy", coverage: {} }, { id: "window", coverage }]);
  } finally { await pg.close(); }
});
