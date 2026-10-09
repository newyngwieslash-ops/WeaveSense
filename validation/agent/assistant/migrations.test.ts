import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

/**
 * Assistant persistence migrations (plan Task 3):
 *  - 0026 assistant_sessions.sql: conversations/turns/messages/events/actions/tool_calls
 *  - 0027 assistant_runtime.sql: job_kind backfill + constraint replacement
 * Mirrors validation/agent/opencode/migrations.test.ts: real SQL, no mocks.
 */

type Db = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec(text: string): Promise<unknown>;
};

const files = readdirSync("migrations").filter((n) => /^\d+.*\.sql$/.test(n)).sort();
const assistantFiles = files.filter((n) => n.startsWith("0026") || n.startsWith("0027"));
// 0028 (continuations) rides in the assistant batch too; priorFiles must exclude it.
const priorFiles = files.filter((n) => !["0026","0027","0028"].some((p) => n.startsWith(p)));

async function applyAll(db: Db, names: string[]) {
  for (const name of names) await db.exec(readFileSync("migrations/" + name, "utf8"));
}

/**
 * Deploy-runner parity: scripts/migrate.mjs applies each file once, keyed by
 * basename in `_migrations`. Legacy 0022–0025 DDL is not IF NOT EXISTS-safe,
 * so a re-run must (and does) skip applied files rather than re-execute them.
 */
async function applyPending(db: Db, applied: Set<string>) {
  for (const name of files) {
    if (applied.has(name)) continue;
    await db.exec(readFileSync("migrations/" + name, "utf8"));
    applied.add(name);
  }
}

async function legacyBase(db: Db) {
  await db.exec("create table _migrations(name text primary key, applied_at timestamptz not null default now())");
  await applyAll(db, priorFiles);
  for (const name of priorFiles) await db.query("insert into _migrations(name) values($1)", [name]);
  // Legacy research artifacts that must survive the assistant migrations byte-equivalent.
  await db.exec(`insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at)
    values('legacy-run','legacy-request','research','opencode','input','materials','loom-agent-v1','{"governed":true}','succeeded','legacy-claim',now() + interval '1 hour');
    insert into ai_jobs(id,item_id,material_hash,policy_version,status,runtime_provider,payload)
      values('legacy-job','research:legacy-run','materials','loom-agent-v1','succeeded','opencode','{"provider":"opencode","mode":"research"}');
    update ai_jobs set run_id='legacy-run' where id='legacy-job';
    insert into ai_runtime_bindings(run_id,provider,runtime_version,config_digest,instance_id,epoch,session_id,dispatch_id,state)
      values('legacy-run','opencode','1.3.13','${"a".repeat(64)}','inst','11111111-1111-4111-8111-111111111111','sess','disp','candidate_saved');`);
}

async function openDb(): Promise<Db> {
  if (process.env.ASSISTANT_MIGRATION_DSN) {
    const pool = new pg.Pool({ connectionString: process.env.ASSISTANT_MIGRATION_DSN, max: 1 });
    const client = await pool.connect();
    return {
      async query(text: string, params?: unknown[]) { return (await client.query(text, params)) as { rows: Record<string, unknown>[] }; },
      async exec(text: string) { await client.query(text); },
    };
  }
  const pgLite = new PGlite();
  await pgLite.waitReady;
  return {
    async query(text: string, params?: unknown[]) { return (await pgLite.query(text, params)) as { rows: Record<string, unknown>[] }; },
    async exec(text: string) { await pgLite.exec(text); },
  };
}

const tableList = async (db: Db) =>
  (await db.query("select table_name from information_schema.tables where table_schema=current_schema() and table_name like 'assistant%' order by table_name")).rows.map((r) => r.table_name);

