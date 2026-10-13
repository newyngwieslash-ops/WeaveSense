import { getSql } from "@/lib/db";
import { itemMatchesPhrase, RADAR_SOURCE_ID } from "@/lib/keyword";
import { isPlatform, type PlatformId } from "@/lib/platforms";
import { shortId } from "@/lib/utils";
import { normalizeWechatUrl } from "@/lib/wechat-canonical";
import { canAdvanceCursor, compareNumericIds, isNumericId } from "./cursor.ts";
import type { TickResult } from "@/lib/types";
import { collectSource } from "./collectors";
import type { FetchIo } from "./http.ts";
import { collectKeyword } from "./collectors/keyword.ts";
import { collectorMeta, type CollectorMeta, type NormalizedItem, type SourceRecord } from "./collectors/types";
import { cronDueQuotas, CRON_SOURCE_CONCURRENCY, runCronBatch, type CronBatchOptions } from "./cron";
import { enqueueItemMedia } from "./media";
import { mapKeyword, mapSource } from "./queries";
import {
  tagCorpusWithPhrase as atomicTagCorpus,
  claimKeyword,
  claimSource,
  completeKeywordClaim,
  completeSourceClaim,
  failKeywordClaim,
  failSourceClaim,
  finishSourceJob,
  finishItemInsert,
  mergeExistingItem,
  SCHEDULER_LEASE_LOST,
  SCHEDULER_LEASE_MINUTES,
} from "./scheduler-atomic";
import { ensureRadarSource, ensureSeeded } from "./seed";
import { keywordRunOutcome } from "./scheduler-outcome.ts";
import { asJson } from "./serialize";
import { mergeProvidersSeen } from "./wechat-meta";

/**
 * The item whose external id should become the source's new cursor.
 *
 * T10: numeric ids are compared as decimal strings (`compareNumericIds`), not
 * through `Number()`. Platform ids can exceed 2^53, where two distinct ids round
 * to the same double — the old reduce could then hand back a different item than
 * the true maximum, and the stored cursor would either skip content or re-fetch
 * it with no error anywhere.
 */
function pickCursor(items: NormalizedItem[], windowSource?: SourceRecord): NormalizedItem | undefined {
  if (!items.length) return undefined;
  const numeric = items.filter((it) => isNumericId(it.external_id));
  if (numeric.length) {
    return numeric.reduce((a, b) =>
      compareNumericIds(a.external_id, b.external_id) >= 0 ? a : b);
  }
  if (!windowSource) return items[0];
  const dated = items.filter((it) => Number.isFinite(Date.parse(it.published_at ?? "")));
  const candidates = dated.length ? dated : items;
  // ponytail: undated opaque RSS cannot prove newest; retain a present anchor or
  // use the first observed item. Upgrade with upstream timestamps/order guarantees.
  return candidates.reduce((a, b) => {
    const aTime = Date.parse(a.published_at ?? "");
    const bTime = Date.parse(b.published_at ?? "");
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime > bTime ? a : b;
    if (windowSource.platform === "telegram") {
      const aPost = a.external_id.match(/^(.+)\/(\d+)$/);
      const bPost = b.external_id.match(/^(.+)\/(\d+)$/);
      if (aPost && bPost && aPost[1] === bPost[1]) {
        return compareNumericIds(aPost[2], bPost[2]) >= 0 ? a : b;
      }
    }
    return a;
  }, candidates.find((it) => it.external_id === windowSource.last_external_id) ?? candidates[0]);
}

