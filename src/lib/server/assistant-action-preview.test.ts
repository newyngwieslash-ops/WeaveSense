import assert from "node:assert/strict";
import test from "node:test";
import { buildActionPreview } from "./assistant-action-preview.ts";
import type { AssistantAction } from "../assistant-contract.ts";

/**
 * Task 11 preview builder: pure, host-rendered Chinese previews whose digest
 * binds kind + args + observed config + policy + expiry (A11/A25).
 */

const kwUpdate: AssistantAction = {
  ordinal: 0,
  kind: "keyword.update",
  args: { keyword_id: "kw-ex", interval: 5 },
};

test("preview is pure: same inputs, same digest; args change, digest changes", () => {
  const a = buildActionPreview(kwUpdate, { interval: 60, platforms: ["rss"], enabled: true }, "act-1");
  const b = buildActionPreview(kwUpdate, { interval: 60, platforms: ["rss"], enabled: true }, "act-1");
  assert.equal(a.digest, b.digest);
  const c = buildActionPreview(kwUpdate, { interval: 90, platforms: ["rss"], enabled: true }, "act-1");
  assert.notEqual(a.digest, c.digest, "changed expected state must invalidate the digest");
});

test("preview binds the action id and expiry", () => {
  const a = buildActionPreview(kwUpdate, null, "act-1");
  const b = buildActionPreview(kwUpdate, null, "act-2");
  assert.notEqual(a.digest, b.digest);
  const withExpiry = buildActionPreview(kwUpdate, null, "act-1", "2026-10-09T00:00:00Z");
  assert.notEqual(a.digest, withExpiry.digest);
});

test("previews render honest Chinese text for each action kind", () => {
  const cases: Array<[AssistantAction, RegExp]> = [
    [{ ordinal: 0, kind: "keyword.create", args: { keyword: "固态电池", platforms: ["rss"], interval: 30, enabled: true } }, /新建关键词/],
    [{ ordinal: 0, kind: "keyword.set_enabled", args: { keyword_id: "kw1", enabled: false } }, /停用关键词/],
    [{ ordinal: 0, kind: "source.create", args: { url: "https://example.com/f.xml", enabled: false } }, /新增 RSS 信源/],
    [{ ordinal: 0, kind: "source.set_enabled", args: { source_id: "s1", enabled: true } }, /启用信源/],
    [{ ordinal: 0, kind: "keyword.collect_once", args: { keyword_id: "kw1" } }, /一次采集/],
    [{ ordinal: 0, kind: "source.collect_once", args: { source_id: "s1" } }, /供应商配额/],
    [{ ordinal: 0, kind: "research.start", args: { question: "量产瓶颈" } }, /深入研究/],
    [{ ordinal: 0, kind: "research.cancel", args: { job_id: "11111111-1111-4111-8111-111111111111" } }, /取消/],
  ];
  for (const [action, pattern] of cases) {
    const preview = buildActionPreview(action, null, "act-x");
    assert.match(preview.text, pattern, `${action.kind} preview text`);
  }
});

test("update preview shows old and new values from the observed snapshot", () => {
  const preview = buildActionPreview(kwUpdate, { interval: 60, platforms: ["rss"], enabled: true }, "act-1");
  assert.ok(preview.text.includes("60"), "old interval shown");
  assert.ok(preview.text.includes("5"), "new interval shown");
});
