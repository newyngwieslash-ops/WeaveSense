import { getSql } from "@/lib/db";
import { itemMatchesPhrase, RADAR_SOURCE_ID } from "@/lib/keyword";
import { isPlatform, type PlatformId } from "@/lib/platforms";
import { shortId } from "@/lib/utils";
import type { TickResult } from "@/lib/types";
import { collectSource } from "./collectors";
import { collectKeyword } from "./collectors/keyword";
import type { NormalizedItem, SourceRecord } from "./collectors/types";
import { runCronBatch, type CronBatchOptions } from "./cron";
import { enqueueItemMedia } from "./media";
import { mapKeyword, mapSource } from "./queries";
import {
  claimKeyword,
  claimSource,
  completeKeywordClaim,
  completeSourceClaim,
  failKeywordClaim,
  failSourceClaim,
  finishItemInsert,
  SCHEDULER_LEASE_LOST,
  SCHEDULER_LEASE_MINUTES,
} from "./scheduler-atomic";
import { ensureRadarSource, ensureSeeded } from "./seed";
import { asJson } from "./serialize";

function pickCursor(items: NormalizedItem[]): NormalizedItem | undefined {
  if (!items.length) return undefined;
  const numeric = items.filter((it) => /^\d+$/.test(it.external_id));
  if (numeric.length) {
    return numeric.reduce((a, b) => (Number(a.external_id) >= Number(b.external_id) ? a : b));
  }
  return items[0];
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 400);
  return String(err).slice(0, 400);
}

async function enabledPhrases(): Promise<{ id: string; phrase: string }[]> {
  const sql = await getSql();
  return sql.query<{ id: string; phrase: string }>(
    "select id, phrase from keywords where enabled = true",
  );
}

