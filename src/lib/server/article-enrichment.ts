import { randomUUID } from "node:crypto";
import type { Queryable, Sql } from "../db.ts";
import { itemMatchesPhrase } from "../keyword.ts";
import type { ArticleAvailability } from "../types.ts";
import { readArticle, type ArticleCandidate } from "./article-reader.ts";
import type { FetchIo } from "./http.ts";
import { assertPublicUrl } from "./outbound-policy.ts";
import { mergeExistingItem } from "./scheduler-atomic.ts";
import { asInt, asJson, iso } from "./serialize.ts";

export type ArticleExtra = {
  article_state: "candidate" | "adopted" | "error" | "restored";
  article_candidate?: string;
  article_digest?: string;
  article_source_url?: string;
  article_provider?: "jina";
  article_fetched_at?: string;
  article_candidate_version?: number;
  article_previous_body?: string;
  article_previous_complete?: boolean;
  article_adopted_version?: number;
  article_error?: string;
};
export type ArticlePreview = ArticleCandidate & { itemId: string; materialVersion: number; cached: boolean };
type ArticleSql = Pick<Sql, "query" | "transaction">;
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 24 * 60 * 60 * 1000;
// ponytail: one reader request per app process; use a shared admission limit before multi-replica enrichment.
const admission = globalThis as typeof globalThis & { __articleReaderInFlight__?: boolean };

function storedId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("article_invalid_id");
}

function versionOf(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") || value === "") {
    throw new Error("article_conflict");
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("article_conflict");
  return version;
}

function allowedHosts(): Set<string> {
  const hosts = (process.env.ARTICLE_READER_ALLOWED_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.some(host => {
    try { return new URL(`https://${host}`).hostname !== host || host.includes("*"); } catch { return true; }
  })) return new Set();
  return new Set(hosts);
}

/** Static availability only; the reader rechecks actual public DNS before fetching. */
export function articleAvailability(item: { media_type: unknown; platform: unknown; url: unknown; extra?: unknown }): ArticleAvailability {
  if (process.env.ARTICLE_READER_ENABLED !== "true") return { available: false, reason: "article_disabled" };
  if (item.platform === "wechat") return { available: false, reason: "article_wechat_gateway_required" };
  if (item.media_type !== "article") return { available: false, reason: "article_unsupported" };
  if (asJson<Record<string, unknown>>(item.extra, {}).body_complete === true) return { available: false, reason: "article_already_complete" };
  try {
    const raw = String(item.url ?? "");
    const url = assertPublicUrl(raw);
    if (url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com")) {
      return { available: false, reason: "article_wechat_gateway_required" };
    }
    if (url.protocol !== "https:" || url.port || raw.includes("?") || raw.includes("#") || !allowedHosts().has(url.hostname)) {
      return { available: false, reason: "article_target_not_allowed" };
    }
    return { available: true };
  } catch { return { available: false, reason: "article_target_not_allowed" }; }
}

async function itemRow(sql: Queryable, itemId: string, lock = false): Promise<Record<string, unknown>> {
  const [row] = await sql.query<Record<string, unknown>>(`select * from items where id=$1${lock ? " for update" : ""}`, [itemId]);
  if (!row) throw new Error("article_not_found");
  return row;
}

function safeReaderError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (["article_busy", "article_conflict", "article_target_not_allowed", "article_wechat_gateway_required",
    "article_invalid_response", "article_invalid_body", "article_access_challenge", "article_disabled",
    "article_unsupported", "article_already_complete", "article_not_found"].includes(code)) return code;
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "article_timeout";
  return "article_read_failed";
}

function cachedArticle(row: Record<string, unknown>, itemId: string, version: number): ArticlePreview | null {
  const extra = asJson<Record<string, unknown>>(row.extra, {});
  const age = Date.now() - Date.parse(String(extra.article_fetched_at ?? ""));
  // material_version includes item.url, binding this candidate to the original URL even if the reader returns a canonical source URL.
  if (extra.article_state === "candidate" && extra.article_candidate_version === version && age >= 0 && age < CACHE_MS &&
    typeof extra.article_candidate === "string" && extra.article_candidate.trim() && Buffer.byteLength(extra.article_candidate) <= MAX_BYTES &&
    typeof extra.article_digest === "string" && /^[a-f0-9]{64}$/.test(extra.article_digest) &&
    typeof extra.article_source_url === "string" && extra.article_provider === "jina") {
    return { itemId, materialVersion: version, cached: true, body: extra.article_candidate,
      sourceUrl: extra.article_source_url, provider: "jina", fetchedAt: String(extra.article_fetched_at), digest: extra.article_digest,
      title: String(row.title ?? "") };
  }
  return null;
}

