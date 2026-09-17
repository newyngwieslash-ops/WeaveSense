import { isPlatform, type PlatformId } from "./platforms.ts";

export function parseKeywordList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；\n\r]+/)) {
    const phrase = part.trim().replace(/\s+/g, " ");
    if (phrase.length < 2 || phrase.length > 40) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  return out.slice(0, 20);
}

export function itemMatchesPhrase(title: string, body: string, author: string, phrase: string): boolean {
  const hay = `${title}\n${body}\n${author}`.toLowerCase();
  return hay.includes(phrase.toLowerCase());
}

export function guessPlatformFromUrl(url: string, fallback: PlatformId = "rss"): PlatformId {
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("bilibili.com") || u.includes("b23.tv")) return "bilibili";
  if (u.includes("mp.weixin.qq.com") || u.includes("weixin.qq.com")) return "wechat";
  if (u.includes("douyin.com") || u.includes("iesdouyin")) return "douyin";
  if (u.includes("xiaohongshu.com") || u.includes("xhslink.com")) return "xhs";
  if (u.includes("ixigua.com") || u.includes("xigua.com")) return "xigua";
  if (u.includes("t.me/") || u.includes("telegram.org")) return "telegram";
  return fallback;
}

export function parsePlatformList(value: unknown): PlatformId[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(isPlatform);
}

/**
 * The keyword "collection scope" options, as shown in the UI.
 *
 * `mode` is the honest distinction between what a scope can mean:
 *   - `search`: an external query goes out (Google News / HN / B 站接口), and the
 *     label says what is actually queried. YouTube is reachable only through a
 *     Google News `site:youtube.com` index query — NOT a full-site search — so
 *     its label says so instead of implying video search.
 *   - `local`: no external request at all; only already-collected material is
 *     matched. Selecting one of these must not trigger the news queries.
 */
export const KEYWORD_SEARCH_PLATFORMS: { id: PlatformId; label: string; mode: "search" | "local" }[] = [
  { id: "rss", label: "新闻 / RSS", mode: "search" },
  { id: "bilibili", label: "B 站搜索", mode: "search" },
  { id: "youtube", label: "YouTube 新闻索引", mode: "search" },
  { id: "telegram", label: "Telegram 信源", mode: "local" },
  { id: "wechat", label: "公众号信源", mode: "local" },
  { id: "douyin", label: "抖音信源", mode: "local" },
  { id: "xhs", label: "小红书信源", mode: "local" },
  { id: "xigua", label: "西瓜信源", mode: "local" },
];

export const RADAR_SOURCE_ID = "src_kw_radar";
