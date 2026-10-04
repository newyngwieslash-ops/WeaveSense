#!/usr/bin/env node
/**
 * T05: outbound download policy — target validation and streaming size limits.
 *
 * Two failure classes this closes, both of which the old `fetch(url, {redirect:
 * "follow"})` helper left open:
 *
 *   1. **Target**: a feed/media URL pointing at loopback, RFC1918, link-local,
 *      unique-local or cloud-metadata space turns a "collect a feed" request
 *      into an SSRF primitive against the host's own services. A redirect can
 *      take a public URL private *after* validation, so redirects are followed
 *      manually and re-validated (DNS + address) at every hop.
 *   2. **Size**: trusting `Content-Length` is not a limit — chunked responses
 *      and lying servers both skip it. The body is counted as it streams and the
 *      connection is dropped the moment the cap is crossed.
 *
 * The address check runs on the *resolution result* (what will actually be
 * connected to), not on the URL text, and the resolved address is what the
 * caller pins the connection to (`lookup`), so a DNS answer that changes between
 * the check and the connect cannot win the race.
 *
 * Internal services (the local model gateway, MinIO, the Telegram worker, the
 * WeChat gateway, MCP servers) deliberately do NOT come through here: they are
 * operator-configured endpoints, often on loopback or a compose network. Their
 * own transports keep their existing rules.
 */
import { isIP } from "node:net";
import dns from "node:dns/promises";
import { acquireCollectionPermit } from "./collection-limits.ts";

/** First-release caps, as code constants (documented, not auto-expanding). */
export const TEXT_MAX_BYTES = 4 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

export class CollectionHttpError extends Error {
  code: string;
  status?: number;
  retryAt?: number;
  constructor(code: string, message = code, details: { status?: number; retryAt?: number } = {}) {
    super(message);
    this.name = "CollectionHttpError";
    this.code = code;
    this.status = details.status;
    this.retryAt = details.retryAt;
  }
}

export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  const retryAt = /^\d+$/.test(text) ? nowMs + Number(text) * 1000
    : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(retryAt) ? Math.max(nowMs, retryAt) : null;
}

/** Discard upstream messages: they can include credentials, URLs or headers. */
export function collectionHttpError(error: unknown, signal?: AbortSignal): CollectionHttpError {
  if (signal?.aborted) return new CollectionHttpError(signal.reason?.name === "TimeoutError" || signal.reason?.code === "timeout" ? "timeout" : "aborted");
  if (error instanceof CollectionHttpError) return error;
  if (error instanceof Error && error.name === "AbortError") return new CollectionHttpError("aborted");
  if (error instanceof Error && error.name === "TimeoutError") return new CollectionHttpError("timeout");
  const message = error instanceof Error ? error.message : "";
  const safeCodes = ["invalid_url", "unsupported_protocol", "url_credentials_not_allowed", "blocked_host", "blocked_address", "dns_no_answer", "redirect_without_location", "too_many_redirects", "response_too_large", "timeout"];
  return new CollectionHttpError(safeCodes.includes(message) ? message : "network_error");
}

/** Race even injected transports/resolvers which do not implement signals. */
export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => {}); throw collectionHttpError(null, signal); }
  let abort: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(collectionHttpError(null, signal));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener("abort", abort!); }
}

function cancelBody(body: BodyLike | null): void {
  if (!body) return;
  if (typeof (body as { destroy?: unknown }).destroy === "function") (body as BodyLike & { destroy(): void }).destroy();
  else if (typeof (body as ReadableStreamLike).getReader === "function") {
    try {
      const reader = (body as ReadableStreamLike).getReader();
      void reader.cancel().catch(() => {}).finally(() => { try { reader.releaseLock(); } catch { /* already released */ } });
    } catch { /* a readCapped reader may already have cancelled this stream */ }
  }
}

/** Addresses that must never be dialled by a public-fetch caller. */
export function addressBlocked(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true; // unspecified + loopback
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d): judge the embedded v4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return addressBlocked(mapped[1]);
    return false;
  }
  return true; // not an IP at all — refuse rather than guess
}

