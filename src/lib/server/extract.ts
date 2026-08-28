import { getSql } from "@/lib/db";
import { shortId } from "@/lib/utils";
import { getObject } from "./storage";

const VISION_MODEL = "grok-4.5";
const STT_MODEL = "grok-stt";

function xaiKey(): string {
  return (process.env.XAI_API_KEY ?? "").trim();
}

export function xaiReady(): boolean {
  return Boolean(xaiKey());
}

async function fetchBytes(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
  if (!res.ok) throw new Error(`下载媒体 HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { bytes, contentType };
}

async function loadMedia(row: {
  object_key: string;
  source_url: string;
  public_url: string;
  content_type: string;
}): Promise<{ bytes: Buffer; contentType: string }> {
  if (row.object_key) {
    const stored = await getObject(row.object_key);
    if (stored.ok) return { bytes: stored.bytes, contentType: row.content_type || "application/octet-stream" };
  }
  const url = row.public_url || row.source_url;
  if (!url.startsWith("http")) throw new Error("没有可读取的媒体地址");
  return fetchBytes(url);
}

export async function ocrBytes(bytes: Buffer, contentType: string): Promise<{ text: string; model: string }> {
  const key = xaiKey();
  if (!key) throw new Error("未启用 XAI_API_KEY，无法 OCR");
  const mime = contentType.startsWith("image/") ? contentType : "image/jpeg";
  const capped = bytes.length > 4_500_000 ? bytes.subarray(0, 4_500_000) : bytes;
  const dataUrl = `data:${mime};base64,${capped.toString("base64")}`;
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

function kindOf(contentType: string, mediaKind: string): "ocr" | "asr" | null {
  if (contentType.startsWith("image/") || mediaKind === "image") return "ocr";
  if (contentType.startsWith("audio/") || contentType.startsWith("video/") || mediaKind === "audio" || mediaKind === "video") {
    return "asr";
  }
  return null;
}

async function appendExtract(itemId: string, label: string, text: string): Promise<void> {
  if (!text) return;
  const sql = await getSql();
  const [row] = await sql.query<{ body: string }>("select body from items where id = $1", [itemId]);
  const body = row?.body ?? "";
  if (body.includes(`[${label}]`)) return;
  const next = `${body}${body ? "\n\n" : ""}[${label}]\n${text}`.slice(0, 16000);
  await sql.query("update items set body = $2, pipeline_status = 'extracted' where id = $1", [itemId, next]);
}

export async function extractItem(itemId: string): Promise<{
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
  }>("select * from media_objects where item_id = $1 order by created_at", [itemId]);

  let targets = media;
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
      kind: item?.media_type === "image" ? "image" : item?.media_type === "video" ? "video" : "file",
    }));
  }

  if (!targets.length) return { ok: false, ran: 0, error: "这条没有可提取的图片或音视频" };

  let ran = 0;
  let lastError = "";
  for (const m of targets.slice(0, 4)) {
    const jobKind = kindOf(m.content_type, m.kind);
    if (!jobKind) continue;
    const jobId = shortId();
    await sql.query(
      `insert into extract_jobs (id, item_id, media_id, kind, status) values ($1,$2,$3,$4,'running')`,
      [jobId, itemId, m.id, jobKind],
    );
    try {
      const file = await loadMedia(m);
      const result =
        jobKind === "ocr"
          ? await ocrBytes(file.bytes, file.contentType)
          : await transcribeBytes(file.bytes, jobKind === "asr" ? "media.mp4" : "file.bin");
      await sql.query(
        `update extract_jobs set status = 'ok', result_text = $2, model = $3, finished_at = now(), error = '' where id = $1`,
        [jobId, result.text.slice(0, 12000), result.model],
      );
      await appendExtract(itemId, jobKind.toUpperCase(), result.text);
      ran += 1;
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
      await sql.query(
        `update extract_jobs set status = 'error', error = $2, finished_at = now() where id = $1`,
        [jobId, lastError],
      );
    }
  }

  if (!ran) return { ok: false, ran: 0, error: lastError || "没有可 OCR/ASR 的媒体" };
  return { ok: true, ran };
}

export async function extractPending(limit = 3): Promise<{ ran: number; errors: number }> {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `select id from items
     where pipeline_status = 'ingested'
       and media_urls <> '[]'::jsonb
     order by collected_at desc
     limit $1`,
    [Math.min(5, Math.max(1, limit))],
  );
  let ran = 0;
  let errors = 0;
  for (const row of rows) {
    const result = await extractItem(row.id);
    if (result.ok) ran += result.ran;
    else errors += 1;
  }
  return { ran, errors };
}
