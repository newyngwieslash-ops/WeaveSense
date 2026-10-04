import type { FetchIo } from "./http.ts";
import { createHash } from 'node:crypto';
import { CollectionHttpError, publicFetch } from "./outbound-policy.ts";
import { parseFeedXml, RSS_PARSER_VERSION, type FeedParseOptions } from "./rss-parser.ts";
import type { CollectorBatch, NormalizedItem, SourceRecord } from "./collectors/types.ts";

export { parseFeedXml } from "./rss-parser.ts";

/**
 * Fetch and parse a public RSS/Atom feed.
 *
 * `io` is a test seam only (see `FetchIo`); production callers omit it and get
 * the real resolver/transport under the outbound policy.
 */
export async function fetchRss(
  feedUrl: string,
  sourceId: string,
  platform: string,
  io: FetchIo = {},
  stats?: FeedParseOptions["stats"],
): Promise<NormalizedItem[]> {
  const result = await fetchRssBatch(feedUrl, { id: sourceId, platform: platform as SourceRecord['platform'] }, io);
  if (stats) stats.rejected_entries = result.rejected_entries ?? 0;
  return result.items;
}

export function feedValidatorIdentity(feedUrl: string, platform: string): string {
  return createHash('sha256').update(JSON.stringify([feedUrl, platform, RSS_PARSER_VERSION])).digest('hex');
}

/** Source-only conditional fetch; array callers remain unconditional. `parse` is an offline test seam. */
export async function fetchRssBatch(feedUrl: string,
  source: Pick<SourceRecord, 'id' | 'platform' | 'feed_etag' | 'feed_last_modified' | 'feed_validator_identity'>,
  io: FetchIo = {}, parse: typeof parseFeedXml = parseFeedXml,
): Promise<Pick<CollectorBatch, 'items' | 'not_modified' | 'feed_validators' | 'feed_validator_identity' | 'rejected_entries'>> {
  const identity = feedValidatorIdentity(feedUrl, source.platform);
  const reusable = source.feed_validator_identity === identity;
  const etag = reusable ? source.feed_etag ?? '' : '';
  const lastModified = reusable ? source.feed_last_modified ?? '' : '';
  const result = await publicFetch(feedUrl, { ...io, timeoutMs: 12000,
    allowNotModified: true,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/html;q=0.9, */*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(etag ? { 'If-None-Match': etag } : {}),
      ...(lastModified ? { 'If-Modified-Since': lastModified } : {}),
    } });
  if (result.status === 304 && !etag && !lastModified) throw new CollectionHttpError('invalid_response');
  const stats = { rejected_entries: 0 };
  return { items: result.status === 304 ? [] : parse(result.text ?? '', source.id, source.platform, { feedUrl: result.url, stats }),
    not_modified: result.status === 304, ...stats, feed_validator_identity: identity,
    feed_validators: { etag: result.headers.etag ?? (result.status === 304 ? etag : ''),
      last_modified: result.headers['last-modified'] ?? (result.status === 304 ? lastModified : '') } };
}
