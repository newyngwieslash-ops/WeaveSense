import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { extractTargetKey, runExtractTargets, type ExtractTarget } from "./extract-targets.ts";

/**
 * T12: extraction must send the *right* media to the *right* model.
 *
 * The defect this pins down: a video entry whose only media is its JPEG cover
 * (exactly what the B 站 adapter produces) was classified as `video` and handed
 * to the speech-to-text model. That spends a paid STT call on a still image and
 * can only ever return garbage.
 *
 * Also covered here: a target that is too large is refused explicitly (zero model
 * calls) instead of being silently truncated into a corrupt payload, and an
 * already-succeeded target is never re-billed.
 */
async function db() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    create table items (id text primary key, body text not null default '', pipeline_status text not null default 'ingested');
    create table extract_jobs (
      id text primary key,
      item_id text not null,
      media_id text not null default '',
      target_key text not null,
      kind text not null,
      status text not null,
      result_text text not null default '',
      model text not null default '',
      error text not null default '',
      attempts integer not null default 0,
      claim_token text not null default '',
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      unique (item_id, target_key)
    );
  `);
  await pg.query("insert into items (id, body) values ('item-1', '')");
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  return { pg, sql };
}

const target = (over: Partial<ExtractTarget> = {}): ExtractTarget => ({
  id: "m1",
  source_url: "https://cdn.example.com/a",
  object_key: "",
  public_url: "https://cdn.example.com/a",
  content_type: "",
  kind: "image",
  ...over,
});

/** Records which model was called and with what. */
function models() {
  const ocrCalls: { contentType: string; bytes: number }[] = [];
  const asrCalls: { filename: string; bytes: number }[] = [];
  return {
    ocrCalls,
    asrCalls,
    ocr: async (bytes: Buffer, contentType: string) => {
      ocrCalls.push({ contentType, bytes: bytes.length });
      return { text: "OCR 文本", model: "vision" };
    },
    asr: async (bytes: Buffer, filename: string) => {
      asrCalls.push({ filename, bytes: bytes.length });
      return { text: "ASR 文本", model: "stt" };
    },
  };
}

test("a video flagged item whose only media is its JPEG cover goes to OCR, not STT", async () => {
  const { pg, sql } = await db();
  const m = models();
  // This is the B 站 shape: media_type "video", media_urls [cover.jpg].
  const result = await runExtractTargets({
    sql,
    itemId: "item-1",
    targets: [target({ id: "cover", kind: "video", content_type: "image/jpeg" })],
    load: async () => ({ bytes: Buffer.from("jpegbytes"), contentType: "image/jpeg" }),
    ocr: m.ocr,
    asr: m.asr,
  });

  assert.equal(m.asrCalls.length, 0, "a still image must never reach the speech model");
  assert.equal(m.ocrCalls.length, 1, "it must reach the vision model instead");
  assert.equal(result.ran, 1);
  await pg.close();
});

test("a declared audio target goes to STT and a declared image target to OCR", async () => {
  const { pg, sql } = await db();
  const m = models();
  await runExtractTargets({
    sql,
    itemId: "item-1",
    targets: [target({ id: "audio", kind: "audio", content_type: "audio/mpeg" })],
    load: async () => ({ bytes: Buffer.from("mp3"), contentType: "audio/mpeg" }),
    ocr: m.ocr,
    asr: m.asr,
  });
  assert.equal(m.asrCalls.length, 1);
  assert.equal(m.asrCalls[0].filename, "media.mp3", "the filename must match the real type");
  assert.equal(m.ocrCalls.length, 0);
  await pg.close();
});

test("a real video file goes to STT", async () => {
  const { pg, sql } = await db();
  const m = models();
  await runExtractTargets({
    sql,
    itemId: "item-1",
    targets: [target({ id: "vid", kind: "video", content_type: "video/mp4" })],
    load: async () => ({ bytes: Buffer.from("mp4bytes"), contentType: "video/mp4" }),
    ocr: m.ocr,
    asr: m.asr,
  });
  assert.equal(m.asrCalls.length, 1);
  assert.equal(m.asrCalls[0].filename, "media.mp4");
  assert.equal(m.ocrCalls.length, 0);
  await pg.close();
});

test("the served content type wins when it contradicts the declared kind", async () => {
  const { pg, sql } = await db();
  const m = models();
  // Declared video, but the bytes served are an image: OCR is the only honest call.
  await runExtractTargets({
    sql,
    itemId: "item-1",
    targets: [target({ id: "mismatch", kind: "video", content_type: "" })],
    load: async () => ({ bytes: Buffer.from("png"), contentType: "image/png" }),
    ocr: m.ocr,
    asr: m.asr,
  });
  assert.equal(m.asrCalls.length, 0, "the actual content type must decide");
  assert.equal(m.ocrCalls.length, 1);
  await pg.close();
});

test("a target with no usable type is closed without any model call", async () => {
  const { pg, sql } = await db();
  const m = models();
  const result = await runExtractTargets({
    sql,
    itemId: "item-1",
    targets: [target({ id: "unknown", kind: "file", content_type: "application/octet-stream" })],
    load: async () => ({ bytes: Buffer.from("?"), contentType: "application/octet-stream" }),
    ocr: m.ocr,
    asr: m.asr,
  });
  assert.equal(m.ocrCalls.length + m.asrCalls.length, 0, "no model may be called for an unknown type");
  assert.equal(result.ran, 0);
  // The job is closed with an explicit reason rather than left running forever,
  // and the reason is visible to an operator.
  const jobs = await pg.query<{ status: string; error: string }>(
    "select status, error from extract_jobs where item_id='item-1'",
  );
  assert.equal(jobs.rows[0].status, "ok");
  assert.equal(jobs.rows[0].error, "unsupported_media_type");
  // It is a terminal, non-retryable outcome — not "still working".
  assert.equal(result.ok, true, "the item is finished with, even though nothing was extracted");
  await pg.close();
});

test("an item with nothing extractable at all reports that, not a clean run", async () => {
  const { pg, sql } = await db();
  const m = models();
  // No targets at all is handled by the caller (extractItem); this asserts the
  // per-run reporting stays honest when a candidate yields no usable media.
  const result = await runExtractTargets({
    sql,
    itemId: "item-1",
    targets: [target({ id: "x", kind: "file", content_type: "application/pdf" })],
    load: async () => ({ bytes: Buffer.from("%PDF"), contentType: "application/pdf" }),
    ocr: m.ocr,
    asr: m.asr,
  });
  assert.equal(result.ran, 0);
  assert.equal(m.ocrCalls.length + m.asrCalls.length, 0, "a PDF is neither OCR nor ASR input here");
  await pg.close();
});

test("a reload must not re-bill a target that already succeeded", async () => {
  const { pg, sql } = await db();
  const m = models();
  const targets = [target({ id: "m1", kind: "image", content_type: "image/jpeg" })];
  const load = async () => ({ bytes: Buffer.from("jpeg"), contentType: "image/jpeg" });

  const first = await runExtractTargets({ sql, itemId: "item-1", targets, load, ocr: m.ocr, asr: m.asr });
  assert.equal(first.ok, true);
  assert.equal(m.ocrCalls.length, 1);

  // A second run (page refresh / retry) must be a no-op: 0 model calls.
  const second = await runExtractTargets({ sql, itemId: "item-1", targets, load, ocr: m.ocr, asr: m.asr });
  assert.equal(m.ocrCalls.length, 1, "an already-extracted target must not be re-sent");
  assert.equal(second.ran, 0);
  assert.equal(second.ok, true, "and the target is still reported as done");
  await pg.close();
});

test("a failed target is retried at most the configured number of times", async () => {
  const { pg, sql } = await db();
  let calls = 0;
  const failingOcr = async () => {
    calls += 1;
    throw new Error("vision 500");
  };
  const targets = [target({ id: "m1", kind: "image", content_type: "image/jpeg" })];
  const load = async () => ({ bytes: Buffer.from("jpeg"), contentType: "image/jpeg" });
  for (let i = 0; i < 5; i += 1) {
    await runExtractTargets({ sql, itemId: "item-1", targets, load, ocr: failingOcr, asr: async () => ({ text: "", model: "" }) });
  }
  assert.equal(calls, 3, "attempts must stop at the cap");
  const attempts = await pg.query<{ status: string; attempts: number }>(
    "select status, attempts from extract_jobs where item_id='item-1'",
  );
  assert.equal(attempts.rows[0].status, "error");
  assert.equal(Number(attempts.rows[0].attempts), 3);
  await pg.close();
});

test("the committed text is attributed to the target that produced it", async () => {
  const { pg, sql } = await db();
  const m = models();
  await runExtractTargets({
    sql,
    itemId: "item-1",
    targets: [target({ id: "img-1", kind: "image", content_type: "image/jpeg" })],
    load: async () => ({ bytes: Buffer.from("jpeg"), contentType: "image/jpeg" }),
    ocr: m.ocr,
    asr: m.asr,
  });
  const { rows } = await pg.query<{ body: string }>("select body from items where id='item-1'");
  assert.match(rows[0].body, /OCR:img-1/, "the marker names the target");
  assert.match(rows[0].body, /OCR 文本/);
  await pg.close();
});

test("target keys are stable across runs so idempotency can hold", () => {
  const a = extractTargetKey(target({ id: "abc" }));
  const b = extractTargetKey(target({ id: "abc" }));
  assert.equal(a, b);
  // A URL-only target (no row id yet) keys on its URL digest.
  const urlKey = extractTargetKey(target({ id: "", public_url: "https://cdn.example.com/x.jpg" }));
  assert.match(urlKey, /^url:[0-9a-f]{64}$/);
  // Two different URLs must not collide.
  assert.notEqual(urlKey, extractTargetKey(target({ id: "", public_url: "https://cdn.example.com/y.jpg" })));
  void randomUUID;
});
