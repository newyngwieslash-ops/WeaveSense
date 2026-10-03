import { prod, telethonConfigured } from "./config";
import type { NormalizedItem } from "./collectors/types";
import { parseTelegramHandle, parseTelegramHandles } from "../telegram-handle";

export { parseTelegramHandle, parseTelegramHandles };

export type TelethonHealth = {
  ok: boolean;
  authorized: boolean;
  me?: string;
  minio?: boolean;
  paused_until?: number;
  error?: string;
};

type HistoryResponse = {
  items?: NormalizedItem[];
  last_id?: string;
  flood_wait?: number;
  error?: string;
};

let healthCache: { at: number; value: TelethonHealth } | null = null;

export async function telethonHealth(): Promise<TelethonHealth> {
  if (!telethonConfigured()) return { ok: false, authorized: false, error: "未配置 TELEGRAM_WORKER_URL" };
  if (healthCache && Date.now() - healthCache.at < 15_000) return healthCache.value;
  try {
    const res = await fetch(`${prod.telegramWorkerUrl}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      const value = { ok: false, authorized: false, error: `worker HTTP ${res.status}` };
      healthCache = { at: Date.now(), value };
      return value;
    }
    const body = (await res.json()) as TelethonHealth;
    const value: TelethonHealth = {
      ok: Boolean(body.ok),
      authorized: Boolean(body.authorized),
      me: body.me,
      minio: body.minio,
      paused_until: body.paused_until,
      error: body.error,
    };
    healthCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    const value: TelethonHealth = {
      ok: false,
      authorized: false,
      error: err instanceof Error ? err.message.slice(0, 180) : "worker 不可达",
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
): Promise<NormalizedItem[]> {
  if (!telethonConfigured()) throw new Error("Telethon 节点未配置");
  const res = await fetch(`${prod.telegramWorkerUrl}/v1/history`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: parseTelegramHandle(channel) || channel.replace(/^@/, ""),
      min_id: (minId.match(/(\d+)$/)?.[1] ?? minId.replace(/\D/g, "")) || "0",
      limit,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body: HistoryResponse;
  try {
    body = JSON.parse(text) as HistoryResponse;
  } catch {
    throw new Error(text.trim().slice(0, 180) || `Telethon HTTP ${res.status}`);
  }
  if (body.flood_wait) throw new Error(`Telethon FloodWait ${body.flood_wait}s`);
  if (!res.ok || body.error) throw new Error(body.error || `Telethon HTTP ${res.status}`);
  return (body.items ?? []).map((it) => ({
    ...it,
    extra: { ...(it.extra ?? {}), collector: "telethon" },
  }));
}

