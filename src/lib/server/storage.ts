import { createHash, createHmac } from "node:crypto";
import { minioConfigured, prod } from "./config.ts";

let healthCache: { at: number; value: { ok: boolean; error?: string } } | null = null;

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function amzDate(now = new Date()): { amz: string; day: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amz = iso.slice(0, 15) + "Z";
  return { amz, day: amz.slice(0, 8) };
}

function endpointHost(): { url: URL; host: string; scheme: string } {
  const raw = prod.minioEndpoint;
  const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  return { url, host: url.host, scheme: url.protocol.replace(":", "") };
}

function signingKey(day: string): Buffer {
  const kDate = hmac(`AWS4${prod.minioSecretKey}`, day);
  const kRegion = hmac(kDate, prod.minioRegion);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function objectUrl(key: string, privateSubtitle = false): URL {
  const { url } = endpointHost();
  const path = prod.minioForcePathStyle || privateSubtitle
    ? `${url.pathname.replace(/\/$/, "")}/${privateSubtitle ? "loom-subtitles" : prod.minioBucket}/${key}`.replace(/\/+/g, "/")
    : `${url.pathname.replace(/\/$/, "")}/${key}`;
  return new URL(path.startsWith("/") ? path : `/${path}`, url.origin);
}

function signHeaders(method: string, target: URL, bodyHash: string, extra: Record<string, string>): Record<string, string> {
  const { host } = endpointHost();
  const { amz, day } = amzDate();
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amz,
    ...extra,
  };
  const names = Object.keys(headers)
    .map((n) => n.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signed = names.join(";");
  const canonical = [
    method,
    target.pathname,
    target.search.replace(/^\?/, ""),
    canonicalHeaders,
    signed,
    bodyHash,
  ].join("\n");
  const scope = `${day}/${prod.minioRegion}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256Hex(canonical)}`;
  const sig = createHmac("sha256", signingKey(day)).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${prod.minioAccessKey}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  return headers;
}

async function s3(
  method: string,
  key: string,
  body?: Buffer,
  contentType?: string,
  privateSubtitle = false,
): Promise<{ ok: boolean; status: number; bytes: Buffer }> {
  const target = objectUrl(key, privateSubtitle);
  const payload = body ?? Buffer.alloc(0);
  const bodyHash = sha256Hex(payload);
  const extra: Record<string, string> = {};
  if (contentType) extra["content-type"] = contentType;
  if (body) extra["content-length"] = String(body.length);
  const headers = signHeaders(method, target, bodyHash, extra);
  const res = await fetch(target, {
    method,
    headers,
    body: body && method !== "GET" && method !== "HEAD" ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, bytes };
}

export function objectPublicUrl(key: string): string {
  if (prod.minioPublicUrl) return `${prod.minioPublicUrl.replace(/\/$/, "")}/${key}`;
  return objectUrl(key).toString();
}

export async function ensureBucket(): Promise<{ ok: boolean; error?: string }> {
  if (!minioConfigured()) return { ok: false, error: "MinIO 未配置" };
  const { url } = endpointHost();
  const target = new URL(`${url.pathname.replace(/\/$/, "")}/${prod.minioBucket}`.replace(/\/+/g, "/"), url.origin);
  const bodyHash = sha256Hex("");
  const headers = signHeaders("PUT", target, bodyHash, {});
  const res = await fetch(target, { method: "PUT", headers, signal: AbortSignal.timeout(8000) });
  if (res.ok || res.status === 409 || res.status === 200) return { ok: true };
  if (res.status === 404 || res.status === 403) {
    const msg = await res.text();
    return { ok: false, error: `MinIO ${res.status} ${msg.slice(0, 180)}` };
  }
  return { ok: res.ok, error: res.ok ? undefined : `MinIO ${res.status}` };
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<{ ok: boolean; url: string; error?: string }> {
  if (!minioConfigured()) return { ok: false, url: "", error: "MinIO 未配置" };
  const result = await s3("PUT", key, body, contentType || "application/octet-stream");
  if (!result.ok) return { ok: false, url: "", error: `上传失败 ${result.status}` };
  return { ok: true, url: objectPublicUrl(key) };
}

export async function getObject(key: string): Promise<{ ok: boolean; bytes: Buffer; error?: string }> {
  if (!minioConfigured()) return { ok: false, bytes: Buffer.alloc(0), error: "MinIO 未配置" };
  const result = await s3("GET", key);
  if (!result.ok) return { ok: false, bytes: Buffer.alloc(0), error: `读取失败 ${result.status}` };
  return { ok: true, bytes: result.bytes };
}

/** Only server-owned IDs/digests reach the fixed private bucket; never return a public URL. */
export async function putSubtitleObject(itemId: string, digest: string, body: Buffer): Promise<{ ok: boolean }> {
  if (!minioConfigured() || prod.minioBucket === "loom-subtitles" || !/^[A-Za-z0-9_-]{1,128}$/.test(itemId) || !/^[a-f0-9]{64}$/.test(digest)
      || body.length > 2 * 1024 * 1024 || sha256Hex(body) !== digest) return { ok: false };
  try { return { ok: (await s3("PUT", `${itemId}/${digest}.json3`, body, "application/json; charset=utf-8", true)).ok }; }
  catch { return { ok: false }; }
}

export async function minioHealth(): Promise<{ ok: boolean; error?: string }> {
  if (!minioConfigured()) return { ok: false, error: "未配置 MINIO_ENDPOINT" };
  if (healthCache && Date.now() - healthCache.at < 20_000) return healthCache.value;
  try {
    const { url } = endpointHost();
    const target = new URL(
      `${url.pathname.replace(/\/$/, "")}/${prod.minioBucket}`.replace(/\/+/g, "/"),
      url.origin,
    );
    const bodyHash = sha256Hex("");
    const headers = signHeaders("HEAD", target, bodyHash, {});
    const res = await fetch(target, { method: "HEAD", headers, signal: AbortSignal.timeout(4000) });
    if (res.ok || res.status === 404) {
      if (res.status === 404) {
        const created = await ensureBucket();
        healthCache = { at: Date.now(), value: created };
        return created;
      }
      const value = { ok: true };
      healthCache = { at: Date.now(), value };
      return value;
    }
    const value = { ok: false, error: `MinIO ${res.status}` };
    healthCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    const value = { ok: false, error: err instanceof Error ? err.message : String(err) };
    healthCache = { at: Date.now(), value };
    return value;
  }
}
