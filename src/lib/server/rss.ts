import { fetchText, type FetchIo } from "./http.ts";
import { parseFeedXml } from "./rss-parser.ts";
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
): Promise<NormalizedItem[]> {
  const xml = await fetchText(feedUrl, 12000, undefined, {}, io);
  return parseFeedXml(xml, sourceId, platform as import("@/lib/platforms").PlatformId);
}