/**
 * Validate a URL for public fetch. Returns the URL, or throws a stable code.
 * Credentials, non-HTTP(S) schemes and any non-standard port shape are refused.
 */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported_protocol");
  if (url.username || url.password) throw new Error("url_credentials_not_allowed");
  return url;
}

/** The DNS capability this policy needs; injectable so tests stay offline. */
export type DnsResolver = {
  lookup(
    hostname: string,
    options: { all: true; verbatim?: boolean },
  ): Promise<{ address: string; family: number }[]>;
};

/** Hostnames that are internal by name regardless of what DNS says. */
export function hostBlocked(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower.endsWith(".local") || lower.endsWith(".internal")) return true;
  if (lower === "metadata.google.internal") return true;
  return false;
}

/**
 * Resolve and validate a host: every answer must be public, because a mixed
 * answer set (one public, one private) means the connect could pick the private.
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolver: DnsResolver = dns,
  /** Test seam; production uses the environment-declared ranges. */
  egressOverride?: readonly { address: string; prefix: number }[],
): Promise<string[]> {
  if (hostBlocked(hostname)) throw new Error("blocked_host");
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    const egress = egressOverride ?? declaredEgress();
    if (addressBlocked(bare) && !addressAllowedByEgress(bare, egress)) {
      throw new Error("blocked_address");
    }
    return [bare];
  }
  const answers = await resolver.lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || !answers.length) throw new Error("dns_no_answer");
  // A declared egress range is the operator's own proxy, so addresses inside it
  // are allowed *for this host*; everything else keeps the strict check.
  const egress = egressOverride ?? declaredEgress();
  for (const { address } of answers) {
    if (addressBlocked(address) && !addressAllowedByEgress(address, egress)) {
      throw new Error("blocked_address");
    }
  }
  return answers.map((a) => a.address);
}

/**
 * Count bytes while reading, aborting as soon as the cap is crossed.
 *
 * Accepts either a web ReadableStream (undici `fetch`) **or** any async iterable
 * — `http.IncomingMessage` is the latter, and supporting only the former would
 * make `publicFetch` crash on its real transport. `destroy`/`cancel` both map to
 * "drop the connection now".
 */
export async function readCapped(body: BodyLike | null, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw collectionHttpError(null, signal);
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;

  const overLimit = () => {
    const error = new CollectionHttpError("response_too_large") as CollectionHttpError & { bytes?: number; limit?: number };
    error.bytes = total;
    error.limit = maxBytes;
    return error;
  };

  const push = (chunk: Uint8Array) => {
    total += chunk.byteLength;
    if (total > maxBytes) throw overLimit();
    chunks.push(chunk);
  };

  if (typeof (body as { getReader?: unknown }).getReader === "function") {
    const reader = (body as ReadableStreamLike).getReader();
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) break;
        if (!value) continue;
        push(value);
      }
    } catch (error) {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // Already torn down; the original error is the one that matters.
      }
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A cancelled stream may already be locked down.
      }
    }
  } else {
    const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const { done, value } = await abortable(iterator.next(), signal);
        if (done) break;
        push(value);
      }
    } catch (error) {
      cancelBody(body);
      void iterator.return?.().catch(() => {});
      throw error;
    }
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Which cap applies to a URL/response pair. Media (audio/video/image) gets the
 * larger budget; everything else is text.
 */
/**
 * Which cap applies to a response.
 *
 * An explicit `kind` is a **hard** choice: `kind: "text"` must not be widened
 * just because the server claims `image/png` — a caller fetching a feed does not
 * want a 25 MiB budget because of a header it never asked for. Only when the
 * caller does not say does the response content-type decide.
 */
export function capFor(contentType = "", kind?: "text" | "media") {
  if (kind === "media") return MEDIA_MAX_BYTES;
  if (kind === "text") return TEXT_MAX_BYTES;
  return /^(audio|video|image)\//i.test(contentType) ? MEDIA_MAX_BYTES : TEXT_MAX_BYTES;
}


