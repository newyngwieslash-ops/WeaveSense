import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { runExtractTargets, type ExtractTarget } from "./extract-targets.ts";

test("per-target extraction preserves all results, skips terminal empty text, and retries only failures", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql", "0004_production.sql", "0007_extract_target_state.sql",
    "0009_extract_claim_fencing.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  const target = (id: string): ExtractTarget => ({ id, source_url: `https://media/${id}`,
    object_key: "", public_url: "", content_type: "image/jpeg", kind: "image" });
  const insertItem = (id: string) => pg.query(
    "insert into items (id,source_id,platform,external_id,media_urls) values ($1,'s','wechat',$1,'[]')", [id]);
  const load = async () => ({ bytes: Buffer.from("image"), contentType: "image/jpeg" });

  await insertItem("both");
  const both = await runExtractTargets({ sql, itemId: "both", targets: [target("img-1"), target("img-2")],
    load, ocr: async (_bytes, _type) => ({ text: "识别文本", model: "vision" }),
    asr: async () => ({ text: "", model: "stt" }) });
  assert.deepEqual(both, { ok: true, ran: 2 });
  const bothRows = (await pg.query<{ target_key: string; result_text: string }>(
    "select target_key,result_text from extract_jobs where item_id='both' order by target_key")).rows;
  assert.deepEqual(bothRows, [{ target_key: "img-1", result_text: "识别文本" },
    { target_key: "img-2", result_text: "识别文本" }]);
  const bothBody = (await pg.query<{ body: string }>("select body from items where id='both'"))
    .rows[0]?.body ?? "";
  assert.match(bothBody, /\[OCR:img-1\][\s\S]*\[OCR:img-2\]/);
  assert.equal((bothBody.match(/识别文本/g) ?? []).length, 2);
  assert.equal((await pg.query<{ pipeline_status: string }>("select pipeline_status from items where id='both'"))
    .rows[0]?.pipeline_status, "extracted");

  await insertItem("empty");
  let emptyCalls = 0;
  const emptyOptions = { sql, itemId: "empty", targets: [target("empty-image")], load,
    ocr: async () => { emptyCalls += 1; return { text: "", model: "vision" }; },
    asr: async () => ({ text: "", model: "stt" }) };
  assert.equal((await runExtractTargets(emptyOptions)).ok, true);
  assert.equal((await runExtractTargets(emptyOptions)).ran, 0);
  assert.equal(emptyCalls, 1);

  await insertItem("retry");
  const calls = new Map<string, number>();
  const retryTargets = [target("flaky"), target("good")];
  const retryOcr = async (bytes: Buffer) => {
    const id = bytes.toString();
    calls.set(id, (calls.get(id) ?? 0) + 1);
    if (id === "flaky" && calls.get(id) === 1) throw new Error("temporary");
    return { text: id, model: "vision" };
  };
  const retryLoad = async (value: ExtractTarget) => ({ bytes: Buffer.from(value.id), contentType: "image/jpeg" });
  assert.equal((await runExtractTargets({ sql, itemId: "retry", targets: retryTargets,
    load: retryLoad, ocr: retryOcr, asr: async () => ({ text: "", model: "stt" }) })).ok, false);
  assert.deepEqual(Object.fromEntries(calls), { flaky: 1, good: 1 });
  assert.equal((await runExtractTargets({ sql, itemId: "retry", targets: retryTargets,
    load: retryLoad, ocr: retryOcr, asr: async () => ({ text: "", model: "stt" }) })).ok, true);
  assert.deepEqual(Object.fromEntries(calls), { flaky: 2, good: 1 });
  assert.equal((await pg.query<{ pipeline_status: string }>("select pipeline_status from items where id='retry'"))
    .rows[0]?.pipeline_status, "extracted");
  await pg.close();
});

test("two workers cannot claim the same fresh extraction target", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql", "0004_production.sql", "0007_extract_target_state.sql",
    "0009_extract_claim_fencing.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into items (id,source_id,platform,external_id,media_urls) values ('race','s','wechat','race','[]')");
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  const target: ExtractTarget = { id: "same", source_url: "https://media/same", object_key: "",
    public_url: "", content_type: "image/jpeg", kind: "image" };
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const options = { sql, itemId: "race", targets: [target],
    load: async () => ({ bytes: Buffer.from("image"), contentType: "image/jpeg" }),
    ocr: async () => { calls += 1; await gate; return { text: "once", model: "vision" }; },
    asr: async () => ({ text: "", model: "stt" }) };
  const first = runExtractTargets(options);
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = runExtractTargets(options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await pg.close();
});

