import { parseViews, stripHtml } from "../format.ts";
import { fetchText, type FetchIo } from "./http.ts";
import type { NormalizedItem } from "./collectors/types";

export function parseTelegramHtml(html: string, username: string): NormalizedItem[] {
  const blocks = html.split('class="tgme_widget_message ');
  const items: NormalizedItem[] = [];
  for (const block of blocks.slice(1)) {
    const post = block.match(/data-post="([^"]+)"/)?.[1] ?? "";
    const datetime = block.match(/<time datetime="([^"]+)"/)?.[1] ?? null;
    const textMatch = block.match(
      /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    const photoTag = block.match(/<a\b[^>]*class="[^"]*\btgme_widget_message_photo_wrap\b[^"]*"[^>]*>/)?.[0] ?? "";
    const photo = photoTag.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/)?.[1] ?? "";
    const video = /tgme_widget_message_video/.test(block);
    const viewsRaw = block.match(/tgme_widget_message_views">([^<]+)/)?.[1] ?? "";
    const author =
      block.match(/tgme_widget_message_owner_name[^>]*>[\s\S]*?<span[^>]*>([^<]+)/)?.[1] ??
      username;
    const body = stripHtml(textMatch?.[1] ?? "");
    const title = body.split("\n")[0]?.slice(0, 120) || (video ? "视频消息" : photo ? "图片消息" : "频道消息");
    const id = post || `${username}:${datetime ?? items.length}`;
    const url = post ? `https://t.me/${post}` : `https://t.me/s/${username}`;
    items.push({
      external_id: id,
      title,
      body: body.slice(0, 8000),
      author,
      url,
      media_type: video ? "video" : photo && !body ? "image" : body ? "text" : "link",
      media_urls: photo ? [photo] : [],
      thumbnail_url: photo,
      views: parseViews(viewsRaw),
      likes: null,
      published_at: datetime,
      extra: { channel: username },
    });
  }
  return items;
}

export async function fetchTelegramChannel(username: string, io: FetchIo = {}): Promise<NormalizedItem[]> {
  const handle = username.replace(/^@/, "").trim();
  if (!handle) throw new Error("缺少频道用户名");
  const html = await fetchText(`https://t.me/s/${encodeURIComponent(handle)}`, 12000, undefined, {}, io);
  const items = parseTelegramHtml(html, handle);
  if (!items.length) throw new Error("未解析到公开消息（频道可能私密或无网页预览）");
  return items;
}
