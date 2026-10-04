import { z } from "zod";
import { PLATFORMS, PLATFORM_IDS } from "../platforms.ts";
import { parseTelegramHandle } from "../telegram-handle.ts";
import { wechatSourceId } from "../wechat-canonical.ts";
import { initialScanState } from "./cursor.ts";
import type { SourceRecord } from "./collectors/types.ts";

const sourceInput = z.object({
  platform: z.enum(PLATFORM_IDS), name: z.string().trim().min(1).max(80),
  handle: z.string().trim().max(400).default(""), url: z.string().trim().max(2048).default(""),
  feed_url: z.string().trim().max(2048).default(""),
  interval_minutes: z.number().int().positive().max(1440), scan_state: z.unknown().optional(),
});

function publicUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

/** Validate creation only; legacy database records remain readable without revalidation. */
export function validateSourceInput(input: unknown):
  { ok: true; value: SourceRecord & { interval_minutes: number } } | { ok: false; code: string } {
  const fail = (code: string) => ({ ok: false as const, code });
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_source_input");
  const raw = input as Record<string, unknown>;
  const platform = z.enum(PLATFORM_IDS).safeParse(raw.platform);
  if (!platform.success) return fail("unsupported_platform");
  const adapter = PLATFORMS[platform.data].adapter;
  if (raw.adapter !== undefined && raw.adapter !== adapter) return fail("unsupported_adapter");
  if (["xhs", "douyin", "xigua"].includes(platform.data) &&
    (typeof raw.feed_url !== "string" || !raw.feed_url.trim())) return fail("feed_required");
  const parsed = sourceInput.safeParse(input);
  if (!parsed.success) return fail("invalid_source_input");
  const data = parsed.data;
  let { handle, url, feed_url } = data;
  if (feed_url && !publicUrl(feed_url)) return fail("invalid_feed_url");
  if (url && !publicUrl(url)) return fail("invalid_source_url");
  if (data.platform === "rss") {
    feed_url ||= handle || url;
    if (!feed_url) return fail("feed_required");
    if (!publicUrl(feed_url)) return fail("invalid_feed_url");
  }
  if (data.platform === "youtube" && !feed_url) {
    const candidate = handle || url;
    if (/^UC[A-Za-z0-9_-]{22}$/.test(candidate)) handle = candidate;
    else if (publicUrl(candidate)) {
      const channel = new URL(candidate);
      if (!["youtube.com", "www.youtube.com"].includes(channel.hostname)) return fail("invalid_youtube_id");
      if (channel.pathname === "/feeds/videos.xml") feed_url = candidate;
      else handle = channel.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})\/?$/)?.[1] ?? "";
    } else return fail("invalid_youtube_id");
    if (!feed_url && !/^UC[A-Za-z0-9_-]{22}$/.test(handle)) return fail("invalid_youtube_id");
  }
  if (data.platform === "bilibili" && !feed_url) {
    const candidate = handle || url;
    if (/^\d+$/.test(candidate)) handle = candidate;
    else if (publicUrl(candidate)) {
      const channel = new URL(candidate);
      handle = channel.hostname === "space.bilibili.com" ? channel.pathname.match(/^\/(\d+)\/?$/)?.[1] ?? "" : "";
    } else handle = "";
    if (!handle) return fail("invalid_bilibili_mid");
  }
  if (data.platform === "telegram") {
    const candidate = handle || url;
    if (!/^(?:@?[A-Za-z0-9_]{5,32}|(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:s\/)?[A-Za-z0-9_]{5,32}(?:\/\d+)?\/?(?:[?#].*)?)$/i.test(candidate)) return fail("invalid_telegram_handle");
    handle = parseTelegramHandle(candidate);
    if (!handle) return fail("invalid_telegram_handle");
    url = `https://t.me/s/${handle}`;
  }
  if (data.platform === "wechat") {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(handle)) return fail("invalid_wechat_id");
    if (feed_url) return fail("wechat_feed_requires_gateway_import");
  }
  if (feed_url) feed_url = new URL(feed_url).href;
  let scan_state: SourceRecord["scan_state"];
  try { scan_state = initialScanState(data.scan_state); } catch { return fail("invalid_scan_state"); }
  if (scan_state.bootstrap === "backfill" && data.platform !== "telegram") return fail("backfill_requires_telegram");
  if (scan_state.bootstrap === "backfill" && feed_url) return fail("telegram_backfill_requires_authorized_worker");
  return { ok: true, value: { id: data.platform === "wechat" ? wechatSourceId(handle) : crypto.randomUUID(),
    platform: data.platform, name: data.name, handle, url, feed_url, adapter,
    interval_minutes: data.interval_minutes, scan_state } };
}
