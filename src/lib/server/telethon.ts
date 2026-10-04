import { telegramMessageId, maxNumericId, compareNumericIds } from "./cursor.ts";
import type { SourceRecord } from "./collectors/types";
import { prod, telethonConfigured } from "./config";
import type { NormalizedItem } from "./collectors/types";
import { parseTelegramHandle, parseTelegramHandles } from "../telegram-handle";
import { z } from "zod";
import { collectionFetch, abortable, CollectionHttpError, collectionHttpError, parseRetryAfter, readCapped, TEXT_MAX_BYTES, MEDIA_MAX_BYTES } from "./outbound-policy.ts";

export { parseTelegramHandle, parseTelegramHandles };

export type TelethonHealth = {
  ok: boolean;
  authorized: boolean;
  state: "unconfigured" | "unauthorized" | "connecting" | "ready" | "cooldown" | "unavailable";
  retry_after_seconds: number;
  status?: number;
  me?: string;
  minio?: boolean;
  media_available?: boolean;
  media_error?: string;
  paused_until?: number;
  error?: string;
};

const healthSchema = z.object({
  ok: z.boolean(), authorized: z.boolean(), me: z.string().optional(), minio: z.boolean().optional(),
  state: z.enum(["unconfigured", "unauthorized", "connecting", "ready", "cooldown", "unavailable"]).optional(),
  retry_after_seconds: z.number().finite().nonnegative().optional(),
  paused_until: z.number().finite().nonnegative().optional(), error: z.string().nullable().optional(),
  media_available: z.boolean().optional(), media_error: z.string().nullable().optional(),
});
const telegramMediaSchema = z.object({
  channel: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).transform(v => v.toLowerCase()),
  message_id: z.string().regex(/^[1-9][0-9]{0,319}$/),
  kind: z.enum(["image", "audio", "video", "file"]), size: z.number().int().nonnegative().nullable(),
});
const historySchema = z.object({
  items: z.array(z.object({
    external_id: z.string().min(1), title: z.string(), body: z.string(), author: z.string(), url: z.string(),
    media_type: z.enum(["article", "text", "image", "video", "audio", "file", "link"]), media_urls: z.array(z.string()),
    thumbnail_url: z.string(), views: z.number().finite().nullable(), likes: z.number().finite().nullable(),
    published_at: z.string().nullable(), extra: z.record(z.string(), z.unknown()),
  })),
  has_more: z.boolean().optional(), last_id: z.string().max(320).regex(/^\d+$/).optional(), flood_wait: z.number().finite().nonnegative().optional(), error: z.string().optional(),
});

let healthCache: { at: number; value: TelethonHealth } | null = null;

export async function telethonHealth(signal?: AbortSignal): Promise<TelethonHealth> {
  if (signal?.aborted) throw collectionHttpError(null, signal);
  if (!telethonConfigured()) return { ok: false, authorized: false, state: "unconfigured", retry_after_seconds: 0, error: "未配置 TELEGRAM_WORKER_URL" };
  if (healthCache && Date.now() - healthCache.at < 15_000) return healthCache.value;
  const deadline = AbortSignal.timeout(2500);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const res = await abortable(collectionFetch(`${prod.telegramWorkerUrl}/health`, { signal: combined, redirect: "error" }), combined);
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      const value: TelethonHealth = { ok: false, authorized: false, state: "unavailable", status: res.status,
        retry_after_seconds: Math.max(0, Math.ceil(((parseRetryAfter(res.headers.get("retry-after"), Date.now()) ?? Date.now()) - Date.now()) / 1000)),
        error: `worker HTTP ${res.status}` };
      healthCache = { at: Date.now(), value };
      return value;
    }
    const text = new TextDecoder().decode(await readCapped(res.body, TEXT_MAX_BYTES, combined));
    let body: z.infer<typeof healthSchema>;
    try { body = healthSchema.parse(JSON.parse(text)); }
    catch { throw new CollectionHttpError("invalid_response"); }
    const state = body.state ?? (!body.ok ? "unavailable" : !body.authorized ? "unauthorized" : body.paused_until ? "cooldown" : "ready");
    if ((["ready", "cooldown"].includes(state) && (!body.ok || !body.authorized)) ||
        (["unconfigured", "unauthorized"].includes(state) && body.authorized)) throw new CollectionHttpError("invalid_response");
    const value: TelethonHealth = {
      ok: body.ok,
      state,
      retry_after_seconds: body.retry_after_seconds ?? body.paused_until ?? 0,
      authorized: body.authorized,
      me: body.me,
      minio: body.minio,
      media_available: body.media_available,
      media_error: body.media_error ? "media_unavailable" : undefined,
      paused_until: body.paused_until,
      error: body.error ? `telethon_${state}` : undefined,
    };
    healthCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    if (signal?.aborted) throw collectionHttpError(err, combined);
    const value: TelethonHealth = {
      ok: false,
      authorized: false,
      state: "unavailable",
      retry_after_seconds: 0,
      error: collectionHttpError(err, combined).code,
    };
    healthCache = { at: Date.now(), value };
    return value;
  }
}

