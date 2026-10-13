import type { CollectorCoverage } from "./collectors/types.ts";

type Queryable = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

// ponytail: fixed leases avoid a heartbeat/queue; jobs exceeding this window can be reclaimed and must lose CAS.
export const SCHEDULER_LEASE_MINUTES = 15;
export const SCHEDULER_LEASE_LOST = "scheduler_lease_lost";

export async function claimSource(
  sql: Queryable,
  sourceId: string,
  claimToken: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    `update sources
     set status = 'running', last_error = '', claim_token = $2, claimed_at = now()
     where id = $1 and enabled = true and (
       status <> 'running'
       or claimed_at is null
       or claimed_at <= now() - ($3::integer * interval '1 minute')
     )
     returning *`,
    [sourceId, claimToken, SCHEDULER_LEASE_MINUTES],
  );
  return row ?? null;
}

export async function claimKeyword(
  sql: Queryable,
  keywordId: string,
  claimToken: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    `update keywords
     set status = 'running', last_error = '', claim_token = $2, claimed_at = now()
     where id = $1 and enabled = true and (
       status <> 'running'
       or claimed_at is null
       or claimed_at <= now() - ($3::integer * interval '1 minute')
     )
     returning *`,
    [keywordId, claimToken, SCHEDULER_LEASE_MINUTES],
  );
  return row ?? null;
}

export async function completeSourceClaim(
  sql: Queryable,
  sourceId: string,
  claimToken: string,
  lastExternalId: string,
  lastPublishedAt: string | null,
): Promise<boolean> {
  const published = lastPublishedAt ? new Date(lastPublishedAt) : null;
  const publishedIso = published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
  const rows = await sql.query<{ id: unknown }>(
    `update sources set
       status = 'ok',
       last_scanned_at = now(),
       last_error = '',
       last_external_id = coalesce(nullif($2, ''), last_external_id),
       last_published_at = coalesce($3::timestamptz, last_published_at),
       claim_token = '',
       claimed_at = null
     where id = $1 and claim_token = $4
     returning id`,
    [sourceId, lastExternalId, publishedIso, claimToken],
  );
  return rows.length === 1;
}

export async function failSourceClaim(
  sql: Queryable,
  sourceId: string,
  claimToken: string,
  error: string,
): Promise<boolean> {
  const rows = await sql.query<{ id: unknown }>(
    `update sources set
       status = 'error', last_scanned_at = now(), last_error = $2,
       claim_token = '', claimed_at = null
     where id = $1 and claim_token = $3
     returning id`,
    [sourceId, error, claimToken],
  );
  return rows.length === 1;
}

export async function completeKeywordClaim(
  sql: Queryable,
  keywordId: string,
  claimToken: string,
  note: string,
  hits: number,
): Promise<boolean> {
  const rows = await sql.query<{ id: unknown }>(
    `update keywords set
       status = 'ok', last_scanned_at = now(), last_error = $2, hits = $3,
       claim_token = '', claimed_at = null
     where id = $1 and claim_token = $4
     returning id`,
    [keywordId, note, hits, claimToken],
  );
  return rows.length === 1;
}

export async function failKeywordClaim(
  sql: Queryable,
  keywordId: string,
  claimToken: string,
  error: string,
): Promise<boolean> {
  const rows = await sql.query<{ id: unknown }>(
    `update keywords set
       status = 'error', last_scanned_at = now(), last_error = $2,
       claim_token = '', claimed_at = null
     where id = $1 and claim_token = $3
     returning id`,
    [keywordId, error, claimToken],
  );
  return rows.length === 1;
}

export async function finishItemInsert(
  rows: readonly { id: unknown }[],
  mediaUrls: string[],
  mediaType: string,
  enqueue: (itemId: string, urls: string[], mediaType: string) => Promise<unknown>,
): Promise<boolean> {
  const id = rows[0]?.id;
  if (typeof id !== "string" || !id) return false;
  if (mediaUrls.length) await enqueue(id, mediaUrls, mediaType);
  return true;
}

export async function finishSourceJob(
  sql: Queryable,
  jobId: string,
  status: "ok" | "error",
  error: string,
  itemsFound: number,
  itemsNew: number,
  meta: { provider: "" | "primary" | "dajiala" | "mixed"; attempts: string[]; paid_call: boolean },
  coverage?: CollectorCoverage,
): Promise<void> {
  await sql.query(`update jobs set status = $2, finished_at = now(), error = $3,
      items_found = $4, items_new = $5, provider = $6, attempts = $7::jsonb, paid_call = $8, coverage = $9::jsonb
    where id = $1`, [jobId, status, error, itemsFound, itemsNew, meta.provider,
    JSON.stringify(meta.attempts), meta.paid_call, JSON.stringify(coverage ?? {})]);
}

