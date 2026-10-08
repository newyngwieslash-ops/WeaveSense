import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  addKeywordDomain,
  updateKeywordDomain,
  setKeywordEnabledDomain,
  createSourceDomain,
  setSourceEnabledDomain,
  type ActorContext,
} from "./project-actions.ts";
import { isPlatform, type PlatformId } from "../platforms.ts";

/**
 * Task 5: extracted shared domain functions. Page behaviour keeps its legacy
 * semantics (addKeywords re-enables + overwrites an existing keyword); the
 * assistant path is explicit: onExisting:returnExisting and sources default
 * to disabled. Everything takes a transaction Queryable + trusted contexts.
 */

async function db() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
    await pg.exec(readFileSync("migrations/" + name, "utf8"));
  }
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn(inner)) as Promise<T>;
    },
  };
  return { pg, sql };
}

const actor: ActorContext = { kind: "page" };
const op = { actionId: "act-1" };

test("platform enum sanity for the contract bridge", () => {
  assert.equal(isPlatform("rss"), true);
  assert.equal(isPlatform("nope"), false);
});

test("page-mode addKeyword keeps legacy behavior: re-enable and overwrite config", async () => {
  const { sql } = await db();
  const first = await addKeywordDomain(sql, actor, null, { keyword: "固态电池", platforms: ["rss", "bilibili"], interval: 30, enabled: true });
  assert.equal(first.kind, "created");
  // Page path re-enables and overwrites interval/platforms of an existing row.
  const second = await addKeywordDomain(sql, actor, null, { keyword: "固态电池", platforms: ["rss"], interval: 60, enabled: true });
  assert.equal(second.kind, "updated");
  const [row] = await sql.query<Record<string, unknown>>("select * from keywords");
  assert.equal(row.interval_minutes, 60);
  assert.deepEqual(row.platforms, ["rss"]);
  assert.equal(row.enabled, true);
});

test("assistant-mode addKeyword returns existing without changing config", async () => {
  const { sql } = await db();
  const first = await addKeywordDomain(sql, actor, null, { keyword: "钠离子", platforms: ["rss"], interval: 30, enabled: true });
  assert.equal(first.kind, "created");
  // Assistant path: same phrase -> existing receipt, no silent overwrite.
  const second = await addKeywordDomain(sql, { kind: "assistant", operation: op }, null,
    { keyword: "钠离子", platforms: ["bilibili"], interval: 60, enabled: true }, { onExisting: "returnExisting" });
  assert.equal(second.kind, "existing");
  assert.ok(second.keywordId);
  if (second.kind === "existing") {
    assert.deepEqual(second.currentPlatforms, ["rss"], "current config reported, not the requested one");
    assert.equal(second.currentInterval, 30);
  }
  const [row] = await sql.query<Record<string, unknown>>("select * from keywords where phrase='钠离子'");
  assert.equal(row.interval_minutes, 30, "existing row untouched");
  assert.deepEqual(row.platforms, ["rss"]);
});

test("setKeywordEnabledDomain: 0-row update reports not_found, same value is unchanged", async () => {
  const { sql } = await db();
  const created = await addKeywordDomain(sql, actor, null, { keyword: "钙钛矿", platforms: ["rss"], interval: 30, enabled: false });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("expected created");
  const kwId: string = created.keywordId;
  // Same value -> unchanged, not a fake success.
  const same = await setKeywordEnabledDomain(sql, actor, null, kwId, false);
  assert.equal(same.kind, "unchanged");
  // Real flip -> updated.
  const flipped = await setKeywordEnabledDomain(sql, actor, null, kwId, true);
  assert.equal(flipped.kind, "updated");
  // Missing id -> not_found (never treat 0 rows as success).
  const missing = await setKeywordEnabledDomain(sql, actor, null, "kw-missing", true);
  assert.equal(missing.kind, "not_found");
});

test("updateKeywordDomain reports old and new values; refuses cross-platform junk", async () => {
  const { sql } = await db();
  const created = await addKeywordDomain(sql, actor, null, { keyword: "复合集流体", platforms: ["rss"], interval: 30, enabled: true });
  assert.equal(created.kind, "created");
  if (created.kind !== "created") throw new Error("expected created");
  const kwId: string = created.keywordId;
  const res = await updateKeywordDomain(sql, actor, null, kwId, { interval: 1440, platforms: ["bilibili", "youtube"] });
  assert.equal(res.kind, "updated");
  if (res.kind === "updated") {
    assert.equal(res.before?.interval, 30);
    assert.deepEqual(res.before?.platforms, ["rss"]);
    assert.equal(res.after?.interval, 1440);
    assert.deepEqual(res.after?.platforms, ["bilibili", "youtube"]);
  }
  const missing = await updateKeywordDomain(sql, actor, null, "kw-x", { interval: 5 });
  assert.equal(missing.kind, "not_found");
});

