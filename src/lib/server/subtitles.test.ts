import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql, Queryable } from "../db.ts";
import { subtitleInput } from "../subtitle-contract.ts";
import { transcriptText, readSubtitleWith, youtubeVideoId, readSubtitle } from "./subtitles.ts";

const json3 = '{ "events": [{"segs":[{"utf8":"one"}]},{"segs":[{"utf8":"one"}]},{"segs":[{"utf8":"良率 two"}]},{"segs":[{"utf8":"one"}]}] }';
const video = "BaW_jenozKc";
const response = () => new Response(JSON.stringify({ status: "ok", video_id: video, language: "en", kind: "manual", text: "one\n良率 two\none", json3 }));
async function setup(t: { after: (fn: () => unknown) => void }) {
  const pg = new PGlite(); await pg.waitReady; t.after(() => pg.close());
  for (const name of ["0002_schema.sql", "0003_keywords.sql", "0004_production.sql", "0019_agent_material_revision.sql"]) await pg.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8"));
  const sql: Pick<Sql, "query" | "transaction"> = {
    async query<T>(text: string, params: unknown[] = []) { return (await pg.query<T>(text, params)).rows; },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) { return pg.transaction(tx => fn({ async query<R>(text: string, params: unknown[] = []) { return (await tx.query<R>(text, params)).rows; } })); },
  };
  await sql.query(`insert into items(id,source_id,platform,external_id,url,body,extra) values('internal-item','s','youtube',$1,$2,E'概要\n\n[OCR:image]\n旧识别','{}')`, [`yt:video:${video}`, `https://www.youtube.com/watch?v=${video}`]);
  await sql.query("insert into keywords(id,phrase,enabled) values('k','良率',true)");
  const row = async () => (await sql.query<Record<string, any>>("select * from items where id='internal-item'"))[0];
  return { sql, row };
}

test("finite input and independent JSON3 validation", () => {
  assert.equal(transcriptText(json3), "one\n良率 two\none");
  for (const value of ["{}", '{"events":[{"segs":[{"utf8":1}]}]}']) assert.throws(() => transcriptText(value));
  for (const language of ["all", "en.*", "--exec=x"]) assert.equal(subtitleInput.safeParse({ id: "i", language }).success, false);
  assert.equal(subtitleInput.safeParse({ id: "i", url: "https://evil" }).success, false);
  assert.equal(youtubeVideoId({ platform: "youtube", url: `https://www.youtube.com/watch?v=${video}`, external_id: `yt:video:${video}` }), video);
  assert.throws(() => youtubeVideoId({ platform: "youtube", url: "https://www.youtube.com.evil.com/watch?v="+video }));
});

test("disabled public entry returns before DB/network", async () => {
  const old = process.env.SUBTITLE_ENABLED; delete process.env.SUBTITLE_ENABLED;
  try { await assert.rejects(readSubtitle("internal-item"), /subtitle_disabled/); }
  finally { if (old !== undefined) process.env.SUBTITLE_ENABLED = old; }
});

test("private raw bytes before version CAS, idempotence, conflict, keyword and history", async t => {
  const f = await setup(t); let puts=0;
  const opts = { sql:f.sql, itemId:"internal-item", language:"en" as const, enabled:true,
    fetcher: async () => response(), token:"fixture", endpoint:"http://subtitle-egress:8794",
    put: async (id:string, digest:string, bytes:Buffer) => { puts++; assert.equal(id,"internal-item"); assert.match(digest,/^[a-f0-9]{64}$/); assert.equal(bytes.toString(),json3); assert.equal(Number((await f.row()).material_version),0); return {ok:true}; } };
  const first=await readSubtitleWith(opts); assert.equal(first.status,"ok");
  const row=await f.row(); assert.equal(Number(row.material_version),1); assert.equal(row.extra.transcript_kind,"manual"); assert.ok(row.body.includes("[OCR:image]")); assert.ok(row.body.endsWith("[字幕: en; manual]\none\n良率 two\none")); assert.deepEqual(row.matched_keywords,["良率"]);
  await readSubtitleWith(opts); assert.equal(puts,1); assert.equal((await f.row()).body,row.body);
  await assert.rejects(readSubtitleWith({...opts, fetcher:async()=>new Response(JSON.stringify({status:"ok",video_id:video,language:"en",kind:"manual",text:"different",json3:'{"events":[{"segs":[{"utf8":"different"}]}]}'}))}),/subtitle_conflict/);
});