function mergeKeywords(current: string[], extra: string[]): string[] {
  const seen = new Set(current.map((k) => k.toLowerCase()));
  const out = [...current];
  for (const k of extra) {
    const key = k.toLowerCase();
    if (!k || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

async function recountKeywordHits(phrase: string, persist = true): Promise<number> {
  const sql = await getSql();
  const [row] = await sql.query<{ n: number }>(
    `select count(*)::int as n from items
     where exists (
       select 1 from jsonb_array_elements_text(matched_keywords) t where t = $1
     )`,
    [phrase],
  );
  const n = row?.n ?? 0;
  if (persist) await sql.query("update keywords set hits = $2 where phrase = $1", [phrase, n]);
  return n;
}

async function persistHit(
  it: NormalizedItem,
  phrase: string,
  defaultPlatform: PlatformId,
): Promise<"new" | "tagged" | "skip"> {
  const sql = await getSql();
  const ext = it.external_id.slice(0, 320);
  const url = it.url.slice(0, 1000);
  const guessed = it.extra?.guessed_platform;
  const platform =
    typeof guessed === "string" && isPlatform(guessed) ? guessed : defaultPlatform;

  const [existing] = await sql.query<Record<string, unknown>>(
    `select id, matched_keywords from items
     where (source_id = $1 and external_id = $2)
        or ($3 <> '' and url = $3)
     limit 1`,
    [RADAR_SOURCE_ID, ext, url],
  );

  if (existing) {
    const current = asJson<string[]>(existing.matched_keywords, []);
    const next = mergeKeywords(current, [phrase]);
    if (next.length !== current.length) {
      await sql.query("update items set matched_keywords = $2::jsonb where id = $1", [
        String(existing.id),
        JSON.stringify(next),
      ]);
      return "tagged";
    }
    return "skip";
  }

  const published = it.published_at ? new Date(it.published_at) : null;
  const publishedIso =
    published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
  const id = shortId();
  const inserted = await sql.query<{ id: unknown }>(
    `insert into items (
       id, source_id, platform, external_id, title, body, author, url,
       media_type, media_urls, thumbnail_url, views, likes, published_at, extra, matched_keywords
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
     on conflict (source_id, external_id) do nothing
     returning id`,
    [
      id,
      RADAR_SOURCE_ID,
      platform,
      ext,
      it.title.slice(0, 500),
      platform === "wechat" ? it.body : it.body.slice(0, 8000),
      it.author.slice(0, 200),
      url,
      it.media_type,
      JSON.stringify(it.media_urls.slice(0, 8)),
      it.thumbnail_url.slice(0, 1000),
      it.views,
      it.likes,
      publishedIso,
      JSON.stringify({ ...it.extra, keyword: phrase }),
      JSON.stringify([phrase]),
    ],
  );
  return await finishItemInsert(inserted, it.media_urls, it.media_type, enqueueItemMedia)
    ? "new"
    : "skip";
}

export async function tagCorpusWithPhrase(phrase: string): Promise<number> {
  const sql = await getSql();
  const like = `%${phrase.replace(/[%_]/g, "")}%`;
  const rows = await sql.query<Record<string, unknown>>(
    `select id, title, body, author, matched_keywords from items
     where title ilike $1 or body ilike $1 or author ilike $1
     limit 200`,
    [like],
  );
  let tagged = 0;
  for (const row of rows) {
    const current = asJson<string[]>(row.matched_keywords, []);
    if (current.some((k) => k.toLowerCase() === phrase.toLowerCase())) continue;
    if (!itemMatchesPhrase(String(row.title ?? ""), String(row.body ?? ""), String(row.author ?? ""), phrase)) {
      continue;
    }
    await sql.query("update items set matched_keywords = $2::jsonb where id = $1", [
      String(row.id),
      JSON.stringify(mergeKeywords(current, [phrase])),
    ]);
    tagged += 1;
  }
  return tagged;
}

export async function runSourceJob(
  sourceId: string,
  kind: "incremental" | "manual" | "reconcile" = "incremental",
): Promise<{ items_found: number; items_new: number; error: string }> {
  const sql = await getSql();
  const jobId = shortId();
  const raw = await claimSource(sql, sourceId, jobId);
  if (!raw) {
    const [current] = await sql.query<Record<string, unknown>>("select * from sources where id = $1", [sourceId]);
    if (!current) return { items_found: 0, items_new: 0, error: "信源不存在" };
    const existing = mapSource(current);
    if (!existing.enabled) return { items_found: 0, items_new: 0, error: "已停用" };
    return { items_found: 0, items_new: 0, error: existing.status === "running" ? "正在运行" : "任务不可用" };
  }
  const source = mapSource(raw);

  let jobCreated = false;
  try {
    await sql.query(
      `insert into jobs (id, source_id, platform, status, kind) values ($1,$2,$3,'running',$4)`,
      [jobId, source.id, source.platform, kind],
    );
    jobCreated = true;
    const record: SourceRecord = {
      id: source.id,
      platform: source.platform,
      name: source.name,
      handle: source.handle,
      url: source.url,
      feed_url: source.feed_url,
      adapter: source.adapter,
      last_external_id: source.last_external_id,
    };
    const fetched = await collectSource(record);
    const existing = await sql.query<{ external_id: string }>(
      "select external_id from items where source_id = $1",
      [source.id],
    );
    const have = new Set(existing.map((r) => r.external_id));
    const fresh = fetched.filter((it) => it.external_id && !have.has(it.external_id));
    const phrases = await enabledPhrases();
    let itemsNew = 0;

    for (const it of fresh) {
      const published = it.published_at ? new Date(it.published_at) : null;
      const publishedIso =
        published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
      const matched = phrases
        .filter((p) => itemMatchesPhrase(it.title, it.body, it.author, p.phrase))
        .map((p) => p.phrase);
      const id = shortId();
      const inserted = await sql.query<{ id: unknown }>(
        `insert into items (
           id, source_id, platform, external_id, title, body, author, url,
           media_type, media_urls, thumbnail_url, views, likes, published_at, extra, matched_keywords
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
           on conflict (source_id, external_id) do nothing
           returning id`,
        [
          id,
          source.id,
          source.platform,
          it.external_id.slice(0, 320),
          it.title.slice(0, 500),
          source.platform === "wechat" ? it.body : it.body.slice(0, 8000),
          it.author.slice(0, 200),
          it.url.slice(0, 1000),
          it.media_type,
          JSON.stringify(it.media_urls.slice(0, 8)),
          it.thumbnail_url.slice(0, 1000),
          it.views,
          it.likes,
          publishedIso,
          JSON.stringify(it.extra ?? {}),
          JSON.stringify(matched),
        ],
      );
      if (await finishItemInsert(inserted, it.media_urls, it.media_type, enqueueItemMedia)) itemsNew += 1;
    }

    const latest = pickCursor(fetched);
    const completed = await completeSourceClaim(
      sql,
      source.id,
      jobId,
      latest?.external_id ?? "",
      latest?.published_at ?? null,
    );
    if (!completed) {
      await sql.query(
        `update jobs set status = 'error', finished_at = now(), error = $2 where id = $1`,
        [jobId, SCHEDULER_LEASE_LOST],
      );
      return { items_found: 0, items_new: 0, error: SCHEDULER_LEASE_LOST };
    }
    await sql.query(
      `update jobs set status = 'ok', finished_at = now(), items_found = $2, items_new = $3, error = ''
       where id = $1`,
      [jobId, fetched.length, itemsNew],
    );
    for (const p of phrases) void recountKeywordHits(p.phrase);
    return { items_found: fetched.length, items_new: itemsNew, error: "" };
  } catch (err) {
    const message = errMessage(err);
    const released = await failSourceClaim(sql, source.id, jobId, message);
    const jobError = released ? message : SCHEDULER_LEASE_LOST;
    if (jobCreated) {
      await sql.query(
        `update jobs set status = 'error', finished_at = now(), error = $2 where id = $1`,
        [jobId, jobError],
      );
    }
    return { items_found: 0, items_new: 0, error: jobError };
  }
}

export async function runKeywordJob(
  keywordId: string,
  kind: "keyword" | "manual" = "keyword",
): Promise<{ items_found: number; items_new: number; error: string; phrase: string }> {
  await ensureRadarSource();
  const sql = await getSql();
  const jobId = shortId();
  const raw = await claimKeyword(sql, keywordId, jobId);
  if (!raw) {
    const [current] = await sql.query<Record<string, unknown>>("select * from keywords where id = $1", [keywordId]);
    if (!current) return { items_found: 0, items_new: 0, error: "关键词不存在", phrase: "" };
    const existing = mapKeyword(current);
    if (!existing.enabled) return { items_found: 0, items_new: 0, error: "已停用", phrase: existing.phrase };
    return { items_found: 0, items_new: 0,
      error: existing.status === "running" ? "正在运行" : "任务不可用", phrase: existing.phrase };
  }
  const kw = mapKeyword(raw);

  let jobCreated = false;
  try {
    await sql.query(
      `insert into jobs (id, source_id, platform, status, kind, keyword_id)
       values ($1,$2,'rss','running',$3,$4)`,
      [jobId, RADAR_SOURCE_ID, kind, kw.id],
    );
    jobCreated = true;
    const fetched = await collectKeyword(kw.phrase, kw.platforms);
    let itemsNew = 0;
    for (const it of fetched) {
      const result = await persistHit(it, kw.phrase, "rss");
      if (result === "new") itemsNew += 1;
    }
    const localTagged = await tagCorpusWithPhrase(kw.phrase);
    const hits = await recountKeywordHits(kw.phrase, false);
    const note =
      fetched.length === 0 && localTagged === 0
        ? "检索源暂无新结果，已扫描本地库"
        : fetched.length === 0
          ? `外部检索受限，本地命中 ${localTagged} 条`
          : "";
    const completed = await completeKeywordClaim(sql, kw.id, jobId, note, hits);
    if (!completed) {
      await sql.query(
        `update jobs set status = 'error', finished_at = now(), error = $2 where id = $1`,
        [jobId, SCHEDULER_LEASE_LOST],
      );
      return { items_found: 0, items_new: 0, error: SCHEDULER_LEASE_LOST, phrase: kw.phrase };
    }
    await sql.query(
      `update jobs set status = 'ok', finished_at = now(), items_found = $2, items_new = $3, error = $4
       where id = $1`,
      [jobId, fetched.length + localTagged, itemsNew, note],
    );
    return { items_found: fetched.length + localTagged, items_new: itemsNew, error: note, phrase: kw.phrase };
  } catch (err) {
    const message = errMessage(err);
    const released = await failKeywordClaim(sql, kw.id, jobId, message);
    const jobError = released ? message : SCHEDULER_LEASE_LOST;
    if (jobCreated) {
      await sql.query(
        `update jobs set status = 'error', finished_at = now(), error = $2 where id = $1`,
        [jobId, jobError],
      );
    }
    return { items_found: 0, items_new: 0, error: jobError, phrase: kw.phrase };
  }
}

export async function tickDueSources(limit = 5, budget: CronBatchOptions = {}): Promise<TickResult & { deferred: number }> {
  await ensureSeeded();
  const sql = await getSql();
  const sourceLimit = Math.max(1, Math.ceil(limit * 0.6));
  const keywordLimit = Math.max(1, limit - sourceLimit);

  const due = await sql.query<Record<string, unknown>>(
    `select * from sources
     where enabled = true
       and id <> $2
       and (
         (status = 'running' and (
           claimed_at is null
           or claimed_at <= now() - ($3::integer * interval '1 minute')
         ))
         or (status <> 'running' and (
           last_scanned_at is null
           or last_scanned_at < now() - (interval_minutes * interval '1 minute')
         ))
       )
     order by last_scanned_at nulls first
     limit $1`,
    [sourceLimit, RADAR_SOURCE_ID, SCHEDULER_LEASE_MINUTES],
  );
  const dueKw = await sql.query<Record<string, unknown>>(
    `select * from keywords
     where enabled = true
       and (
         (status = 'running' and (
           claimed_at is null
           or claimed_at <= now() - ($2::integer * interval '1 minute')
         ))
         or (status <> 'running' and (
           last_scanned_at is null
           or last_scanned_at < now() - (interval_minutes * interval '1 minute')
         ))
       )
     order by last_scanned_at nulls first
     limit $1`,
    [keywordLimit, SCHEDULER_LEASE_MINUTES],
  );

  const sourceBatch = await runCronBatch(due, async (row) => {
    const source = mapSource(row);
    const result = await runSourceJob(source.id, "incremental");
    return {
      source_id: source.id,
      name: source.name,
      items_new: result.items_new,
      error: result.error,
      kind: "source",
    };
  }, budget);

  const keywordBatch = sourceBatch.deferred ? { results: [], deferred: dueKw.length } : await runCronBatch(dueKw, async (row) => {
    const kw = mapKeyword(row);
    const result = await runKeywordJob(kw.id, "keyword");
    return {
      source_id: kw.id,
      name: `关键词 · ${kw.phrase}`,
      items_new: result.items_new,
      error: result.error,
      kind: "keyword",
    };
  }, budget);

  const jobs: TickResult["jobs"] = [...sourceBatch.results, ...keywordBatch.results];
  const items_new = jobs.reduce((total, job) => total + job.items_new, 0);
  const errors = jobs.filter((job) => job.error && (job.kind === "source"
    || (job.items_new === 0 && job.error !== "已停用" && !job.error.includes("本地")))).length;

  return { ran: jobs.length, items_new, errors, jobs, deferred: sourceBatch.deferred + keywordBatch.deferred };
}
