export function parseTelegramHandle(raw: string): string {
  let handle = raw.trim();
  if (!handle) return "";
  handle = handle.replace(/^@/, "");
  handle = handle.replace(/^https?:\/\//i, "");
  handle = handle.replace(/^(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i, "");
  handle = handle.replace(/^s\//i, "");
  if (/^(?:\+|joinchat\/)/i.test(handle)) return "";
  handle = handle.replace(/[/?#].*$/, "");
  handle = handle.replace(/[^A-Za-z0-9_]/g, "");
  if (handle.length < 5 || handle.length > 32) return "";
  return handle;
}

export function parseTelegramHandles(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,;]+/)) {
    const handle = parseTelegramHandle(part);
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
    if (out.length >= 1000) break;
  }
  return out;
}
