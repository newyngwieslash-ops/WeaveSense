import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { runAssistantTool } from "./assistant-tools.ts";

/**
 * Task 6: read-only whitelist tools + per-run tool ledger. "Read-only" means
 * no ensureSeeded, no business writes, no expiry convergence, no model calls.
 * The ledger replays identical calls and refuses the same call_id with
 * different args.
 */

async function db() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const name of readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
    await pg.exec(readFileSync("migrations/" + name, "utf8"));
  }
  const sql: {
    query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  } = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
      return (await pg.query<T>(text, params)).rows;
    },
  };
  return { pg, sql };
}

async function seedTurn(sql: { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> }) {
  const [conv] = await sql.query<{ id: string }>(
    "insert into assistant_conversations(id) values($1) returning id", [randomUUID()],
  );
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','running') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  const [run] = await sql.query<{ id: string }>(
    `insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at,data_token_hash)
     values($1,$2,'research','opencode','i','m','loom-assistant-v1','{}','running','tok', clock_timestamp() + interval '10 minutes', 'dtok')
     returning id`,
    [randomUUID(), randomUUID()],
  );
  await sql.query("update assistant_turns set run_id=$2 where id=$1", [turn.id, run.id]);
  return { conversationId: conv.id, turnId: turn.id, runId: run.id };
}

test("list_keywords returns trimmed DTOs without seeding an empty database", async () => {
  const { sql } = await db();
  const seeded = await seedTurn(sql);
  const result = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId: randomUUID(), tool: "list_keywords", args: {},
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { keywords: [], truncated: false });
  }
  // Nothing was created by the tool: keywords table is still empty.
  const rows = await sql.query("select count(*)::int as n from keywords");
  assert.equal(rows[0].n, 0);
});

test("unknown tools, over-budget tools and missing run are refused", async () => {
  const { sql } = await db();
  const seeded = await seedTurn(sql);
  const missingRun = await runAssistantTool(sql, {
    runId: randomUUID(), turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId: randomUUID(), tool: "list_keywords", args: {},
  });
  assert.equal(missingRun.ok, false);
  assert.equal((missingRun as { error_code: string }).error_code, "run_not_active");
  const badToken = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "wrong", callId: randomUUID(), tool: "list_keywords", args: {},
  });
  assert.equal(badToken.ok, false);
  const unknown = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId: randomUUID(), tool: "drop_table", args: {},
  });
  assert.equal(unknown.ok, false);
});

test("tool ledger: identical call replays, same call different args conflicts", async () => {
  const { sql } = await db();
  const seeded = await seedTurn(sql);
  await sql.query("insert into keywords(id,phrase,platforms,interval_minutes,enabled) values('kw1','固态电池','[\"rss\"]'::jsonb,30,true)");
  const callId = randomUUID();
  const first = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId, tool: "list_keywords", args: {},
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal((first.value as { keywords: { phrase: string }[] }).keywords.length, 1);
    assert.equal((first.value as { keywords: { phrase: string }[] }).keywords[0].phrase, "固态电池");
    // DTO is trimmed: internal columns like last_error are absent.
    assert.equal(Object.keys((first.value as { keywords: Record<string, unknown>[] }).keywords[0]).includes("last_error"), false);
  }
  // Replay: same call_id + same args digest returns the stored result.
  const replay = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId, tool: "list_keywords", args: {},
  });
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.deepEqual(replay.value, first.ok ? first.value : null, "replay returns the stored result");
  }
  // Same call_id, different args -> conflict, never a second execution.
  const conflict = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId, tool: "list_keywords", args: { limit: 5 },
  });
  assert.equal(conflict.ok, false);
  assert.equal((conflict as { error_code: string }).error_code, "tool_conflict");
});

test("per-run tool budget is enforced (8 for assistant)", async () => {
  const { sql } = await db();
  const seeded = await seedTurn(sql);
  for (let i = 0; i < 8; i++) {
    const r = await runAssistantTool(sql, {
      runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
      dataTokenHash: "dtok", callId: randomUUID(), tool: "list_keywords", args: {},
    });
    assert.equal(r.ok, true, `call ${i + 1} should pass`);
  }
  const ninth = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId: randomUUID(), tool: "list_keywords", args: {},
  });
  assert.equal(ninth.ok, false);
  assert.equal((ninth as { error_code: string }).error_code, "tool_budget_exceeded");
});

test("reference-scoped reads validate entity ids and refuse out-of-scope references", async () => {
  const { sql } = await db();
  const seeded = await seedTurn(sql);
  // get_note with a nonexistent id returns an explicit empty, not a fabricated note.
  const note = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId: randomUUID(), tool: "get_note", args: { note_id: "nope" },
  });
  assert.equal(note.ok, true);
  if (note.ok) assert.deepEqual(note.value, { note: null });
  // get_operation is limited to this conversation's actions.
  const op = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId: randomUUID(), tool: "get_operation", args: { action_id: "nope" },
  });
  assert.equal(op.ok, true);
  if (op.ok) assert.deepEqual(op.value, { operation: null });
});

test("tool results respect the 64KiB response bound", async () => {
  const { sql } = await db();
  const seeded = await seedTurn(sql);
  const body = "长".repeat(5000);
  await sql.query("insert into items(id,source_id,platform,external_id,title,body) values('i1','s','rss','x','标题',$1)",
    [body]);
  // A source row must exist for the join.
  await sql.query("insert into sources(id,platform,name) values('s','rss','信源')");
  const item = await runAssistantTool(sql, {
    runId: seeded.runId, turnId: seeded.turnId, conversationId: seeded.conversationId,
    dataTokenHash: "dtok", callId: randomUUID(), tool: "get_item", args: { item_id: "i1" },
  });
  assert.equal(item.ok, true);
  if (item.ok) {
    assert.ok(Buffer.byteLength(JSON.stringify(item.value), "utf8") <= 64 * 1024, "result under 64KiB");
    const text = (item.value as { item?: { body?: string } }).item?.body ?? "";
    assert.ok(Array.from(text).length <= 1200, "body is code-point clipped for the model");
  }
});
