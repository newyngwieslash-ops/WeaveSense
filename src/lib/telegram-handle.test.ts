import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTelegramHandle, parseTelegramHandles } from "./telegram-handle.ts";

test("Telegram public links normalize while invite links stay rejected", () => {
  for (const value of ["@Example", "https://t.me/s/Example/123?single", "https://telegram.me/Example"]) assert.equal(parseTelegramHandle(value), "Example");
  for (const value of ["https://t.me/+invite", "https://t.me/joinchat/invite", "tiny", ""]) assert.equal(parseTelegramHandle(value), "");
});

test("batch input deduplicates public handles case insensitively", () => {
  assert.deepEqual(parseTelegramHandles("@Example;https://t.me/example\nAnother"), ["Example", "Another"]);
});
