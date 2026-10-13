import type { PlatformId } from "@/lib/platforms";
import { fetchRss } from "../rss";
import { fetchTelegramChannel } from "../telegram";
import { fetchTelethonHistory, parseTelegramHandle, telethonHealth } from "../telethon";
import { prod, wechatGatewayConfigured } from "../config";
import { fetchJson, type FetchIo } from "../http";
import { parseFeedXml } from "../rss-parser";
import { WECHAT_GATEWAY_FEED_TIMEOUT_MS } from "../cron";
import { providerFromItems } from "../wechat-meta.ts";
import { CollectorBatchError, collectorMeta,
  type CollectorAdapter, type CollectorBatch, type CollectorMeta, type NormalizedItem,
  type SourceRecord } from "./types";

const batch = (items: NormalizedItem[], adapter: string): CollectorBatch => ({
  items, meta: { provider: "", attempts: [adapter], paid_call: false },
});

function windowCoverage(items: NormalizedItem[], previous = "") {
  const note = !items.length ? "empty_window" : !previous ? "initial_window"
    : items.some((item) => item.external_id === previous) ? "window_overlap" : "window_gap";
  return { complete: false, window_only: true, note };
}

// Gateway feed ceiling: generous for a WeChat Atom feed (bodies included), but
// far below "unbounded". Kept next to the caller it guards.
const WECHAT_GATEWAY_FEED_MAX_CHARS = 8 * 1024 * 1024;

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
  async fetch(source, io = {}) {
    const url = source.feed_url || source.handle || source.url;
    if (!url.startsWith("http")) throw new Error("需要有效的 RSS / Atom 地址");
    const result = batch(await fetchRss(url, source.id, source.platform, io), "rss");
    return { ...result, coverage: windowCoverage(result.items, source.last_external_id) };
  },
};

