import assert from "node:assert/strict";
import test from "node:test";
import { parseTelegramHandle, parseTelegramHandles } from "../telegram-handle.ts";

test("parseTelegramHandle keeps the username after t.me/", () => {
  assert.equal(parseTelegramHandle("t.me/chqq888888"), "chqq888888");
  assert.equal(parseTelegramHandle("https://t.me/chqq888888"), "chqq888888");
  assert.equal(parseTelegramHandle("https://t.me/s/chqq888888"), "chqq888888");
  assert.equal(parseTelegramHandle("@chqq888888"), "chqq888888");
  assert.equal(parseTelegramHandle("chqq888888"), "chqq888888");
  assert.equal(parseTelegramHandle("tme"), "");
  assert.equal(parseTelegramHandle("t.me/+invite"), "");
});

test("parseTelegramHandles accepts a pasted t.me link", () => {
  assert.deepEqual(parseTelegramHandles("t.me/chqq888888"), ["chqq888888"]);
  assert.deepEqual(parseTelegramHandles("durov\nhttps://t.me/telegram"), ["durov", "telegram"]);
});
