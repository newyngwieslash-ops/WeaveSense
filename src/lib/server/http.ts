import { publicFetch, type DnsResolver, type OutboundTransport } from "./outbound-policy.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Test seam for the outbound policy: production leaves this empty and the real
 * resolver/transport are used. There is no "allow private" switch — a test can
 * only supply a *stricter* double, never a bypass.
 */
export type FetchIo = {
  resolver?: DnsResolver;
  transport?: OutboundTransport;
  maxBytes?: number;
};

/**
 * Fetch a **public** text resource (feeds, HTML, search results).
 *
 * Goes through `publicFetch`, so the target is validated against the private/
 * metadata address space on every redirect hop and the body is capped while
 * streaming — the previous plain `fetch(url, {redirect:"follow"})` had neither.
 * Error semantics are unchanged: a non-2xx response still throws `HTTP <status>`.
 */
export async function fetchText(
  url: string,
  timeoutMs = 10000,
  accept = "application/rss+xml, application/atom+xml, application/xml, text/html;q=0.9, */*;q=0.8",
  headers: Record<string, string> = {},
  io: FetchIo = {},
): Promise<string> {
  const result = await publicFetch(url, {
    timeoutMs,
    resolver: io.resolver,
    transport: io.transport,
    maxBytes: io.maxBytes,
    headers: {
      "User-Agent": UA,
      Accept: accept,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...headers,
    },
  });
  return result.text ?? "";
}

export async function fetchJson<T>(
  url: string,
  timeoutMs = 10000,
  io: FetchIo = {},
): Promise<T> {
  const result = await publicFetch(url, {
    timeoutMs,
    resolver: io.resolver,
    transport: io.transport,
    maxBytes: io.maxBytes,
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.bilibili.com/",
    },
  });
  return JSON.parse(result.text ?? "") as T;
}