/** Sql/FetchIo are the existing offline seams; public server entry points supply neither from clients. */
export async function previewArticleWith(opts: { sql: Queryable; itemId: string; io?: FetchIo }): Promise<ArticlePreview> {
  storedId(opts.itemId);
  const row = await itemRow(opts.sql, opts.itemId);
  const version = versionOf(row.material_version);
  const availability = articleAvailability(row as { media_type: unknown; platform: unknown; url: unknown });
  if (!availability.available) throw new Error(availability.reason);
  const cached = cachedArticle(row, opts.itemId, version);
  if (cached) return cached;
  if (admission.__articleReaderInFlight__) throw new Error("article_busy");
  admission.__articleReaderInFlight__ = true;
  const token = randomUUID();
  try {
    const [claimed] = await opts.sql.query<Record<string, unknown>>(`update items set extra=extra || $3::jsonb
      where id=$1 and material_version=$2 and coalesce(extra->>'body_complete','false') <> 'true'
        and (extra->>'article_claim_token' is null or (extra->>'article_claimed_at')::timestamptz < now()-interval '60 seconds')
      returning *`, [opts.itemId, version, JSON.stringify({ article_claim_token: token, article_claimed_at: new Date().toISOString() })]);
    if (!claimed) {
      // Another process may have saved/released a candidate since the initial read; inspect current state before fetching.
      const current = await itemRow(opts.sql, opts.itemId);
      const currentVersion = versionOf(current.material_version);
      if (currentVersion !== version || current.url !== row.url) throw new Error("article_conflict");
      const currentAvailability = articleAvailability(current as { media_type: unknown; platform: unknown; url: unknown });
      if (!currentAvailability.available) throw new Error(currentAvailability.reason);
      const currentCached = cachedArticle(current, opts.itemId, currentVersion);
      if (currentCached) return currentCached;
      throw new Error("article_busy");
    }
    // The atomic claim returns current cache state, while its token fences other processes' candidate writes.
    if (versionOf(claimed.material_version) !== version || claimed.url !== row.url) throw new Error("article_conflict");
    const claimedAvailability = articleAvailability(claimed as { media_type: unknown; platform: unknown; url: unknown });
    if (!claimedAvailability.available) throw new Error(claimedAvailability.reason);
    const claimedCached = cachedArticle(claimed, opts.itemId, version);
    if (claimedCached) return claimedCached;
    const candidate = await readArticle(String(claimed.url), { allowedHosts: allowedHosts(), io: opts.io });
    const saved = await opts.sql.query(`update items set extra=(extra - 'article_error') || $4::jsonb
      where id=$1 and material_version=$2 and extra->>'article_claim_token'=$3 and url=$5
        and coalesce(extra->>'body_complete','false') <> 'true'
        and (extra->>'article_claimed_at')::timestamptz > now()-interval '60 seconds'
      returning id`, [opts.itemId, version, token, JSON.stringify({ article_state: "candidate", article_candidate: candidate.body,
      article_digest: candidate.digest, article_source_url: candidate.sourceUrl, article_provider: candidate.provider,
      article_fetched_at: candidate.fetchedAt, article_candidate_version: version }), row.url]);
    if (!saved.length) throw new Error("article_conflict");
    return { ...candidate, itemId: opts.itemId, materialVersion: version, cached: false };
  } catch (error) {
    const code = safeReaderError(error);
    await opts.sql.query(`update items set extra=(extra - 'article_candidate') || $4::jsonb
      where id=$1 and material_version=$2 and extra->>'article_claim_token'=$3`,
    [opts.itemId, version, token, JSON.stringify({ article_state: "error", article_error: code })]);
    throw new Error(code);
  } finally {
    try {
      await opts.sql.query(`update items set extra=extra - 'article_claim_token' - 'article_claimed_at'
        where id=$1 and extra->>'article_claim_token'=$2`, [opts.itemId, token]);
    } finally { admission.__articleReaderInFlight__ = false; }
  }
}

