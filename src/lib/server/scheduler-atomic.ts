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
    [sourceId, lastExternalId, lastPublishedAt, claimToken],
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
  await sql.query(`update items set
      title=coalesce(nullif(title,''),nullif($2,''),title),
      body=coalesce(nullif(body,''),nullif($3,''),body),
      author=coalesce(nullif(author,''),nullif($4,''),author),
      url=coalesce(nullif(url,''),nullif($5,''),url),
      media_type=coalesce(nullif(media_type,''),nullif($6,''),media_type),
      media_urls=case when jsonb_array_length(media_urls)=0 and jsonb_array_length($7::jsonb)>0
        then $7::jsonb else media_urls end,
      thumbnail_url=coalesce(nullif(thumbnail_url,''),nullif($8,''),thumbnail_url),
      views=coalesce(views,$9), likes=coalesce(likes,$10),
      published_at=coalesce(published_at,$11::timestamptz), extra=extra || $12::jsonb,
      matched_keywords=(select coalesce(jsonb_agg(keyword order by keyword),'[]'::jsonb)
        from (select distinct value as keyword
          from jsonb_array_elements_text(items.matched_keywords || $13::jsonb)) merged)
    where id=$1`, [itemId, item.title, item.body, item.author, item.url, item.media_type,
    JSON.stringify(item.media_urls), item.thumbnail_url, item.views, item.likes, item.published_at,
    JSON.stringify(item.extra), JSON.stringify(matchedKeywords)]);
}
