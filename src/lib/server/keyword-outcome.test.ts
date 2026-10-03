/**
 * T08 (scheduler level): a keyword run must persist the outcome that actually
 * happened, so the jobs page can distinguish "clean scan, nothing found" from
 * "every external source failed".
 *
 * This drives the pure decision used by `runKeywordJob` (the SQL writes around it
 * are exercised by the existing scheduler suite and the PGlite checks).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { keywordRunOutcome } from "./scheduler-outcome.ts";
import type { KeywordAttempt } from "./collectors/types.ts";

const ok = (source: KeywordAttempt["source"], count = 0): KeywordAttempt => ({ source, status: "ok", count });
const err = (source: KeywordAttempt["source"], code: KeywordAttempt["error_code"] = "http_error"): KeywordAttempt =>
  ({ source, status: "error", count: 0, error_code: code });

test("a local-only scope is a normal run, not a failure", () => {
  const outcome = keywordRunOutcome([], { externalItems: 0, localTagged: 0 });
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.note, "");
});

test("all sources failing is an error, and local tags are still reported", () => {
  const outcome = keywordRunOutcome([err("google_news_zh"), err("hacker_news", "rate_limited")], {
    externalItems: 0,
    localTagged: 3,
  });
  assert.equal(outcome.status, "error", "a total outage must not read as a clean scan");
  assert.match(outcome.note, /全部失败/);
  assert.match(outcome.note, /rate_limited/);
  assert.match(outcome.note, /本地命中 3 条/, "the local tags that did happen must still be visible");
});

test("a partial failure keeps the run ok but names the failing sources", () => {
  const outcome = keywordRunOutcome([ok("google_news_zh", 2), err("hacker_news")], {
    externalItems: 2,
    localTagged: 0,
  });
  assert.equal(outcome.status, "ok");
  assert.match(outcome.note, /部分来源失败/);
  assert.match(outcome.note, /hacker_news/);
  assert.ok(!outcome.note.includes("google_news_zh"), "a succeeding source must not be named as failed");
});

test("a clean scan with no hits says so, without implying a failure", () => {
  const outcome = keywordRunOutcome([ok("google_news_zh"), ok("hacker_news")], {
    externalItems: 0,
    localTagged: 0,
  });
  assert.equal(outcome.status, "ok");
  assert.match(outcome.note, /暂无新结果/);
  assert.ok(!/失败/.test(outcome.note));
});

test("external silence plus local hits reports the local hits", () => {
  const outcome = keywordRunOutcome([ok("google_news_zh")], { externalItems: 0, localTagged: 7 });
  assert.equal(outcome.status, "ok");
  assert.match(outcome.note, /本地命中 7 条/);
});

test("a previous partial phrase's tag count cannot be attributed to a failing run", () => {
  // Guards the exact scenario the old code hid: everything failed, but local
  // tags from earlier runs exist. The run is still an error.
  const outcome = keywordRunOutcome([err("bilibili_search", "invalid_response")], {
    externalItems: 0,
    localTagged: 12,
  });
  assert.equal(outcome.status, "error");
  assert.notEqual(outcome.status, "ok");
});

test("the note never embeds a raw provider message", () => {
  // error codes are the only diagnostic: raw text can carry keys/query strings.
  const outcome = keywordRunOutcome([err("bilibili_search", "invalid_response")], {
    externalItems: 0,
    localTagged: 0,
  });
  assert.ok(!outcome.note.includes("http"), "no URL/status text beyond the stable code");
  assert.match(outcome.note, /invalid_response/);
});
