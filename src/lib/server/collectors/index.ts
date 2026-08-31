import type { PlatformId } from "@/lib/platforms";
import { fetchRss } from "../rss";
import { fetchTelegramChannel } from "../telegram";
import { fetchTelethonHistory, telethonReady } from "../telethon";
import { prod, wechatGatewayConfigured } from "../config";
import { fetchJson } from "../http";
import { parseFeedXml } from "../rss-parser";
import { WECHAT_GATEWAY_FEED_TIMEOUT_MS } from "../cron";
import { providerFromItems } from "../wechat-meta.ts";
import { CollectorBatchError, collectorMeta,
  type CollectorAdapter, type CollectorBatch, type CollectorMeta, type NormalizedItem,
  type SourceRecord } from "./types";

const batch = (items: NormalizedItem[], adapter: string): CollectorBatch => ({
  items, meta: { provider: "", attempts: [adapter], paid_call: false },
});

function gatewayMeta(headers: Headers): CollectorMeta {
  const provider = headers.get("x-loom-provider");
  const attempts = (headers.get("x-loom-attempts") ?? "").split(",").filter(Boolean);
  const paid = headers.get("x-loom-paid-call");
  if (!(["", "primary", "dajiala", "mixed"] as Array<string | null>).includes(provider) ||
    !(["primary"].join(",") === attempts.join(",") ||
      ["primary", "dajiala"].join(",") === attempts.join(",")) ||
    (paid !== "true" && paid !== "false")) {
    throw new CollectorBatchError("wechat_gateway_invalid_metadata",
      { provider: "", attempts: ["primary"], paid_call: false });
  }
  return { provider: provider as CollectorMeta["provider"], attempts, paid_call: paid === "true" };
}

function gatewayFeedUrl(sourceId: string): string {
  try {
    const url = new URL(prod.wechatGatewayUrl);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/feeds/${encodeURIComponent(sourceId)}.atom`;
    return url.toString();
  } catch {
    throw new CollectorBatchError("wechat_gateway_unavailable",
      { provider: "", attempts: ["primary"], paid_call: false });
  }
}

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
    return batch(await fetchRss(url, source.id, source.platform), "rss");
  },
};

const wechatGatewayAdapter: CollectorAdapter = {
  id: "wechat_gateway",
  async fetch(source) {
    if (!wechatGatewayConfigured()) throw new Error("微信公众号源网关未配置");
    let response: Response;
    try {
      response = await fetch(gatewayFeedUrl(source.id), {
        headers: { Accept: "application/atom+xml", Authorization: `Bearer ${prod.wechatGatewayToken}` },
        signal: AbortSignal.timeout(WECHAT_GATEWAY_FEED_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch {
      throw new CollectorBatchError("wechat_gateway_unavailable",
        { provider: "", attempts: ["primary"], paid_call: false });
    }
    const meta = gatewayMeta(response.headers);
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* fixed error below */ }
      throw new CollectorBatchError(`wechat_gateway_http_${response.status}`, meta);
    }
    if (!meta.provider) throw new CollectorBatchError("wechat_gateway_invalid_metadata", meta);
    let items: NormalizedItem[];
    try {
      items = parseFeedXml(await response.text(), source.id, "wechat");
    } catch {
      throw new CollectorBatchError("wechat_gateway_invalid_feed", meta);
    }
    return { items, meta: { ...meta, provider: meta.provider || providerFromItems(items) } };
  },
};

const telegramAdapter: CollectorAdapter = {
  id: "telegram_web",
  async fetch(source) {
    if (source.feed_url.startsWith("http")) {
      return batch(await fetchRss(source.feed_url, source.id, "telegram"), "telegram_web");
    }
    const handle = source.handle.replace(/^@/, "") || source.url.replace(/https?:\/\/t\.me\/(s\/)?/, "");
    const minId = source.last_external_id ?? "";
    if (await telethonReady()) {
      try {
        return batch(await fetchTelethonHistory(handle, minId, 80), "telegram_web");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("FloodWait") || msg.includes("未登录")) throw err;
      }
    }
    return batch(await fetchTelegramChannel(handle), "telegram_web");
  },
};

const youtubeAdapter: CollectorAdapter = {
  id: "youtube",
  async fetch(source) {
    return batch(await fetchRss(youtubeFeedUrl(source), source.id, "youtube"), "youtube");
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
      return batch(await fetchRss(source.feed_url, source.id, "bilibili"), "bilibili");
    }
    const mid = (source.handle || source.url).replace(/\D/g, "");
    if (!mid) throw new Error("需要 B 站 mid");
    const json = await fetchJson<BiliList>(
      `https://api.bilibili.com/x/space/arc/search?mid=${mid}&ps=20&pn=1`,
    );
    if (json.code && json.code !== 0) throw new Error(json.message || `B站 ${json.code}`);
    const list = json.data?.list?.vlist ?? [];
    if (!list.length) throw new Error("B站接口未返回视频（可能被风控）");
    return batch(list.map((v) => ({
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
    })), "bilibili");
  },
};

const rsshubAdapter: CollectorAdapter = {
  id: "rsshub",
  async fetch(source) {
    const url = source.feed_url || source.handle;
    if (!url.startsWith("http")) {
      throw new Error("该平台需要 RSSHub / WeWe 订阅地址，或等待浏览器采集节点");
    }
    return batch(await fetchRss(url, source.id, source.platform), "rsshub");
  },
};

const ADAPTERS: Record<string, CollectorAdapter> = {
  rss: rssAdapter,
  wechat_gateway: wechatGatewayAdapter,
  telegram_web: telegramAdapter,
  youtube: youtubeAdapter,
  bilibili: biliAdapter,
  rsshub: rsshubAdapter,
};

export async function collectSource(source: SourceRecord): Promise<CollectorBatch> {
  const adapter = ADAPTERS[source.adapter] ?? rssAdapter;
  try {
    return await adapter.fetch(source);
  } catch (err) {
    const failed = collectorMeta(err);
    const attempted = failed.attempts.length ? failed.attempts : [adapter.id];
    if (source.feed_url.startsWith("http") && adapter.id !== "rss") {
      const attempts = [...new Set([...attempted, "rss"])];
      try {
        const fallback = await rssAdapter.fetch({ ...source, adapter: "rss" });
        return { ...fallback, meta: { ...fallback.meta,
          attempts,
          paid_call: failed.paid_call || fallback.meta.paid_call } };
      } catch {
        throw new CollectorBatchError("collector_fallback_failed", {
          provider: failed.provider, attempts, paid_call: failed.paid_call,
        });
      }
    }
    throw err instanceof CollectorBatchError ? err
      : new CollectorBatchError(err instanceof Error ? err.message : "collector_failed", {
        provider: failed.provider, attempts: attempted, paid_call: failed.paid_call,
      });
  }
}

export function defaultAdapter(platform: PlatformId): string {
  if (platform === "wechat") return "wechat_gateway";
  if (platform === "telegram") return "telegram_web";
  if (platform === "bilibili") return "bilibili";
  if (platform === "youtube") return "youtube";
  if (platform === "douyin" || platform === "xhs" || platform === "xigua") return "rsshub";
  return "rss";
}
