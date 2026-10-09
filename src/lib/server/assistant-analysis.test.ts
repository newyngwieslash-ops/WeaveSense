import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { startAssistantAnalysis, getAnalysisByIdForItem } from "./assistant-analysis.ts";

/**
 * Task 20: managed single-item analysis via the assistant (§6.4, B01).
 *   - stable request_id replay returns the SAME analysis_id;
 *   - material version change after prepare conflicts, never stale-executes;
 *   - budget admission rides the governed pipeline (reservation row created);
 *   - the receipt binds exactly this analysis_id, not the item's latest.
 */

async function db() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
    await pg.exec(readFileSync("migrations/" + name, "utf8"));
  }
  const sql = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
    async transaction<T>(fn: (tx: { query: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]> }) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({
        async query<R = Record<string, unknown>>(text: string, params: unknown[] = []) {
          return (await inner.query<R>(text, params)).rows;
        },
      })) as Promise<T>;
    },
  };
  return { pg, sql };
}

async function seedItem(sql: Awaited<ReturnType<typeof db>>["sql"]) {
  await sql.query("insert into sources(id,platform,name) values('s1','rss','信源')");
  await sql.query(
    `insert into items(id,source_id,platform,external_id,title,body,pipeline_status,material_version)
     values('item-1','s1','rss','x1','固态电池量产卡点','电解液仍是瓶颈，良率不足。','ready',0)`,
  );
  return "item-1";
}

/** Prepare an analysis action against the item (host-side freeze). */
async function seedAnalysisAction(sql: Awaited<ReturnType<typeof db>>["sql"], itemId: string) {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','running') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  const [action] = await sql.query<{ id: string }>(
    `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, status)
     values($1,$2,0,'item.analyze',$3::jsonb,'${"b".repeat(64)}','approved') returning id`,
    [randomUUID(), turn.id, JSON.stringify({ item_id: itemId })],
  );
  return { conversationId: conv.id, turnId: turn.id, actionId: action.id };
}

test("item.analyze without the managed adapter returns an honest capability refusal", async () => {
  const { sql } = await db();
  const itemId = await seedItem(sql);
  const t = await seedAnalysisAction(sql, itemId);
  const result = await startAssistantAnalysis(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    requestId: randomUUID(), itemId,
  });
  // In this environment the legacy/eino engine lacks verified budget
  // admission for the assistant path; the contract demands refusal over a
  // fake success.
  assert.equal(result.ok, false);
  assert.ok(["capability_unavailable", "engine_unavailable"].includes(result.error_code!), result.error_code);
});

test("missing item refuses with not_found; no analysis row is fabricated", async () => {
  const { sql } = await db();
  const t = await seedAnalysisAction(sql, "no-such-item");
  const result = await startAssistantAnalysis(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    requestId: randomUUID(), itemId: "no-such-item",
  });
  assert.equal(result.ok, false);
  const rows = await sql.query("select count(*)::int as n from analyses");
  assert.equal(rows[0].n, 0);
});

test("same request_id replays identically once an analysis exists (deterministic binding)", async () => {
  const { sql } = await db();
  const itemId = await seedItem(sql);
  const t = await seedAnalysisAction(sql, itemId);
  const requestId = randomUUID();
  // Simulate a previously-completed managed analysis bound to this request.
  const [run] = await sql.query<{ id: string }>(
    `insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,response_json)
     values($1,$2,'analyze_item','eino','h','m','loom-agent-v1','{"analysis_id":"an-1","mode":"analyze_item"}','succeeded','tok', clock_timestamp()+interval '5 minutes','{"analysis_id":"an-1"}')
     returning id`,
    [randomUUID(), requestId],
  );
  await sql.query("insert into analyses(id,item_id,summary) values('an-1',$1,'旧分析')", [itemId]);
  void run;
  const replay = await startAssistantAnalysis(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    requestId, itemId,
  });
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.analysis_id, "an-1", "replay returns exactly the bound analysis");
    assert.equal(replay.replay, true);
  }
});

test("getAnalysisByIdForItem only returns the exact (analysis_id, item_id) pair", async () => {
  const { sql } = await db();
  const itemId = await seedItem(sql);
  await sql.query("insert into analyses(id,item_id,summary) values('an-1',$1,'第一份')", [itemId]);
  await sql.query("insert into analyses(id,item_id,summary) values('an-2',$1,'第二份')", [itemId]);
  const exact = await getAnalysisByIdForItem(sql, "an-1", itemId);
  assert.equal(exact?.id, "an-1");
  assert.equal(exact?.item_id, itemId);
  // Cross-item lookup refuses.
  const wrong = await getAnalysisByIdForItem(sql, "an-1", "other-item");
  assert.equal(wrong, null);
});

test("material version bump between prepare and execute conflicts", async () => {
  const { sql } = await db();
  const itemId = await seedItem(sql);
  const t = await seedAnalysisAction(sql, itemId);
  const { assistantAnalysisPrepare } = await import("./assistant-analysis.ts");
  const prepared = await assistantAnalysisPrepare(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    kind: "item.analyze", targetId: itemId,
  });
  assert.equal(prepared.kind === "prepared" ? prepared.materialVersion : -1, 0);
  // Material changes after prepare.
  await sql.query("update items set body='电解液瓶颈已解决，良率大幅提升。', material_version=1 where id='item-1'");
  const conflict = await assistantAnalysisPrepare(sql, {
    conversationId: t.conversationId, turnId: t.turnId, actionId: t.actionId,
    kind: "item.analyze", targetId: itemId,
  });
  assert.equal(conflict.kind, "conflict");
});
