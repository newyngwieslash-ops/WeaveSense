import { telegramMessageId, maxNumericId, compareNumericIds } from "./cursor.ts";
import type { SourceRecord } from "./collectors/types";
import { prod, telethonConfigured } from "./config";
import type { NormalizedItem } from "./collectors/types";
import { parseTelegramHandle, parseTelegramHandles } from "../telegram-handle";
import { z } from "zod";
import { abortable, CollectionHttpError, collectionHttpError, parseRetryAfter, readCapped, TEXT_MAX_BYTES } from "./outbound-policy.ts";

export { parseTelegramHandle, parseTelegramHandles };

export type TelethonHealth = {
  ok: boolean;
  authorized: boolean;
  state: "unconfigured" | "unauthorized" | "connecting" | "ready" | "cooldown" | "unavailable";
  retry_after_seconds: number;
  status?: number;
  me?: string;
  minio?: boolean;
  paused_until?: number;
  error?: string;
};

const healthSchema = z.object({
  ok: z.boolean(), authorized: z.boolean(), me: z.string().optional(), minio: z.boolean().optional(),
  state: z.enum(["unconfigured", "unauthorized", "connecting", "ready", "cooldown", "unavailable"]).optional(),
  retry_after_seconds: z.number().finite().nonnegative().optional(),
  paused_until: z.number().finite().nonnegative().optional(), error: z.string().nullable().optional(),
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
    const res = await abortable(fetch(`${prod.telegramWorkerUrl}/health`, { signal: combined, redirect: "error" }), combined);
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
    const res = await abortable(fetch(`${prod.telegramWorkerUrl}/v1/history`, {
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
      { ...details, retryAt: details.retryAt ?? Date.now() + failure.data.flood_wait * 1000 });
    if (!res.ok || failure.data.error) throw new CollectionHttpError(res.status === 429 ? "rate_limited" : failure.data.error === "timeout" ? "timeout" : "http_error",
      failure.data.error === "timeout" ? "timeout" : failure.data.error === "membership_required" ? "Telethon membership_required" : `Telethon HTTP ${res.status}`, details);
    const parsed = historySchema.safeParse(json);
    if (!parsed.success) throw new CollectionHttpError("invalid_response");
    const items = parsed.data.items.map((it) => ({
      ...it,
      media_type: it.media_type === "audio" ? "file" : it.media_type,
      extra: { ...(it.extra ?? {}), ...(it.media_type === "audio" ? { telethon_media_type: "audio" } : {}), collector: "telethon" },
    }));
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

