import { createHash, randomUUID } from "node:crypto";

type QuerySql = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export type ExtractTarget = {
  id: string;
  source_url: string;
  object_key: string;
  public_url: string;
  content_type: string;
  kind: string;
};

type Extracted = { text: string; model: string };

/**
 * Which model should handle this target: OCR (vision) or ASR (speech).
 *
 * T12: the *served* content type wins over the declared kind, because the
 * declared kind describes the entry, not the file. A B 站 video entry carries its
 * JPEG cover as its only media — declaring it `video` and sending it to the
 * speech model spends a paid STT call on a still image and can only return
 * garbage. `kind` is therefore only a fallback for targets whose content type is
 * not yet known.
 *
 * `contentType` is what the fetch actually reported; `kind` is the stored/declared
 * hint. Returns null when neither can classify it, so the caller refuses rather
 * than guessing.
 */
export function kindOf(target: ExtractTarget, contentType = target.content_type): "ocr" | "asr" | null {
  const mime = (contentType || "").toLowerCase();
  if (mime.startsWith("image/")) return "ocr";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "asr";
  if (mime) {
    // A known-but-unclassifiable MIME (application/pdf, octet-stream) must not
    // fall through to the declared kind and reach a paid model by accident.
    return null;
  }
  if (target.kind === "image") return "ocr";
  if (target.kind === "audio" || target.kind === "video") return "asr";
  return null;
}

/** A filename the speech model can trust: the extension follows the real MIME. */
export function asrFilename(contentType: string): string {
  const mime = (contentType || "").toLowerCase();
  if (mime.startsWith("audio/")) {
    if (mime.includes("mpeg") || mime.includes("mp3")) return "media.mp3";
    if (mime.includes("wav")) return "media.wav";
    if (mime.includes("ogg")) return "media.ogg";
    if (mime.includes("aac")) return "media.aac";
    if (mime.includes("m4a") || mime.includes("mp4")) return "media.m4a";
    return "media.audio";
  }
  if (mime.startsWith("video/")) {
    if (mime.includes("webm")) return "media.webm";
    if (mime.includes("quicktime") || mime.includes("mov")) return "media.mov";
    return "media.mp4";
  }
  return "media.bin";
}

export function extractTargetKey(target: ExtractTarget): string {
  if (target.id) return target.id;
  return `url:${createHash("sha256").update(target.public_url || target.source_url).digest("hex")}`;
}

async function commitResult(sql: QuerySql, jobId: string, claimToken: string, itemId: string, label: string,
  result: Extracted): Promise<void> {
  const text = result.text.slice(0, 12000);
  if (!text) {
    const rows = await sql.query(`update extract_jobs set status='ok', result_text='', model=$2,
      finished_at=now(), error='', claim_token=''
      where id=$1 and claim_token=$3 and status='running' returning id`,
    [jobId, result.model, claimToken]);
    if (rows.length !== 1) throw new Error("extraction claim lost");
    return;
  }
  const marker = `[${label}]`;
  const [row] = await sql.query<{ committed: number }>(`with finished as (
      update extract_jobs set status='ok', result_text=$3, model=$4,
        finished_at=now(), error='', claim_token=''
      where id=$1 and claim_token=$2 and status='running'
        and exists (select 1 from items where id=$5)
      returning id
    ), appended as (
      update items set body = body || case when body='' then '' else E'\n\n' end || $7
      where id=$5 and exists (select 1 from finished) and position($6 in body)=0
      returning id
    )
    select count(*)::int as committed from finished`,
  [jobId, claimToken, text, result.model, itemId, marker, `${marker}\n${text}`]);
  if (row?.committed !== 1) throw new Error("extraction commit failed");
}

