import { stripHtml } from "@/lib/format";
import { guessPlatformFromUrl } from "@/lib/keyword";
import type { PlatformId } from "@/lib/platforms";
import { fetchJson, type FetchIo } from "../http";
import { fetchRss } from "../rss";
import type { KeywordAttempt, KeywordAttemptSource, KeywordBatch, NormalizedItem } from "./types";

function wants(platforms: PlatformId[], id: PlatformId): boolean {
  return platforms.length === 0 || platforms.includes(id);
}

export function mergeKeywordResults(groups: NormalizedItem[][], limit = 40): NormalizedItem[] {
  const result: NormalizedItem[] = [];
  const seen = new Set<string>();
  const positions = groups.map(() => 0);
  const cap = Number.isSafeInteger(limit) ? Math.max(0, Math.min(40, limit)) : 40;
  while (result.length < cap) {
    let added = false;
    for (let g = 0; g < groups.length && result.length < cap; g++) {
      while (positions[g] < groups[g].length) {
        const item = groups[g][positions[g]++];
        const key = item.url || item.external_id;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return result;
}

/**
 * Classify a failure into a stable, non-sensitive code.
 *
 * The public-fetch layer throws `response_too_large` (a size guard), `HTTP <n>`
 * (a status), a DNS/address refusal, or an abort. Anything that is not
 * recognized is a network-level problem as far as the caller can tell — and the
 * raw message is discarded rather than stored, since it can embed the query.
 */
export function classifyFailure(error: unknown): NonNullable<KeywordAttempt["error_code"]> {
  const message = error instanceof Error ? error.message : String(error);
  // A provider can signal throttling with a business code inside an HTTP 200
  // body (Bilibili does: -799/-412), so the message text and an explicit `code`
  // are both honoured before falling back to generic categories.
  const explicit = (error as { code?: unknown } | null)?.code;
  if (explicit === "rate_limited" || /rate_limited|限流/.test(message)) return "rate_limited";
  if (/^HTTP 429/.test(message)) return "rate_limited";
  if (/^HTTP /.test(message)) return "http_error";
  if (/timeout|aborted|ETIMEDOUT|TimeoutError/i.test(message)) return "timeout";
  // A body that arrived but could not be parsed, or was refused for size.
  if (["response_too_large", "invalid_feed_xml", "invalid_feed_root", "feed_entry_limit"].includes(message)
    || /JSON|Unexpected token|invalid json/i.test(message)) {
    return "invalid_response";
  }
  return "network_error";
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

/**
 * Run one source and report what happened.
 *
 * `source` is the attempt id; the RSS-based feeds share a code path but keep
 * their own identity so the UI can distinguish "Google News failed" from
 * "Hacker News failed".
 */
async function attempt(
  source: KeywordAttemptSource,
  run: () => Promise<NormalizedItem[]>,
): Promise<{ items: NormalizedItem[]; attempt: KeywordAttempt }> {
  try {
    const items = await run();
    return { items, attempt: { source, status: "ok", count: items.length } };
  } catch (error) {
    return {
      items: [],
      attempt: { source, status: "error", count: 0, error_code: classifyFailure(error) },
    };
  }
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

async function biliSearch(phrase: string, io: FetchIo): Promise<NormalizedItem[]> {
  const json = await fetchJson<BiliSearch>(
    `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(phrase)}&page=1&pagesize=12`,
    10000,
    io,
  );
  if (json.code && json.code !== 0) {
    // A provider-level rejection is a failure, not an empty result. Throttling
    // gets a stable code so the keyword contract reports `rate_limited` rather
    // than an unhelpful "B站接口错误" (the same API answers HTTP 200 for it).
    if ([-799, -412, -509].includes(json.code)) {
      const error = new Error("B站接口限流 rate_limited") as Error & { code?: string };
      error.code = "rate_limited";
      throw error;
    }
    throw new Error(json.message ? `B站接口错误 ${json.code}` : "B站接口错误");
  }
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
}

/**
 * Keyword search across the configured platforms.
 *
 * Returns the merged items **and** a per-source attempt record. A source that
 * was not selected produces no attempt at all (nothing was contacted), and a
 * local-only scope makes no external request — the caller can therefore report
 * "no external sources ran" rather than "all sources found nothing".
 *
 * The platform labels match what is actually queried: YouTube is a Google News
 * `site:youtube.com` index query, not a full-site search, and Hacker News is
 * searched through hnrss.
 */
export async function collectKeyword(
  phrase: string,
  platforms: PlatformId[],
  io: FetchIo = {},
): Promise<KeywordBatch> {
  const q = encodeURIComponent(phrase);
  const tasks: Promise<{ items: NormalizedItem[]; attempt: KeywordAttempt }>[] = [];

  // Only the "search" platforms trigger an external query. Selecting a local
  // platform (公众号信源 / Telegram 信源 / …) previously ALSO ran the Google News
  // queries — so a keyword scoped to "local corpus only" silently made external
  // requests, and its results were labelled as if they came from the news feeds.
  // Local platforms are now handled by the corpus tagging pass alone.
  if (wants(platforms, "rss")) {
    tasks.push(attempt("google_news_zh", () =>
      fetchRss(`https://news.google.com/rss/search?q=${q}&hl=zh-CN&gl=US&ceid=US:zh-Hans`, "kw", "rss", io)
        .then((items) => stamp(items, "google_news_zh", "rss"))));
    tasks.push(attempt("google_news_en", () =>
      fetchRss(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, "kw", "rss", io)
        .then((items) => stamp(items, "google_news_en", "rss"))));
    tasks.push(attempt("hacker_news", () =>
      fetchRss(`https://hnrss.org/newest?q=${q}&count=12`, "kw", "rss", io)
        .then((items) => stamp(items, "hacker_news", "rss"))));
  }
  if (wants(platforms, "youtube")) {
    tasks.push(attempt("youtube_news", () =>
      fetchRss(
        `https://news.google.com/rss/search?q=${q}+site:youtube.com&hl=en-US&gl=US&ceid=US:en`,
        "kw",
        "youtube",
        io,
      ).then((items) => stamp(items, "youtube_news", "youtube"))));
  }
  if (wants(platforms, "bilibili")) {
    tasks.push(attempt("bilibili_search", () => biliSearch(phrase, io)));
  }

  const settled = await Promise.all(tasks);
  return {
    items: mergeKeywordResults(settled.map(({ items }) => items)),
    attempts: settled.map(({ attempt }) => attempt),
  };
}
