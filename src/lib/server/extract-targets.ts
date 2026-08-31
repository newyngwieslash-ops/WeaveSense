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

function kindOf(target: ExtractTarget): "ocr" | "asr" | null {
  if (target.content_type.startsWith("image/") || target.kind === "image") return "ocr";
  if (target.content_type.startsWith("audio/") || target.content_type.startsWith("video/")
    || target.kind === "audio" || target.kind === "video") return "asr";
  return null;
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
  const eligible = targets.slice(0, 4).map((target) => ({ target, kind: kindOf(target),
    key: extractTargetKey(target) })).filter((entry): entry is typeof entry & { kind: "ocr" | "asr" } =>
    entry.kind !== null);
  if (!eligible.length) return { ok: false, ran: 0, error: "没有可 OCR/ASR 的媒体" };
  let ran = 0;
  let lastError = "";
  for (const { target, kind, key } of eligible) {
    const jobId = randomUUID();
    const claimToken = randomUUID();
    await sql.query(`insert into extract_jobs (id, item_id, media_id, target_key, kind, status)
      values ($1,$2,$3,$4,$5,'pending') on conflict (item_id, target_key) do nothing`,
    [jobId, itemId, target.id, key, kind]);
    const [claimed] = await sql.query<{ id: string }>(`update extract_jobs
      set status='running', attempts=attempts+1, error='', finished_at=null, started_at=now(), claim_token=$3
      where item_id=$1 and target_key=$2 and attempts < 3
        and (status in ('pending','error')
          or (status='running' and (started_at is null or started_at <= now() - interval '15 minutes')))
      returning id`, [itemId, key, claimToken]);
    if (!claimed) continue;
    try {
      const file = await load(target);
      const result = kind === "ocr" ? await ocr(file.bytes, file.contentType)
        : await asr(file.bytes, "media.mp4");
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
  return terminal ? { ok: true, ran } : { ok: false, ran, error: lastError || "提取尚未完成" };
}
