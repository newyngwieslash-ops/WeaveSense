import type { ItemRow } from "../types.ts";
import { hashCanonical } from "./agent-runs.ts";

export const ITEM_CODE_POINT_CAP = 12_000;
export const TASK_CODE_POINT_CAP = 24_000;
export const TOOL_CODE_POINT_CAP = 4_000;
export const MAX_BRIEFING_ITEMS = 12;
export const MAX_DATE_SPAN_DAYS = 31;

export type TextSegment = { start: number; end: number; text: string };
export type Coverage = "full" | "partial";

export type EvidenceSource = {
  evidence_id: string;
  item_id: string;
  title: string;
  platform: string;
  source_name: string;
  url: string;
  published_at: string | null;
  text: string;
  start: number;
  end: number;
  coverage: Coverage;
};

export type EvidenceReceipt = {
  evidence_id: string;
  item_id: string | null;
  text: string;
  origin: "internal" | "mcp";
};

export type Citation = { evidence_id: string; quote: string };

export function normalizeNewlines(body: string): string {
  return body.replace(/\r\n/g, "\n");
}

export function codePoints(text: string): string[] {
  return Array.from(normalizeNewlines(text));
}

export function selectTextSegments(body: string, cap = ITEM_CODE_POINT_CAP): TextSegment[] {
  if (!Number.isInteger(cap) || cap <= 0) throw new Error("invalid_cap");
  const chars = codePoints(body);
  if (chars.length <= cap) return [{ start: 0, end: chars.length, text: chars.join("") }];
  const head = Math.floor(cap / 2);
  const tail = cap - head;
  return [
    { start: 0, end: head, text: chars.slice(0, head).join("") },
    { start: chars.length - tail, end: chars.length, text: chars.slice(-tail).join("") },
  ];
}

export function materialFingerprint(item: ItemRow): string {
  return hashCanonical({
    id: item.id,
    title: item.title,
    body: normalizeNewlines(item.body),
    author: item.author,
    url: item.url,
    platform: item.platform,
    source_name: item.source_name ?? "",
    published_at: item.published_at,
  });
}

function toSources(item: ItemRow, segments: TextSegment[], coverage: Coverage): EvidenceSource[] {
  return segments.map((seg, index) => ({
    evidence_id: `item:${item.id}:${index}`,
    item_id: item.id,
    title: item.title,
    platform: item.platform,
    source_name: item.source_name ?? "",
    url: item.url,
    published_at: item.published_at,
    text: seg.text,
    start: seg.start,
    end: seg.end,
    coverage,
  }));
}

export function selectAnalyzeSources(item: ItemRow, opts: { mediaIncomplete?: boolean } = {}) {
  const warnings: string[] = [];
  const chars = codePoints(item.body);
  if (chars.join("").trim().length === 0) {
    return {
      sources: [] as EvidenceSource[],
      coverage: "full" as Coverage,
      warnings: ["empty_body"],
      materialHash: materialFingerprint(item),
    };
  }
  const segments = selectTextSegments(item.body);
  const coverage: Coverage = chars.length > ITEM_CODE_POINT_CAP ? "partial" : "full";
  if (coverage === "partial") warnings.push("partial_coverage");
  if (opts.mediaIncomplete) warnings.push("media_incomplete");
  return {
    sources: toSources(item, segments, coverage),
    coverage,
    warnings,
    materialHash: materialFingerprint(item),
  };
}

export function shanghaiDayRange(isoDate: string): { from: string; to: string } {
  const start = new Date(`${isoDate}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function spanDays(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

export function selectBriefingSources(
  items: ItemRow[],
  range: { from: string; to: string },
): { ok: true; sources: EvidenceSource[]; warnings: string[]; materialHash: string; coverage: Coverage }
  | { ok: false; error: string } {
  if (!Number.isFinite(Date.parse(range.from)) || !Number.isFinite(Date.parse(range.to)) || Date.parse(range.from) >= Date.parse(range.to)) {
    return { ok: false, error: "invalid_date_range" };
  }
  if (spanDays(range.from, range.to) > MAX_DATE_SPAN_DAYS) {
    return { ok: false, error: "date_range_too_long" };
  }
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const inRange = items.filter((item) => {
    const at = Date.parse(item.published_at ?? item.collected_at);
    return Number.isFinite(at) && at >= fromMs && at < toMs;
  });
  const warnings: string[] = [];
  if (inRange.length === 0) warnings.push("no_materials");
  const chosen = inRange.slice(0, MAX_BRIEFING_ITEMS);
  const perItem = Math.max(1, Math.floor(TASK_CODE_POINT_CAP / Math.max(chosen.length, 1)));
  const sources: EvidenceSource[] = [];
  let coverage: Coverage = "full";
  for (const item of chosen) {
    const segs = selectTextSegments(item.body, Math.min(ITEM_CODE_POINT_CAP, perItem));
    const itemCoverage: Coverage = codePoints(item.body).length > Math.min(ITEM_CODE_POINT_CAP, perItem) ? "partial" : "full";
    if (itemCoverage === "partial") coverage = "partial";
    sources.push(...toSources(item, segs, itemCoverage));
  }
  return {
    ok: true,
    sources,
    warnings,
    coverage,
    materialHash: hashCanonical({
      range,
      items: chosen.map((item) => ({ id: item.id, hash: materialFingerprint(item) })),
    }),
  };
}

export function selectResearchSeeds(items: ItemRow[]): {
  sources: EvidenceSource[];
  warnings: string[];
  materialHash: string;
  coverage: Coverage;
} {
  if (items.length === 0) {
    return { sources: [], warnings: ["no_matching_items"], materialHash: hashCanonical([]), coverage: "partial" };
  }
  const sources = items.flatMap((item) => {
    const segs = selectTextSegments(item.body, TOOL_CODE_POINT_CAP);
    const coverage: Coverage = codePoints(item.body).length > TOOL_CODE_POINT_CAP ? "partial" : "full";
    return toSources(item, segs, coverage);
  });
  return {
    sources,
    warnings: [],
    coverage: sources.some((s) => s.coverage === "partial") ? "partial" : "full",
    materialHash: hashCanonical(items.map((item) => materialFingerprint(item))),
  };
}

export function evidenceMap(sources: EvidenceSource[]): Map<string, EvidenceReceipt> {
  return new Map(sources.map((s) => [s.evidence_id, {
    evidence_id: s.evidence_id,
    item_id: s.item_id,
    text: s.text,
    origin: "internal",
  }]));
}

export function validateCitations(
  citations: Citation[],
  evidence: Map<string, EvidenceReceipt>,
): { ok: true; citations: Citation[] } | { ok: false; error: string } {
  const kept: Citation[] = [];
  for (const citation of citations) {
    const row = evidence.get(citation.evidence_id);
    if (!row) return { ok: false, error: "invalid_citation" };
    if (!row.text.includes(citation.quote)) return { ok: false, error: "invalid_citation" };
    kept.push(citation);
  }
  return { ok: true, citations: kept };
}