export async function telethonReady(): Promise<boolean> {
  const h = await telethonHealth();
  if (h.paused_until && h.paused_until > 0) return false;
  return h.state === "ready" && h.ok && h.authorized;
}

export async function fetchTelethonHistory(
  channel: string,
  minId: string,
  limit = 80,
  signal?: AbortSignal,
  scanState?: SourceRecord["scan_state"],
): Promise<NormalizedItem[] & { has_more?: boolean; next_cursor?: string }> {
  if (!telethonConfigured()) throw new Error("Telethon 节点未配置");
  const handle = parseTelegramHandle(channel) || channel.replace(/^@/, "");
  const cursor = telegramMessageId(minId || "0", handle);
  if (!cursor) throw new CollectionHttpError("invalid_response", "invalid_telegram_cursor");
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const res = await abortable(collectionFetch(`${prod.telegramWorkerUrl}/v1/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: parseTelegramHandle(channel) || channel.replace(/^@/, ""),
        min_id: cursor,
        bootstrap: scanState?.bootstrap ?? "latest",
        limit,
      }),
      signal: combined,
      redirect: "error",
    }), combined);
    const text = new TextDecoder().decode(await readCapped(res.body, TEXT_MAX_BYTES, combined));
    const details = { status: res.status, retryAt: parseRetryAfter(res.headers.get("retry-after"), Date.now()) ?? undefined };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CollectionHttpError(res.ok ? "invalid_response" : res.status === 429 ? "rate_limited" : "http_error", res.ok ? "invalid_response" : `Telethon HTTP ${res.status}`, details);
    }
    const failure = z.object({ error: z.string().optional(), flood_wait: z.number().finite().nonnegative().optional() }).safeParse(json);
    if (!failure.success) throw new CollectionHttpError(res.ok ? "invalid_response" : res.status === 429 ? "rate_limited" : "http_error",
      res.ok ? "invalid_response" : `Telethon HTTP ${res.status}`, details);
    if (failure.data.flood_wait) throw new CollectionHttpError("rate_limited", `Telethon FloodWait ${failure.data.flood_wait}s`,
      { ...details, retryAt: Math.max(details.retryAt ?? 0, Date.now() + failure.data.flood_wait * 1000) });
    if (!res.ok || failure.data.error) throw new CollectionHttpError(res.status === 429 ? "rate_limited" : failure.data.error === "timeout" ? "timeout" : "http_error",
      failure.data.error === "timeout" ? "timeout" : failure.data.error === "membership_required" ? "Telethon membership_required" : `Telethon HTTP ${res.status}`, details);
    const parsed = historySchema.safeParse(json);
    if (!parsed.success) throw new CollectionHttpError("invalid_response");
    const items: NormalizedItem[] = parsed.data.items.map((it) => {
      const attachment = it.extra.telegram_media === undefined ? undefined : telegramMediaSchema.safeParse(it.extra.telegram_media);
      if (attachment && (!attachment.success || attachment.data.channel !== handle.toLowerCase() ||
          attachment.data.message_id !== it.external_id || attachment.data.kind !== it.media_type))
        throw new CollectionHttpError("invalid_response");
      const locator = attachment?.success ? attachment.data : undefined;
      if (it.media_urls.some(url => /^telegram:/i.test(url)) && !locator) throw new CollectionHttpError("invalid_response");
      return { ...it,
        media_urls: locator ? [`telegram://${locator.channel}/${locator.message_id}`] : it.media_urls,
        extra: { ...it.extra, ...(locator ? { telegram_media: locator } : {}),
          ...(it.media_type === "audio" ? { telethon_media_type: "audio" } : {}), collector: "telethon" },
      };
    });
    if (items.some(it => telegramMessageId(it.external_id, handle) !== it.external_id)) throw new CollectionHttpError("invalid_response");
    const maximum = maxNumericId(items.map(it => it.external_id)) ?? cursor;
    const boundary = parsed.data.last_id ?? maximum;
    if (compareNumericIds(boundary, cursor) < 0 || compareNumericIds(boundary, maximum) < 0 ||
      (parsed.data.has_more && compareNumericIds(boundary, cursor) <= 0)) throw new CollectionHttpError("invalid_response");
    // The worker boundary includes traversed service messages, even on an empty
    // content page. Persistence commits it only after saving this entire page.
    return Object.assign(items, { has_more: parsed.data.has_more ?? items.length >= limit,
      next_cursor: boundary });
  } catch (error) {
    throw collectionHttpError(error, combined);
  }
}

