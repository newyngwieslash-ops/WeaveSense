import type { MediaType, PlatformId } from "@/lib/platforms";
import type { FetchIo } from "../http.ts";

export type SourceRecord = {
  id: string;
  platform: PlatformId;
  name: string;
  handle: string;
  url: string;
  feed_url: string;
  adapter: string;
  last_external_id?: string;
};

export type NormalizedItem = {
  external_id: string;
  title: string;
  body: string;
  author: string;
  url: string;
  media_type: MediaType;
  media_urls: string[];
  thumbnail_url: string;
  views: number | null;
  likes: number | null;
  published_at: string | null;
  extra: Record<string, unknown>;
};

export type CollectorMeta = {
  provider: "" | "primary" | "dajiala" | "mixed";
  attempts: string[];
  paid_call: boolean;
};

/**
 * T10: how much of a source's history a batch actually covered.
 *
 * A limited-window feed (the newest 20 B 站 videos, one page of results) cannot
 * prove it reached the source's previous boundary. Without this, the cursor
 * advanced to the newest item in the page and everything between the old cursor
 * and the page was skipped silently. A batch that stops early must say so, so the
 * caller can retain a paged-history cursor or track a window discovery watermark.
 */
export type CollectorCoverage = {
  /** True when the fetch provably reached the source's previous boundary. */
  complete: boolean;
  /** A bounded window (RSS/网页) can never claim full backfill. */
  window_only?: boolean;
  /** Non-sensitive explanation, e.g. page_cap or initial_window/window_overlap/window_gap/empty_window. */
  note?: string;
};

export type CollectorBatch = {
  items: NormalizedItem[];
  meta: CollectorMeta;
  /** Required for new adapters; undefined legacy Telethon results mean unknown coverage. */
  coverage?: CollectorCoverage;
};

/**
 * T08: how one keyword-search source went.
 *
 * The previous contract was "an array of items", so a request that failed and a
 * request that legitimately returned nothing were indistinguishable — the
 * scheduler recorded both as a successful zero-hit run. An explicit per-source
 * attempt record is what lets the scheduler/UI say "sources failed" instead of
 * claiming a clean scan.
 *
 * `error_code` is a stable, non-sensitive category; raw provider text (which can
 * carry keys or query strings) is never part of it.
 */
export type KeywordAttemptSource =
  | "google_news_zh"
  | "google_news_en"
  | "hacker_news"
  | "youtube_news"
  | "bilibili_search";

export type KeywordAttempt = {
  source: KeywordAttemptSource;
  status: "ok" | "error";
  count: number;
  error_code?: "timeout" | "rate_limited" | "http_error" | "invalid_response" | "network_error";
};

export type KeywordBatch = { items: NormalizedItem[]; attempts: KeywordAttempt[] };

export class CollectorBatchError extends Error {
  constructor(message: string, readonly meta: CollectorMeta) {
    super(message);
    this.name = "CollectorBatchError";
  }
}

export function collectorMeta(error: unknown): CollectorMeta {
  return error instanceof CollectorBatchError
    ? error.meta : { provider: "", attempts: [], paid_call: false };
}

export type CollectorAdapter = {
  id: string;
  /** `io` is an optional test seam (see `FetchIo`); production omits it. */
  fetch(source: SourceRecord, io?: FetchIo): Promise<CollectorBatch>;
};
