import { getSql, type Sql } from "@/lib/db";
import { itemMatchesPhrase, RADAR_SOURCE_ID } from "@/lib/keyword";
import { isPlatform, type PlatformId } from "@/lib/platforms";
import { shortId } from "@/lib/utils";
import { normalizeWechatUrl } from "@/lib/wechat-canonical";
import { canAdvanceCursor, compareNumericIds, isNumericId, telegramMessageId } from "./cursor.ts";
import type { TickResult } from "@/lib/types";
import { parseTelegramHandle } from "../telegram-handle.ts";
import { collectSource } from "./collectors";
import type { FetchIo } from "./http.ts";
import { collectKeyword } from "./collectors/keyword.ts";
import { collectorMeta, type CollectorMeta, type CollectorBatch, type NormalizedItem, type SourceRecord } from "./collectors/types";
import { fairCollectionQueue, CRON_SOURCE_CONCURRENCY, runCronBatch, type CronBatchOptions } from "./cron";
import { enqueueItemMedia } from "./media";
import { mapKeyword, mapSource } from "./queries";
import {
  tagCorpusWithPhrase as atomicTagCorpus,
  claimKeyword,
  claimSource,
  lockSourceClaim,
  completeKeywordClaim,
  completeSourceClaim,
  failKeywordClaim,
  failSourceClaim,
  finishSourceJob,
  finishItemInsert,
  mergeExistingItem,
  SCHEDULER_LEASE_LOST,
  selectDueCollections,
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
function pickCursor(items: NormalizedItem[]): NormalizedItem | undefined {
  if (!items.length) return undefined;
  const numeric = items.filter((it) => isNumericId(it.external_id));
  if (numeric.length) {
    return numeric.reduce((a, b) =>
      compareNumericIds(a.external_id, b.external_id) >= 0 ? a : b);
  }
  return items[0];
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

/** One pinned connection: fence before any writes, then commit content and progress together.
 * Source claims use the job ID as their token, so completion needs no extra job context.
 */
export async function persistCollectedBatch(database: Sql, source: SourceRecord, claimToken: string,
  collected: CollectorBatch): Promise<{items_new: number}> {
  return database.transaction(async sql => {
    await lockSourceClaim(sql, source.id, claimToken);
    const fetched = collected.items;
    if (collected.not_modified && (fetched.length || !collected.feed_validators ||
      !source.feed_validator_identity || collected.feed_validator_identity !== source.feed_validator_identity ||
      !(source.feed_etag || source.feed_last_modified))) throw new Error('invalid_not_modified_batch');
    const meta = collected.meta;
    const externalIds = [...new Set(fetched.flatMap(item => [item.external_id.slice(0,320),
      ...(typeof item.extra.rss_legacy_id === "string" ? [item.extra.rss_legacy_id] : [])]))];
    const normalizedUrl = (url: string) => {
      if (source.platform !== "wechat" || !url) return "";
      try { return normalizeWechatUrl(url); } catch { return ""; }
    };
    const urls = [...new Set(fetched.map(item=>normalizedUrl(item.url)).filter(Boolean))];
    if (source.platform === "wechat" && (await sql.query(
      "select id from items where source_id=$1 and platform='wechat' and normalized_wechat_url is null limit 1", [source.id])).length) {
      throw new Error("wechat_identity_backfill_required: run reconcile-collection-identities --wechat-url-keys with the source paused");
    }
    const telegram = source.platform === "telegram" && !source.feed_url;
    const existing = await sql.query<{ id: string; external_id: string; url: string; extra: unknown; normalized_wechat_url: string | null }>(
      `select id, external_id, url, extra, normalized_wechat_url from items where source_id = $1 and
        (external_id=any($2::text[])${source.platform === "wechat" ? " or normalized_wechat_url=any($3::text[])" : telegram ? ` or
        (case when external_id ~ '^[0-9]+$' then coalesce(nullif(ltrim(external_id,'0'),''),'0')
          when external_id ~ '^[^/]+/[0-9]+$' then coalesce(nullif(ltrim(split_part(external_id,'/',2),'0'),''),'0') end)=any($3::text[])` : ""})`,
      [source.id,externalIds,...(source.platform === "wechat" ? [urls] : telegram ? [externalIds] : [])],
    );
    const existingByExternalId = new Map(existing.map((row) => [row.external_id, row]));
    if (source.platform === "telegram" && !source.feed_url) {
      const handle = parseTelegramHandle(source.handle) || parseTelegramHandle(source.url);
      // Numeric and exact channel/ID aliases refer to one message of this source.
      // Check every group before changing any row, retaining internal IDs.
      const aliases = new Map<string, (typeof existing)[number]>();
      for (const row of existing) {
        const canonical = telegramMessageId(row.external_id, handle);
        if (!canonical) continue;
        if (aliases.has(canonical)) {
          throw Object.assign(new Error("identity_conflict:telegram_duplicate"), {identityConflict: {
            kind: "telegram_duplicate", evidence: {item_ids: [aliases.get(canonical)!.id, row.id], external_id: canonical} }});
        }
        aliases.set(canonical, row);
      }
      for (const [canonical, row] of aliases) {
        if (row.external_id !== canonical) {
          await sql.query("update items set external_id=$2 where id=$1", [row.id, canonical]);
          existingByExternalId.delete(row.external_id);
          row.external_id = canonical;
        }
        existingByExternalId.set(canonical, row);
      }
    }
    // Check the whole page before changing any item: legacy XML coercion can
    // map distinct opaque GUIDs onto the same previously stored key.
    for (const item of fetched) {
      const alias = item.extra.rss_legacy_id;
      const legacy = typeof alias === "string" ? existingByExternalId.get(alias) : undefined;
      if (legacy && asJson<Record<string, unknown>>(legacy.extra, {}).rss_identity !== "raw-v1") {
        throw Object.assign(new Error("identity_conflict:rss_legacy_alias"), {identityConflict: {
          kind: "rss_legacy_alias", evidence: {item_id: legacy.id, legacy_external_id: alias, incoming_external_id: item.external_id} }});
      }
    }
    const existingByUrl = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      const url = row.normalized_wechat_url;
      if (source.platform === 'wechat' && url) {
        const previous = existingByUrl.get(url);
        if (previous && previous.id !== row.id) throw Object.assign(new Error('identity_conflict:wechat_duplicate_url'), {
          identityConflict: {kind:'wechat_duplicate_url',evidence:{item_ids:[previous.id,row.id]}} });
        existingByUrl.set(url, row);
      }
    }
    const phrases = await sql.query<{ id: string; phrase: string }>("select id, phrase from keywords where enabled = true");
    let itemsNew = 0, itemsUpdated = 0, contentProgress = false;

    for (const it of fetched.filter((item) => item.external_id)) {
      const published = it.published_at ? new Date(it.published_at) : null;
      const publishedIso =
        published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
      const matched = phrases
        .filter((p) => itemMatchesPhrase(it.title, it.body, it.author, p.phrase))
        .map((p) => p.phrase);
      const existingItem = existingByExternalId.get(it.external_id.slice(0,320))
        ?? existingByUrl.get(normalizedUrl(it.url));
      const existingExtra = asJson<Record<string, unknown>>(existingItem?.extra, {});
      const providerHistory = mergeProvidersSeen(existingExtra, it.extra.providers_seen);
      const itemExtra = source.platform === "wechat"
        ? mergeProvidersSeen(existingItem
          ? { ...providerHistory, ...it.extra, providers_seen: providerHistory.providers_seen }
          : it.extra, it.extra.provider ?? meta.provider)
        : it.extra;
      const primaryContent = source.platform !== 'wechat' || it.extra.provider === 'primary' || meta.provider === 'primary';
      if (existingItem) {
        // An existing coerced identity is not proven raw merely by an exact-ID
        // refresh; retain legacy provenance until an operator verifies it.
        if (it.extra.rss_identity && existingExtra.rss_identity !== "raw-v1") delete itemExtra.rss_identity;
        const bodyProgress = await mergeExistingItem(sql, existingItem.id,
          { ...it, extra: itemExtra, published_at: publishedIso }, matched);
        if (bodyProgress) itemsUpdated += 1;
        contentProgress ||= bodyProgress && primaryContent;
        if (source.platform === 'wechat' && !existingItem.url) {
          existingItem.normalized_wechat_url = normalizedUrl(it.url);
          existingItem.url = it.url.slice(0,1000);
          await sql.query('update items set normalized_wechat_url=$2 where id=$1', [existingItem.id,existingItem.normalized_wechat_url]);
          if (existingItem.normalized_wechat_url) existingByUrl.set(existingItem.normalized_wechat_url,existingItem);
        }
        existingItem.extra = itemExtra;
        await enqueueItemMedia(existingItem.id, it.media_urls, it.media_type, sql);
        continue;
      }
      const id = shortId();
      const inserted = await sql.query<{ id: unknown }>(
        `insert into items (
           id, source_id, platform, external_id, title, body, author, url,
           media_type, media_urls, thumbnail_url, views, likes, published_at, extra, matched_keywords, normalized_wechat_url
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)
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
          normalizedUrl(it.url),
        ],
      );
      if (await finishItemInsert(inserted, it.media_urls, it.media_type, (id,urls,type)=>enqueueItemMedia(id,urls,type,sql))) {
        itemsNew += 1;
        contentProgress ||= primaryContent;
        const saved = { id, external_id: it.external_id.slice(0, 320),
          url: it.url.slice(0, 1000), extra: itemExtra, normalized_wechat_url: normalizedUrl(it.url) };
        existingByExternalId.set(saved.external_id, saved);
        const savedUrl = saved.normalized_wechat_url;
        if (savedUrl) existingByUrl.set(savedUrl, saved);
      }
    }

    // T10: the cursor may only advance to a boundary the fetch actually proved
    // it reached. A batch that stopped at its page cap (or is inherently a
    // limited window) reports `complete: false`; advancing then would skip
    // everything between the old cursor and this page, permanently and silently.
    const coverage = collected.coverage;
    const cursorSafe = coverage === undefined ? true : coverage.complete;
    const previousCursor = source.last_external_id ?? "";
    let nextCursor = previousCursor;
    if (cursorSafe) {
      const latest = pickCursor(fetched);
      if (latest && canAdvanceCursor(previousCursor, latest.external_id)) {
        nextCursor = latest.external_id;
      }
    }
    if (collected.next_cursor) nextCursor = collected.next_cursor;
    const cursorItem = fetched.find((it) => it.external_id === nextCursor);
    // A feed window can be fully consumed without proving historical coverage.
    // Quarantined entries/body failures and incomplete pages must fetch a fresh 200 next time.
    const feedComplete = !collected.rejected_entries && !collected.has_more &&
      fetched.every(item => item.external_id && item.extra.body_complete !== false) &&
      (!coverage || coverage.complete || (coverage.window_only && coverage.note === 'feed_window'));
    const validators = collected.feed_validators && (feedComplete
      ? collected.feed_validators : { etag: '', last_modified: '' });
    const completed = await completeSourceClaim(
      sql,
      source.id,
      claimToken,
      nextCursor,
      cursorItem?.published_at ?? (nextCursor === previousCursor ? null : latestPublished(fetched, nextCursor)),
      { scan_state: collected.next_scan_state ?? source.scan_state, has_more: collected.has_more,
        content_progress: contentProgress,
        coverage: collected.coverage, rejected_entries: collected.rejected_entries,
        feed_validators: validators, feed_validator_identity: feedComplete ? collected.feed_validator_identity : '' },
    );
    if (!completed) throw new Error(SCHEDULER_LEASE_LOST);
    const invalid = (collected.rejected_entries ?? 0) + fetched.filter(item=>!item.external_id).length;
    await finishSourceJob(sql, claimToken, "ok", "", fetched.length + (collected.rejected_entries ?? 0), itemsNew, meta,
      {items_updated:itemsUpdated, items_invalid:invalid, bytes:collected.bytes, coverage:collected.coverage});
    return { items_new: itemsNew };
  });
}

export async function runSourceJob(
  sourceId: string,
  kind: "incremental" | "manual" | "reconcile" = "incremental",
  /** Test seam (see `FetchIo`); production callers omit it. */
  io: FetchIo = {},
): Promise<{ items_found: number; items_new: number; error: string }> {
  const sql = await getSql();
  const jobId = shortId();
  const raw = await claimSource(sql, sourceId, jobId, kind === "manual" || kind === "reconcile");
  if (!raw) {
    const [current] = await sql.query<Record<string, unknown>>("select * from sources where id = $1", [sourceId]);
    if (!current) return { items_found: 0, items_new: 0, error: "信源不存在" };
    const existing = mapSource(current);
    if (!existing.enabled) return { items_found: 0, items_new: 0, error: "已停用" };
    return { items_found: 0, items_new: 0, error: existing.status === "running" ? "正在运行" : existing.next_attempt_at ? `冷却中，重试时间 ${existing.next_attempt_at}` : "尚未到采集时间" };
  }
  const source = mapSource(raw);

  let jobCreated = false;
  const metrics = {bytes: null as number | null};
  let meta: CollectorMeta = { provider: "", attempts: [], paid_call: false };
  let collected: CollectorBatch | undefined;
  try {
    await sql.query(
      `insert into jobs (id, source_id, platform, status, kind, adapter) values ($1,$2,$3,'running',$4,$5)`,
      [jobId, source.id, source.platform, kind, source.adapter],
    );
    jobCreated = true;
    const record: SourceRecord = {
      id: source.id,
      platform: source.platform,
      name: source.name,
      handle: source.handle,
      url: source.url,
      feed_url: source.feed_url,
      // Read persisted internal cache fields from the claim, never from client input.
      // Reconciliation repairs item/media state even when the upstream body is unchanged.
      feed_etag: kind === 'reconcile' ? '' : String(raw.feed_etag ?? ''),
      feed_last_modified: kind === 'reconcile' ? '' : String(raw.feed_last_modified ?? ''),
      feed_validator_identity: String(raw.feed_validator_identity ?? ''),
      adapter: source.adapter,
      last_external_id: source.last_external_id,
      scan_state: asJson<SourceRecord["scan_state"]>(raw.scan_state, { bootstrap: "latest" }),
    };
    collected = await collectSource(record, {...io, metrics});
    collected.bytes = metrics.bytes;
    meta = collected.meta;
    const {items_new} = await persistCollectedBatch(sql, record, jobId, collected);
    return {items_found: collected.items.length, items_new, error: ""};
  } catch (err) {
    const failedMeta = collectorMeta(err);
    if (failedMeta.attempts.length) meta = failedMeta;
    const message = errMessage(err);
    const jobError = await sql.transaction(async tx => {
      try { await lockSourceClaim(tx, source.id, jobId); }
      catch (failure) {
        if (failure instanceof Error && failure.message === SCHEDULER_LEASE_LOST) return SCHEDULER_LEASE_LOST;
        throw failure;
      }
      const conflict = (err as {identityConflict?: {kind:string;evidence:unknown}})?.identityConflict;
      if (conflict) await tx.query(`insert into collection_identity_conflicts(source_id,kind,evidence)
        values($1,$2,$3::jsonb)`,[source.id,conflict.kind,JSON.stringify(conflict.evidence)]);
      await failSourceClaim(tx, source.id, jobId, err);
      if (jobCreated) await finishSourceJob(tx, jobId, "error", message,
        collected ? collected.items.length+(collected.rejected_entries ?? 0) : null,0,meta,
        {bytes:metrics.bytes,coverage:collected?.coverage,items_updated:collected ? 0 : undefined,
          items_invalid:collected ? (collected.rejected_entries ?? 0)+collected.items.filter(item=>!item.external_id).length : undefined});
      return message;
    });
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
  const raw = await claimKeyword(sql, keywordId, jobId, kind === "manual");
  if (!raw) {
    const [current] = await sql.query<Record<string, unknown>>("select * from keywords where id = $1", [keywordId]);
    if (!current) return { items_found: 0, items_new: 0, error: "关键词不存在", phrase: "" };
    const existing = mapKeyword(current);
    if (!existing.enabled) return { items_found: 0, items_new: 0, error: "已停用", phrase: existing.phrase };
    return { items_found: 0, items_new: 0,
      error: existing.status === "running" ? "正在运行" : existing.next_attempt_at ? `冷却中，重试时间 ${existing.next_attempt_at}` : "尚未到采集时间", phrase: existing.phrase };
  }
  const kw = mapKeyword(raw);

  let jobCreated = false;
  const metrics = {bytes:null as number | null};
  try {
    await sql.query(
      `insert into jobs (id, source_id, platform, status, kind, keyword_id, adapter)
       values ($1,$2,'rss','running',$3,$4,'keyword_index')`,
      [jobId, RADAR_SOURCE_ID, kind, kw.id],
    );
    jobCreated = true;
    const batch = await collectKeyword(kw.phrase, kw.platforms, {...io,metrics});
    const fetched = batch.items;
    let itemsNew = 0, itemsUpdated = 0;
    for (const it of fetched) {
      const result = await persistHit(it, kw.phrase, "rss");
      if (result === "new") itemsNew += 1;
      if (result === 'tagged') itemsUpdated += 1;
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

    const failures = batch.attempts.filter(attempt => attempt.status === 'error');
    const retryAt = Math.max(0, ...failures.map(attempt => attempt.retryAt ?? 0));
    const completed = failures.length ? await failKeywordClaim(sql, kw.id, jobId, {
      message: note, code: failures[0].error_code, status: failures.find(a => a.http_status === 401 || a.http_status === 403)?.http_status,
      retryAt: retryAt || undefined,
    }, hits) : await completeKeywordClaim(sql, kw.id, jobId, note, hits);
    if (!completed) {
      await sql.query(
        `update jobs set status = 'error', finished_at = now(), error = $2 where id = $1`,
        [jobId, SCHEDULER_LEASE_LOST],
      );
      return { items_found: 0, items_new: 0, error: SCHEDULER_LEASE_LOST, phrase: kw.phrase };
    }
    await sql.query(
      `update jobs set status = $5, finished_at = now(), items_found = $2, items_new = $3, error = $4,
         duration_ms=greatest(0,floor(extract(epoch from(now()-started_at))*1000))::bigint,
         items_updated=$6, bytes=$7, attempts=$8::jsonb,
         error_code=(select last_error_code from keywords where id=jobs.keyword_id),
         retry_at=(select next_attempt_at from keywords where id=jobs.keyword_id)
       where id = $1`,
      [jobId, fetched.length + localTagged, itemsNew, note, jobStatus,itemsUpdated+localTagged,metrics.bytes,
        JSON.stringify(batch.attempts.map(attempt=>attempt.source))],
    );
    return { items_found: fetched.length + localTagged, items_new: itemsNew, error: note, phrase: kw.phrase };
  } catch (err) {
    const message = errMessage(err);
    const released = await failKeywordClaim(sql, kw.id, jobId, err);
    const jobError = released ? message : SCHEDULER_LEASE_LOST;
    if (jobCreated) {
      await sql.query(
        `update jobs set status = 'error', finished_at = now(), error = $2,
          duration_ms=greatest(0,floor(extract(epoch from(now()-started_at))*1000))::bigint,
          items_found=null,items_updated=null,bytes=$3,error_code=case when $4::boolean then
            (select last_error_code from keywords where id=jobs.keyword_id) else 'scheduler_lease_lost' end,
          retry_at=(select next_attempt_at from keywords where id=jobs.keyword_id) where id = $1`,
        [jobId, jobError,metrics.bytes,released],
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
  const count = Math.min(35, Math.max(1, Number.isSafeInteger(limit) ? limit : 5));
  const due = await selectDueCollections(sql, count);
  const queue = fairCollectionQueue(due.sources, due.backfill, due.keywords, count);
  const batch = await runCronBatch(queue, async ({row,kind}) => {
    if (kind === 'keyword') {
      const kw = mapKeyword(row);
      const result = await runKeywordJob(kw.id, 'keyword', io);
      return { source_id: kw.id, name: `关键词 · ${kw.phrase}`, items_new: result.items_new, error: result.error, kind };
    }
    const source = mapSource(row);
    const result = await runSourceJob(source.id, 'incremental', io);
    return { source_id: source.id, name: source.name, items_new: result.items_new, error: result.error, kind };
  }, { ...budget, concurrency: Math.min(CRON_SOURCE_CONCURRENCY, budget.concurrency ?? CRON_SOURCE_CONCURRENCY) });
  const jobs: TickResult['jobs'] = batch.results;
  const items_new = jobs.reduce((total, job) => total + job.items_new, 0);
  const errors = jobs.filter((job) => job.error && (job.kind === "source"
    || (job.items_new === 0 && job.error !== "已停用" && !job.error.includes("本地")))).length;

  return { ran: jobs.length, items_new, errors, jobs, deferred: batch.deferred };
}
