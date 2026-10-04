import { RADAR_SOURCE_ID } from "../keyword.ts";
type Queryable = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

// ponytail: fixed leases avoid a heartbeat/queue; jobs exceeding this window can be reclaimed and must lose CAS.
export const SCHEDULER_LEASE_MINUTES = 15;
export const SCHEDULER_LEASE_LOST = "scheduler_lease_lost";

export async function lockSourceClaim(sql: Queryable, sourceId: string, claimToken: string): Promise<void> {
  const [source] = await sql.query<{claim_token: string; status: string}>(
    'select claim_token,status from sources where id=$1 for update', [sourceId]);
  if (!claimToken || source?.claim_token !== claimToken || source.status !== 'running') {
    throw new Error(SCHEDULER_LEASE_LOST);
  }
}

const available = `(next_attempt_at is null or next_attempt_at <= now()) and
  (status <> 'running' or claimed_at is null or claimed_at <= now() - (${SCHEDULER_LEASE_MINUTES} * interval '1 minute'))`;
const due = `(status = 'running' or next_attempt_at is not null or last_scanned_at is null or
  last_scanned_at <= now() - (interval_minutes * interval '1 minute'))`;
const sourceDue = `(${due} or (has_more and last_scanned_at <= now() - interval '1 minute'))`;

export async function selectDueCollections(sql: Queryable, limit: number) {
  const order = `order by coalesce(next_attempt_at, last_scanned_at + interval_minutes * interval '1 minute', '-infinity'::timestamptz), id limit $1`;
  const sources = await sql.query<Record<string, unknown>>(`select * from sources where enabled and id <> '${RADAR_SOURCE_ID}' and ${available} and ${sourceDue} and not has_more ${order}`, [limit]);
  const backfill = await sql.query<Record<string, unknown>>(`select * from sources where enabled and id <> '${RADAR_SOURCE_ID}' and ${available} and ${sourceDue} and has_more ${order.replace("interval_minutes * interval '1 minute'", "interval '1 minute'")}`, [limit]);
  const keywords = await sql.query<Record<string, unknown>>(`select * from keywords where enabled and ${available} and ${due} ${order}`, [limit]);
  return { sources, backfill, keywords };
}

/** Only call after a validated configuration change, never an enable/disable toggle. */
export async function clearConfigurationFailure(sql: Queryable, table: 'sources' | 'keywords', id: string) {
  await sql.query(`update ${table} set next_attempt_at=null, consecutive_failures=0, last_error_code='', last_error=''
    where id=$1 and last_error_code='config_error' and status <> 'running'`, [id]);
}

export async function claimSource(
  sql: Queryable,
  sourceId: string,
  claimToken: string,
  manual = false,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    `update sources
     set status = 'running', last_error = '', claim_token = $2, claimed_at = now()
     where id = $1 and enabled = true and ${available}
       and ($3::boolean or ${sourceDue})
     returning *`,
    [sourceId, claimToken, manual],
  );
  return row ?? null;
}

export async function claimKeyword(
  sql: Queryable,
  keywordId: string,
  claimToken: string,
  manual = false,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    `update keywords
     set status = 'running', last_error = '', claim_token = $2, claimed_at = now()
     where id = $1 and enabled = true and ${available}
       and ($3::boolean or ${due})
     returning *`,
    [keywordId, claimToken, manual],
  );
  return row ?? null;
}

export async function completeSourceClaim(
  sql: Queryable,
  sourceId: string,
  claimToken: string,
  lastExternalId: string,
  lastPublishedAt: string | null,
  progress?: { scan_state?: unknown; has_more?: boolean; coverage?: unknown; rejected_entries?: number;
    feed_validators?: { etag: string; last_modified: string }; feed_validator_identity?: string },
): Promise<boolean> {
  const rows = await sql.query<{ id: unknown }>(
    `update sources set
       status = 'ok', next_attempt_at = null, consecutive_failures = 0, last_success_at = now(), last_error_code = '',
       last_scanned_at = now(),
       last_error = '',
       last_external_id = coalesce(nullif($2, ''), last_external_id),
       last_published_at = coalesce($3::timestamptz, last_published_at),
       claim_token = '',
       claimed_at = null${progress ? `, scan_state = $5::jsonb, has_more = $6,
       collection_coverage = $7::jsonb, rejected_entries = $8${progress.feed_validators ? `,
       feed_etag = $9, feed_last_modified = $10, feed_validator_identity = $11` : ''}` : ''}
     where id = $1 and claim_token = $4
     returning id`,
    [sourceId, lastExternalId, lastPublishedAt, claimToken, ...(progress ? [
      JSON.stringify(progress.scan_state ?? { bootstrap: "latest" }), progress.has_more ?? false,
      JSON.stringify(progress.coverage ?? null), progress.rejected_entries ?? 0,
      ...(progress.feed_validators ? [progress.feed_validators.etag, progress.feed_validators.last_modified,
        progress.feed_validator_identity ?? ''] : [])] : [])],
  );
  return rows.length === 1;
}

