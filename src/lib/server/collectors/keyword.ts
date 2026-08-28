import { stripHtml } from "@/lib/format";
import { guessPlatformFromUrl } from "@/lib/keyword";
import type { PlatformId } from "@/lib/platforms";
import { fetchJson } from "../http";
import { fetchRss } from "../rss";
import type { NormalizedItem } from "./types";

function wants(platforms: PlatformId[], id: PlatformId): boolean {
  return platforms.length === 0 || platforms.includes(id);
}

async function safeRss(url: string, sourceId: string, platform: string): Promise<NormalizedItem[]> {
  try {
    return await fetchRss(url, sourceId, platform);
  } catch {
    return [];
  }
}

function stamp(items: NormalizedItem[], origin: string, fallback: PlatformId): NormalizedItem[] {
  return items.map((it) => {
    const platform = guessPlatformFromUrl(it.url, fallback);
    return {
      ...it,
      extra: { ...it.extra, origin, keyword_origin: origin, guessed_platform: platform },
    };
  });
}

type BiliSearch = {
  code?: number;
  message?: string;
  data?: {
    result?: {
      bvid?: string;
      aid?: number;
      title?: string;
      description?: string;
      author?: string;
      pic?: string;
      play?: number;
      favorites?: number;
      pubdate?: number;
      typename?: string;
    }[];
  };
};

async function biliSearch(phrase: string): Promise<NormalizedItem[]> {
  try {
    const json = await fetchJson<BiliSearch>(
      `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(phrase)}&page=1&pagesize=12`,
      10000,
    );
    if (json.code && json.code !== 0) return [];
    const list = json.data?.result ?? [];
    return list
      .filter((v) => v.bvid)
      .slice(0, 12)
      .map((v) => {
        const pic = v.pic ? (v.pic.startsWith("http") ? v.pic : `https:${v.pic}`) : "";
        return {
          external_id: String(v.bvid),
          title: stripHtml(v.title ?? ""),
          body: stripHtml(v.description ?? ""),
          author: v.author ?? "",
          url: `https://www.bilibili.com/video/${v.bvid}`,
          media_type: "video" as const,
          media_urls: pic ? [pic] : [],
          thumbnail_url: pic,
          views: typeof v.play === "number" ? v.play : null,
          likes: typeof v.favorites === "number" ? v.favorites : null,
          published_at: v.pubdate ? new Date(v.pubdate * 1000).toISOString() : null,
          extra: { origin: "bilibili_search", bvid: v.bvid ?? "", typename: v.typename ?? "" },
        };
      });
  } catch {
    return [];
  }
}

export async function collectKeyword(phrase: string, platforms: PlatformId[]): Promise<NormalizedItem[]> {
  const q = encodeURIComponent(phrase);
  const tasks: Promise<NormalizedItem[]>[] = [];

  if (wants(platforms, "rss") || wants(platforms, "wechat")) {
    tasks.push(
      safeRss(
        `https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=US&ceid=US:zh-Hans`,
        "kw",
        "rss",
      ).then((items) => stamp(items, "google_news_zh", "rss")),
    );
    tasks.push(
      safeRss(
        `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
        "kw",
        "rss",
      ).then((items) => stamp(items, "google_news_en", "rss")),
    );
    tasks.push(
      safeRss(`https://hnrss.org/newest?q=${q}&count=12`, "kw", "rss").then((items) =>
        stamp(items, "hacker_news", "rss"),
      ),
    );
  }
  if (wants(platforms, "youtube")) {
    tasks.push(
      safeRss(
        `https://news.google.com/rss/search?q=${q}+site:youtube.com&hl=en-US&gl=US&ceid=US:en`,
        "kw",
        "youtube",
      ).then((items) => stamp(items, "youtube_news", "youtube")),
    );
  }
  if (wants(platforms, "bilibili")) {
    tasks.push(biliSearch(phrase));
  }

  const settled = await Promise.allSettled(tasks);
  const merged: NormalizedItem[] = [];
  const seen = new Set<string>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) {
      const key = (item.url || item.external_id).slice(0, 320);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged.slice(0, 40);
}
