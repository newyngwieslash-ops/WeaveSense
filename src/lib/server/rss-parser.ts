import { XMLParser } from "fast-xml-parser";
import type { MediaType, PlatformId } from "../platforms.ts";
import { stripHtml } from "../format.ts";
import type { NormalizedItem } from "./collectors/types.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec["#cdata"] === "string") return rec["#cdata"];
    if (typeof rec["#text"] === "string") return rec["#text"];
    if (typeof rec["@_href"] === "string") return rec["@_href"];
  }
  return "";
}

function pickLink(raw: unknown): string {
  const links = asArray(raw);
  const mapped = links.map((link) => {
    if (typeof link === "string") return { href: link, rel: "" };
    const rec = (link ?? {}) as Record<string, unknown>;
    return {
      href: String(rec["@_href"] ?? rec["#text"] ?? rec["@_url"] ?? ""),
      rel: String(rec["@_rel"] ?? ""),
    };
  });
  const alternate = mapped.find((link) => link.rel === "alternate" && link.href);
  return (alternate ?? mapped.find((link) => link.href) ?? { href: "" }).href;
}

function pickThumb(item: Record<string, unknown>): string {
  const media = item["media:thumbnail"] ?? item["media:content"] ?? item.thumbnail;
  const first = asArray(media)[0] as Record<string, unknown> | undefined;
  if (first) {
    const url = String(first["@_url"] ?? first["@_href"] ?? "");
    if (url) return url;
  }
  const enclosure = asArray(item.enclosure)[0] as Record<string, unknown> | undefined;
  const type = String(enclosure?.["@_type"] ?? "");
  if (type.startsWith("image/") && enclosure?.["@_url"]) return String(enclosure["@_url"]);
  const group = item["media:group"] as Record<string, unknown> | undefined;
  return group ? pickThumb(group) : "";
}

function guessMedia(item: Record<string, unknown>, url: string, thumb: string): MediaType {
  const enclosure = asArray(item.enclosure)[0] as Record<string, unknown> | undefined;
  const type = String(enclosure?.["@_type"] ?? "");
  if (type.startsWith("video/") || /youtube|bilibili|youtu\.be|v\.qq|ixigua/i.test(url)) return "video";
  if (type.startsWith("image/") || (thumb && !item.description && !item.summary)) return "image";
  if (type && !type.startsWith("text/")) return "file";
  return "article";
}

function enclosureUrl(item: Record<string, unknown>): string {
  const enclosure = asArray(item.enclosure)[0] as Record<string, unknown> | undefined;
  return String(enclosure?.["@_url"] ?? "");
}

function authorOf(item: Record<string, unknown>): string {
  const author = item.author;
  for (const entry of asArray(author)) {
    const name = entry && typeof entry === "object" ? textOf((entry as Record<string, unknown>).name) : "";
    if (name) return name;
  }
  return textOf(item["dc:creator"] ?? author ?? item["itunes:author"] ?? "");
}

function loomExtra(item: Record<string, unknown>, platform: PlatformId): Record<string, unknown> {
  const extra: Record<string, unknown> = { platform };
  const provider = textOf(item["loom:provider"]);
  const providersSeen = textOf(item["loom:providers_seen"]);
  const discoveredAt = textOf(item["loom:discovered_at"]);
  const bodyComplete = textOf(item["loom:body_complete"]);
  if (provider) extra.provider = provider;
  if (providersSeen) extra.providers_seen = [...new Set(providersSeen.split(",")
    .map((value) => value.trim()).filter(Boolean))];
  if (discoveredAt) extra.discovered_at = discoveredAt;
  if (bodyComplete === "true" || bodyComplete === "false") extra.body_complete = bodyComplete === "true";
  return extra;
}

export function parseFeedXml(xml: string, sourceId: string, platform: PlatformId): NormalizedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as Record<string, unknown> | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  let items: Record<string, unknown>[] = [];
  if (rss) {
    const channel = (rss.channel ?? rss) as Record<string, unknown>;
    items = asArray(channel.item) as Record<string, unknown>[];
  } else if (atom) {
    items = asArray(atom.entry) as Record<string, unknown>[];
  } else if (rdf) {
    items = asArray(rdf.item) as Record<string, unknown>[];
  }

  return items.slice(0, 24).map((raw) => {
    const url = pickLink(raw.link) || textOf(raw.guid) || textOf(raw.id);
    const title = stripHtml(textOf(raw.title) || "未命名");
    const rawBody = textOf(
      raw["content:encoded"] ?? raw.content ?? raw.description ?? raw.summary ?? raw["media:description"],
    );
    // T11: the stored body is not truncated. The 8,000-char cut that used to be
    // applied to non-WeChat feeds silently destroyed the tail of long articles at
    // ingestion, before any model context budget ran — so no downstream fixture
    // could ever see the missing text. The model layer keeps its own budget
    // (agent-context); the storage layer keeps the material.
    //
    // The one remaining bound is a transport-level safety net: a body whose UTF-8
    // payload exceeds MAX_BODY_BYTES is refused explicitly (marked `body_too_large`
    // + `body_complete: false`) rather than silently trimmed, for every platform.
    const tooLarge = Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES;
    const body = tooLarge ? "" : stripHtml(rawBody);
    const author = stripHtml(authorOf(raw));
    const published = textOf(raw.pubDate ?? raw.published ?? raw.updated ?? raw["dc:date"] ?? "") || null;
    const thumb = pickThumb(raw);
    const media = enclosureUrl(raw);
    const id = textOf(raw.guid ?? raw.id) || url || `${sourceId}:${title}:${published ?? ""}`;
    const extra = loomExtra(raw, platform);
    if (tooLarge) {
      extra.body_error = "body_too_large";
      extra.body_complete = false;
    }
    return {
      external_id: id.slice(0, 320),
      title,
      body,
      author,
      url,
      media_type: guessMedia(raw, url, thumb),
      media_urls: [media, thumb].filter(Boolean),
      thumbnail_url: thumb,
      views: null,
      likes: null,
      published_at: published,
      extra,
    };
  });
}
