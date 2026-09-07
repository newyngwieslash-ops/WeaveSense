import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ExecuteResponse } from "../agent-contract.ts";
import { analyzeItemWith, askKnowledgeWith, generateBriefingWith } from "./analyze.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql", "0011_ai_runs.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources (id, platform, name) values ('s','rss','信源')");
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  return { pg, sql };
}

function okAnalyze(): ExecuteResponse {
  return {
    schema_version: 1,
    run_id: "00000000-0000-4000-8000-000000000001",
    ok: true,
    result: {
      analysis: { summary: "摘要", topics: ["主题"], entities: ["实体"], insights: "洞察", tags: ["标签"] },
      citations: [{ evidence_id: "item:item-1:0", quote: "正文" }],
      insufficient_evidence: false,
      coverage: "full",
      warnings: [],
    },
    runtime: { model: "compat", prompt_version: "loom-agent-v1", skill_versions: {}, input_tokens: 1, output_tokens: 1, model_calls: 1, tool_calls: 0, events: [] },
    evidence: [],
  };
}

test("same analyze request calls the model once and replays the saved id", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','标题','正文内容足够长')");
  let calls = 0;
  const execute = async (req: { run_id: string }) => {
    calls += 1;
    return { ...okAnalyze(), run_id: req.run_id };
  };
  const requestId = randomUUID();
  const first = await analyzeItemWith({ sql, itemId: "item-1", requestId, engine: "eino", execute });
  const second = await analyzeItemWith({ sql, itemId: "item-1", requestId, engine: "eino", execute });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.equal(first.id, second.id);
  assert.equal(calls, 1);
  const analyses = await sql.query("select id from analyses");
  assert.equal(analyses.length, 1);
  await pg.close();
});

test("invalid output writes no analysis row", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','标题','正文内容足够长')");
  const execute = async (req: { run_id: string }): Promise<ExecuteResponse> => ({
    schema_version: 1, run_id: req.run_id, ok: false,
    error: { code: "invalid_output", message: "bad", retryable: false, outcome_unknown: false },
  });
  const result = await analyzeItemWith({ sql, itemId: "item-1", engine: "eino", execute });
  assert.equal(result.ok, false);
  assert.equal((await sql.query("select id from analyses")).length, 0);
  assert.equal((await sql.query<{ pipeline_status: string }>("select pipeline_status from items"))[0]?.pipeline_status, "ingested");
  await pg.close();
});

test("material change during analyze rejects the old snapshot", async () => {
  const { pg, sql } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','标题','正文内容足够长')");
  const execute = async (req: { run_id: string }) => {
    await pg.query("update items set body = body || ' OCR追加' where id = 'item-1'");
    return { ...okAnalyze(), run_id: req.run_id };
  };
  const result = await analyzeItemWith({ sql, itemId: "item-1", engine: "eino", execute });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error_code, "input_changed");
  assert.equal((await sql.query("select id from analyses")).length, 0);
  await pg.close();
});

test("briefing only uses the requested range", async () => {
  const { pg, sql } = await setup();
  await pg.query(`insert into items (id,source_id,platform,external_id,title,body,published_at)
    values ('old','s','rss','old','上周','上周新闻','2026-08-01T00:00:00Z')`);
  let calls = 0;
  const result = await generateBriefingWith({
    sql, from: "2026-09-06T16:00:00.000Z", to: "2026-09-07T16:00:00.000Z", engine: "eino",
    execute: async () => { calls += 1; return okAnalyze(); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  await pg.close();
});

test("ask with no matches does not invent citations", async () => {
  const { pg, sql } = await setup();
  await pg.query(`insert into items (id,source_id,platform,external_id,title,body)
    values ('item-1','s','rss','e1','无关标题','无关正文足够长')`);
  let calls = 0;
  const result = await askKnowledgeWith({
    sql, question: "固态电池量产卡点", engine: "eino",
    execute: async () => { calls += 1; return okAnalyze(); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(result.citations ?? [], []);
  await pg.close();
});
