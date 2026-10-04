import assert from "node:assert/strict";
import test from "node:test";
import { validateSourceInput } from "./source-validation.ts";
import { wechatSourceId } from "../wechat-canonical.ts";
import { keywordRunOutcome } from "./scheduler-outcome.ts";

const base = { platform: "rss", name: "synthetic", handle: "", feed_url: "https://feed.example/rss", interval_minutes: 30 };
test("invalid trust-boundary input returns stable codes without throwing", () => {
  for (const input of [undefined, null, [], {}, { ...base, name: 3 }, { ...base, interval_minutes: -1 }]) {
    assert.equal(validateSourceInput(input).ok, false);
  }
  assert.deepEqual(validateSourceInput({ platform: "xhs", handle: "demo", feed_url: "" }), { ok: false, code: "feed_required" });
  for (const platform of ["xhs", "douyin", "xigua"]) assert.deepEqual(validateSourceInput({ ...base, platform, feed_url: "", handle: "demo" }), { ok: false, code: "feed_required" });
  assert.deepEqual(validateSourceInput({ ...base, adapter: "invented" }), { ok: false, code: "unsupported_adapter" });
  assert.deepEqual(validateSourceInput({ ...base, platform: "unknown" }), { ok: false, code: "unsupported_platform" });
  for (const feed_url of ["file:///tmp/rss", "https://user:pass@feed.example/rss", "garbage"]) assert.deepEqual(validateSourceInput({ ...base, feed_url }), { ok: false, code: "invalid_feed_url" });
});

test("WeChat links server-derived gateway identity without a naked feed", () => {
  const result = validateSourceInput({ ...base, platform: "wechat", handle: "gh_example", feed_url: "", id: "attacker" });
  assert.ok(result.ok); assert.equal(result.value.id, wechatSourceId("gh_example"));
  assert.deepEqual(validateSourceInput({ ...base, platform: "wechat", handle: "gh_example" }), { ok: false, code: "wechat_feed_requires_gateway_import" });
});
test("local-only keyword scopes report corpus matching without pretending native search", () => {
  assert.match(keywordRunOutcome([], { externalItems: 0, localTagged: 0 }).note, /仅匹配已采集内容.*未执行原生关键词检索/);
});
test("new IDs are exact and feed overrides are explicit", () => {
  for (const handle of ["UCshort", "junkUCabcdefghijklmnopqrstuv", "https://youtube.com/watch?v=UCabcdefghijklmnopqrstuv"]) assert.deepEqual(validateSourceInput({ ...base, platform: "youtube", handle, feed_url: "" }), { ok: false, code: "invalid_youtube_id" });
  for (const handle of ["https://www.bilibili.com/video/BV123456", "mid123", "https://space.bilibili.com/123/video"]) assert.deepEqual(validateSourceInput({ ...base, platform: "bilibili", handle, feed_url: "" }), { ok: false, code: "invalid_bilibili_mid" });
  for (const handle of ["hello!world", "https://evil.example/telegram", "t.me/+private"]) assert.deepEqual(validateSourceInput({ ...base, platform: "telegram", handle, feed_url: "" }), { ok: false, code: "invalid_telegram_handle" });
  for (const [platform, handle] of [["youtube", "UCabcdefghijklmnopqrstuv"], ["bilibili", "https://space.bilibili.com/00123"], ["telegram", "https://t.me/s/channel_name/123"]]) {
    const result = validateSourceInput({ ...base, platform, handle, feed_url: "", id: "client-controlled" });
    assert.equal(result.ok, true);
    if (result.ok) { assert.notEqual(result.value.id, "client-controlled"); assert.equal(result.value.interval_minutes, 30); }
  }
  assert.equal(validateSourceInput({ ...base, platform: "youtube", handle: "" }).ok, true);
});
test("Telegram backfill keeps decimal strings and defaults to newest window", () => {
  const input = { ...base, platform: "telegram", handle: "channel_name", feed_url: "" };
  const latest = validateSourceInput(input);
  assert.ok(latest.ok); assert.deepEqual(latest.value.scan_state, { bootstrap: "latest" });
  const backfill = validateSourceInput({ ...input, scan_state: { bootstrap: "backfill", boundary: "9007199254740993" } });
  assert.ok(backfill.ok); assert.equal(backfill.value.scan_state?.boundary, "9007199254740993");
  assert.deepEqual(validateSourceInput({ ...input, scan_state: { bootstrap: "backfill", boundary: 123 } }), { ok: false, code: "invalid_scan_state" });
  assert.deepEqual(validateSourceInput({ ...input, feed_url: base.feed_url, scan_state: { bootstrap: "backfill", boundary: "0" } }), { ok: false, code: "telegram_backfill_requires_authorized_worker" });
});
