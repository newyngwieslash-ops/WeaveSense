import assert from "node:assert/strict";
import { test } from "node:test";
import { keywordRunOutcome } from "./scheduler-outcome.ts";

test("all failed sources deduplicate safe error codes and retain local tagging", () => {
  const outcome = keywordRunOutcome([
    { source: "google_news_zh", status: "error", count: 0 },
    { source: "google_news_en", status: "error", count: 0, error_code: "network_error" },
  ], { externalItems: 0, localTagged: 3 });
  assert.equal(outcome.status, "error");
  assert.ok(outcome.note.includes("3"));
  assert.equal(outcome.note.match(/network_error/g)?.length, 1);
});

test("successful external results produce a clean success note", () => {
  assert.deepEqual(keywordRunOutcome([
    { source: "hacker_news", status: "ok", count: 2 },
  ], { externalItems: 2, localTagged: 0 }), { status: "ok", note: "" });
});