const wechatGatewayAdapter: CollectorAdapter = {
  id: "wechat_gateway",
  async fetch(source) {
    if (!wechatGatewayConfigured()) throw new Error("微信公众号源网关未配置");
    // The WeChat gateway is an operator-configured INTERNAL service (compose
    // network / loopback), so it deliberately does NOT go through the public
    // outbound policy. Its redirect behaviour is tightened instead: the request
    // carries a bearer token, so following a redirect would hand that token to
    // whatever host the redirect names.
    let response: Response;
    try {
      response = await fetch(gatewayFeedUrl(source.id), {
        headers: { Accept: "application/atom+xml", Authorization: `Bearer ${prod.wechatGatewayToken}` },
        signal: AbortSignal.timeout(WECHAT_GATEWAY_FEED_TIMEOUT_MS),
        redirect: "error",
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
      // A gateway feed is text; an explicit ceiling keeps a wedged gateway from
      // streaming an unbounded body into memory before the parse.
      const text = await response.text();
      if (text.length > WECHAT_GATEWAY_FEED_MAX_CHARS) throw new Error("wechat_gateway_feed_too_large");
      items = parseFeedXml(text, source.id, "wechat");
    } catch {
      throw new CollectorBatchError("wechat_gateway_invalid_feed", meta);
    }
    return { items, meta: { ...meta, provider: meta.provider || providerFromItems(items) },
      coverage: windowCoverage(items, source.last_external_id) };
  },
};

const telegramAdapter: CollectorAdapter = {
  id: "telegram_web",
  async fetch(source, io = {}) {
    if (source.feed_url.startsWith("http")) {
      const result = batch(await fetchRss(source.feed_url, source.id, "telegram", io), "rss");
      return { ...result, coverage: windowCoverage(result.items, source.last_external_id) };
    }
    const handle = parseTelegramHandle(source.handle) || parseTelegramHandle(source.url);
    if (!handle) throw new Error("请填写频道用户名，或 t.me/用户名 链接");
    const minId = source.last_external_id ?? "";
    const health = await telethonHealth();
    if (health.authorized) {
      if (health.paused_until && health.paused_until > 0) {
        throw new CollectorBatchError(`Telethon FloodWait ${health.paused_until}s`, {
          provider: "", attempts: ["telethon"], paid_call: false,
        });
      }
      try {
        return batch(await fetchTelethonHistory(handle, minId, 80), "telethon");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CollectorBatchError(msg, {
          provider: "", attempts: ["telethon"], paid_call: false,
        });
      }
    }
    try {
      const result = batch(await fetchTelegramChannel(handle, io), "t.me/s");
      return { ...result, coverage: windowCoverage(result.items, source.last_external_id) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CollectorBatchError(msg, {
        provider: "", attempts: ["t.me/s"], paid_call: false,
      });
    }
  },
};

const youtubeAdapter: CollectorAdapter = {
  id: "youtube",
  async fetch(source, io = {}) {
    const result = batch(await fetchRss(youtubeFeedUrl(source), source.id, "youtube", io), "youtube");
    return { ...result, coverage: windowCoverage(result.items, source.last_external_id) };
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

// B站 page size and the ceiling on how many pages one scan may read. The cap
// exists so a high-volume channel cannot make a scan unbounded; when it is hit
// the batch reports `complete: false` and the cursor must not advance.
const BILI_PAGE_SIZE = 20;
const BILI_MAX_PAGES = 5;

/**
 * Bilibili business codes that mean "you are going too fast, back off".
 *
 * The API answers HTTP 200 with these as JSON — so a status check alone sees
 * success, and the previous code treated the body as a generic failure. That made
 * a throttled scan indistinguishable from a broken one: the scheduler would
 * re-try at the same cadence and stay throttled. Naming it lets the operator see
 * "throttled" and lets the retry logic back off instead of hammering.
 *
 * `-799` was observed live on 2026-09-17 ("请求过于频繁，请稍后再试"); `-412` is the
 * long-standing "请求被拦截" code the corpus already documents.
 */
const BILI_RATE_LIMIT_CODES = new Set([-799, -412, -509]);

function biliError(code: number, message: string): Error {
  if (BILI_RATE_LIMIT_CODES.has(code)) {
    const error = new Error(`B站接口限流 rate_limited (${code})`);
    (error as Error & { code?: string }).code = "rate_limited";
    return error;
  }
  return new Error(message || `B站 ${code}`);
}

const biliAdapter: CollectorAdapter = {
  id: "bilibili",
  async fetch(source, io = {}) {
    if (source.feed_url.startsWith("http")) {
      const result = batch(await fetchRss(source.feed_url, source.id, "bilibili", io), "bilibili");
      return { ...result, coverage: windowCoverage(result.items, source.last_external_id) };
    }
    const mid = (source.handle || source.url).replace(/\D/g, "");
    if (!mid) throw new Error("需要 B 站 mid");

    // Walk pages until a known item is reached (or the page cap). Previously only
    // page 1 was read; the cursor then advanced to the newest item in it, so any
    // videos published between the stored cursor and this page were never seen.
    const seenIds = new Set<string>();
    type BiliRow = NonNullable<NonNullable<NonNullable<BiliList["data"]>["list"]>["vlist"]>[number];
    const rows: BiliRow[] = [];
    const previous = source.last_external_id ?? "";
    let complete = false;
    let note = "";

    for (let page = 1; page <= BILI_MAX_PAGES; page += 1) {
      const json = await fetchJson<BiliList>(
        `https://api.bilibili.com/x/space/arc/search?mid=${mid}&ps=${BILI_PAGE_SIZE}&pn=${page}`,
        10000,
        io,
      );
      if (json.code && json.code !== 0) throw biliError(json.code, json.message ?? "");
      const list = json.data?.list?.vlist ?? [];
      if (!list.length) {
        // Ran out of items: the boundary is reached (or the channel is empty).
        complete = true;
        break;
      }
      for (const video of list) {
        if (!video.bvid || seenIds.has(video.bvid)) continue;
        seenIds.add(video.bvid);
        rows.push(video);
        // Reaching the previously known newest video proves there is no gap.
        if (previous && video.bvid === previous) complete = true;
      }
      if (complete) break;
      if (list.length < BILI_PAGE_SIZE) {
        // A short page means the channel ends here.
        complete = true;
        break;
      }
    }
    if (!complete) note = "page_cap";
    if (!rows.length) throw new Error("B站接口未返回视频（可能被风控）");
    const result = batch(rows.map((v) => ({
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
    return { ...result, coverage: { complete, note } };
  },
};

const rsshubAdapter: CollectorAdapter = {
  id: "rsshub",
  async fetch(source, io = {}) {
    const url = source.feed_url || source.handle;
    if (!url.startsWith("http")) {
      throw new Error("该平台需要 RSSHub / WeWe 订阅地址，或等待浏览器采集节点");
    }
    const result = batch(await fetchRss(url, source.id, source.platform, io), "rsshub");
    return { ...result, coverage: windowCoverage(result.items, source.last_external_id) };
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

/**
 * Collect one source.
 *
 * `io` is a test seam only: production callers omit it and use the real
 * resolver/transport under the outbound policy. Only public-fetch adapters
 * consume it — the WeChat gateway keeps its own internal transport.
 */
export async function collectSource(source: SourceRecord, io: FetchIo = {}): Promise<CollectorBatch> {
  const adapter = ADAPTERS[source.adapter] ?? rssAdapter;
  try {
    return await adapter.fetch(source, io);
  } catch (err) {
    const failed = collectorMeta(err);
    const attempted = failed.attempts.length ? failed.attempts : [adapter.id];
    if (source.feed_url.startsWith("http") && adapter.id !== "rss" && adapter.id !== "wechat_gateway") {
      const attempts = [...new Set([...attempted, "rss"])];
      try {
        const fallback = await rssAdapter.fetch({ ...source, adapter: "rss" }, io);
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
