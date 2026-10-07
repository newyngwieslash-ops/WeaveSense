import assert from "node:assert/strict";
import test from "node:test";
import {
  shanghaiDayRange,
  selectTextSegments,
  selectAnalyzeSources,
  selectBriefingSources,
  rankRetrievedItems,
  splitQueryTerms,
  validateCitations,
  materialFingerprint,
  selectResearchSeeds,
  evidenceMap,
  runtimeSources,
} from "./agent-context.ts";

test('V7 selected query and briefing conclusion windows include tail proof and disclose partial coverage',()=>{
 const row=item({id:'tail',body:'背景。'.repeat(9000)+'结论 quantum separator 良率为97%。'});
 const research=selectResearchSeeds([row],'quantum separator');
 assert.equal(research.coverage,'partial');assert.match(research.sources[0].text,/quantum separator/);
 assert.ok(research.sources[0].start>0);
 const briefing=selectBriefingSources([row],{from:'2026-09-07T00:00:00Z',to:'2026-09-08T00:00:00Z'});
 assert.ok(briefing.ok);if(briefing.ok){assert.equal(briefing.coverage,'partial');assert.match(briefing.sources.map(s=>s.text).join(''),/良率为97%/);}
 assert.notEqual(materialFingerprint(row),materialFingerprint({...row,material_version:1}));
});
import type { ItemRow } from "../types.ts";
import { mapAgentItem } from './agent-retrieval.ts';

test('V7 shared DB material mapping retains Date milliseconds in fingerprints',()=>{
 const date=new Date('2026-09-08T07:00:00.789Z');
 const row=item({id:'millis',body:'same material',published_at:date.toISOString()});
 const mapped=mapAgentItem({...row,published_at:date});
 assert.equal(mapped.published_at,date.toISOString());
 assert.equal(materialFingerprint(mapped),materialFingerprint(row));
});

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

test("query split and field weights prefer title and late-body facts", () => {
  const terms = splitQueryTerms("固态电池量产卡点");
  assert.ok(terms.includes("固态") || terms.includes("固态电池量产卡点") || terms.some((t) => t.includes("固态")));
  const ranked = rankRetrievedItems("固态电池量产卡点", [
    item({ id: "noise", title: "今日天气", body: "晴" }),
    item({ id: "late", title: "纪要", body: "A".repeat(80) + "固态电池量产仍缺电解液" }),
    item({ id: "title", title: "固态电池量产卡点", body: "概述" }),
  ], 8);
  assert.equal(ranked[0].id, "title");
  assert.ok(ranked.some((row) => row.id === "late"));
  assert.equal(ranked.some((row) => row.id === "noise"), false);
});

test("materialFingerprint changes when body or title changes", () => {
  const a = materialFingerprint(item({ id: "x", body: "one", title: "t" }));
  const b = materialFingerprint(item({ id: "x", body: "one OCR", title: "t" }));
  const c = materialFingerprint(item({ id: "x", body: "one", title: "t2" }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("trusted seed metadata retains full fingerprint, version and authorized range outside the v1 envelope", () => {
  const row = item({ id: "versioned", body: "😀\r\n证据正文", material_version: 7 });
  const range = { from: "2026-09-07T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" };
  const selected = selectBriefingSources([row], range);
  assert.ok(selected.ok);
  if (!selected.ok) return;
  const [source] = selected.sources;
  assert.equal(source.material_fingerprint, materialFingerprint(row));
  assert.equal(source.material_fingerprint!.length, 64);
  assert.equal(source.material_version, 7);
  assert.deepEqual(source.authorized_range, range);
  const receipt = evidenceMap(selected.sources).get(source.evidence_id)!;
  assert.equal(receipt.material_fingerprint, source.material_fingerprint);
  assert.equal(receipt.material_version, 7);
  assert.deepEqual(receipt.authorized_range, range);
  assert.equal(receipt.end! - receipt.start!, Array.from(receipt.text).length);
  assert.equal(receipt.coverage, "full");
  const [runtime] = runtimeSources(selected.sources);
  assert.equal("material_fingerprint" in runtime, false);
  assert.equal("material_version" in runtime, false);
  assert.equal("authorized_range" in runtime, false);
  assert.equal(runtime.text, source.text);
  const [legacy] = selectResearchSeeds([item({ id: "legacy", body: "旧素材" })]).sources;
  assert.equal(legacy.material_version, undefined);
});
