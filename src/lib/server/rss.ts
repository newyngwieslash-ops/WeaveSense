import type { FetchIo } from "./http.ts";
import { publicFetch } from "./outbound-policy.ts";
import { parseFeedXml, type FeedParseOptions } from "./rss-parser.ts";
import type { NormalizedItem } from "./collectors/types.ts";

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
  const result = await publicFetch(feedUrl, { ...io, timeoutMs: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/html;q=0.9, */*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    } });
  return parseFeedXml(result.text ?? "", sourceId, platform as import("@/lib/platforms").PlatformId,
    { feedUrl: result.url, stats });
}
