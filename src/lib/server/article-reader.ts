import { createHash } from "node:crypto";
import { z } from "zod";
import type { FetchIo } from "./http.ts";
import { assertPublicUrl, publicFetch, resolvePublicAddresses } from "./outbound-policy.ts";

export type ArticleCandidate = {
  body: string;
  sourceUrl: string;
  title: string;
  provider: "jina";
  fetchedAt: string;
  digest: string;
};

const MAX_BYTES = 2 * 1024 * 1024;
const readerEnvelope = z.object({ data: z.object({
  title: z.string().default(""), url: z.string().url(), content: z.string().min(1),
}) });

async function validateTarget(raw: string, allowedHosts: Set<string>, io: FetchIo, signal: AbortSignal): Promise<URL> {
  signal.throwIfAborted();
  const url = assertPublicUrl(raw);
  if (url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com")) {
    throw new Error("article_wechat_gateway_required");
  }
  if (url.protocol !== "https:" || url.port || raw.includes("?") || raw.includes("#") || !allowedHosts.has(url.hostname)) {
    throw new Error("article_target_not_allowed");
  }
  // Public articles do not inherit operator private/fake-IP egress exceptions.
  await resolvePublicAddresses(url.hostname, io.resolver, [], signal);
  return url;
}

/** Server-only candidate reader. Callers supply stored item.url, never browser URLs.
 * Hosted Jina's downstream navigation is outside our DNS pinning boundary;
 * fully controlled downstream fetching requires the C04 isolated self-host trial.
 */
export async function readArticle(url: string, options: { allowedHosts: Set<string>; io?: FetchIo }): Promise<ArticleCandidate> {
  const signal = AbortSignal.timeout(20000);
  const io = options.io ?? {}; // Test seam only; production callers omit it.
  const target = await validateTarget(url, options.allowedHosts, io, signal);
  const response = await publicFetch(`https://r.jina.ai/${target.href}`, {
    headers: { Accept: "application/json", "x-retain-images": "none" },
    timeoutMs: 20000, maxBytes: MAX_BYTES, maxRedirects: 0, signal,
    resolver: io.resolver, transport: io.transport,
  });
  let value: z.infer<typeof readerEnvelope>["data"];
  try {
    value = readerEnvelope.parse(JSON.parse(response.text ?? "")).data;
  } catch { throw new Error("article_invalid_response"); }
  const body = value.content.trim();
  if (!body || Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new Error("article_invalid_body");
  // ponytail: conservative phrase rejection can reject legitimate discussion of
  // challenges; upgrade to reviewed site-specific parsing if the pilot needs it.
  if (/^\s*(?:sign in|log in|login|登录)(?:\b|$)/i.test(value.title) ||
    /sign\s*in\s+to\s+(?:continue|read)|log\s*in\s+to\s+(?:continue|read)|verify\s+(?:that\s+)?you\s+are\s+human|just a moment|access denied|captcha|请登录|登录后|安全验证|人机验证/i.test(`${value.title}\n${body}`)) {
    throw new Error("article_access_challenge");
  }
  await validateTarget(value.url, options.allowedHosts, io, signal);
  signal.throwIfAborted();
  return { body, sourceUrl: value.url, title: value.title, provider: "jina", fetchedAt: new Date().toISOString(),
    digest: createHash("sha256").update(value.url).update("\0").update(body).digest("hex"),
  };
}