test("failed upload, malformed output, no subtitles and concurrent edit do not append", async t => {
  const f=await setup(t); const original=(await f.row()).body;
  const opts={sql:f.sql,itemId:"internal-item",language:"en" as const,enabled:true,token:"fixture",endpoint:"http://subtitle-egress:8794",fetcher:async()=>response(),put:async()=>({ok:false})};
  await assert.rejects(readSubtitleWith(opts),/subtitle_unavailable/); assert.equal((await f.row()).body,original);
  await assert.rejects(readSubtitleWith({...opts,fetcher:async()=>new Response('{"status":"ok"}')}),/subtitle_invalid_response/);
  const none=await readSubtitleWith({...opts,fetcher:async()=>new Response(JSON.stringify({status:"no_subtitles",video_id:video,language:"en",kind:"none",text:""}))}); assert.equal(none.status,"no_subtitles"); assert.equal(Number((await f.row()).material_version),0);
  await assert.rejects(readSubtitleWith({...opts,put:async()=>{await f.sql.query("update items set body=body||' changed' where id='internal-item'");return {ok:true};}}),/subtitle_conflict/);
  assert.equal((await f.row()).body,original+" changed");
});

test("bounded malformed worker responses and exact private signer bucket", async t => {
  const f=await setup(t);let puts=0;
  const opts={sql:f.sql,itemId:"internal-item",language:"en" as const,enabled:true,token:"fixture",endpoint:"http://subtitle-egress:8794",put:async()=>{puts++;return {ok:true};}};
  for (const data of [
    {...JSON.parse(await response().text()),video_id:"XXXXXXXXXXX"},
    {...JSON.parse(await response().text()),text:"forged text"},
    {...JSON.parse(await response().text()),language:"zh-Hans"},
  ]) await assert.rejects(readSubtitleWith({...opts,fetcher:async()=>new Response(JSON.stringify(data))}),/subtitle_invalid_response/);
  await assert.rejects(readSubtitleWith({...opts,fetcher:async()=>new Response("x".repeat(2*1024*1024+1))}),/subtitle_output_too_large/);
  assert.equal(puts,0);
  const { prod } = await import("./config.ts");
  const { putSubtitleObject, putObject } = await import("./storage.ts");
  const before={...prod},old=globalThis.fetch;
  t.after(()=>{Object.assign(prod,before);globalThis.fetch=old;});
  Object.assign(prod,{minioEndpoint:"http://private-object.invalid",minioAccessKey:"fixture",minioSecretKey:"fixture",minioBucket:"public-media",minioForcePathStyle:false,minioPublicUrl:"https://public.invalid"});
  const { createHash }=await import("node:crypto");
  const bytes=Buffer.from(json3),digest=createHash("sha256").update(bytes).digest("hex");
  let calls=0;
  globalThis.fetch=async(input,init)=>{calls++;assert.equal(String(input),`http://private-object.invalid/loom-subtitles/internal-item/${digest}.json3`);assert.equal(init?.redirect,"error");assert.match(String((init?.headers as Record<string,string>).authorization),/^AWS4-HMAC-SHA256 /);return new Response(null,{status:200});};
  assert.deepEqual(await putSubtitleObject("internal-item",digest,bytes),{ok:true});
  assert.deepEqual(await putSubtitleObject("../escape",digest,bytes),{ok:false});assert.equal(calls,1);
  globalThis.fetch=async()=>new Response(null,{status:200});
  assert.equal((await putObject("legacy",Buffer.from("x"),"text/plain")).url,"https://public.invalid/legacy");
});