/**
 * T21-A: operator-declared egress ranges.
 *
 * Why this exists: on a host whose DNS runs in a proxy's **fake-IP** mode, every
 * public domain resolves into a synthetic range (commonly 198.18.0.0/15, RFC 2544
 * benchmarking) and the proxy performs the real lookup out of band. The strict
 * policy below correctly refuses that range by default — which is exactly right
 * for a server — but on such a host it also refuses *all legitimate collection*.
 *
 * The fix is an explicit, operator-declared exception rather than a weakening of
 * the default:
 *   - **Off by default**: with nothing declared, behaviour is byte-for-byte what
 *     it was (the range stays blocked).
 *   - **Opt-in per range**: only ranges the operator names are allowed, and only
 *     after they are validated.
 *   - **Never for the dangerous ones**: loopback, link-local (cloud metadata),
 *     unspecified and multicast are refused even when named, so a bad config or a
 *     hostile environment variable cannot turn them into egress.
 *
 * The declared ranges are genuinely less trusted than the public internet, so
 * anything relying on this should also be pinned to the operator's own proxy (the
 * `lookup` pinning already does that: the resolved address is what gets dialled).
 */

/** Addresses that may never be declared as egress, whatever the config says. */
function isNeverEgress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0) return true; // unspecified / this-network
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 224 || a === 240 || a === 255) return true; // multicast/reserved/broadcast
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80") || lower.startsWith("ff")) return true; // link-local, multicast
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isNeverEgress(mapped[1]);
    return false;
  }
  return true; // not an address at all
}

/** IPv4/IPv6 parse to a comparable 128-bit bigint, or null when invalid. */
function addressToBigInt(address: string): { value: bigint; bits: number } | null {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return { value: parts.reduce((acc, n) => (acc << 8n) | BigInt(n), 0n), bits: 32 };
  }
  if (version === 6) {
    const [head, tail = ""] = address.toLowerCase().split("::");
    const expand = (part: string) => (part ? part.split(":") : []);
    const left = expand(head), right = expand(tail);
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const groups = [...left, ...Array(missing).fill("0"), ...right];
    let value = 0n;
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      value = (value << 16n) | BigInt(parseInt(group, 16));
    }
    return { value, bits: 128 };
  }
  return null;
}

/**
 * Parse a comma-separated CIDR list (e.g. `198.18.0.0/15,fd00::/8`).
 * Invalid or never-egress entries are dropped silently: a status script should
 * not fail to start because one range in a list was malformed, and a dropped
 * entry is the safe direction.
 */
export function parseEgressCidrs(raw: string | undefined | null): { address: string; prefix: number }[] {
  if (!raw || typeof raw !== "string") return [];
  const out: { address: string; prefix: number }[] = [];
  for (const entry of raw.split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const [address, prefixText] = text.split("/");
    const parsed = addressToBigInt(address.trim());
    if (!parsed) continue;
    const prefix = prefixText === undefined ? parsed.bits : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) continue;
    // The network address itself must not be a never-egress address.
    if (isNeverEgress(address.trim())) continue;
    out.push({ address: address.trim(), prefix });
  }
  return out;
}

/** Whether `address` falls inside any declared egress range. */
export function addressAllowedByEgress(
  address: string,
  cidrs: readonly { address: string; prefix: number }[],
): boolean {
  if (!cidrs.length) return false;
  const target = addressToBigInt(address);
  if (!target) return false;
  if (isNeverEgress(address)) return false;
  for (const cidr of cidrs) {
    const base = addressToBigInt(cidr.address);
    if (!base || base.bits !== target.bits) continue;
    const shift = BigInt(base.bits - cidr.prefix);
    if ((target.value >> shift) === (base.value >> shift)) return true;
  }
  return false;
}

/**
 * The operator's declared egress ranges, read from the environment.
 *
 * Read per call rather than captured at module load: a script or test that sets
 * `LOOM_EGRESS_CIDRS` after importing this module must still be honoured, and
 * capturing it at import makes the setting silently order-dependent.
 */
export function declaredEgress(): { address: string; prefix: number }[] {
  return parseEgressCidrs(typeof process === "undefined" ? undefined : process.env.LOOM_EGRESS_CIDRS);
}

/** Redirect codes worth following. 304 and friends are not. */
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Build the `lookup` hook that answers from an already-validated address list.
 *
 * Node calls this in two shapes — `(host, opts, cb)` for the classic single
 * answer, and the same with `opts.all === true` expecting an array. Getting the
 * shape wrong fails as `ERR_INVALID_IP_ADDRESS: undefined`, so both are handled
 * here and tested against a real socket (see the integration test).
 */
