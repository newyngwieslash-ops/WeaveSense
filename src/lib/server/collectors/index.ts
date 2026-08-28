import type { PlatformId } from "@/lib/platforms";
import { fetchRss } from "../rss";
import { fetchTelegramChannel } from "../telegram";
import { fetchTelethonHistory, telethonReady } from "../telethon";
import { fetchJson } from "../http";
import type { CollectorAdapter, NormalizedItem, SourceRecord } from "./types";

function youtubeFeedUrl(source: SourceRecord): string {
  if (source.feed_url) return source.feed_url;
  const handle = source.handle.trim();
  if (handle.startsWith("http") && handle.includes("feeds/videos.xml")) return handle;
  const idMatch = handle.match(/UCU[A-Za-z0-9_-]{22}|UC[A-Za-z0-9_-]{22}/);
  const fromUrl = source.url.match(/channel\/(UC[A-Za-z0-9_-]{22})/);
  const id = idMatch?.[0] ?? fromUrl?.[1] ?? handle;
  if (id.startsWith("UC")) return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
  return `https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(id)}`;
}

const rssAdapter: CollectorAdapter = {
  id: "rss",
  async fetch(source) {
    const url = source.feed_url || source.handle || source.url;
    if (!url.startsWith("http")) throw new Error("需要有效的 RSS / Atom 地址");
    return fetchRss(url, source.id, source.platform);
  },
};

const telegramAdapter: CollectorAdapter = {
  id: "telegram_web",
  async fetch(source) {
    if (source.feed_url.startsWith("http")) {
      return fetchRss(source.feed_url, source.id, "telegram");
    }
    const handle = source.handle.replace(/^@/, "") || source.url.replace(/https?:\/\/t\.me\/(s\/)?/, "");
    const minId = source.last_external_id ?? "";
    if (await telethonReady()) {
      try {
        return await fetchTelethonHistory(handle, minId, 80);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("FloodWait") || msg.includes("未登录")) throw err;
      }
    }
    return fetchTelegramChannel(handle);
  },
};

const youtubeAdapter: CollectorAdapter = {
  id: "youtube",
  async fetch(source) {
    return fetchRss(youtubeFeedUrl(source), source.id, "youtube");
  },
};

type BiliList = {
  code?: number;
  message?: string;
  data?: {
    list?: {
      vlist?: {
        bvid: string;
        title: string;
        description: string;
        author: string;
        pic: string;
        play: number;
        comment: number;
        created: number;
        mid: number;
      }[];
    };
  };
};

const biliAdapter: CollectorAdapter = {
  id: "bilibili",
  async fetch(source) {
    if (source.feed_url.startsWith("http")) {
      return fetchRss(source.feed_url, source.id, "bilibili");
    }
    const mid = (source.handle || source.url).replace(/\D/g, "");
    if (!mid) throw new Error("需要 B 站 mid");
    const json = await fetchJson<BiliList>(
      `https://api.bilibili.com/x/space/arc/search?mid=${mid}&ps=20&pn=1`,
    );
    if (json.code && json.code !== 0) throw new Error(json.message || `B站 ${json.code}`);
    const list = json.data?.list?.vlist ?? [];
    if (!list.length) throw new Error("B站接口未返回视频（可能被风控）");
    return list.map((v) => ({
      external_id: v.bvid,
      title: v.title,
      body: v.description ?? "",
      author: v.author ?? source.name,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      media_type: "video" as const,
      media_urls: v.pic ? [v.pic.startsWith("http") ? v.pic : `https:${v.pic}`] : [],
      thumbnail_url: v.pic ? (v.pic.startsWith("http") ? v.pic : `https:${v.pic}`) : "",
      views: v.play ?? null,
      likes: null,
      published_at: v.created ? new Date(v.created * 1000).toISOString() : null,
      extra: { bvid: v.bvid, mid: v.mid },
    }));
  },
};

const rsshubAdapter: CollectorAdapter = {
  id: "rsshub",
  async fetch(source) {
    const url = source.feed_url || source.handle;
    if (!url.startsWith("http")) {
      throw new Error("该平台需要 RSSHub / WeWe 订阅地址，或等待浏览器采集节点");
    }
    return fetchRss(url, source.id, source.platform);
  },
};

const ADAPTERS: Record<string, CollectorAdapter> = {
  rss: rssAdapter,
  telegram_web: telegramAdapter,
  youtube: youtubeAdapter,
  bilibili: biliAdapter,
  rsshub: rsshubAdapter,
};

export async function collectSource(source: SourceRecord): Promise<NormalizedItem[]> {
  const adapter = ADAPTERS[source.adapter] ?? rssAdapter;
  try {
    return await adapter.fetch(source);
  } catch (err) {
    if (source.feed_url.startsWith("http") && source.adapter !== "rss") {
      return rssAdapter.fetch({ ...source, adapter: "rss" });
    }
    throw err;
  }
}

export function defaultAdapter(platform: PlatformId): string {
  if (platform === "telegram") return "telegram_web";
  if (platform === "bilibili") return "bilibili";
  if (platform === "youtube") return "youtube";
  if (platform === "douyin" || platform === "xhs" || platform === "xigua") return "rsshub";
  return "rss";
}