export async function runExtractTargets({ sql, itemId, targets, load, ocr, asr }: {
  sql: QuerySql;
  itemId: string;
  targets: ExtractTarget[];
  load: (target: ExtractTarget) => Promise<{ bytes: Buffer; contentType: string }>;
  ocr: (bytes: Buffer, contentType: string) => Promise<Extracted>;
  asr: (bytes: Buffer, filename: string) => Promise<Extracted>;
}): Promise<{ ok: boolean; ran: number; error?: string }> {
  // Candidates are the first few targets; whether each one is OCR or ASR is
  // decided per target, after its bytes are loaded, because the *served* content
  // type is the honest signal (see kindOf).
  const eligible = targets.slice(0, 4).map((target) => ({ target, key: extractTargetKey(target) }));
  if (!eligible.length) return { ok: false, ran: 0, error: "没有可 OCR/ASR 的媒体" };
  let ran = 0;
  let lastError = "";
  let classified = 0;
  for (const { target, key } of eligible) {
    // The declared kind decides the *job* row, so a reload still short-circuits on
    // the existing row; the served type is re-checked before any model call.
    const jobKind = target.kind === "audio" || target.kind === "video" ? "asr" : "ocr";
    const kind = kindOf(target) ?? jobKind;
    const jobId = randomUUID();
    const claimToken = randomUUID();
    await sql.query(`insert into extract_jobs (id, item_id, media_id, target_key, kind, status)
      values ($1,$2,$3,$4,$5,'pending') on conflict (item_id, target_key) do nothing`,
    [jobId, itemId, target.id, key, jobKind]);
    const [claimed] = await sql.query<{ id: string }>(`update extract_jobs
      set status='running', attempts=attempts+1, error='', finished_at=null, started_at=now(), claim_token=$3
      where item_id=$1 and target_key=$2 and attempts < 3
        and (status in ('pending','error')
          or (status='running' and (started_at is null or started_at <= now() - interval '15 minutes')))
      returning id`, [itemId, key, claimToken]);
    if (!claimed) continue;
    try {
      const file = await load(target);
      // Re-decide with the served type: this is what prevents a still image from
      // being billed as speech.
      const decided = kindOf({ ...target, content_type: file.contentType }, file.contentType);
      if (decided === null) {
        // Nothing can be extracted here. Close the job honestly (it is not a
        // provider failure) and never call a paid model.
        await sql.query(`update extract_jobs set status='ok', result_text='', model='',
          finished_at=now(), error='unsupported_media_type', claim_token=''
          where id=$1 and claim_token=$2 and status='running'`,
        [claimed.id, claimToken]);
        continue;
      }
      classified += 1;
      const result = decided === "ocr" ? await ocr(file.bytes, file.contentType)
        : await asr(file.bytes, asrFilename(file.contentType));
      await commitResult(sql, claimed.id, claimToken, itemId, `${kind.toUpperCase()}:${key.slice(0, 16)}`, result);
      ran += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      await sql.query(`update extract_jobs set status='error', error=$2, finished_at=now(), claim_token=''
        where id=$1 and claim_token=$3 and status='running'`, [claimed.id, lastError, claimToken]);
    }
  }
  const states = await sql.query<{ status: string; attempts: number }>(
    "select status, attempts from extract_jobs where item_id=$1 and target_key=any($2::text[])",
    [itemId, eligible.map(({ key }) => key)],
  );
  const terminal = states.length === eligible.length
    && states.every(({ status, attempts }) => status === "ok" || Number(attempts) >= 3);
  await sql.query("update items set pipeline_status=$2 where id=$1", [itemId, terminal ? "extracted" : "ingested"]);
  if (!terminal) return { ok: false, ran, error: lastError || "提取尚未完成" };
  // Terminal. Distinguish "nothing here was ever extractable" from "already done":
  // a target that succeeded on a previous run is a clean no-op, not a failure —
  // otherwise every page refresh would report an error.
  const anySucceededBefore = states.some(({ status }) => status === "ok");
  if (classified === 0 && !anySucceededBefore) {
    return { ok: false, ran: 0, error: "没有可 OCR/ASR 的媒体" };
  }
  return { ok: true, ran };
}
