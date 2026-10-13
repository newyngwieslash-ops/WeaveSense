import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

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
const MAX_PRIMARY_FEED_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com") throw new Error("需要微信原文链接");
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
  const completeBody = textOf(raw["content:encoded"] ?? raw.content);
  const trustedBody = bodyText(completeBody);
  const rawBody = trustedBody ? completeBody : textOf(raw.description ?? raw.summary);
  const normalizedBody = bodyText(rawBody);
  return {
    account_id: source.account_id,
    account_name: source.name,
    title,
    published_at: publishedAt,
    original_url: originalUrl,
    canonical_id: canonicalWechatId(originalUrl, source.account_id, title, publishedAt),
    ...(rawBody ? { body_html: rawBody, body_text: normalizedBody } : {}),
    body_complete: Boolean(trustedBody),
    ...(pickCover(raw) ? { cover_url: pickCover(raw) } : {}),
    provider: "primary",
    discovered_at: discoveredAt,
  };
}

function allowedUrl(raw, allowedFeedHosts) {
  const url = new URL(raw);
  const hosts = new Set([...allowedFeedHosts].map((host) => String(host).trim().toLowerCase()).filter(Boolean));
  if (!['http:', 'https:'].includes(url.protocol) || !hosts.has(url.hostname.toLowerCase())) {
    throw new Error("primary_feed_url must use an allowed host");
  }
  return url;
}

async function fetchAllowed(rawUrl, allowedFeedHosts) {
  const signal = AbortSignal.timeout(20_000);
  let url = allowedUrl(rawUrl, allowedFeedHosts);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, {
      headers: { Accept: "application/atom+xml, application/rss+xml, application/xml" },
      signal,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    if (redirects === 5) throw new Error("primary feed has too many redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("primary feed redirect has no location");
    url = allowedUrl(new URL(location, url).toString(), allowedFeedHosts);
  }
  throw new Error("primary feed has too many redirects");
}

async function readLimited(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PRIMARY_FEED_BYTES) {
    await response.body?.cancel();
    throw new Error("primary feed body too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PRIMARY_FEED_BYTES) {
      await reader.cancel();
      throw new Error("primary feed body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function fetchPrimary(source, now = new Date(), allowedFeedHosts) {
  const hosts = allowedFeedHosts ?? new Set([new URL(source.primary_feed_url).hostname]);
  const response = await fetchAllowed(source.primary_feed_url, hosts);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`primary feed HTTP ${response.status}`);
  }
  const xml = await readLimited(response);
  if (XMLValidator.validate(xml) !== true) throw new Error("invalid primary feed: malformed XML");
  const doc = parser.parse(xml);
  let entries;
  if (Object.hasOwn(doc, "rss")) entries = arrayOf((doc.rss?.channel ?? doc.rss)?.item);
  else if (Object.hasOwn(doc, "feed")) entries = arrayOf(doc.feed?.entry);
  else if (Object.hasOwn(doc, "rdf:RDF")) entries = arrayOf(doc["rdf:RDF"]?.item);
  else throw new Error("invalid primary feed: unknown root");
  const discoveredAt = now.toISOString();
  const items = [];
  const invalid = [];
  if (entries.length > 1000) throw new Error("primary_feed_entry_limit");
  for (const [index, entry] of entries.entries()) {
    try {
      items.push(normalizeEntry(entry, source, discoveredAt));
    } catch (error) {
      invalid.push({ index, error: error instanceof Error ? error.message : "invalid primary entry" });
    }
  }
  if (invalid.length) {
    console.warn(JSON.stringify({ event: "wechat_primary_invalid_entries",
      source_id: source.source_id ?? source.id ?? "", invalid_count: invalid.length,
      errors: invalid.slice(0, 3) }));
  }
  if (!items.length && invalid.length) throw new Error(`invalid primary feed: ${invalid.length} invalid entries`);
  return items;
}