function retryFailure(error: unknown) {
  const value = error as { code?: string; status?: number; retryAt?: number; message?: string } | null;
  const message = typeof error === 'string' ? error : value?.message ?? 'collection_failed';
  const permanent = value?.status === 401 || value?.status === 403 ||
    /未配置|需要有效|请填写|requires_authorized_worker|membership_required/.test(message) ||
    ['config_error', 'invalid_url', 'unsupported_protocol', 'url_credentials_not_allowed', 'blocked_host', 'blocked_address'].includes(value?.code ?? '');
  // A server deadline must never become clearable through configuration repair.
  const retryAt = Number.isFinite(value?.retryAt) ? value!.retryAt! : null;
  return { message: (permanent ? `${message}；请检查信源地址、授权或服务配置` : message).slice(0,400), code: retryAt ? 'rate_limited' : permanent ? 'config_error' : /^[a-z][a-z0-9_]{0,79}$/.test(value?.code ?? '') ? value!.code! : 'collection_failed', retryAt, permanent };
}

async function failClaim(sql: Queryable, table: 'sources' | 'keywords', id: string, token: string, error: unknown, hits?: number): Promise<boolean> {
  const failure = retryFailure(error);
  const rows = await sql.query<{id: unknown}>(`update ${table} set status='error', last_scanned_at=now(), last_error=$2,
    last_error_code=$4, consecutive_failures=consecutive_failures+1,
    next_attempt_at=greatest(next_attempt_at, to_timestamp($5::double precision / 1000), now() +
      (least(360, (case when $6::boolean then 360 when consecutive_failures=0 then 1
        when consecutive_failures=1 then 5 when consecutive_failures=2 then 15 else 60 end) * (1 + random()*0.2)) * interval '1 minute')),
    claim_token='', claimed_at=null${table === 'keywords' ? ', hits=coalesce($7::integer,hits)' : ''} where id=$1 and claim_token=$3 returning id`,
    [id, failure.message, token, failure.code, failure.retryAt, failure.permanent, ...(table === 'keywords' ? [hits ?? null] : [])]);
  return rows.length===1;
}

export async function failSourceClaim(sql: Queryable, sourceId: string, claimToken: string, error: unknown): Promise<boolean> {
  return failClaim(sql, 'sources', sourceId, claimToken, error);
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
       status = 'ok', next_attempt_at = null, consecutive_failures = 0, last_success_at = now(), last_error_code = '', last_scanned_at = now(), last_error = $2, hits = $3,
       claim_token = '', claimed_at = null
     where id = $1 and claim_token = $4
     returning id`,
    [keywordId, note, hits, claimToken],
  );
  return rows.length === 1;
}

export async function failKeywordClaim(sql: Queryable, keywordId: string, claimToken: string, error: unknown, hits?: number): Promise<boolean> {
  return failClaim(sql, 'keywords', keywordId, claimToken, error, hits);
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
): Promise<void> {
  await sql.query(`update jobs set status = $2, finished_at = now(), error = $3,
      items_found = $4, items_new = $5, provider = $6, attempts = $7::jsonb, paid_call = $8
    where id = $1`, [jobId, status, error, itemsFound, itemsNew, meta.provider,
    JSON.stringify(meta.attempts), meta.paid_call]);
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
        when position('[OCR:' in body)>0 or position('[ASR:' in body)>0 then E'\n\n' || substring(body from case
          when position('[OCR:' in body)=0 then position('[ASR:' in body)
          when position('[ASR:' in body)=0 then position('[OCR:' in body)
          else least(position('[OCR:' in body),position('[ASR:' in body)) end)
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
    JSON.stringify(item.extra), JSON.stringify(matchedKeywords), incomingComplete]);
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
