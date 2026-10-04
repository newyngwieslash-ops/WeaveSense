import { createHash, randomUUID } from "node:crypto";
import { guessKind } from "./media-kind.ts";
import { getSql, type Queryable, type Sql } from "@/lib/db";
import { shortId } from "@/lib/utils";
import { asJson } from "./serialize";
import { minioConfigured } from "./config";
import { publicFetch, CollectionHttpError } from "./outbound-policy.ts";
import { putObject } from "./storage";
import type { FetchIo } from "./http.ts";

/**
 * Classify a media URL by its *file*, falling back to the entry's declared
 * `mediaType` only when the extension says nothing.
 *
 * T12: the declared shape describes the item, not the file — a B 站 "video" entry
 * carries a JPEG cover, and classifying by `mediaType` alone would file that cover
 * as a video and later send it to a speech model.
 */

export async function enqueueItemMedia(
  itemId: string,
  urls: string[],
  mediaType: string,
  sql?: Queryable,
): Promise<number> {
  sql ??= await getSql();
  let n = 0;
  for (const url of urls.slice(0, 8)) {
    if (!url) continue;
    const inserted = await sql.query(
      `insert into media_objects (id, item_id, source_url, kind, status, public_url)
       values ($1,$2,$3,$4,'remote',$3)
       on conflict (item_id,source_url) do nothing returning id`,
      [shortId(), itemId, url.slice(0, 1500), guessKind(url, mediaType)],
    );
    n += inserted.length;
  }
  return n;
}

// Initial attempt + three automatic retries. Expired claims consume attempts too.
const RETRY_MS = [60_000, 300_000, 900_000];
export const MEDIA_LEASE_MS = 5 * 60_000;

export type MediaRow = {
  id: string;
  item_id: string;
  source_url: string;
  object_key: string;
  public_url: string;
  content_type: string;
  bytes: number | null;
  sha256: string;
  kind: string;
  status: string;
  error: string;
  created_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  claim_token: string;
  claimed_at: Date | string | null;
};

export async function claimMedia(
  sql: Queryable,
  token: string,
  now = Date.now(),
): Promise<MediaRow | null> {
  if (!token || !Number.isFinite(now)) throw new Error("invalid_media_claim");
  const at = new Date(now).toISOString(),
    expired = new Date(now - MEDIA_LEASE_MS).toISOString();
  // A crashed final attempt still converges to dead, retaining its stable object key.
  await sql.query(
    `update media_objects set status='dead', claim_token='', claimed_at=null,
    error='attempts_exhausted:' || error
    where attempts >= 4 and (status in ('remote','error')
      or (status='running' and (claimed_at is null or claimed_at <= $1::timestamptz)))`,
    [expired],
  );
  const [row] = await sql.query<MediaRow>(
    `with candidate as (
      select id from media_objects where attempts < 4 and (
        (status='remote' and (next_attempt_at is null or next_attempt_at <= $2::timestamptz))
        or (status='error' and next_attempt_at <= $2::timestamptz)
        or (status='running' and (claimed_at is null or claimed_at <= $3::timestamptz)))
      order by created_at,id for update skip locked limit 1
    ) update media_objects m set status='running', attempts=m.attempts+1,
      claim_token=$1,claimed_at=$2::timestamptz,next_attempt_at=null,
      object_key=case when m.object_key='' then m.item_id || '/' || m.id else m.object_key end
    from candidate c where m.id=c.id returning m.*`,
    [token, at, expired],
  );
  return row ?? null;
}

/** Explicit single-row replay only; stored and active rows keep their state/references. */
export async function replayMedia(sql: Queryable, id: string, now = Date.now()): Promise<boolean> {
  const rows = await sql.query(
    `update media_objects set status='remote',attempts=0,
    next_attempt_at=case when next_attempt_at > $2::timestamptz then next_attempt_at else null end,
    claim_token='',claimed_at=null,error=''
    where id=$1 and status in ('error','dead') returning id`,
    [id, new Date(now).toISOString()],
  );
  return rows.length === 1;
}

function transient(error: unknown): boolean {
  if (!(error instanceof CollectionHttpError)) return true; // SQL/upload transport failures get a bounded retry.
  if (error.status !== undefined)
    return [408, 425, 429].includes(error.status) || error.status >= 500;
  return ["timeout", "aborted", "network_error", "dns_no_answer"].includes(error.code);
}