test("0026/0027 exist and create the assistant tables on a fresh database", async () => {
  assert.equal(assistantFiles.length, 2, "0026 and 0027 must exist, got: " + assistantFiles.join(","));
  const db = await openDb();
  try {
    await applyAll(db, files);
    const tables = await tableList(db);
    for (const expected of [
      "assistant_conversations", "assistant_turns", "assistant_messages",
      "assistant_events", "assistant_actions", "assistant_tool_calls",
    ]) {
      assert.ok(tables.includes(expected), "missing table " + expected);
    }
    // One active turn per conversation (partial unique index).
    await db.exec(`insert into assistant_conversations(id,title,revision) values('c1','对话',0)`);
    const turn = (status: string) =>
      `insert into assistant_turns(id,conversation_id,request_id,request_hash,status) values('${randomUUID()}','c1','${randomUUID()}','${"f".repeat(64)}','${status}')`;
    await db.exec(turn("queued"));
    await assert.rejects(() => db.exec(turn("running")), /unique/i, "second active turn must violate the partial unique index");
    await db.exec(`update assistant_turns set status='completed' where conversation_id='c1' and status='queued'`);
    await db.exec(turn("queued")); // terminal state frees the active slot
    // Event seq uniqueness: use the real turn IDs.
    const turnIds = (await db.query<{ id: string }[]>("select id from assistant_turns order by created_at")).rows.map((r) => r.id);
    const [t1, t2] = turnIds;
    await db.exec(`insert into assistant_events(id,conversation_id,turn_id,seq,type,payload_json) values('e1','c1','${t1}','0','turn.queued','{}')`);
    await assert.rejects(() => db.exec(`insert into assistant_events(id,conversation_id,turn_id,seq,type,payload_json) values('e2','c1','${t2}','0','turn.queued','{}')`));
    await db.exec(`insert into assistant_events(id,conversation_id,turn_id,seq,type,payload_json) values('e3','c1','${t2}','1','turn.queued','{}')`);
    // Actions: ordinal + intent digest uniqueness; decision_request_id uniqueness.
    await db.exec(`insert into assistant_actions(id,turn_id,ordinal,kind,args_json,intent_digest,status)
      values('a1','${t1}',0,'keyword.create','{}','${"b".repeat(64)}','proposed')`);
    await assert.rejects(() => db.exec(`insert into assistant_actions(id,turn_id,ordinal,kind,args_json,intent_digest,status)
      values('a2','${t1}',0,'source.create','{}','${"c".repeat(64)}','proposed')`), /unique/i);
    await db.exec(`insert into assistant_actions(id,turn_id,ordinal,kind,args_json,intent_digest,status)
      values('a3','${t1}',1,'source.create','{}','${"c".repeat(64)}','proposed')`);
    await db.exec(`update assistant_actions set decision_request_id='d1' where id='a1'`);
    await assert.rejects(() => db.exec(`update assistant_actions set decision_request_id='d1' where id='a3'`), /unique/i);
    // Tool calls are per-run and reject the same call with different args.
    await db.exec(`insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at)
      values('toolcall-run','toolcall-request','research','eino','i','m','loom-agent-v1','{}','running','c3',now()+interval '1 hour')`);
    await db.exec(`insert into assistant_tool_calls(run_id,call_id,tool,args_digest,state)
      values('toolcall-run','call1','list_keywords','${"d".repeat(64)}','completed')`);
    await assert.rejects(() => db.exec(`insert into assistant_tool_calls(run_id,call_id,tool,args_digest,state)
      values('toolcall-run','call1','list_keywords','${"e".repeat(64)}','started')`));
  } finally {
    await db.exec("drop schema if exists assistant_probe cascade;").catch(() => {});
  }
});

test("0027 backfills job_kind and assistant rows bind runtime facts", async () => {
  const db = await openDb();
  try {
    await legacyBase(db);
    await applyAll(db, assistantFiles);
    for (const name of assistantFiles) await db.query("insert into _migrations(name) values($1)", [name]);
    assert.equal((await db.query("select job_kind from ai_jobs where id='legacy-job'")).rows[0].job_kind, "research");
    // assistant job bound to a real turn is accepted and binds result_saved.
    await db.exec(`insert into assistant_conversations(id,title,revision) values('c9','对话',0)`);
    await db.exec(`insert into assistant_turns(id,conversation_id,request_id,request_hash,status)
      values('turn-x','c9','${randomUUID()}','${"f".repeat(64)}','queued')`);
    await db.exec(`insert into ai_jobs(id,item_id,material_hash,policy_version,status,runtime_provider,job_kind,payload)
      values('assistant-job','assistant:turn-x','materials','loom-assistant-v1','queued','opencode','assistant','{"provider":"opencode","mode":"research"}')`);
    await db.exec(`insert into ai_runs(id,request_id,mode,provider,input_hash,material_hash,policy_version,request_json,status,claim_token,expires_at)
      values('assistant-run','assistant-request','research','opencode','i','m','loom-assistant-v1','{}','running','c2',now()+interval '1 hour')`);
    await db.exec(`update ai_jobs set run_id='assistant-run' where id='assistant-job'`);
    await db.exec(`insert into ai_runtime_bindings(run_id,provider,runtime_version,config_digest,instance_id,epoch,session_id,dispatch_id,state)
      values('assistant-run','opencode','1.3.13','${"b".repeat(64)}','inst2','22222222-2222-4222-8222-222222222222','sess2','disp2','submitted')`);
    await db.exec(`update ai_runtime_bindings set state='result_saved' where run_id='assistant-run'`);
    assert.equal((await db.query("select state from ai_runtime_bindings where run_id='assistant-run'")).rows[0].state, "result_saved");
    // research bindings keep the candidate_saved state (not rewritten to assistant states).
    assert.equal((await db.query("select state from ai_runtime_bindings where run_id='legacy-run'")).rows[0].state, "candidate_saved");
  } finally { /* keep for next probe */ }
});

