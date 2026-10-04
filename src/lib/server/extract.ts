import { getSql } from "@/lib/db";
import { publicFetch } from "./outbound-policy.ts";
import { getObject } from "./storage";
import { runExtractTargets, EXTRACT_TARGET_LIMIT, EXTRACT_LEASE_MINUTES, type ExtractTarget } from "./extract-targets";
import type { FetchIo } from "./http.ts";

const VISION_MODEL = "grok-4.5";
const STT_MODEL = "grok-stt";

function xaiKey(): string {
  return (process.env.XAI_API_KEY ?? "").trim();
}

export function xaiReady(): boolean {
  return Boolean(xaiKey());
}

async function fetchBytes(url: string, io: Pick<FetchIo, "resolver" | "transport">): Promise<{ bytes: Buffer; contentType: string }> {
  // Public media only: private/metadata targets and oversized payloads are
  // refused by the outbound policy before any bytes are held in memory.
  const fetched = await publicFetch(url, { timeoutMs: 20000, kind: "media", as: "bytes", resolver: io.resolver, transport: io.transport });
  return {
    bytes: Buffer.from(fetched.bytes ?? new Uint8Array()),
    contentType: fetched.contentType || "application/octet-stream",
  };
}

async function loadMedia(row: {
  object_key: string;
  source_url: string;
  public_url: string;
  content_type: string;
}, io: Pick<FetchIo, "resolver" | "transport">): Promise<{ bytes: Buffer; contentType: string }> {
  if (row.object_key) {
    const stored = await getObject(row.object_key);
    if (stored.ok) return { bytes: stored.bytes, contentType: row.content_type || "application/octet-stream" };
  }
  const url = row.public_url || row.source_url;
  if (!url.startsWith("http")) throw new Error("没有可读取的媒体地址");
  return fetchBytes(url, io);
}

/**
 * Vision models accept a bounded image payload. A larger image is REFUSED, not
 * trimmed: `bytes.subarray(0, N)` cuts a JPEG/PNG mid-stream, and the resulting
 * data URL is a corrupt image that still bills a paid vision call (and returns
 * nonsense or an error the operator has to diagnose). Refusing costs nothing.
 */
export const OCR_MAX_BYTES = 4_500_000;

export async function ocrBytes(bytes: Buffer, contentType: string): Promise<{ text: string; model: string }> {
  const key = xaiKey();
  if (!key) throw new Error("未启用 XAI_API_KEY，无法 OCR");
  if (bytes.length > OCR_MAX_BYTES) throw new Error("media_too_large");
  const mime = contentType.startsWith("image/") ? contentType : "image/jpeg";
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请识别这张图片中的全部文字（OCR）。保留原语言。只要正文，不要描述图片风格。若无文字，返回空。",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`OCR API ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return { text: (body.choices?.[0]?.message?.content ?? "").trim(), model: VISION_MODEL };
}

export async function transcribeBytes(bytes: Buffer, filename: string): Promise<{ text: string; model: string }> {
  const key = xaiKey();
  if (!key) throw new Error("未启用 XAI_API_KEY，无法 ASR");
  const form = new FormData();
  form.append("model", STT_MODEL);
  form.append("language", "zh");
  form.append("format", "true");
  form.append("file", new Blob([new Uint8Array(bytes)]), filename || "audio.mp3");
  const res = await fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`ASR API ${res.status}`);
  const body = (await res.json()) as { text?: string };
  return { text: (body.text ?? "").trim(), model: STT_MODEL };
}

export async function extractItem(itemId: string, io: Pick<FetchIo, "resolver" | "transport"> = {}): Promise<{
  ok: boolean;
  ran: number;
  error?: string;
}> {
  if (!xaiReady()) return { ok: false, ran: 0, error: "当前环境未启用 AI 提取" };
  const sql = await getSql();
  const media = await sql.query<{
    id: string;
    source_url: string;
    object_key: string;
    public_url: string;
    content_type: string;
    kind: string;
    status: string;
  }>("select * from media_objects where item_id = $1 order by created_at,id", [itemId]);

  let targets: ExtractTarget[] = media;
  if (!targets.length) {
    const [item] = await sql.query<{ media_urls: unknown; media_type: string }>(
      "select media_urls, media_type from items where id = $1",
      [itemId],
    );
    const urls = Array.isArray(item?.media_urls) ? (item.media_urls as string[]) : [];
    targets = urls.filter((u) => u.startsWith("http")).map((u) => ({
      id: "",
      source_url: u,
      object_key: "",
      public_url: u,
      content_type: "",
      kind: ["image", "video", "audio"].includes(item?.media_type) ? item.media_type : "file",
    }));
  }

  if (!targets.length) return { ok: false, ran: 0, error: "这条没有可提取的图片或音视频" };

  return runExtractTargets({ sql, itemId, targets, load: target => loadMedia(target, io), ocr: ocrBytes, asr: transcribeBytes });
}

export async function extractPending(limit = 3, io: Pick<FetchIo, "resolver" | "transport"> = {}): Promise<{ ran: number; errors: number }> {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    // Inspect the same first target window as the runner, before spending the batch limit.
    `select i.id from items i where i.pipeline_status='ingested' and exists (
       select 1 from (
         (select m.id as target_key,
           (m.object_key='' or (m.status='stored' and m.content_type<>'')) as ready
          from media_objects m where m.item_id=i.id order by m.created_at,m.id limit $2)
         union all
         (select 'url:' || encode(sha256(convert_to(u.url,'UTF8')),'hex') as target_key,true as ready
          from jsonb_array_elements_text(i.media_urls) with ordinality u(url,ord)
          where u.url like 'http%' and not exists (select 1 from media_objects m where m.item_id=i.id)
          order by u.ord limit $2)
       ) t left join extract_jobs e on e.item_id=i.id and e.target_key=t.target_key
       having bool_or(t.ready and (e.id is null or (e.attempts<3 and (
         e.status in ('pending','error') or (e.status='running' and
           (e.started_at is null or e.started_at <= now()-($3::integer * interval '1 minute')))))))
         or bool_and(t.ready and coalesce(e.status='ok' or e.attempts>=3,false)
           and not (e.status='running' and coalesce(e.started_at > now()-($3::integer * interval '1 minute'),false)))
     ) order by i.collected_at desc,i.id
     limit $1`,
    [Math.min(5, Math.max(1, limit)), EXTRACT_TARGET_LIMIT, EXTRACT_LEASE_MINUTES],
  );
  let ran = 0;
  let errors = 0;
  for (const row of rows) {
    const result = await extractItem(row.id, io);
    if (result.ok) ran += result.ran;
    else errors += 1;
  }
  return { ran, errors };
}
