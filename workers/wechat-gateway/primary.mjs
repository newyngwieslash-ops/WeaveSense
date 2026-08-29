import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const TRACKING_PARAMS = new Set([
  "scene", "sessionid", "clicktime", "enterid", "ascene", "devicetype", "version",
  "nettype", "lang", "exportkey", "pass_ticket", "wx_header", "chksm", "mpshare",
  "srcid", "sharer_shareinfo", "sharer_shareinfo_first", "from", "isappinstalled",
]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true,
});

const arrayOf = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const hash32 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 32);

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return String(value["#cdata"] ?? value["#text"] ?? value["@_href"] ?? "");
}

function normalizeWechatUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("需要微信原文链接"); }
  if (url.hostname !== "mp.weixin.qq.com") throw new Error("需要微信原文链接");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function canonicalWechatId(rawUrl, accountId, title, publishedAt) {
  try {
    const normalized = normalizeWechatUrl(rawUrl);
    const url = new URL(normalized);
    const biz = url.searchParams.get("__biz");
    const mid = url.searchParams.get("mid");
    const idx = url.searchParams.get("idx");
    return biz && mid && idx
      ? `wx:${biz}:${mid}:${idx}`
      : `wx:url:${hash32(normalized)}`;
  } catch {
    return `wx:fallback:${hash32([accountId.trim(), title.trim(), publishedAt.slice(0, 10)].join("\n"))}`;
  }
}

function pickLink(value) {
  const links = arrayOf(value).map((link) => typeof link === "string"
    ? { href: link, rel: "" }
    : { href: textOf(link), rel: String(link?.["@_rel"] ?? "") });
  return (links.find(({ href, rel }) => href && rel === "alternate") ?? links.find(({ href }) => href))?.href ?? "";
}

function pickCover(item) {
  const media = arrayOf(item["media:thumbnail"] ?? item["media:content"])[0];
  if (media?.["@_url"]) return String(media["@_url"]);
  const enclosure = arrayOf(item.enclosure)[0];
  return String(enclosure?.["@_type"]?.startsWith("image/") ? enclosure["@_url"] ?? "" : "");
}

function bodyText(value) {
  return textOf(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function isoDate(raw) {
  const value = raw.trim();
  const withZone = /^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?$/.test(value)
    ? `${value.replace(" ", "T")}${value.length === 10 ? "T00:00:00" : ""}+08:00`
    : value;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) throw new Error("invalid primary entry: published_at");
  return date.toISOString();
}

function normalizeEntry(raw, source, discoveredAt) {
  const title = bodyText(raw.title);
  if (!title) throw new Error("invalid primary entry: title");
  const originalUrl = pickLink(raw.link) || textOf(raw.guid) || textOf(raw.id);
  normalizeWechatUrl(originalUrl);
  const publishedAt = isoDate(textOf(raw.pubDate ?? raw.published ?? raw.updated ?? raw["dc:date"]));
  const rawBody = textOf(raw["content:encoded"] ?? raw.content ?? raw.description ?? raw.summary);
  return {
    account_id: source.account_id,
    account_name: source.name,
    title,
    published_at: publishedAt,
    original_url: originalUrl,
    canonical_id: canonicalWechatId(originalUrl, source.account_id, title, publishedAt),
    ...(rawBody ? { body_html: rawBody, body_text: bodyText(rawBody) } : {}),
    ...(pickCover(raw) ? { cover_url: pickCover(raw) } : {}),
    provider: "primary",
    discovered_at: discoveredAt,
  };
}

export async function fetchPrimary(source, now = new Date()) {
  const response = await fetch(source.primary_feed_url, {
    headers: { Accept: "application/atom+xml, application/rss+xml, application/xml" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`primary feed HTTP ${response.status}`);
  const doc = parser.parse(await response.text());
  const rss = doc.rss;
  const entries = rss
    ? arrayOf((rss.channel ?? rss).item)
    : arrayOf(doc.feed?.entry ?? doc["rdf:RDF"]?.item);
  if (!entries.length) throw new Error("invalid primary feed: no entries");
  const discoveredAt = now.toISOString();
  return entries.slice(0, 24).map((entry) => normalizeEntry(entry, source, discoveredAt));
}
