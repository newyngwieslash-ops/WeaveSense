import type { ItemRow } from "../types.ts";
import { expandTerms } from "./term-glossary.ts";
import { hashCanonical } from "./agent-runs.ts";

export const ITEM_CODE_POINT_CAP = 12_000;
export const TASK_CODE_POINT_CAP = 24_000;
export const TOOL_CODE_POINT_CAP = 4_000;
export const MAX_BRIEFING_ITEMS = 12;
export const MAX_DATE_SPAN_DAYS = 31;

export type TextSegment = { start: number; end: number; text: string };
export type Coverage = "full" | "partial";
export type AuthorizedRange = { from: string; to: string } | null;

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
  material_fingerprint?: string;
  material_version?: number;
  authorized_range?: AuthorizedRange;
};

export type EvidenceReceipt = {
  evidence_id: string;
  item_id: string | null;
  text: string;
  origin: "internal" | "mcp";
  title?: string; url?: string; platform?: string; source_name?: string;
  published_at?: string | null;
  start?: number;
  end?: number;
  coverage?: Coverage;
  material_fingerprint?: string;
  material_version?: number;
  authorized_range?: AuthorizedRange;
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
    material_version: Number(item.material_version ?? 0),
  });
}

export function evidenceIdFor(item: { id: string; title: string; body: string; author: string; url: string; platform: string; source_name?: string; published_at: string | null; material_version?: number }, start: number, end: number): string {
  const hash = materialFingerprint(item as ItemRow).slice(0, 12);
  return `item:${item.id}:${hash}:${start}:${end}`;
}

export function evidenceSourceFor(item: ItemRow, seg: TextSegment, coverage: Coverage, range: AuthorizedRange = null): EvidenceSource {
  return {
    evidence_id: evidenceIdFor(item, seg.start, seg.end),
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
    material_fingerprint: materialFingerprint(item),
    ...(item.material_version != null ? { material_version: Number(item.material_version) } : {}),
    authorized_range: range ? { ...range } : null,
  };
}

function toSources(item: ItemRow, segments: TextSegment[], coverage: Coverage, range: AuthorizedRange = null): EvidenceSource[] {
  return segments.map(seg => evidenceSourceFor(item, seg, coverage, range));
}

/** Project the host snapshot onto the unchanged public /v1/execute source schema. */
export function runtimeSources(sources: readonly EvidenceSource[]) {
  return sources.map(({ evidence_id, item_id, title, platform, source_name, url, published_at, text, start, end, coverage }) =>
    ({ evidence_id, item_id, title, platform, source_name, url, published_at, text, start, end, coverage }));
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
  // One source per selected item keeps the public 12-source contract intact.
  // Fixed briefings have no retrieval tool. Prefer an explicit conclusion window;
  // every omitted region remains partial, never described as full coverage.
  for (const item of chosen) {
    const chars = codePoints(item.body);
    const end = Math.min(chars.length, ITEM_CODE_POINT_CAP, perItem);
    const itemCoverage: Coverage = end < chars.length ? "partial" : "full";
    if (itemCoverage === "partial") coverage = "partial";
    if (end > 0) sources.push(...toSources(item, [selectEvidenceWindow(item.body,end,"结论 总结 summary conclusion")], itemCoverage, range));
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

const STOPWORDS = new Set(["的", "了", "和", "与", "在", "是", "对", "及", "或", "the", "a", "an", "of", "to", "for"]);

export function splitQueryTerms(query: string): string[] {
  const raw = query
    .replace(/[，。！？、；：""''（）()[\]{}]/g, " ")
    .split(/[\s,./\\-]+/)
    .flatMap((part) => {
      if (/[\u4e00-\u9fff]/.test(part) && part.length >= 4) {
        const grams: string[] = [];
        for (let i = 0; i < part.length - 1; i += 1) grams.push(part.slice(i, i + 2));
        grams.push(part);
        return grams;
      }
      return [part];
    })
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t.toLowerCase()));
  return [...new Set(raw)].slice(0, 16);
}