/** Strict logical locator, never a public URL or an operator endpoint override. */
export function telegramMediaLocator(url: string): { channel: string; message_id: string; object_key: string } {
  const match = /^telegram:\/\/([a-zA-Z0-9_]{5,32})\/([1-9][0-9]{0,319})$/.exec(url);
  if (!match) throw new CollectionHttpError("invalid_media_locator");
  const channel = match[1].toLowerCase(), message_id = match[2];
  return { channel, message_id, object_key: `telegram/${channel}/${message_id}` };
}

// ponytail: serialize attachments in this server process so the shared host limiter leaves room for history;
// use distributed admission only if the app gains multiple replicas. The worker also has its own media slot.
let mediaTail = Promise.resolve();

export async function fetchTelethonMedia(url: string, callerSignal?: AbortSignal): Promise<{ object_key: string; content_type: string; bytes: number; sha256: string }> {
  const locator = telegramMediaLocator(url);
  if (!prod.telegramWorkerUrl || !prod.telegramMediaToken) throw new CollectionHttpError("media_unavailable", "media_unavailable", { status: 503 });
  const deadline = AbortSignal.timeout(130_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const previous = mediaTail;
  let release!: () => void;
  const slot = new Promise<void>(resolve => { release = resolve; });
  // A cancelled waiter releases only its own link; the tail still waits for its predecessor.
  mediaTail = previous.then(() => slot);
  let receivedFailure: CollectionHttpError | undefined;
  try {
    await abortable(previous, signal);
    const res = await abortable(collectionFetch(`${prod.telegramWorkerUrl}/v1/media`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${prod.telegramMediaToken}` },
      body: JSON.stringify({ channel: locator.channel, message_id: locator.message_id }), signal, redirect: "error",
    }), signal);
    // Received failure headers remain authoritative if reading its body later resets or times out.
    if (!res.ok) receivedFailure = new CollectionHttpError("telegram_media_http_error", "telegram_media_http_error", {
      status: res.status, retryAt: parseRetryAfter(res.headers.get("retry-after"), Date.now()) ?? undefined,
    });
    const text = new TextDecoder().decode(await readCapped(res.body, TEXT_MAX_BYTES, signal));
    if (receivedFailure) throw receivedFailure;
    let json: unknown;
    try { json = JSON.parse(text); }
    catch { throw new CollectionHttpError("invalid_response"); }
    const parsed = z.object({
      object_key: z.literal(locator.object_key), content_type: z.string().max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),
      bytes: z.number().int().positive().max(MEDIA_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).safeParse(json);
    if (!parsed.success) throw new CollectionHttpError("invalid_response");
    return parsed.data;
  } catch (error) { throw receivedFailure ?? collectionHttpError(error, signal); }
  finally { release(); }
}

