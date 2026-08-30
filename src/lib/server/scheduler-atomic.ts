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