export async function adoptArticleWith(opts: { sql: ArticleSql; itemId: string; digest: string; expectedVersion: number }) {
  storedId(opts.itemId);
  if (!Number.isSafeInteger(opts.expectedVersion) || opts.expectedVersion < 0) throw new Error("article_conflict");
  if (typeof opts.digest !== "string" || !/^[a-f0-9]{64}$/.test(opts.digest)) throw new Error("article_candidate_stale");
  return opts.sql.transaction(async tx => {
    const row = await itemRow(tx, opts.itemId, true);
    if (versionOf(row.material_version) !== opts.expectedVersion) throw new Error("article_conflict");
    const extra = asJson<Record<string, unknown>>(row.extra, {});
    if (extra.article_digest !== opts.digest || extra.article_candidate_version !== opts.expectedVersion || extra.article_state !== "candidate") {
      throw new Error("article_candidate_stale");
    }
    if (extra.body_complete === true) throw new Error("article_already_complete");
    if (row.media_type !== "article" || row.platform === "wechat") throw new Error("article_unsupported");
    const body = extra.article_candidate;
    if (typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > MAX_BYTES) throw new Error("article_invalid_body");
    const phrases = await tx.query<{ phrase: string }>("select phrase from keywords where enabled=true");
    const matched = phrases.filter(p => itemMatchesPhrase(String(row.title), body, String(row.author), p.phrase)).map(p => p.phrase);
    await mergeExistingItem(tx, opts.itemId, {
      title: String(row.title), body, author: String(row.author), url: String(row.url), media_type: String(row.media_type),
      media_urls: asJson<string[]>(row.media_urls, []), thumbnail_url: String(row.thumbnail_url),
      views: asInt(row.views), likes: asInt(row.likes), published_at: iso(row.published_at), extra: { body_complete: true },
    }, matched);
    // 0019 watches material text fields; a completeness-only confirmation still needs one database revision.
    const [updated] = await tx.query<{ material_version: unknown }>(`update items set pipeline_status='ingested',
      material_version=case when material_version=$3 then material_version+1 else material_version end,
      extra=(extra - 'article_candidate' - 'article_error' - 'article_claim_token' - 'article_claimed_at') || $2::jsonb where id=$1 returning material_version`,
    [opts.itemId, JSON.stringify({ article_state: "adopted", article_previous_body: String(row.body),
      article_previous_complete: extra.body_complete === true }), opts.expectedVersion]);
    const materialVersion = versionOf(updated?.material_version);
    await tx.query("update items set extra=jsonb_set(extra,'{article_adopted_version}',to_jsonb($2::bigint)) where id=$1", [opts.itemId, materialVersion]);
    return { itemId: opts.itemId, materialVersion };
  });
}

export async function restoreArticleWith(opts: { sql: ArticleSql; itemId: string; expectedVersion: number }) {
  storedId(opts.itemId);
  if (!Number.isSafeInteger(opts.expectedVersion) || opts.expectedVersion < 0) throw new Error("article_conflict");
  return opts.sql.transaction(async tx => {
    const row = await itemRow(tx, opts.itemId, true);
    const extra = asJson<Record<string, unknown>>(row.extra, {});
    if (versionOf(row.material_version) !== opts.expectedVersion || extra.article_adopted_version !== opts.expectedVersion) {
      throw new Error("article_conflict");
    }
    if (extra.article_state !== "adopted" || typeof extra.article_previous_body !== "string" || typeof extra.article_previous_complete !== "boolean") {
      throw new Error("article_restore_unavailable");
    }
    const [restored] = await tx.query<{ material_version: unknown }>(`update items set body=$2,pipeline_status='ingested',
      extra=(extra - 'article_candidate' - 'article_error' - 'article_claim_token' - 'article_claimed_at') || $3::jsonb
      where id=$1 returning material_version`, [opts.itemId, extra.article_previous_body,
    JSON.stringify({ article_state: "restored", body_complete: extra.article_previous_complete })]);
    let materialVersion = versionOf(restored?.material_version);
    if (materialVersion === opts.expectedVersion) {
      const [revised] = await tx.query<{ material_version: unknown }>(`update items set material_version=material_version+1
        where id=$1 and material_version=$2 returning material_version`, [opts.itemId, opts.expectedVersion]);
      materialVersion = versionOf(revised?.material_version);
    }
    return { itemId: opts.itemId, materialVersion };
  });
}

export async function previewArticle(itemId: string) {
  storedId(itemId);
  const { getSql } = await import("../db.ts");
  return previewArticleWith({ sql: await getSql(), itemId });
}

export async function adoptArticle(itemId: string, digest: string, expectedVersion: number) {
  storedId(itemId);
  const { getSql } = await import("../db.ts");
  return adoptArticleWith({ sql: await getSql(), itemId, digest, expectedVersion });
}

export async function restoreArticle(itemId: string, expectedVersion: number) {
  storedId(itemId);
  const { getSql } = await import("../db.ts");
  return restoreArticleWith({ sql: await getSql(), itemId, expectedVersion });
}
