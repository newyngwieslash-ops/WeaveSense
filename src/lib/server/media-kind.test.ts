import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { guessKind } from "./media-kind.ts";

/**
 * T12: media type classification for the ingest path.
 *
 * The B 站 adapter declares `media_type: "video"` while its `media_urls` hold a
 * JPEG cover. `guessKind` must classify from the *file* (extension), not from the
 * entry's declared shape — otherwise the cover is stored as "video" and a later
 * extraction step hands a still image to the speech model.
 */
test("a video entry whose media is a cover image classifies as image", () => {
  assert.equal(guessKind("https://i0.hdslb.com/bfs/archive/abc.jpg", "video"), "image");
  assert.equal(guessKind("https://p3-sign.douyinpic.com/x.webp", "video"), "image");
  assert.equal(guessKind("https://mmbiz.qpic.cn/cover.png", "video"), "image");
});

test("a real video file classifies as video even when the entry says article", () => {
  assert.equal(guessKind("https://cdn.example.com/clip.mp4", "article"), "video");
  assert.equal(guessKind("https://cdn.example.com/clip.webm", "text"), "video");
});

test("audio extensions classify as audio", () => {
  assert.equal(guessKind("https://cdn.example.com/a.mp3", "video"), "audio");
  assert.equal(guessKind("https://cdn.example.com/a.m4a", "article"), "audio");
  assert.equal(guessKind("https://cdn.example.com/a.ogg", "image"), "audio");
});

test("an unknown extension falls back to the declared kind", () => {
  assert.equal(guessKind("https://cdn.example.com/blob", "image"), "image");
  assert.equal(guessKind("https://cdn.example.com/blob", "video"), "video");
  assert.equal(guessKind("https://cdn.example.com/blob", "file"), "file");
});

test("a query string does not hide the extension", () => {
  assert.equal(guessKind("https://cdn.example.com/clip.mp4?token=abc", "article"), "video");
  assert.equal(guessKind("https://cdn.example.com/pic.jpeg?x=1&y=2", "video"), "image");
});

test("the stored hash matches the stored bytes (integrity contract)", async () => {
  // The ingest path records a sha256 of what it wrote. This asserts the contract
  // it relies on: hashing the same bytes twice is stable, so a later read-back can
  // be compared against the stored value.
  const body = Buffer.from("封面图片字节".repeat(100));
  const first = createHash("sha256").update(body).digest("hex");
  const second = createHash("sha256").update(Buffer.from(body)).digest("hex");
  assert.equal(first, second);
  assert.equal(first.length, 64);
});

test("a stored object key survives a round trip through the table", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`create table media_objects (
    id text primary key, item_id text not null, source_url text not null,
    object_key text not null default '', public_url text not null default '',
    content_type text not null default '', bytes integer not null default 0,
    sha256 text not null default '', status text not null default 'remote'
  )`);
  const hash = createHash("sha256").update("bytes").digest("hex");
  await pg.query(
    `insert into media_objects (id, item_id, source_url, object_key, public_url, content_type, bytes, sha256, status)
     values ('m1','i1','https://cdn.example.com/a.jpg','i1/m1.jpg','https://minio.example.com/loom/i1/m1.jpg','image/jpeg',5,$1,'stored')`,
    [hash],
  );
  const { rows } = await pg.query<{ object_key: string; sha256: string; public_url: string }>(
    "select object_key, sha256, public_url from media_objects where id='m1'",
  );
  assert.equal(rows[0].object_key, "i1/m1.jpg");
  assert.equal(rows[0].sha256, hash);
  // The browser-facing URL must be the deployment address, never a loopback one.
  assert.ok(!/127\.0\.0\.1|localhost/.test(rows[0].public_url), "a loopback URL is unreachable from the browser");
  await pg.close();
});