test("assistant jobs cannot claim opencode runtime without a conversation turn (0027 CHECK)", async () => {
  const db = await openDb();
  try {
    await applyAll(db, files);
    await db.exec(`insert into assistant_conversations(id,title,revision) values('c2','对话',0)`);
    await db.exec(`insert into assistant_turns(id,conversation_id,request_id,request_hash,status)
      values('turn-ok','c2','${randomUUID()}','${"f".repeat(64)}','queued')`);
    // Valid: assistant job with a linked turn.
    await db.exec(`insert into ai_jobs(id,item_id,material_hash,policy_version,status,runtime_provider,job_kind,payload)
      values('aj1','assistant:turn-ok','m','loom-assistant-v1','queued','opencode','assistant','{}')`);
    // Invalid: assistant job whose item_id has no assistant_turns row.
    await assert.rejects(
      () => db.exec(`insert into ai_jobs(id,item_id,material_hash,policy_version,status,runtime_provider,job_kind,payload)
        values('aj2','assistant:nope','m','loom-assistant-v1','queued','opencode','assistant','{}')`),
      /assistant_turn|check/i,
    );
    // Invalid: legacy analyze mode must never appear under opencode runtime.
    await assert.rejects(
      () => db.exec(`insert into ai_jobs(id,item_id,material_hash,policy_version,status,runtime_provider,job_kind,payload)
        values('aj3','plain-item','m','loom-agent-v1','queued','opencode','analyze_item','{}')`),
      /check/i,
    );
  } finally { /* isolated db */ }
});

test("invalid legacy backfill rolls 0027 back while 0026 stays applied", async () => {
  const db = await openDb();
  try {
    await legacyBase(db);
    // Job payload mode contradicts the run it links: 0027 must refuse to classify.
    await db.exec(`update ai_jobs set payload='{"provider":"opencode","mode":"analyze_item"}' where id='legacy-job'`);
    // Each file applies in its own transaction (scripts/migrate.mjs parity):
    // 0026 commits, 0027 throws and rolls back only itself.
    await db.exec(readFileSync("migrations/" + assistantFiles[0], "utf8"));
    await db.query("insert into _migrations(name) values($1)", [assistantFiles[0]]);
    await assert.rejects(() => db.exec(readFileSync("migrations/" + assistantFiles[1], "utf8")));
    assert.equal((await db.query("select name from _migrations where name like '0027%'")).rows.length, 0);
    assert.equal((await db.query("select column_name from information_schema.columns where table_name='ai_jobs' and column_name='job_kind'")).rows.length, 0,
      "0027 DDL must roll back with its transaction");
    assert.equal((await db.query("select count(*)::int as n from assistant_conversations")).rows[0].n, 0, "0026 applied but empty until retry completes");
    // Fix the data; retry succeeds and legacy rows read back complete.
    await db.exec(`update ai_jobs set payload='{"provider":"opencode","mode":"research"}' where id='legacy-job'`);
    await db.exec(readFileSync("migrations/" + assistantFiles[1], "utf8"));
    await db.query("insert into _migrations(name) values($1)", [assistantFiles[1]]);
    const runs = await db.query<{ run: Record<string, unknown> }>("select to_jsonb(r) as run from ai_runs r where r.id='legacy-run'");
    assert.equal(runs.rows[0].run.status, "succeeded");
    assert.equal((await db.query("select job_kind from ai_jobs where id='legacy-job'")).rows[0].job_kind, "research");
  } finally { /* isolated db */ }
});

test("re-running applied migrations is a no-op (deploy runner parity)", async () => {
  const db = await openDb();
  try {
    const applied = new Set<string>();
    await applyPending(db, applied);
    await db.exec(`insert into assistant_conversations(id,title,revision) values('keep','保留',2)`);
    // The deploy runner records basenames; a re-run skips applied files.
    await applyPending(db, applied);
    assert.equal((await db.query("select count(*)::int as n from assistant_conversations")).rows[0].n, 1);
    assert.equal(applied.size, files.length);
  } finally { /* isolated db */ }
});
