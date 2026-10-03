import { getSql } from "../db.ts";
import { decodeHtmlEntities } from "../format.ts";
import { parsePlatformList } from "../keyword.ts";
import type { PlatformId } from "../platforms.ts";
import { isPlatform } from "../platforms.ts";
import type {
  AnalysisRow,
  ExtractJobView,
  ItemRow,
  JobRow,
  JsonScalar,
  KeywordRow,
  KnowledgeNote,
  MediaObjectRow,
  Overview,
  PlatformStat,
  SourceRow,
} from "../types.ts";
import { asBool, asInt, asJson, iso } from "./serialize.ts";

function platformOf(value: unknown): PlatformId {
  const s = String(value);
  return isPlatform(s) ? s : "rss";
}

function toScalarRecord(value: Record<string, unknown>): Record<string, JsonScalar> {
  const out: Record<string, JsonScalar> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v as JsonScalar;
    } else {
      out[k] = JSON.stringify(v).slice(0, 400);
    }
  }
  return out;
}

export function mapSource(row: Record<string, unknown>): SourceRow {
  return {
    id: String(row.id),
    platform: platformOf(row.platform),
    name: String(row.name),
    handle: String(row.handle ?? ""),
    url: String(row.url ?? ""),
    feed_url: String(row.feed_url ?? ""),
    interval_minutes: asInt(row.interval_minutes) ?? 30,
    enabled: asBool(row.enabled),
    last_external_id: String(row.last_external_id ?? ""),
    last_published_at: iso(row.last_published_at),
    last_scanned_at: iso(row.last_scanned_at),
    last_error: String(row.last_error ?? ""),
    status: (["idle", "running", "ok", "error"].includes(String(row.status))
      ? row.status
      : "idle") as SourceRow["status"],
    adapter: String(row.adapter ?? "rss") as SourceRow["adapter"],
    notes: String(row.notes ?? ""),
    created_at: iso(row.created_at) ?? new Date().toISOString(),
    item_count: asInt(row.item_count) ?? undefined,
  };
}

export function mapKeyword(row: Record<string, unknown>): KeywordRow {
  return {
    id: String(row.id),
    phrase: String(row.phrase),
    platforms: parsePlatformList(asJson<unknown[]>(row.platforms, [])),
    interval_minutes: asInt(row.interval_minutes) ?? 30,
    enabled: asBool(row.enabled),
    last_scanned_at: iso(row.last_scanned_at),
    last_error: String(row.last_error ?? ""),
    status: (["idle", "running", "ok", "error"].includes(String(row.status))
      ? row.status
      : "idle") as KeywordRow["status"],
    hits: asInt(row.hits) ?? 0,
    notes: String(row.notes ?? ""),
    created_at: iso(row.created_at) ?? new Date().toISOString(),
  };
}

export function mapItem(row: Record<string, unknown>): ItemRow {
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    platform: platformOf(row.platform),
    external_id: String(row.external_id),
    title: decodeHtmlEntities(String(row.title ?? "")),
    body: decodeHtmlEntities(String(row.body ?? "")),
    author: decodeHtmlEntities(String(row.author ?? "")),
    url: String(row.url ?? ""),
    media_type: (row.media_type as ItemRow["media_type"]) ?? "article",
    media_urls: asJson<string[]>(row.media_urls, []),
    thumbnail_url: String(row.thumbnail_url ?? ""),
    views: asInt(row.views),
    likes: asInt(row.likes),
    published_at: iso(row.published_at),
    collected_at: iso(row.collected_at) ?? new Date().toISOString(),
    pipeline_status: (row.pipeline_status as ItemRow["pipeline_status"]) ?? "ingested",
    extra: toScalarRecord(asJson<Record<string, unknown>>(row.extra, {})),
    matched_keywords: asJson<string[]>(row.matched_keywords, []),
    source_name: row.source_name ? String(row.source_name) : undefined,
  };
}

