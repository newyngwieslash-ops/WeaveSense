import type { MediaType, PlatformId } from "@/lib/platforms";
import type { FetchIo } from "../http.ts";
import { CollectionHttpError } from "../outbound-policy.ts";

export type SourceRecord = {
  id: string;
  platform: PlatformId;
  name: string;
  handle: string;
  url: string;
  feed_url: string;
  adapter: string;
  feed_etag?: string;
  feed_last_modified?: string;
  feed_validator_identity?: string;
  last_external_id?: string;
  scan_state?: { bootstrap: "latest" | "backfill"; page?: number; boundary?: string };
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
  extra: Record<string, unknown> & {
    telegram_media?: { channel: string; message_id: string; kind: string; size: number | null };
  };
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
 * caller can refuse to advance the high-water mark.
 */
export type CollectorCoverage = {
  /** True when the fetch provably reached the source's previous boundary. */
  complete: boolean;
  /** A bounded window (RSS/网页) can never claim full backfill. */
  window_only?: boolean;
  /** Non-sensitive explanation, e.g. "page_cap" or "no_previous_cursor". */
  note?: string;
};

export type CollectorBatch = {
  items: NormalizedItem[];
  not_modified?: boolean;
  feed_validators?: { etag: string; last_modified: string };
  feed_validator_identity?: string;
  meta: CollectorMeta;
  coverage?: CollectorCoverage;
  next_scan_state?: SourceRecord["scan_state"];
  has_more?: boolean;
  next_cursor?: string;
  /** Entries rejected by feed normalization; never counted as collected items. */
  rejected_entries?: number;
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
  retryAt?: number;
  http_status?: number;
  error_code?: "timeout" | "rate_limited" | "http_error" | "invalid_response" | "network_error";
};

export type KeywordBatch = { items: NormalizedItem[]; attempts: KeywordAttempt[] };

export class CollectorBatchError extends CollectionHttpError {
  readonly meta: CollectorMeta;
  constructor(message: string, meta: CollectorMeta, cause?: unknown) {
    const failure = cause as { code?: string; status?: number; retryAt?: number } | undefined;
    super(failure?.code ?? message, message, { status: failure?.status, retryAt: failure?.retryAt });
    this.name = "CollectorBatchError";
    this.meta = meta;
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