test("different target workers append atomically without truncating a long original body", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql", "0004_production.sql", "0007_extract_target_state.sql",
    "0009_extract_claim_fencing.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const original = "长".repeat(20_000);
  await pg.query(`insert into items (id,source_id,platform,external_id,body,media_urls)
    values ('parallel','s','wechat','parallel',$1,'[]')`, [original]);
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  let arrived = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const run = (id: string) => runExtractTargets({ sql, itemId: "parallel", targets: [{ id,
    source_url: `https://media/${id}`, object_key: "", public_url: "",
    content_type: "image/jpeg", kind: "image" }],
  load: async () => ({ bytes: Buffer.from(id), contentType: "image/jpeg" }),
  ocr: async (bytes) => { arrived += 1; if (arrived === 2) release(); await barrier;
    return { text: `文本-${bytes.toString()}`, model: "vision" }; },
  asr: async () => ({ text: "", model: "stt" }) });
  await Promise.all([run("left"), run("right")]);
  const body = (await pg.query<{ body: string }>("select body from items where id='parallel'"))
    .rows[0]?.body ?? "";
  assert.ok(body.startsWith(original));
  assert.ok(body.length > original.length);
  assert.match(body, /\[OCR:left\][\s\S]*文本-left/);
  assert.match(body, /\[OCR:right\][\s\S]*文本-right/);
  await pg.close();
});

test("a commit-stage failure cannot leave an ok job without its body label", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql", "0004_production.sql", "0007_extract_target_state.sql",
    "0009_extract_claim_fencing.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into items (id,source_id,platform,external_id,media_urls) values ('fault','s','wechat','fault','[]')");
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    if (text.includes("with finished as")) throw new Error("injected commit failure");
    return (await pg.query<T>(text, params)).rows;
  } };
  const result = await runExtractTargets({ sql, itemId: "fault", targets: [{ id: "image",
    source_url: "https://media/image", object_key: "", public_url: "",
    content_type: "image/jpeg", kind: "image" }],
  load: async () => ({ bytes: Buffer.from("image"), contentType: "image/jpeg" }),
  ocr: async () => ({ text: "不得丢失", model: "vision" }),
  asr: async () => ({ text: "", model: "stt" }) });
  assert.equal(result.ok, false);
  const job = (await pg.query<{ status: string; result_text: string }>(
    "select status,result_text from extract_jobs where item_id='fault'" )).rows[0];
  const body = (await pg.query<{ body: string }>("select body from items where id='fault'" )).rows[0]?.body;
  assert.deepEqual(job, { status: "error", result_text: "" });
  assert.equal(body, "");
  await pg.close();
});

test("a stale extraction worker cannot overwrite the reclaimed worker", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql", "0004_production.sql", "0007_extract_target_state.sql",
    "0009_extract_claim_fencing.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into items (id,source_id,platform,external_id,media_urls) values ('stale','s','wechat','stale','[]')");
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  const target: ExtractTarget = { id: "image", source_url: "https://media/image", object_key: "",
    public_url: "", content_type: "image/jpeg", kind: "image" };
  let calls = 0;
  let releaseOld = () => {};
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const run = () => runExtractTargets({ sql, itemId: "stale", targets: [target],
    load: async () => ({ bytes: Buffer.from("image"), contentType: "image/jpeg" }),
    ocr: async () => { calls += 1; if (calls === 1) { await oldGate; return { text: "旧结果", model: "old" }; }
      return { text: "新结果", model: "new" }; },
    asr: async () => ({ text: "", model: "stt" }) });
  const oldWorker = run();
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  await pg.query("update extract_jobs set started_at=now()-interval '16 minutes' where item_id='stale'");
  const newWorker = await run();
  assert.equal(newWorker.ok, true);
  releaseOld();
  await oldWorker;
  const job = (await pg.query<{ status: string; result_text: string; model: string; claim_token: string }>(
    "select status,result_text,model,claim_token from extract_jobs where item_id='stale'" )).rows[0];
  const body = (await pg.query<{ body: string }>("select body from items where id='stale'" )).rows[0]?.body;
  assert.deepEqual(job, { status: "ok", result_text: "新结果", model: "new", claim_token: "" });
  assert.match(body ?? "", /新结果/);
  assert.doesNotMatch(body ?? "", /旧结果/);
  assert.equal(calls, 2);
  await pg.close();
});
