import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import { shortId } from "@/lib/utils";
import { asJson } from "./serialize";
import { minioConfigured } from "./config";
import { putObject } from "./storage";

function guessKind(url: string, mediaType: string): string {
  const u = url.toLowerCase();
  if (mediaType === "image" || /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/.test(u)) return "image";
  if (mediaType === "video" || /\.(mp4|mov|webm|mkv)(\?|$)/.test(u)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg)(\?|$)/.test(u)) return "audio";
  return mediaType === "file" ? "file" : "file";
}

export async function enqueueItemMedia(itemId: string, urls: string[], mediaType: string): Promise<number> {
  const sql = await getSql();
  let n = 0;
  for (const url of urls.slice(0, 8)) {
    if (!url) continue;
    const [exists] = await sql.query<{ id: string }>(
      "select id from media_objects where item_id = $1 and source_url = $2 limit 1",
      [itemId, url.slice(0, 1500)],
    );
    if (exists) continue;
    await sql.query(
      `insert into media_objects (id, item_id, source_url, kind, status, public_url)
       values ($1,$2,$3,$4,'remote',$3)`,
      [shortId(), itemId, url.slice(0, 1500), guessKind(url, mediaType)],
    );
    n += 1;
  }
  return n;
}

export async function ingestPending(limit = 6): Promise<{ stored: number; errors: number }> {
  if (!minioConfigured()) return { stored: 0, errors: 0 };
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    item_id: string;
    source_url: string;
    kind: string;
  }>("select id, item_id, source_url, kind from media_objects where status = 'remote' order by created_at limit $1", [
    Math.min(20, Math.max(1, limit)),
  ]);
  let stored = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      if (!row.source_url.startsWith("http")) {
        await sql.query("update media_objects set status = 'error', error = $2 where id = $1", [
          row.id,
          "无远程地址",
        ]);
        errors += 1;
        continue;
      }
      const res = await fetch(row.source_url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const sha = createHash("sha256").update(buf).digest("hex");
      const ext = contentType.includes("png")
        ? "png"
        : contentType.includes("jpeg") || contentType.includes("jpg")
          ? "jpg"
          : contentType.includes("mp4")
            ? "mp4"
            : contentType.includes("webm")
              ? "webm"
              : "bin";
      const key = `${row.item_id}/${row.id}.${ext}`;
      const put = await putObject(key, buf, contentType);
      if (!put.ok) throw new Error(put.error || "上传失败");
      await sql.query(
        `update media_objects
         set status = 'stored', object_key = $2, public_url = $3, content_type = $4, bytes = $5, sha256 = $6, error = ''
         where id = $1`,
        [row.id, key, put.url, contentType.slice(0, 120), buf.length, sha],
      );
      const [item] = await sql.query<{ media_urls: unknown; thumbnail_url: string }>(
        "select media_urls, thumbnail_url from items where id = $1",
        [row.item_id],
      );
      if (item) {
        const urls = asJson<string[]>(item.media_urls, []).map((u) => (u === row.source_url ? put.url : u));
        const thumb = item.thumbnail_url === row.source_url ? put.url : item.thumbnail_url;
        await sql.query("update items set media_urls = $2::jsonb, thumbnail_url = $3 where id = $1", [
          row.item_id,
          JSON.stringify(urls),
          thumb,
        ]);
      }
      stored += 1;
    } catch (err) {
      errors += 1;
      await sql.query("update media_objects set status = 'error', error = $2 where id = $1", [
        row.id,
        err instanceof Error ? err.message.slice(0, 300) : String(err),
      ]);
    }
  }
  return { stored, errors };
}
