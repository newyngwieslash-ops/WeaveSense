import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  appendAssistantEvent,
  getSnapshot,
  listEventsAfter,
  submitAssistantMessage,
} from "./assistant-events.ts";

/**
 * Task 14: event persistence + replay (§5.4).
 *   - snapshot watermark (last_seq) and events come from ONE consistent read;
 *   - duplicate seq is refused by the unique index;
 *   - after-cursor replay returns events in order and dedupes;
 *   - a cursor older than the earliest retained event → resync_required;
 *   - status/capability reads never call models and never seed.
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

async function seedConversation(sql: Awaited<ReturnType<typeof db>>["sql"], eventCount = 5) {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','running') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  for (let i = 0; i < eventCount; i++) {
    await appendAssistantEvent(sql, conv.id, turn.id, "turn.started", { status: "running", n: i });
  }
  return { conversationId: conv.id, turnId: turn.id, eventCount };
}

test("snapshot watermark and events come from one consistent read", async () => {
  const { sql } = await db();
  const t = await seedConversation(sql, 5);
  const snap = await getSnapshot(sql, t.conversationId);
  assert.ok(snap);
  assert.equal(snap!.lastSeq, 4, "watermark is the max seq, not a later re-query");
  assert.equal(snap!.events.length, 5);
  assert.deepEqual(snap!.events.map((e) => e.seq), [0, 1, 2, 3, 4]);
});

test("duplicate seq insert is refused by the unique index", async () => {
  const { sql } = await db();
  const t = await seedConversation(sql, 1);
  await assert.rejects(
    () => sql.query(
      `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
       values($1,$2,$3,0,'turn.started','{}'::jsonb)`,
      [randomUUID(), t.conversationId, t.turnId],
    ),
    /unique/i,
  );
});

test("after-cursor replay returns strictly-newer events in order", async () => {
  const { sql } = await db();
  const t = await seedConversation(sql, 5);
  const page = await listEventsAfter(sql, t.conversationId, 2);
  assert.deepEqual(page.events.map((e) => e.seq), [3, 4]);
  assert.equal(page.resyncRequired, false);
  // No new events → empty page, no resync.
  const empty = await listEventsAfter(sql, t.conversationId, 4);
  assert.equal(empty.events.length, 0);
});

test("cursor older than earliest retained event triggers resync_required", async () => {
  const { sql } = await db();
  const t = await seedConversation(sql, 5);
  // Contract surface: without archival (seq starts at 0) any cursor < 0 is
  // resync territory; cursor 0 with events from 0 replays normally. Simulate
  // archival by deleting early rows and asking for a cursor below the floor.
  await sql.query("delete from assistant_events where conversation_id=$1 and seq < 3", [t.conversationId]);
  const page = await listEventsAfter(sql, t.conversationId, 1);
  assert.equal(page.resyncRequired, true, "gap between cursor and retained floor must resync");
  assert.equal(page.events.length, 0);
});

test("submitAssistantMessage is idempotent and returns the turn", async () => {
  const { sql } = await db();
  const t = await seedConversation(sql, 0);
  // Free the active slot: the fixture turn is terminal, so a new submission wins.
  await sql.query("update assistant_turns set status='completed', finished_at=clock_timestamp() where id=$1", [t.turnId]);
  const input = {
    request_id: randomUUID(),
    expected_revision: 0,
    text: "看看最近采集失败的任务",
    context: { page: "overview" as const, filters: {}, references: [] },
  };
  const first = await submitAssistantMessage(sql, t.conversationId, input);
  assert.equal(first.kind, "won");
  const replay = await submitAssistantMessage(sql, t.conversationId, input);
  assert.equal(replay.kind, "replay");
  assert.equal((replay as { turn: { id: string } }).turn.id, (first as { turn: { id: string } }).turn.id);
});

test("status reads never seed the database", async () => {
  const { sql } = await db();
  const t = await seedConversation(sql, 1);
  await getSnapshot(sql, t.conversationId);
  await listEventsAfter(sql, t.conversationId, 0);
  // The keyword/source/item tables must remain untouched by these reads.
  for (const table of ["keywords", "sources", "items"]) {
    const [row] = await sql.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    assert.equal(row.n, 0, `${table} must not be seeded by status reads`);
  }
});
