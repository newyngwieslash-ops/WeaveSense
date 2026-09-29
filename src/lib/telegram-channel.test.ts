import assert from "node:assert/strict";
import test from "node:test";
import { attemptLabel, telegramChannelKind, telegramChannelLabel } from "./telegram-channel.ts";

test("telegramChannelKind prefers the last transport", () => {
  assert.equal(telegramChannelKind(["telethon"]), "telethon");
  assert.equal(telegramChannelKind(["t.me/s"]), "web");
  assert.equal(telegramChannelKind(["telegram_web"]), "web");
  assert.equal(telegramChannelKind(["telethon", "t.me/s"]), "web");
  assert.equal(telegramChannelKind(["rss"]), "rss");
  assert.equal(telegramChannelKind([]), null);
});

test("labels distinguish Telethon from the public preview", () => {
  assert.equal(telegramChannelLabel("telethon"), "Telethon");
  assert.equal(telegramChannelLabel("web"), "t.me/s");
  assert.equal(attemptLabel("telegram_web"), "t.me/s");
  assert.equal(attemptLabel("telethon"), "Telethon");
});