export function mapJob(row: Record<string, unknown>): JobRow {
  const provider = String(row.provider ?? "");
  const attempts = asJson<unknown>(row.attempts, []);
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    platform: platformOf(row.platform),
    started_at: iso(row.started_at) ?? new Date().toISOString(),
    finished_at: iso(row.finished_at),
    status: (row.status as JobRow["status"]) ?? "ok",
    items_found: asInt(row.items_found) ?? 0,
    items_new: asInt(row.items_new) ?? 0,
    error: String(row.error ?? ""),
    kind: String(row.kind ?? "incremental"),
    provider: (["", "primary", "dajiala", "mixed"].includes(provider) ? provider : "") as JobRow["provider"],
    attempts: (Array.isArray(attempts) ? attempts : [])
      .filter((attempt): attempt is string => typeof attempt === "string")
      .map((attempt) => attempt.slice(0, 80)).slice(0, 8),
    paid_call: asBool(row.paid_call),
    keyword_id: row.keyword_id ? String(row.keyword_id) : "",
    source_name: row.source_name ? String(row.source_name) : undefined,
  };
}

function runMeta(row: Record<string, unknown>): { run_id: string | null; coverage: "full" | "partial" | "unknown"; warnings: string[] } {
  const runId = row.run_id == null || row.run_id === "" ? null : String(row.run_id);
  const response = asJson<Record<string, unknown>>(row.response_json, {});
  const result = asJson<Record<string, unknown>>(response.result, {});
  const coverage = result.coverage === "full" || result.coverage === "partial" ? result.coverage : runId ? "unknown" : "unknown";
  return {
    run_id: runId,
    coverage: runId ? coverage : "unknown",
    warnings: asJson<string[]>(result.warnings, []),
  };
}

export function mapAnalysis(row: Record<string, unknown>): AnalysisRow {
  const meta = runMeta(row);
  return {
    id: String(row.id),
    item_id: String(row.item_id),
    summary: String(row.summary ?? ""),
    topics: asJson<string[]>(row.topics, []),
    entities: asJson<string[]>(row.entities, []),
    insights: String(row.insights ?? ""),
    tags: asJson<string[]>(row.tags, []),
    model: String(row.model ?? "grok-4.5"),
    created_at: iso(row.created_at) ?? new Date().toISOString(),
    run_id: meta.run_id,
    coverage: meta.coverage,
    warnings: meta.warnings,
  };
}

export function mapNote(row: Record<string, unknown>): KnowledgeNote {
  const meta = runMeta(row);
  const response = asJson<Record<string, unknown>>(row.response_json, {});
  const result = asJson<Record<string, unknown>>(response.result, {});
  const evidence = asJson<Record<string, unknown>[]>(response.verified_evidence, []);
  const citations = asJson<{ evidence_id: string; quote: string }[]>(result.citations, []).flatMap(c => {
    const source = evidence.find(e => e.evidence_id === c.evidence_id);
    return source ? [{ evidence_id:c.evidence_id, item_id:source.item_id == null ? null : String(source.item_id), title:String(source.title ?? "来源"),url:String(source.url ?? ""),quote:c.quote }] : [];
  });
  return {
    id: String(row.id),
    title: String(row.title),
    content: String(row.content),
    kind: (row.kind as KnowledgeNote["kind"]) ?? "briefing",
    item_ids: asJson<string[]>(row.item_ids, []),
    created_at: iso(row.created_at) ?? new Date().toISOString(),
    run_id: meta.run_id,
    coverage: meta.coverage,
    warnings: meta.warnings,
    insufficient_evidence: Boolean(result.insufficient_evidence),
    citations,
  };
}

export function mapMediaObject(row: Record<string, unknown>): MediaObjectRow {
  return {
    id: String(row.id),
    source_url: String(row.source_url ?? ""),
    object_key: String(row.object_key ?? ""),
    public_url: String(row.public_url ?? ""),
    content_type: String(row.content_type ?? ""),
    bytes: asInt(row.bytes),
    kind: String(row.kind ?? "file"),
    status: String(row.status ?? "remote"),
    error: String(row.error ?? ""),
  };
}

export function mapExtractJob(row: Record<string, unknown>): ExtractJobView {
  return {
    id: String(row.id),
    kind: String(row.kind ?? ""),
    status: String(row.status ?? "pending"),
    result_text: String(row.result_text ?? ""),
    model: String(row.model ?? ""),
    error: String(row.error ?? ""),
    created_at: iso(row.created_at) ?? new Date().toISOString(),
  };
}

