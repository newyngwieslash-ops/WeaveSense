import { createHash } from "node:crypto";
import type { Sql } from "../db.ts";
import { itemMatchesPhrase } from "../keyword.ts";
import { subtitleLanguages, type SubtitleLanguage } from "../subtitle-contract.ts";
import { asJson } from "./serialize.ts";

const MAX_BYTES = 2 * 1024 * 1024;
type Row = Record<string, unknown>;
type Result = { status: "ok" | "no_subtitles"; language: SubtitleLanguage; kind: "manual" | "automatic" | "none" };
const fail = (code: string): never => { throw new Error(`subtitle_${code}`); };
function version(value: unknown): number {
  const n = typeof value === "number" || typeof value === "string" || typeof value === "bigint" ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0 || value === "") fail("conflict");
  return n;
}
export function youtubeVideoId(row: Row): string {
  if (row.platform !== "youtube") return fail("unsupported");
  try {
    const url = new URL(String(row.url));
    if (url.protocol !== "https:" || url.username || url.password || url.port) return fail("unsupported");
    let id = "";
    if (["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname)) {
      if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v") ?? "";
      else id = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1] ?? "";
    } else if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    const external = /^yt:video:([A-Za-z0-9_-]{11})$/.exec(String(row.external_id ?? ""))?.[1];
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || (external && external !== id)) return fail("unsupported");
    return id;
  } catch { return fail("unsupported"); }
}
export function subtitleAvailability(row: Row): { available: boolean; reason?: string } {
  if (process.env.SUBTITLE_ENABLED !== "true") return { available: false, reason: "subtitle_disabled" };
  try { youtubeVideoId(row); return { available: true }; }
  catch { return { available: false, reason: "subtitle_unsupported" }; }
}
export function transcriptText(raw: string): string {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES) return fail("output_too_large");
  let payload;
  try { payload = JSON.parse(raw); } catch { return fail("invalid_response"); }
  if (!payload || !Array.isArray(payload.events)) return fail("invalid_response");
  let count = payload.events.length;
  const chunks: string[] = [];
  for (const event of payload.events) {
    if (count > 100000 || !event || typeof event !== "object" || Array.isArray(event)) return fail("invalid_response");
    const segs = Object.hasOwn(event, "segs") ? event.segs : [];
    if (!Array.isArray(segs)) return fail("invalid_response");
    count += segs.length;
    if (count > 100000 || segs.some((s: unknown) => !s || typeof s !== "object" || typeof (s as Row).utf8 !== "string")) return fail("invalid_response");
    const text = segs.map((s: { utf8: string }) => s.utf8).join("").trim();
    if (text && chunks.at(-1) !== text) chunks.push(text);
  }
  if (!chunks.length) return fail("invalid_response");
  return chunks.join("\n");
}
type Options = {
  sql: Pick<Sql, "query" | "transaction">; itemId: string; language: SubtitleLanguage; enabled: boolean;
  endpoint: string; token: string; fetcher?: typeof fetch;
  put: (id: string, digest: string, bytes: Buffer) => Promise<{ ok: boolean }>;
};
async function workerResult(opts: Options, videoId: string) {
  if (!opts.token) return fail("unavailable");
  let endpoint: URL;
  try { endpoint = new URL(opts.endpoint); } catch { return fail("unavailable"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") return fail("unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (opts.fetcher ?? fetch)(new URL("/v1/transcript", endpoint), { method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` }, body: JSON.stringify({ video_id: videoId, language: opts.language }) });
    if (!response.body) return fail("invalid_response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > MAX_BYTES) return fail("output_too_large"); chunks.push(next.value);
    }
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return fail("invalid_response"); }
    if (!response.ok) {
      const code = data?.error;
      return fail(["timeout", "busy", "output_too_large"].includes(code) ? code : "unavailable");
    }
    if (!data || data.video_id !== videoId || data.language !== opts.language) return fail("invalid_response");
    if (data.status === "no_subtitles" && data.kind === "none" && data.text === "" && data.json3 === undefined) return { ...data, digest: "" };
    if (data.status !== "ok" || !["manual", "automatic"].includes(data.kind) || typeof data.json3 !== "string") return fail("invalid_response");
    const text = transcriptText(data.json3);
    if (data.text !== text) return fail("invalid_response");
    return { ...data, text, digest: createHash("sha256").update(data.json3, "utf8").digest("hex") };
  } catch (error) {
    if (error instanceof Error && /^subtitle_[a-z_]+$/.test(error.message)) throw error;
    return fail(controller.signal.aborted ? "timeout" : "unavailable");
  } finally {
    clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {});
  }
}
export async function readSubtitleWith(opts: Options): Promise<Result> {
  if (!opts.enabled) return fail("disabled");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(opts.itemId) || !subtitleLanguages.includes(opts.language)) return fail("invalid_input");
  const [initial] = await opts.sql.query<Row>("select * from items where id=$1", [opts.itemId]);
  if (!initial) return fail("unsupported");
  const videoId = youtubeVideoId(initial), expected = version(initial.material_version);
  const data = await workerResult(opts, videoId);
  const result: Result = { status: data.status, language: opts.language, kind: data.kind };
  if (data.status === "ok") {
    const extra = asJson<Row>(initial.extra, {});
    if (extra.transcript_digest && extra.transcript_digest !== data.digest) return fail("conflict");
    // ponytail: a lost CAS may leave an immutable private object; add lifecycle cleanup if orphan volume becomes material.
    if (!extra.transcript_digest && !(await opts.put(opts.itemId, data.digest, Buffer.from(data.json3, "utf8"))).ok) return fail("unavailable");
  }
  return opts.sql.transaction(async tx => {
    const [current] = await tx.query<Row>("select * from items where id=$1 for update", [opts.itemId]);
    if (!current || youtubeVideoId(current) !== videoId) return fail("conflict");
    const extra = asJson<Row>(current.extra, {});
    if (data.status === "ok" && extra.transcript_digest === data.digest) return { status: "ok", language: extra.transcript_language as SubtitleLanguage, kind: extra.transcript_kind as "manual" | "automatic" };
    if (version(current.material_version) !== expected || extra.transcript_digest) return fail("conflict");
    if (data.status === "no_subtitles") {
      await tx.query("update items set extra=extra || $2::jsonb where id=$1", [opts.itemId, JSON.stringify({ transcript_state: "no_subtitles", transcript_language: opts.language, transcript_kind: "none", transcript_provider: "youtube" })]);
      return result;
    }
    const body = String(current.body ?? "") + `\n\n[字幕: ${opts.language}; ${data.kind}]\n${data.text}`;
    const phrases = await tx.query<{ phrase: string }>("select phrase from keywords where enabled=true");
    const matched = phrases.filter(p => itemMatchesPhrase(String(current.title), body, String(current.author), p.phrase)).map(p => p.phrase);
    const updated = await tx.query(`update items set body=$3, pipeline_status='ingested', extra=extra || $4::jsonb,
      matched_keywords=(select coalesce(jsonb_agg(value order by value),'[]'::jsonb) from (select distinct value from jsonb_array_elements_text(items.matched_keywords || $5::jsonb)) words)
      where id=$1 and material_version=$2 returning id`, [opts.itemId, expected, body, JSON.stringify({ transcript_state: "ok", transcript_language: opts.language,
      transcript_kind: data.kind, transcript_provider: "youtube", transcript_digest: data.digest, transcript_object_key: `${opts.itemId}/${data.digest}.json3` }), JSON.stringify(matched)]);
    if (!updated.length) return fail("conflict");
    return result;
  });
}
export async function readSubtitle(itemId: string, language: SubtitleLanguage = "en"): Promise<Result> {
  if (process.env.SUBTITLE_ENABLED !== "true") return fail("disabled");
  const { getSql } = await import("../db.ts");
  const { putSubtitleObject } = await import("./storage.ts");
  return readSubtitleWith({ sql: await getSql(), itemId, language, enabled: true, endpoint: process.env.SUBTITLE_URL ?? "http://subtitle-egress:8794",
    token: process.env.SUBTITLE_SERVICE_TOKEN ?? "", put: putSubtitleObject });
}
