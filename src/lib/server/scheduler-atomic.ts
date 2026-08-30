type Queryable = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export async function claimSource(
  sql: Queryable,
  sourceId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    `update sources set status = 'running', last_error = ''
     where id = $1 and enabled = true and status <> 'running'
     returning *`,
    [sourceId],
  );
  return row ?? null;
}

export async function claimKeyword(
  sql: Queryable,
  keywordId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await sql.query<Record<string, unknown>>(
    `update keywords set status = 'running', last_error = ''
     where id = $1 and enabled = true and status <> 'running'
     returning *`,
    [keywordId],
  );
  return row ?? null;
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