export async function ingestPending(
  limit = 6,
  io: Pick<FetchIo, "resolver" | "transport"> & {
    now?: () => number;
  } = {},
): Promise<{ stored: number; errors: number }> {
  if (!minioConfigured()) return { stored: 0, errors: 0 };
  const sql: Sql = await getSql();
  const now = io.now ?? Date.now;
  let stored = 0,
    errors = 0;
  for (let n = 0; n < Math.min(20, Math.max(1, Math.floor(limit) || 1)); n++) {
    const row = await claimMedia(sql, randomUUID(), now());
    if (!row) break;
    try {
      const fetched = await publicFetch(row.source_url, {
        timeoutMs: 20000,
        kind: "media",
        as: "bytes",
        resolver: io.resolver,
        transport: io.transport,
      });
      const buf = Buffer.from(fetched.bytes ?? new Uint8Array());
      const contentType = (fetched.contentType || "application/octet-stream").slice(0, 120);
      const mime = contentType.split(";")[0].trim().toLowerCase();
      const kind = /^(image|audio|video)\//.exec(mime)?.[1] ?? "file";
      const sha = createHash("sha256").update(buf).digest("hex");
      const put = await putObject(row.object_key, buf, contentType);
      if (!put.ok)
        throw new CollectionHttpError("storage_http_error", "storage_upload_failed", {
          status: put.status,
          retryAt: put.retryAt,
        });
      const committed = await sql.transaction(async (tx) => {
        // Match source-batch lock order: item first, then media. No network under these locks.
        const [item] = await tx.query<{ media_urls: unknown; thumbnail_url: string }>(
          "select media_urls,thumbnail_url from items where id=$1 for update",
          [row.item_id],
        );
        if (!item) throw new Error("media_item_missing");
        const [owned] = await tx.query<MediaRow>(
          "select * from media_objects where id=$1 for update",
          [row.id],
        );
        if (
          !owned ||
          owned.status !== "running" ||
          owned.claim_token !== row.claim_token ||
          !owned.claimed_at ||
          new Date(owned.claimed_at).getTime() <= now() - MEDIA_LEASE_MS
        )
          return false;
        const finished = await tx.query(
          `update media_objects set status='stored',public_url=$3,
          content_type=$4,bytes=$5,sha256=$6,kind=$7,error='',next_attempt_at=null,claim_token='',claimed_at=null
          where id=$1 and claim_token=$2 and status='running' and claimed_at > $8::timestamptz returning id`,
          [
            row.id,
            row.claim_token,
            put.url,
            contentType,
            buf.length,
            sha,
            kind,
            new Date(now() - MEDIA_LEASE_MS).toISOString(),
          ],
        );
        if (!finished.length) return false;
        const urls = asJson<string[]>(item.media_urls, []).map((u) =>
          u === row.source_url ? put.url : u,
        );
        const thumb = item.thumbnail_url === row.source_url ? put.url : item.thumbnail_url;
        await tx.query("update items set media_urls=$2::jsonb,thumbnail_url=$3 where id=$1", [
          row.item_id,
          JSON.stringify(urls),
          thumb,
        ]);
        return true;
      });
      stored += Number(committed);
    } catch (error) {
      const delay = transient(error) ? RETRY_MS[row.attempts - 1] : undefined;
      const code =
        error instanceof CollectionHttpError
          ? error.code + (error.status ? `:${error.status}` : "")
          : "media_processing_failed";
      const retryAt = error instanceof CollectionHttpError ? error.retryAt : undefined;
      const nextAttempt =
        delay !== undefined
          ? new Date(Math.max(now() + delay, retryAt ?? 0)).toISOString()
          : retryAt !== undefined && retryAt > now()
            ? new Date(retryAt).toISOString()
            : null;
      const failure = await sql.query(
        `update media_objects set status=$3,error=$4,next_attempt_at=$5::timestamptz,
        claim_token='',claimed_at=null where id=$1 and claim_token=$2 and status='running'
        and claimed_at > $6::timestamptz returning id`,
        [
          row.id,
          row.claim_token,
          delay === undefined ? "dead" : "error",
          (row.attempts >= 4 ? "attempts_exhausted:" : "") + code,
          nextAttempt,
          new Date(now() - MEDIA_LEASE_MS).toISOString(),
        ],
      );
      errors += failure.length;
    }
  }
  return { stored, errors };
}