test("createSourceDomain: assistant default disabled, page path keeps enabled=true", async () => {
  const { sql } = await db();
  const pageSource = await createSourceDomain(sql, actor, null, {
    platform: "rss", name: "页面信源", url: "https://example.com/feed.xml", feedUrl: "https://example.com/feed.xml",
    interval: 30, enabled: true,
  });
  assert.equal(pageSource.enabled, true);
  const assistantSource = await createSourceDomain(sql, { kind: "assistant", operation: op }, null, {
    platform: "rss", name: "助手信源", url: "https://example.org/rss.xml", feedUrl: "https://example.org/rss.xml",
    interval: 30, enabled: false,
  });
  assert.equal(assistantSource.enabled, false, "assistant sources default to disabled");
  // Telegram normalization matches the page path.
  const tg = await createSourceDomain(sql, actor, null, {
    platform: "telegram", name: "tg", handle: "@some_channel", url: "", feedUrl: "", interval: 10, enabled: true,
  });
  assert.equal(tg.platform, "telegram");
  const [row] = await sql.query<Record<string, unknown>>("select url from sources where name='tg'");
  assert.equal(row.url, "https://t.me/s/some_channel");
});

test("setSourceEnabledDomain mirrors keyword toggle semantics", async () => {
  const { sql } = await db();
  const src = await createSourceDomain(sql, actor, null, {
    platform: "rss", name: "切换信源", url: "https://example.com/f.xml", feedUrl: "https://example.com/f.xml",
    interval: 30, enabled: false,
  });
  const same = await setSourceEnabledDomain(sql, actor, null, src.sourceId, false);
  assert.equal(same.kind, "unchanged");
  const flipped = await setSourceEnabledDomain(sql, actor, null, src.sourceId, true);
  assert.equal(flipped.kind, "updated");
  const missing = await setSourceEnabledDomain(sql, actor, null, "src-x", true);
  assert.equal(missing.kind, "not_found");
});

test("assistant keyword.create validates the strict platform list and single normalized phrase", async () => {
  const { sql } = await db();
  // Single phrase only (no parseKeywordList 20-word batch for one action).
  await assert.rejects(
    () => addKeywordDomain(sql, { kind: "assistant", operation: op }, null,
      { keyword: "词一,词二", platforms: ["rss"], interval: 30, enabled: true }, { onExisting: "returnExisting" }),
    /multi_phrase|invalid_keyword/,
  );
  // Unknown platform is refused (never filtered into an implicit all-platform empty array).
  await assert.rejects(
    () => addKeywordDomain(sql, { kind: "assistant", operation: op }, null,
      { keyword: "氢能", platforms: ["netease" as PlatformId], interval: 30, enabled: true }, { onExisting: "returnExisting" }),
    /invalid_platform/,
  );
  // Empty platform list is refused for assistant creates.
  await assert.rejects(
    () => addKeywordDomain(sql, { kind: "assistant", operation: op }, null,
      { keyword: "氢能", platforms: [], interval: 30, enabled: true }, { onExisting: "returnExisting" }),
    /invalid_platform/,
  );
});

test("domain functions run inside a caller-provided transaction without opening their own", async () => {
  const { sql } = await db();
  await sql.transaction(async (tx: unknown) => {
    // PGlite transaction handles return {rows} — wrap to the domain Queryable.
    const txQuery = { query: async <R = Record<string, unknown>>(text: string, params: unknown[] = []) =>
      (await (tx as { query: (t: string, p?: unknown[]) => Promise<{ rows: R[] }> }).query(text, params)).rows };
    const created = await addKeywordDomain(txQuery, actor, null,
      { keyword: "事务关键词", platforms: ["rss"], interval: 30, enabled: true });
    assert.equal(created.kind, "created");
    // Row visible inside the same transaction.
    const inside = await (tx as { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> })
      .query("select id from keywords where phrase='事务关键词'");
    assert.equal(inside.rows.length, 1);
  });
  const after = await sql.query("select id from keywords where phrase='事务关键词'");
  assert.equal(after.length, 1);
});