/** The published time of the item that owns `externalId`, if it is in the batch. */
function latestPublished(items: NormalizedItem[], externalId: string): string | null {
  const match = items.find((it) => it.external_id === externalId);
  return match?.published_at ?? null;
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
      // T11: no body truncation at the storage layer, for any platform. The
      // model context budget lives in agent-context; silently cutting here lost
      // the tail before anything downstream could notice.
      it.body,
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

/**
 * Tag the whole corpus with one phrase.
 *
 * The SQL lives in `scheduler-atomic.ts` so the set-based, concurrency-safe
 * update is testable on its own; this wrapper supplies the shared `sql` handle
 * and the platform scope.
 *
 * `platforms` comes from the keyword record. An empty list means "all platforms"
 * — matching the collector, where an empty `platforms` means "no filter".
 * Passing "local" platforms through keeps a keyword scoped to WeChat/Telegram
 * from tagging unrelated RSS rows in the local corpus.
 */
export async function tagCorpusWithPhrase(
  phrase: string,
  options: { platforms?: PlatformId[] } = {},
): Promise<number> {
  const sql = await getSql();
  return atomicTagCorpus(sql, phrase, { platforms: options.platforms ?? [] });
}

export async function runSourceJob(
  sourceId: string,
  kind: "incremental" | "manual" | "reconcile" = "incremental",
  /** Test seam (see `FetchIo`); production callers omit it. */
  io: FetchIo = {},
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
  let meta: CollectorMeta = { provider: "", attempts: [], paid_call: false };
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
    const collected = await collectSource(record, io);
    const fetched = collected.items;
    meta = collected.meta;
    const existing = await sql.query<{ id: string; external_id: string; url: string; extra: unknown }>(
      "select id, external_id, url, extra from items where source_id = $1",
      [source.id],
    );
    const existingByExternalId = new Map(existing.map((row) => [row.external_id, row]));
    const normalizedUrl = (url: string) => {
      if (source.platform !== "wechat" || !url) return "";
      try { return normalizeWechatUrl(url); } catch { return ""; }
    };
    const existingByUrl = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      const url = normalizedUrl(row.url);
      if (url) existingByUrl.set(url, row);
    }
    const phrases = await enabledPhrases();
    let itemsNew = 0;

    for (const it of fetched.filter((item) => item.external_id)) {
      const published = it.published_at ? new Date(it.published_at) : null;
      const publishedIso =
        published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
      const matched = phrases
        .filter((p) => itemMatchesPhrase(it.title, it.body, it.author, p.phrase))
        .map((p) => p.phrase);
      const existingItem = existingByExternalId.get(it.external_id)
        ?? existingByUrl.get(normalizedUrl(it.url));
      const existingExtra = asJson<Record<string, unknown>>(existingItem?.extra, {});
      const providerHistory = mergeProvidersSeen(existingExtra, it.extra.providers_seen);
      const itemExtra = source.platform === "wechat"
        ? mergeProvidersSeen(existingItem
          ? { ...providerHistory, ...it.extra, providers_seen: providerHistory.providers_seen }
          : it.extra, it.extra.provider ?? meta.provider)
        : it.extra;
      if (existingItem) {
        await mergeExistingItem(sql, existingItem.id,
          { ...it, extra: itemExtra, published_at: publishedIso }, matched);
        continue;
      }
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
          // T11: see the note on the keyword insert above — storage keeps the body.
          it.body,
          it.author.slice(0, 200),
          it.url.slice(0, 1000),
          it.media_type,
          JSON.stringify(it.media_urls.slice(0, 8)),
          it.thumbnail_url.slice(0, 1000),
          it.views,
          it.likes,
          publishedIso,
          JSON.stringify(itemExtra ?? {}),
          JSON.stringify(matched),
        ],
      );
      if (await finishItemInsert(inserted, it.media_urls, it.media_type, enqueueItemMedia)) {
        itemsNew += 1;
        const saved = { id, external_id: it.external_id.slice(0, 320),
          url: it.url.slice(0, 1000), extra: itemExtra };
        existingByExternalId.set(saved.external_id, saved);
        const savedUrl = normalizedUrl(saved.url);
        if (savedUrl) existingByUrl.set(savedUrl, saved);
      }
    }

    // Windows advance a discovery watermark for next scan's overlap check;
    // paged history must prove its boundary before advancing. Legacy collectors
    // without coverage keep their increment behavior but record coverage unknown.
    const coverage = collected.coverage;
    const cursorSafe = coverage === undefined || coverage.window_only === true || coverage.complete;
    const previousCursor = source.last_external_id ?? "";
    let nextCursor = previousCursor;
    if (cursorSafe) {
      const latest = pickCursor(fetched, coverage?.window_only === true ? record : undefined);
      if (latest && ((coverage?.window_only === true && !isNumericId(latest.external_id))
        || canAdvanceCursor(previousCursor, latest.external_id))) {
        nextCursor = latest.external_id;
      }
    }
    const cursorItem = fetched.find((it) => it.external_id === nextCursor);
    const completed = await completeSourceClaim(
      sql,
      source.id,
      jobId,
      nextCursor,
      cursorItem?.published_at ?? (nextCursor === previousCursor ? null : latestPublished(fetched, nextCursor)),
    );
    if (!completed) {
      await finishSourceJob(sql, jobId, "error", SCHEDULER_LEASE_LOST, 0, 0, meta);
      return { items_found: 0, items_new: 0, error: SCHEDULER_LEASE_LOST };
    }
    await finishSourceJob(sql, jobId, "ok", "", fetched.length, itemsNew, meta, coverage);
    return { items_found: fetched.length, items_new: itemsNew, error: "" };
  } catch (err) {
    const failedMeta = collectorMeta(err);
    if (failedMeta.attempts.length) meta = failedMeta;
    const message = errMessage(err);
    const released = await failSourceClaim(sql, source.id, jobId, message);
    const jobError = released ? message : SCHEDULER_LEASE_LOST;
    if (jobCreated) {
      await finishSourceJob(sql, jobId, "error", jobError, 0, 0, meta);
    }
    return { items_found: 0, items_new: 0, error: jobError };
  }
}

