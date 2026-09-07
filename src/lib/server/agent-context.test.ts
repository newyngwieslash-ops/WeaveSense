import assert from "node:assert/strict";
import test from "node:test";
import {
  shanghaiDayRange,
  selectTextSegments,
  selectAnalyzeSources,
  selectBriefingSources,
  validateCitations,
  materialFingerprint,
} from "./agent-context.ts";
import type { ItemRow } from "../types.ts";

function item(partial: Partial<ItemRow> & { id: string; body: string }): ItemRow {
  return {
    source_id: "s1",
    platform: "rss",
    external_id: partial.id,
    title: "标题",
    author: "作者",
    url: "https://example.com/" + partial.id,
    media_type: "article",
    media_urls: [],
    thumbnail_url: "",
    views: null,
    likes: null,
    published_at: "2026-09-07T01:00:00.000Z",
    collected_at: "2026-09-07T01:00:00.000Z",
    pipeline_status: "ingested",
    extra: {},
    matched_keywords: [],
    source_name: "信源",
    ...partial,
  };
}

test("selectTextSegments keeps head and tail of long bodies as separate fragments", () => {
  const body = "A".repeat(8000) + "MIDDLE" + "C".repeat(8000);
  const segs = selectTextSegments(body);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, 6000);
  assert.equal(segs[0].text, "A".repeat(6000));
  assert.equal(segs[1].end, 16_006);
  assert.equal(segs[1].start, 16_006 - 6000);
  assert.equal(segs[1].text.endsWith("C".repeat(6000)), true);
  assert.equal(segs[0].text.includes("MIDDLE") || segs[1].text.includes("MIDDLE"), false);
});

test("selectTextSegments uses unicode code points and CRLF to LF", () => {
  const segs = selectTextSegments("😀\r\nx");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, "😀\nx");
  assert.equal(segs[0].end, 3);
});

test("selectAnalyzeSources marks partial coverage and media_incomplete", () => {
  const long = item({ id: "item-1", body: "前".repeat(13000) + "OCR尾部内容" });
  const selected = selectAnalyzeSources(long, { mediaIncomplete: true });
  assert.equal(selected.coverage, "partial");
  assert.equal(selected.sources.length, 2);
  assert.ok(selected.sources[1].text.includes("OCR尾部内容"));
  assert.ok(selected.warnings.includes("media_incomplete"));
  assert.equal(selected.sources.reduce((n, s) => n + Array.from(s.text).length, 0) <= 24000, true);
});

test("zero material does not produce sources", () => {
  const selected = selectAnalyzeSources(item({ id: "empty", body: "   " }));
  assert.equal(selected.sources.length, 0);
  assert.ok(selected.warnings.includes("empty_body"));
});

test("shanghai midnight range is [from,to) UTC for a Shanghai civil day", () => {
  const range = shanghaiDayRange("2026-09-07");
  assert.equal(range.from, "2026-09-06T16:00:00.000Z");
  assert.equal(range.to, "2026-09-07T16:00:00.000Z");
});

test("briefing rejects ranges longer than 31 days and empty days", () => {
  const tooLong = selectBriefingSources([], {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-03-01T00:00:00.000Z",
  });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error, "date_range_too_long");
  const empty = selectBriefingSources([], shanghaiDayRange("2026-09-07"));
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.sources.length, 0);
    assert.ok(empty.warnings.includes("no_materials"));
  }
});

test("validateCitations keeps only exact quotes from this run's evidence", () => {
  const evidence = new Map([
    ["item:a:0", { evidence_id: "item:a:0", text: "alpha beta", item_id: "a", origin: "internal" as const }],
    ["item:b:0", { evidence_id: "item:b:0", text: "gamma", item_id: "b", origin: "internal" as const }],
  ]);
  const ok = validateCitations([
    { evidence_id: "item:a:0", quote: "alpha" },
    { evidence_id: "item:missing", quote: "nope" },
    { evidence_id: "item:b:0", quote: "not in text" },
  ], evidence);
  assert.equal(ok.ok, false);
  const one = validateCitations([{ evidence_id: "item:a:0", quote: "alpha" }], evidence);
  assert.equal(one.ok, true);
  if (one.ok) assert.equal(one.citations.length, 1);
});

test("materialFingerprint changes when body or title changes", () => {
  const a = materialFingerprint(item({ id: "x", body: "one", title: "t" }));
  const b = materialFingerprint(item({ id: "x", body: "one OCR", title: "t" }));
  const c = materialFingerprint(item({ id: "x", body: "one", title: "t2" }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});