export function scoreItemMatch(query: string, item: { title: string; body: string; author: string }): number {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return 0;
  // T15: a term's equivalent forms (e.g. 电动垂直起降 -> eVTOL) match too. The
  // relationship is declared as data in term-glossary.ts; matching stays lexical.
  const title = item.title.toLowerCase();
  const body = item.body.toLowerCase();
  const author = item.author.toLowerCase();
  let score = 0;
  for (const term of terms) {
    // The original term scores normally; an equivalent form scores a little less,
    // so a document that literally uses the question's wording still outranks one
    // that only matches through the glossary.
    const needles: [string, number][] = [[term.toLowerCase(), 1]];
    for (const equivalent of expandTerms(term)) needles.push([equivalent.toLowerCase(), 0.75]);
    for (const [needle, weight] of needles) {
      const position = (text: string) => /^[a-z0-9]+$/.test(needle)
        ? text.search(new RegExp(`(?<![a-z0-9])${needle}(?![a-z0-9])`)) : text.indexOf(needle);
      if (position(title) >= 0) score += 4 * weight;
      if (position(author) >= 0) score += 2 * weight;
      const firstHit = position(body);
      if (firstHit >= 0) score += (firstHit > body.length * 0.55 ? 3 : 1) * weight;
    }
  }
  return score;
}

export function rankRetrievedItems<T extends { title: string; body: string; author: string }>(
  query: string,
  items: T[],
  limit = 8,
): T[] {
  return [...items]
    .map((item) => ({ item, score: scoreItemMatch(query, item) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.item);
}

export function selectResearchSeeds(items: ItemRow[], query = ""): {
  sources: EvidenceSource[];
  warnings: string[];
  materialHash: string;
  coverage: Coverage;
} {
  if (items.length === 0) {
    return { sources: [], warnings: ["no_matching_items"], materialHash: hashCanonical([]), coverage: "partial" };
  }
  const chosen = items.slice(0, MAX_BRIEFING_ITEMS);
  const perItem = Math.max(1, Math.floor(TASK_CODE_POINT_CAP / Math.max(chosen.length, 1)));
  const sources = chosen.flatMap((item) => {
    const chars = codePoints(item.body);
    const end = Math.min(chars.length, TOOL_CODE_POINT_CAP, perItem);
    const coverage: Coverage = end < chars.length ? "partial" : "full";
    return end > 0 ? toSources(item, [selectEvidenceWindow(item.body,end,query)], coverage) : [];
  });
  return {
    sources,
    warnings: [],
    coverage: sources.some((s) => s.coverage === "partial") ? "partial" : "full",
    materialHash: hashCanonical(chosen.map((item) => materialFingerprint(item))),
  };
}

export function selectEvidenceWindow(body: string, cap: number, query: string): TextSegment {
  const chars = codePoints(body), normalized = chars.join("");
  if (chars.length <= cap) return { start: 0, end: chars.length, text: normalized };
  const terms = splitQueryTerms(query).map(t => t.toLowerCase());
  const lower = normalized.toLowerCase();
  let bestStart = 0, bestScore = -1;
  // ponytail: at most 16 first-hit windows; exhaustive multi-hit ranking needs eval evidence before expanding this bound.
  for (const term of terms) {
    const hit = lower.indexOf(term);
    if (hit < 0) continue;
    const point = Array.from(normalized.slice(0,hit)).length;
    const start = Math.max(0,Math.min(chars.length-cap,point-Math.floor(cap/3)));
    const window = chars.slice(start,start+cap).join("").toLowerCase();
    const score = terms.filter(t => window.includes(t)).length;
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  return { start: bestStart, end: bestStart+cap, text: chars.slice(bestStart,bestStart+cap).join("") };
}

export function rangePredicate(range: { from?: string; to?: string } | null, startIndex: number): { sql: string; params: unknown[] } {
  if (!range?.from || !range?.to) return { sql: "", params: [] };
  return {
    sql: ` and coalesce(i.published_at, i.collected_at) >= $${startIndex}::timestamptz and coalesce(i.published_at, i.collected_at) < $${startIndex + 1}::timestamptz`,
    params: [range.from, range.to],
  };
}

export function evidenceMap(sources: EvidenceSource[]): Map<string, EvidenceReceipt> {
  return new Map(sources.map((s) => [s.evidence_id, {
    ...s,
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