export async function mergeExistingItem(sql: Queryable, itemId: string, item: {
  title: string;
  body: string;
  author: string;
  url: string;
  media_type: string;
  media_urls: string[];
  thumbnail_url: string;
  views: number | null;
  likes: number | null;
  published_at: string | null;
  extra: Record<string, unknown>;
}, matchedKeywords: string[]): Promise<void> {
  const incomingComplete = item.extra.body_complete === true;
  await sql.query(`update items set
      title=coalesce(nullif(title,''),nullif($2,''),title),
      body=case when $14::boolean and coalesce(extra->>'body_complete','false') <> 'true'
          and nullif($3,'') is not null then $3 || case
        when body ~ '\\[(OCR:|ASR:|字幕:)' then E'\n\n' || substring(body from
          least(nullif(position('[OCR:' in body),0),nullif(position('[ASR:' in body),0),nullif(position('[字幕:' in body),0)))
        else '' end
        else coalesce(nullif(body,''),nullif($3,''),body) end,
      author=coalesce(nullif(author,''),nullif($4,''),author),
      url=coalesce(nullif(url,''),nullif($5,''),url),
      media_type=coalesce(nullif(media_type,''),nullif($6,''),media_type),
      media_urls=case when jsonb_array_length(media_urls)=0 and jsonb_array_length($7::jsonb)>0
        then $7::jsonb else media_urls end,
      thumbnail_url=coalesce(nullif(thumbnail_url,''),nullif($8,''),thumbnail_url),
      views=coalesce(views,$9), likes=coalesce(likes,$10),
      published_at=coalesce(published_at,$11::timestamptz),
      extra=extra || $12::jsonb || case
        when coalesce(extra->>'body_complete','false')='true' or $14::boolean
        then '{"body_complete":true}'::jsonb else '{}'::jsonb end,
      matched_keywords=(select coalesce(jsonb_agg(keyword order by keyword),'[]'::jsonb)
        from (select distinct value as keyword
          from jsonb_array_elements_text(items.matched_keywords || $13::jsonb)) merged)
    where id=$1`, [itemId, item.title, item.body, item.author, item.url, item.media_type,
    JSON.stringify(item.media_urls), item.thumbnail_url, item.views, item.likes, item.published_at,
    JSON.stringify(Object.fromEntries(Object.entries(item.extra).filter(([key]) => !key.startsWith("article_") && !key.startsWith("transcript_")))),
    JSON.stringify(matchedKeywords), incomingComplete]);
}

/**
 * T07: tag the WHOLE corpus with one phrase, in a single set-based statement.
 *
 * The previous implementation selected candidates with `limit 200` and then
 * skipped rows that already carried the tag, so a corpus bigger than one page
 * (or one whose first page was already tagged) could never finish — and re-running
 * it did not continue, it just re-scanned the same page. Here the database does
 * the work in one statement:
 *
 *   - the match is `strpos(lower(...))`, so `%` and `_` are literal characters
 *     rather than LIKE wildcards, and matching is case-insensitive;
 *   - `not exists (... arrays ...)` makes re-runs idempotent and case-insensitive;
 *   - `|| jsonb_build_array(...)` appends instead of overwriting, so concurrent
 *     tagging of two different phrases cannot lose either tag (the read-modify-
 *     write of the old code could);
 *   - the tag is added only to rows this statement matched, so a concurrent
 *     writer's own tags survive.
 *
 * Returns how many rows were newly tagged.
 *
 * ponytail: one statement over the whole corpus, so a very large items table
 * holds a row lock for the duration. At the current corpus size that is well
 * within budget; if it ever isn't, batch by an id cursor (`where id > $last
 * order by id limit N`) rather than reintroducing a page-then-skip scan.
 */
export async function tagCorpusWithPhrase(
  sql: Queryable,
  phrase: string,
  options: { platforms?: string[] } = {},
): Promise<number> {
  const trimmed = String(phrase ?? "").trim();
  // Boundary validation: an empty or 1-character phrase would match almost
  // everything, and is not a meaningful keyword (parseKeywordList uses the same
  // 2..40 rule).
  if (trimmed.length < 2 || trimmed.length > 40) throw new Error("invalid_phrase");

  const platforms = (options.platforms ?? []).filter((p) => typeof p === "string" && p);
  const rows = await sql.query<{ id: string }>(
    `update items
        set matched_keywords = coalesce(matched_keywords, '[]'::jsonb) || jsonb_build_array($1::text)
      where strpos(lower(coalesce(title, '') || E'\n' || coalesce(body, '') || E'\n' || coalesce(author, '')),
                  lower($1::text)) > 0
        and not exists (
          select 1 from jsonb_array_elements_text(coalesce(matched_keywords, '[]'::jsonb)) as kw(value)
           where lower(kw.value) = lower($1::text)
        )
        and ($2::jsonb = '[]'::jsonb or platform = any (
          select jsonb_array_elements_text($2::jsonb)
        ))
      returning id`,
    [trimmed, JSON.stringify(platforms)],
  );
  return rows.length;
}
