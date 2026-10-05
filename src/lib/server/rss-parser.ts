import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { MediaType, PlatformId } from "../platforms.ts";
import { stripHtml } from "../format.ts";
import type { NormalizedItem } from "./collectors/types.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Bump when normalized content/identity semantics change; old validators must not skip reprocessing.
export const RSS_PARSER_VERSION = 'raw-v1-body-v3';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true,
  parseTagValue: false,
});

const legacyIdentityParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text",
  cdataPropName: "#cdata", trimValues: true,
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

function pickLink(raw: unknown, articleOnly = false): string {
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
  return (alternate ?? mapped.find((link) => (!articleOnly || !link.rel) && link.href) ?? { href: "" }).href;
}

function webUrl(raw: string, base?: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw, base);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function enclosureOf(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return (asArray(item.enclosure)[0] ?? asArray(item.link).find((link) =>
    link && typeof link === "object" && (link as Record<string, unknown>)["@_rel"] === "enclosure")) as Record<string, unknown> | undefined;
}

function pickThumb(item: Record<string, unknown>): string {
  const media = item["media:thumbnail"] ?? item["media:content"] ?? item.thumbnail;
  const first = asArray(media)[0] as Record<string, unknown> | undefined;
  if (first) {
    const url = String(first["@_url"] ?? first["@_href"] ?? "");
    if (url) return url;
  }
  const enclosure = enclosureOf(item);
  const type = String(enclosure?.["@_type"] ?? "");
  if (type.startsWith("image/") && enclosure?.["@_url"]) return String(enclosure["@_url"]);
  const group = item["media:group"] as Record<string, unknown> | undefined;
  return group ? pickThumb(group) : "";
}

function guessMedia(item: Record<string, unknown>, url: string, thumb: string): MediaType {
  const enclosure = enclosureOf(item);
  const type = String(enclosure?.["@_type"] ?? "");
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/") || /youtube|bilibili|youtu\.be|v\.qq|ixigua/i.test(url)) return "video";
  if (type.startsWith("image/") || (thumb && !item.description && !item.summary)) return "image";
  if (type && !type.startsWith("text/")) return "file";
  return "article";
}

function enclosureUrl(item: Record<string, unknown>): string {
  const enclosure = enclosureOf(item);
  return String(enclosure?.["@_url"] ?? enclosure?.["@_href"] ?? "");
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

export type FeedParseOptions = { feedUrl?: string; stats?: { rejected_entries: number } };

export function parseFeedXml(xml: string, sourceId: string, platform: PlatformId, options: FeedParseOptions = {}): NormalizedItem[] {
  if (options.stats) options.stats.rejected_entries = 0;
  if (XMLValidator.validate(xml) !== true) throw new Error("feed_invalid_xml");
  const doc = parser.parse(xml) as Record<string, unknown>;
  const roots = Object.keys(doc).filter((key) => !key.startsWith("?"));
  if (roots.length !== 1 || Array.isArray(doc[roots[0]])) throw new Error("feed_invalid_xml");
  const rss = doc.rss as Record<string, unknown> | undefined;
  const atom = doc.feed as Record<string, unknown> | undefined;
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  let items: Record<string, unknown>[] = [];
  if (Object.hasOwn(doc, "rss")) {
    if (!rss || !Object.hasOwn(rss, "channel") || Array.isArray(rss.channel)) throw new Error("feed_invalid_xml");
    const channel = rss.channel as Record<string, unknown>;
    items = asArray(channel.item) as Record<string, unknown>[];
  } else if (Object.hasOwn(doc, "feed")) {
    items = asArray(atom?.entry) as Record<string, unknown>[];
  } else if (Object.hasOwn(doc, "rdf:RDF")) {
    items = asArray(rdf?.item) as Record<string, unknown>[];
  } else throw new Error("feed_unknown_root");
  if (items.length > 1000) throw new Error("feed_entry_limit");

  // Reproduce legacy keys from the same XML, including numeric GUIDs wrapped
  // with attributes and the old raw-link fallback. Never reconstruct from DB IDs.
  const legacyDoc = legacyIdentityParser.parse(xml);
  const legacyItems = asArray(legacyDoc.rss?.channel?.item ?? legacyDoc.feed?.entry ?? legacyDoc["rdf:RDF"]?.item);
  const result: NormalizedItem[] = [];
  let rejected = 0;
  for (const [index, raw] of items.entries()) {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("feed_invalid_entry");
      const rawLink = pickLink(raw.link);
      const guid = raw.guid as Record<string, unknown> | undefined;
      const url = webUrl(pickLink(raw.link, true), options.feedUrl) ||
        (guid?.["@_isPermaLink"] === "false" ? "" : webUrl(textOf(raw.guid))) || webUrl(textOf(raw.id));
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
      const timestampField = ['pubDate','published','updated','dc:date'].find(field=>raw[field]!=null);
      const published = textOf(timestampField ? raw[timestampField] : '') || null;
      if (published && Number.isNaN(Date.parse(published))) throw new Error("feed_invalid_entry");
      const thumb = webUrl(pickThumb(raw), options.feedUrl);
      const media = webUrl(enclosureUrl(raw), options.feedUrl);
      if (!textOf(raw.guid ?? raw.id) && !rawLink && !url && !textOf(raw.title) && !rawBody && !media) throw new Error("feed_invalid_entry");
      const id = textOf(raw.guid ?? raw.id) || rawLink || url || `${sourceId}:${title}:${published ?? ""}`;
      // ponytail: IDs support at most 320 characters; accepting longer IDs requires a persisted-ID migration.
      if (id.length > 320) throw new Error("feed_entry_id_limit");
      const extra = { ...loomExtra(raw, platform), rss_identity: "raw-v1" } as Record<string, unknown>;
      // Atom updated alone is an edit time, never evidence of publication/discovery latency.
      if (timestampField==='updated' && published) extra.publication_time_kind = 'updated';
      const primaryContentAt=textOf((doc.feed as Record<string,unknown> | undefined)?.['loom:primary_content_at']);
      if (platform==='wechat' && primaryContentAt) extra.primary_content_at=primaryContentAt;
      // Compatibility evidence only: reproduce the prior XML scalar coercion,
      // never use this alias as the identity of new content.
      const legacyRaw = legacyItems[index] as Record<string, unknown>;
      const legacyGuid = legacyRaw.guid as Record<string, unknown> | undefined;
      const legacyUrl = webUrl(pickLink(legacyRaw.link, true), options.feedUrl) ||
        (legacyGuid?.["@_isPermaLink"] === "false" ? "" : webUrl(textOf(legacyRaw.guid))) || webUrl(textOf(legacyRaw.id));
      const legacyPublished = textOf(legacyRaw.pubDate ?? legacyRaw.published ?? legacyRaw.updated ?? legacyRaw["dc:date"] ?? "");
      const legacyId = textOf(legacyRaw.guid ?? legacyRaw.id) || pickLink(legacyRaw.link) || legacyUrl ||
        `${sourceId}:${stripHtml(textOf(legacyRaw.title) || "未命名")}:${legacyPublished}`;
      if (legacyId && legacyId !== id) extra.rss_legacy_id = legacyId;
      if (tooLarge) {
        extra.body_error = "body_too_large";
        extra.body_complete = false;
      }
      result.push({
        external_id: id,
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
      });
    } catch { rejected += 1; }
  }
  if (options.stats) options.stats.rejected_entries = rejected;
  if (!result.length && rejected) throw new Error("feed_no_usable_entries");
  return result;
}
