import { fetchText } from "./http";
import { parseFeedXml } from "./rss-parser";
import type { NormalizedItem } from "./collectors/types";

export { parseFeedXml } from "./rss-parser";

export async function fetchRss(
  feedUrl: string,
  sourceId: string,
  platform: string,
): Promise<NormalizedItem[]> {
  const xml = await fetchText(feedUrl, 12000);
  return parseFeedXml(xml, sourceId, platform as import("@/lib/platforms").PlatformId);
}
