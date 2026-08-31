import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "scene",
  "sessionid",
  "clicktime",
  "enterid",
  "ascene",
  "devicetype",
  "version",
  "nettype",
  "lang",
  "exportkey",
  "pass_ticket",
  "wx_header",
  "chksm",
  "mpshare",
  "srcid",
  "sharer_shareinfo",
  "sharer_shareinfo_first",
  "from",
  "isappinstalled",
]);

function hash32(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function wechatSourceId(wechatId: string): string {
  const normalized = wechatId.trim().toLowerCase();
  if (!normalized) throw new Error("wechat_id 不能为空");
  return `wx-${hash32(normalized).slice(0, 20)}`;
}

function hashWechatUrl(url: string): string {
  return `wx:url:${hash32(url)}`;
}

function hashWechatFallback(
  accountId: string,
  title: string,
  publishedAt: string,
): string {
  return `wx:fallback:${hash32(
    [accountId.trim(), title.trim(), publishedAt.slice(0, 10)].join("\n"),
  )}`;
}

export function normalizeWechatUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("需要微信原文链接");
  }

  if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com" ||
    url.username || url.password) {
    throw new Error("需要微信原文链接");
  }

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

export function canonicalWechatId(
  rawUrl: string,
  accountId: string,
  title: string,
  publishedAt: string,
): string {
  try {
    const normalized = normalizeWechatUrl(rawUrl);
    const url = new URL(normalized);
    const biz = url.searchParams.get("__biz");
    const mid = url.searchParams.get("mid");
    const idx = url.searchParams.get("idx");

    if (biz && mid && idx) {
      return `wx:${biz}:${mid}:${idx}`;
    }

    return hashWechatUrl(normalized);
  } catch {
    return hashWechatFallback(accountId, title, publishedAt);
  }
}