export function createPinnedLookup(addresses: string[]): LookupHook {
  const entries = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  return function pinnedLookup(_hostname, options, callback) {
    if (options?.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  };
}

/** A body as either a web stream or an async iterable (Node's IncomingMessage). */
export type ReadableStreamLike = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
};
export type BodyLike = ReadableStreamLike | AsyncIterable<Uint8Array>;

/** The shape `publicFetch` needs from any transport (http, https, or a double). */
export type OutboundResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: BodyLike;
};

export type OutboundTransport = (
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    signals?: { abortSignal?: AbortSignal };
    /** Set by `publicFetch` to pin the socket to a validated address. */
    lookup?: LookupHook;
  },
) => Promise<OutboundResponse>;

/** Constructor options for `pinnedTransport`. */
type PinnedTransportOptions = {
  lookup?: LookupHook;
  signals?: { abortSignal?: AbortSignal };
};

export type LookupHook = (
  hostname: string,
  options: { all?: boolean },
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void;

/**
 * Default transport: `http(s).request` with `lookup` pinned to the addresses
 * validation approved.
 *
 * Pinning is the point. Checking DNS and then calling plain `fetch()` leaves a
 * window where a second lookup returns a different (private) address — the
 * rebinding race. Node's `lookup` hook lets the socket connect to the *checked*
 * address while SNI/Host/certificate validation still use the original hostname,
 * so TLS is not weakened.
 *
 * The lookup comes from the **per-call options** (what `publicFetch` supplies),
 * with `pinnedTransport({ lookup })` as a constructor-level fallback.
 */
export function pinnedTransport({ lookup: defaultLookup, signals }: PinnedTransportOptions = {}): OutboundTransport {
  return async function request(url, { method = "GET", headers = {}, timeoutMs = 10000, lookup = defaultLookup, signals: callSignals } = {}) {
    const abortSignals = [signals?.abortSignal, callSignals?.abortSignal].filter((s): s is AbortSignal => !!s);
    const signal = abortSignals.length ? AbortSignal.any(abortSignals) : undefined;
    signal?.throwIfAborted();
    const { request: httpRequest } = url.protocol === "https:"
      ? await import("node:https")
      : await import("node:http");
    return await new Promise<OutboundResponse>((resolve, reject) => {
      const req = httpRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          lookup: lookup as import("node:net").LookupFunction | undefined,
          signal,
        },
        (res) => {
          res.once("close", () => clearTimeout(timer));
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as OutboundResponse["headers"],
            // IncomingMessage is an async iterable of Buffers; readCapped accepts both.
            body: res as unknown as OutboundResponse["body"],
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new CollectionHttpError("timeout")), timeoutMs);
      req.once("error", (error) => { clearTimeout(timer); reject(error); });
      req.once("close", () => clearTimeout(timer));
      req.end();
    });
  };
}

/**
 * Fetch a **public** URL under the outbound policy.
 *
 * Redirects are followed manually so every hop is re-validated (a public URL
 * that 302s to `http://10.0.0.1/` must not be followed). The body is read with a
 * streaming cap, so a chunked or lying response cannot exhaust memory.
 *
 * `resolver` and `transport` exist for deterministic tests; production callers
 * leave them at their defaults.
 */
