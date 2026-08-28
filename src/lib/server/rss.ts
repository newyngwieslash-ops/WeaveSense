import { XMLParser } from "fast-xml-parser";
import type { MediaType } from "@/lib/platforms";
import { stripHtml } from "@/lib/format";
import { fetchText } from "./http";
import type { NormalizedItem } from "./collectors/types";

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
  const mapped = links.map((l) => {
    if (typeof l === "string") return { href: l, rel: "" };
    const rec = (l ?? {}) as Record<string, unknown>;
    return {
      href: String(rec["@_href"] ?? rec["#text"] ?? rec["@_url"] ?? ""),
      rel: String(rec["@_rel"] ?? ""),
    };
  });
  const alt = mapped.find((l) => l.rel === "alternate" && l.href);
  return (alt ?? mapped.find((l) => l.href) ?? { href: "" }).href;
}

function pickThumb(item: Record<string, unknown>): string {
  const media = item["media:thumbnail"] ?? item["media:content"] ?? item.thumbnail;
  const first = asArray(media)[0] as Record<string, unknown> | undefined;
  if (first) {
    const u = String(first["@_url"] ?? first["@_href"] ?? "");
    if (u) return u;
  }
  const enclosure = asArray(item.enclosure)[0] as Record<string, unknown> | undefined;
  const et = String(enclosure?.["@_type"] ?? "");
  if (et.startsWith("image/") && enclosure?.["@_url"]) return String(enclosure["@_url"]);
  const group = item["media:group"] as Record<string, unknown> | undefined;
  if (group) return pickThumb(group);
  return "";
}

function guessMedia(item: Record<string, unknown>, url: string, thumb: string): MediaType {
  const enclosure = asArray(item.enclosure)[0] as Record<string, unknown> | undefined;
  const et = String(enclosure?.["@_type"] ?? "");
  if (et.startsWith("video/") || /youtube|bilibili|youtu\.be|v\.qq|ixigua/i.test(url)) return "video";
  if (et.startsWith("image/") || (thumb && !item.description && !item.summary)) return "image";
  if (et && !et.startsWith("text/")) return "file";
  return "article";
}

function enclosureUrl(item: Record<string, unknown>): string {
  const enclosure = asArray(item.enclosure)[0] as Record<string, unknown> | undefined;
  return String(enclosure?.["@_url"] ?? "");
}

export function parseFeedXml(xml: string, sourceId: string, platform: string): NormalizedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as Record<string, unknown> | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;

  let channelItems: Record<string, unknown>[] = [];
  if (rss) {
    const channel = (rss.channel ?? rss) as Record<string, unknown>;
    channelItems = asArray(channel.item) as Record<string, unknown>[];
  } else if (atom) {
    channelItems = asArray(atom.entry) as Record<string, unknown>[];
  } else if (rdf) {
    channelItems = asArray(rdf.item) as Record<string, unknown>[];
  }

  const out: NormalizedItem[] = [];
  for (const raw of channelItems.slice(0, 24)) {
    const url = pickLink(raw.link) || textOf(raw.guid) || textOf(raw.id);
    const title = stripHtml(textOf(raw.title) || "未命名");
    const body = stripHtml(
      textOf(raw["content:encoded"] ?? raw.content ?? raw.description ?? raw.summary ?? raw["media:description"]),
    );
    const author = stripHtml(
      textOf(raw["dc:creator"] ?? raw.author ?? raw["itunes:author"] ?? ""),
    );
    const published =
      textOf(raw.pubDate ?? raw.published ?? raw.updated ?? raw["dc:date"] ?? "") || null;
    const thumb = pickThumb(raw);
    const media = enclosureUrl(raw);
    const id =
      textOf(raw.guid ?? raw.id) || url || `${sourceId}:${title}:${published ?? ""}`;
    const mediaType = guessMedia(raw, url, thumb);
    out.push({
      external_id: id.slice(0, 320),
      title,
      body: body.slice(0, 8000),
      author,
      url,
      media_type: mediaType,
      media_urls: [media, thumb].filter(Boolean),
      thumbnail_url: thumb,
      views: null,
      likes: null,
      published_at: published,
      extra: { platform },
    });
  }
  return out;
}

export async function fetchRss(feedUrl: string, sourceId: string, platform: string): Promise<NormalizedItem[]> {
  const xml = await fetchText(feedUrl, 12000);
  return parseFeedXml(xml, sourceId, platform);
}