export async function listSources(): Promise<SourceRow[]> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select s.*, coalesce(c.n, 0) as item_count
     from sources s
     left join (select source_id, count(*)::int as n from items group by source_id) c
       on c.source_id = s.id
     order by s.platform, s.name`,
  );
  return rows.map(mapSource);
}

export async function listKeywords(): Promise<KeywordRow[]> {
  const sql = await getSql();
  const rows = await sql.query<Record<string, unknown>>(
    `select * from keywords order by created_at desc`,
  );
  return rows.map(mapKeyword);
}

export async function getOverview(): Promise<Overview> {
  const sql = await getSql();
  const [counts] = await sql.query<Record<string, unknown>>(
    `select
        (select count(*)::int from sources) as source_count,
        (select count(*)::int from sources where enabled) as enabled_count,
        (select count(*)::int from items) as item_count,
        (select count(*)::int from jobs) as job_count,
        (select count(*)::int from analyses) as analysis_count,
        (select count(*)::int from knowledge_notes) as note_count,
        (select count(*)::int from items where collected_at > now() - interval '24 hours') as new_24h,
        (select count(*)::int from sources where enabled and (last_scanned_at is null or last_scanned_at < now() - (interval_minutes * interval '1 minute'))) as due_count,
        (select count(*)::int from keywords) as keyword_count,
        (select count(*)::int from keywords where enabled) as keyword_enabled,
        (select count(*)::int from keywords where enabled and (last_scanned_at is null or last_scanned_at < now() - (interval_minutes * interval '1 minute'))) as keyword_due,
        (select coalesce(sum(hits), 0)::int from keywords) as keyword_hits`,
  );
  const platformRows = await sql.query<Record<string, unknown>>(
    `select s.platform,
            count(*)::int as sources,
            count(*) filter (where s.enabled)::int as enabled,
            coalesce(max(i.n), 0)::int as items,
            max(s.last_scanned_at) as last_scanned_at,
            coalesce(max(s.status), 'idle') as status
     from sources s
     left join (select platform, count(*)::int as n from items group by platform) i
       on i.platform = s.platform
     group by s.platform`,
  );
  const recentItems = await sql.query<Record<string, unknown>>(
    `select i.*, s.name as source_name
     from items i join sources s on s.id = i.source_id
     order by coalesce(i.published_at, i.collected_at) desc
     limit 8`,
  );
  const recentJobs = await sql.query<Record<string, unknown>>(
    `select j.*, coalesce(nullif(k.phrase, ''), s.name) as source_name
     from jobs j
     left join sources s on s.id = j.source_id
     left join keywords k on k.id = j.keyword_id
     order by j.started_at desc
     limit 8`,
  );
  const recentKeywords = await sql.query<Record<string, unknown>>(
    `select * from keywords order by last_scanned_at desc nulls last, created_at desc limit 8`,
  );
  const platforms: PlatformStat[] = platformRows.map((r) => ({
    platform: platformOf(r.platform),
    sources: asInt(r.sources) ?? 0,
    enabled: asInt(r.enabled) ?? 0,
    items: asInt(r.items) ?? 0,
    last_scanned_at: iso(r.last_scanned_at),
    status: String(r.status ?? "idle"),
  }));
  return {
    seeded: true,
    source_count: asInt(counts?.source_count) ?? 0,
    enabled_count: asInt(counts?.enabled_count) ?? 0,
    item_count: asInt(counts?.item_count) ?? 0,
    job_count: asInt(counts?.job_count) ?? 0,
    analysis_count: asInt(counts?.analysis_count) ?? 0,
    note_count: asInt(counts?.note_count) ?? 0,
    new_24h: asInt(counts?.new_24h) ?? 0,
    due_count: asInt(counts?.due_count) ?? 0,
    keyword_count: asInt(counts?.keyword_count) ?? 0,
    keyword_enabled: asInt(counts?.keyword_enabled) ?? 0,
    keyword_due: asInt(counts?.keyword_due) ?? 0,
    keyword_hits: asInt(counts?.keyword_hits) ?? 0,
    platforms,
    recent_items: recentItems.map(mapItem),
    recent_jobs: recentJobs.map(mapJob),
    recent_keywords: recentKeywords.map(mapKeyword),
  };
}
