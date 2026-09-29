/** Last Telegram transport recorded on a job's attempts list. */
export type TelegramChannelKind = "telethon" | "web" | "rss";

export function telegramChannelKind(attempts: readonly string[]): TelegramChannelKind | null {
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i];
    if (attempt === "telethon") return "telethon";
    if (attempt === "t.me/s" || attempt === "telegram_web") return "web";
    if (attempt === "rss") return "rss";
  }
  return null;
}

export function telegramChannelLabel(kind: TelegramChannelKind | null): string | null {
  if (kind === "telethon") return "Telethon";
  if (kind === "web") return "t.me/s";
  if (kind === "rss") return "RSS";
  return null;
}

export function attemptLabel(attempt: string): string {
  if (attempt === "telethon") return "Telethon";
  if (attempt === "t.me/s" || attempt === "telegram_web") return "t.me/s";
  return attempt;
}