export async function runKeywordJob(
  keywordId: string,
  kind: "keyword" | "manual" = "keyword",
  /** Test seam (see `FetchIo`); production callers omit it. */
  io: FetchIo = {},
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
    const batch = await collectKeyword(kw.phrase, kw.platforms, io);
    const fetched = batch.items;
    let itemsNew = 0;
    for (const it of fetched) {
      const result = await persistHit(it, kw.phrase, "rss");
      if (result === "new") itemsNew += 1;
    }
    const localTagged = await tagCorpusWithPhrase(kw.phrase, { platforms: kw.platforms });
    const hits = await recountKeywordHits(kw.phrase, false);

    // T08: the run's status must reflect what actually happened (see
    // scheduler-outcome.ts). Previously every outcome collapsed into "ok", so a
    // total outage looked like a clean zero-hit scan.
    const { status: jobStatus, note } = keywordRunOutcome(batch.attempts, {
      externalItems: fetched.length,
      localTagged,
    });

    const completed = await completeKeywordClaim(sql, kw.id, jobId, note, hits);
    if (!completed) {
      await sql.query(
        `update jobs set status = 'error', finished_at = now(), error = $2 where id = $1`,
        [jobId, SCHEDULER_LEASE_LOST],
      );
      return { items_found: 0, items_new: 0, error: SCHEDULER_LEASE_LOST, phrase: kw.phrase };
    }
    await sql.query(
      `update jobs set status = $5, finished_at = now(), items_found = $2, items_new = $3, error = $4
       where id = $1`,
      [jobId, fetched.length + localTagged, itemsNew, note, jobStatus],
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

export async function tickDueSources(
  limit = 5,
  budget: CronBatchOptions = {},
  /** Test seam (see `FetchIo`); production callers omit it. */
  io: FetchIo = {},
): Promise<TickResult & { deferred: number }> {
  await ensureSeeded();
  const sql = await getSql();
  const { sources: sourceLimit, keywords: keywordLimit } = cronDueQuotas(limit);

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

  // Fixed pools let keyword and source work share the same bounded window without either backlog starving.
  const [keywordBatch, sourceBatch] = await Promise.all([runCronBatch(dueKw, async (row) => {
    const kw = mapKeyword(row);
    const result = await runKeywordJob(kw.id, "keyword", io);
    return {
      source_id: kw.id,
      name: `关键词 · ${kw.phrase}`,
      items_new: result.items_new,
      error: result.error,
      kind: "keyword",
    };
  }, budget), runCronBatch(due, async (row) => {
    const source = mapSource(row);
    const result = await runSourceJob(source.id, "incremental", io);
    return {
      source_id: source.id,
      name: source.name,
      items_new: result.items_new,
      error: result.error,
      kind: "source",
    };
  }, { ...budget, concurrency: CRON_SOURCE_CONCURRENCY })]);

  const jobs: TickResult["jobs"] = [...keywordBatch.results, ...sourceBatch.results];
  const items_new = jobs.reduce((total, job) => total + job.items_new, 0);
  const errors = jobs.filter((job) => job.error && (job.kind === "source"
    || (job.items_new === 0 && job.error !== "已停用" && !job.error.includes("本地")))).length;

  return { ran: jobs.length, items_new, errors, jobs, deferred: sourceBatch.deferred + keywordBatch.deferred };
}
