import assert from "node:assert/strict";
import test from "node:test";
import { selectResearchSeeds, selectBriefingSources } from "../../../src/lib/server/agent-context.ts";
import type { ItemRow } from "../../../src/lib/types.ts";

function rows(n: number): ItemRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `i${i}`, source_id: "s", platform: "rss", external_id: `e${i}`,
    title: "Battery", body: "文".repeat(5000), author: "author", url: "https://example.com", source_name: "source",
    media_type: "article", media_urls: [], thumbnail_url: "", views: null, likes: null,
    published_at: "2026-09-07T01:00:00Z", collected_at: "2026-09-07T01:00:00Z", pipeline_status: "ingested",
    extra: {}, matched_keywords: [] }));
}
test("M01 research eight long candidates fit shared source and text caps", () => {
  const result = selectResearchSeeds(rows(8));
  const chars = result.sources.reduce((n, source) => n + [...source.text].length, 0);
  assert.ok(result.sources.length <= 12 && chars <= 24000, JSON.stringify({ sources: result.sources.length, chars }));
});
test("M02 briefing twelve long candidates fit shared source cap", () => {
  const result = selectBriefingSources(rows(12), { from: "2026-09-07T00:00:00Z", to: "2026-09-08T00:00:00Z" });
  assert.ok(result.ok);
  assert.ok(result.sources.length <= 12, JSON.stringify({ sources: result.sources.length }));
});