export async function publicFetch(
  rawUrl: string,
  {
    headers = {},
    timeoutMs = 10000,
    kind = "text",
    maxBytes,
    maxRedirects = MAX_REDIRECTS,
    resolver = dns,
    transport = pinnedTransport(),
    as = "text",
    signal,
    allowNotModified = false,
  }: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    kind?: "text" | "media";
    maxBytes?: number;
    maxRedirects?: number;
    resolver?: DnsResolver;
    transport?: OutboundTransport;
    as?: "text" | "bytes";
    signal?: AbortSignal;
    allowNotModified?: boolean;
  } = {},
): Promise<{ text?: string; bytes?: Uint8Array; url: string; contentType: string; status: number; headers: Record<string, string> }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new CollectionHttpError("timeout")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const expiresAt = Date.now() + timeoutMs;
  let response: OutboundResponse | undefined;
  let release: (() => void) | undefined;
  try {
    let url = assertPublicUrl(rawUrl);
    let redirects = 0;
    let requestHeaders = { ...headers };
    for (;;) {
      combined.throwIfAborted();
      // ponytail: OS DNS lookup is not cancellable; discard late results and never dial after expiry.
      const addresses = await abortable(resolvePublicAddresses(url.hostname, resolver), combined);
      const approved = [...addresses];
      const lookup = createPinnedLookup(approved);
      release = await acquireCollectionPermit(url, combined);
      combined.throwIfAborted();
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) throw new CollectionHttpError("timeout");
      const pending = transport(url, { method: "GET", headers: requestHeaders,
        timeoutMs: remainingMs, lookup, signals: { abortSignal: combined } });
      void pending.then((late) => { if (combined.aborted) cancelBody(late.body); }, () => {});
      response = await abortable(pending, combined);
      const status = response.status ?? 0;
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        if (value !== undefined) responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }

      if (REDIRECT_CODES.has(status)) {
        const location = responseHeaders.location;
        cancelBody(response.body);
        response = undefined;
        release(); release = undefined;
        if (!location) throw new Error("redirect_without_location");
        if (redirects >= maxRedirects) throw new Error("too_many_redirects");
        redirects += 1;
        const next = assertPublicUrl(new URL(location, url).href);
        // Validators belong to this representation, not the next redirect target.
        // ponytail: redirected feeds refetch 200; cache the final URL explicitly if that cost matters.
        requestHeaders = Object.fromEntries(Object.entries(requestHeaders)
          .filter(([key]) => !/^(if-none-match|if-modified-since)$/i.test(key)));
        if (next.origin !== url.origin) requestHeaders = Object.fromEntries(Object.entries(requestHeaders)
          .filter(([key]) => !/^(host|referer)$|auth|cookie|token|key|secret|credential|session|password/i.test(key)));
        url = next;
        continue;
      }
      if (status === 304 && allowNotModified && redirects === 0) {
        cancelBody(response.body);
        response = undefined;
        return { url: url.href, contentType: responseHeaders['content-type'] ?? '', status, headers: responseHeaders };
      }
      if (status < 200 || status >= 300) throw new CollectionHttpError(status === 429 ? "rate_limited" : "http_error", `HTTP ${status}`,
        { status, retryAt: parseRetryAfter(responseHeaders["retry-after"] ?? null, Date.now()) ?? undefined });

      const contentType = responseHeaders["content-type"] ?? "";
      const limit = maxBytes ?? capFor(contentType, kind);
      const bytes = await readCapped(response.body, limit, combined);
      response = undefined;
      if (as === "bytes") return { bytes, url: url.href, contentType, status, headers: responseHeaders };
      return { text: new TextDecoder().decode(bytes), url: url.href, contentType, status, headers: responseHeaders };
    }
  } catch (error) {
    throw collectionHttpError(error, combined);
  } finally {
    clearTimeout(timer);
    if (response) cancelBody(response.body);
    release?.();
  }
}

/** Fixed operator endpoints only. Hold admission through body EOF, cancellation or deadline. */
export async function collectionFetch(url: string, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const signal = init.signal ?? undefined;
  const release = await acquireCollectionPermit(new URL(url), signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const finish = () => { signal?.removeEventListener('abort', abort); release(); };
  const abort = () => { void reader?.cancel().catch(() => {}); finish(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const pending = fetchImpl(url, { ...init, redirect: 'error' });
    void pending.then(r => { if(signal?.aborted) void r.body?.cancel().catch(() => {}); }, () => {});
    const response = await abortable(pending, signal);
    if (!response.body) { finish(); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await abortable(reader!.read(), signal);
          if (part.done) { finish(); controller.close(); }
          else controller.enqueue(part.value);
        } catch (error) { abort(); controller.error(error); }
      },
      cancel() { abort(); },
    }, { highWaterMark: 0 });
    const result = new Response(body, {status:response.status, statusText:response.statusText, headers:response.headers});
    Object.defineProperty(result, 'url', {value:response.url});
    return result;
  } catch (error) { abort(); throw collectionHttpError(error, signal); }
}
