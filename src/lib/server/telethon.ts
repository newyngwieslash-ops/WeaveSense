import { prod, telethonConfigured } from "./config";
import type { NormalizedItem } from "./collectors/types";
import { parseTelegramHandle, parseTelegramHandles } from "../telegram-handle";
import { z } from "zod";
import { abortable, CollectionHttpError, collectionHttpError, parseRetryAfter, readCapped, TEXT_MAX_BYTES } from "./outbound-policy.ts";

export { parseTelegramHandle, parseTelegramHandles };

export type TelethonHealth = {
  ok: boolean;
  authorized: boolean;
  me?: string;
  minio?: boolean;
  paused_until?: number;
  error?: string;
};

const healthSchema = z.object({
  ok: z.boolean(), authorized: z.boolean(), me: z.string().optional(), minio: z.boolean().optional(),
  paused_until: z.number().finite().nonnegative().optional(), error: z.string().nullable().optional(),
});
const historySchema = z.object({
  items: z.array(z.object({
    external_id: z.string().min(1), title: z.string(), body: z.string(), author: z.string(), url: z.string(),
    media_type: z.enum(["article", "text", "image", "video", "audio", "file", "link"]), media_urls: z.array(z.string()),
    thumbnail_url: z.string(), views: z.number().finite().nullable(), likes: z.number().finite().nullable(),
    published_at: z.string().nullable(), extra: z.record(z.string(), z.unknown()),
  })),
  last_id: z.string().optional(), flood_wait: z.number().finite().nonnegative().optional(), error: z.string().optional(),
});

let healthCache: { at: number; value: TelethonHealth } | null = null;

export async function telethonHealth(signal?: AbortSignal): Promise<TelethonHealth> {
  if (signal?.aborted) throw collectionHttpError(null, signal);
  if (!telethonConfigured()) return { ok: false, authorized: false, error: "未配置 TELEGRAM_WORKER_URL" };
  if (healthCache && Date.now() - healthCache.at < 15_000) return healthCache.value;
  const deadline = AbortSignal.timeout(2500);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const res = await abortable(fetch(`${prod.telegramWorkerUrl}/health`, { signal: combined, redirect: "error" }), combined);
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      const value = { ok: false, authorized: false, error: `worker HTTP ${res.status}` };
      healthCache = { at: Date.now(), value };
      return value;
    }
    const text = new TextDecoder().decode(await readCapped(res.body, TEXT_MAX_BYTES, combined));
    let body: z.infer<typeof healthSchema>;
    try { body = healthSchema.parse(JSON.parse(text)); }
    catch { throw new CollectionHttpError("invalid_response"); }
    const value: TelethonHealth = {
      ok: body.ok,
      authorized: body.authorized,
      me: body.me,
      minio: body.minio,
      paused_until: body.paused_until,
      error: body.error ? "telethon_unauthorized" : undefined,
    };
    healthCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    if (signal?.aborted) throw collectionHttpError(err, combined);
    const value: TelethonHealth = {
      ok: false,
      authorized: false,
      error: collectionHttpError(err, combined).code,
    };
    healthCache = { at: Date.now(), value };
    return value;
  }
}

export async function telethonReady(): Promise<boolean> {
  const h = await telethonHealth();
  if (h.paused_until && h.paused_until > 0) return false;
  return h.ok && h.authorized;
}

export async function fetchTelethonHistory(
  channel: string,
  minId: string,
  limit = 80,
  signal?: AbortSignal,
): Promise<NormalizedItem[]> {
  if (!telethonConfigured()) throw new Error("Telethon 节点未配置");
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const res = await abortable(fetch(`${prod.telegramWorkerUrl}/v1/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: parseTelegramHandle(channel) || channel.replace(/^@/, ""),
        min_id: (minId.match(/(\d+)$/)?.[1] ?? minId.replace(/\D/g, "")) || "0",
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
      failure.data.error === "timeout" ? "timeout" : `Telethon HTTP ${res.status}`, details);
    const parsed = historySchema.safeParse(json);
    if (!parsed.success) throw new CollectionHttpError("invalid_response");
    return parsed.data.items.map((it) => ({
      ...it,
      media_type: it.media_type === "audio" ? "file" : it.media_type,
      extra: { ...(it.extra ?? {}), ...(it.media_type === "audio" ? { telethon_media_type: "audio" } : {}), collector: "telethon" },
    }));
  } catch (error) {
    throw collectionHttpError(error, combined);
  }
}

