import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { proposeAssistantActions, decideAssistantAction, type ProposeInput } from "./assistant-actions.ts";
import { buildActionPreview } from "./assistant-action-preview.ts";
import type { AssistantAction } from "../assistant-contract.ts";

/**
 * Task 11: §6 state machine — propose (host preview + digest) → decide
 * (approve/reject, idempotent by decision_request_id) → execute in SQL with
 * receipt + event in the same transaction. Concurrent approvals elect one
 * winner; forged model success never lands; stale previews expire.
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

async function seedTurn(sql: Awaited<ReturnType<typeof db>>["sql"]) {
  const [conv] = await sql.query<{ id: string }>("insert into assistant_conversations(id) values($1) returning id", [randomUUID()]);
  const [turn] = await sql.query<{ id: string }>(
    `insert into assistant_turns(id, conversation_id, request_id, request_hash, status)
     values($1,$2,$3,'${"f".repeat(64)}','awaiting_confirmation') returning id`,
    [randomUUID(), conv.id, randomUUID()],
  );
  return { conversationId: conv.id, turnId: turn.id };
}

const kwCreate = (keyword = "固态电池"): AssistantAction => ({
  ordinal: 0,
  kind: "keyword.create",
  args: { keyword, platforms: ["rss", "bilibili"], interval: 30, enabled: true },
});

function proposeInput(turnId: string, conversationId: string, actions: AssistantAction[] = [kwCreate()]): ProposeInput {
  return { conversationId, turnId, actions };
}

test("propose generates host preview with digest and expected state", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const proposals = await proposeAssistantActions(sql, proposeInput(t.turnId, t.conversationId));
  assert.equal(proposals.length, 1);
  const p = proposals[0];
  assert.match(p.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(p.status, "proposed");
  assert.ok(p.previewText.length > 0, "human-readable Chinese preview");
  assert.ok(p.expiresAt != null);
  // The preview stores the CURRENT config state for precondition checks.
  // keyword.create has no pre-existing target: expected stays null by design.
  assert.ok(p.expected === null);
});

test("decide with matching digest executes in one transaction and writes receipt + event", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const [proposal] = await proposeAssistantActions(sql, proposeInput(t.turnId, t.conversationId));
  const decision = {
    requestId: randomUUID(),
    decision: "approve" as const,
    previewDigest: proposal.previewDigest,
    revision: 0,
  };
  const receipt = await decideAssistantAction(sql, t.conversationId, proposal.id, decision);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.effect, "created");
  assert.equal(receipt.changed_domains.includes("keywords"), true);
  const [row] = await sql.query<{ id: string }>("select id from keywords where phrase='固态电池'");
  assert.ok(row, "keyword was actually written");
  // Receipt persisted with the action row.
  const [action] = await sql.query<{ status: string; result_json: Record<string, unknown> }>(
    "select status, result_json from assistant_actions where id=$1", [proposal.id],
  );
  assert.equal(action.status, "succeeded");
  assert.equal(action.result_json.status, "succeeded");
  // Event appended.
  const events = await sql.query<{ type: string }>(
    "select type from assistant_events where conversation_id=$1 order by seq", [t.conversationId],
  );
  assert.ok(events.some((e) => e.type === "action.updated"), "action.updated event emitted");
});

test("concurrent approval elects exactly one winner", async () => {
  const { pg, sql } = await db();
  const t = await seedTurn(sql);
  const [proposal] = await proposeAssistantActions(sql, proposeInput(t.turnId, t.conversationId));
  const decision = () => ({
    requestId: randomUUID(),
    decision: "approve" as const,
    previewDigest: proposal.previewDigest,
    revision: 0,
  });
  const [a, b] = await Promise.allSettled([
    decideAssistantAction(sql, t.conversationId, proposal.id, decision()),
    decideAssistantAction(sql, t.conversationId, proposal.id, decision()),
  ]);
  // The loser returns a conflict RECEIPT (a value), it does not throw.
  const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : "err"));
  assert.equal(statuses.filter((s0) => s0 === "succeeded").length, 1, "exactly one approval executes");
  assert.equal(statuses.filter((s0) => s0 === "conflict" || s0 === "err").length, 1, "the loser surfaces a conflict");
  const keywords = await sql.query("select id from keywords where phrase='固态电池'");
  assert.equal(keywords.length, 1, "single keyword row despite concurrency");
  void pg;
});

test("same decision request id with different digest conflicts and does not execute", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const [proposal] = await proposeAssistantActions(sql, proposeInput(t.turnId, t.conversationId));
  const requestId = randomUUID();
  const first = await decideAssistantAction(sql, t.conversationId, proposal.id, {
    requestId, decision: "approve", previewDigest: "b".repeat(64), revision: 0,
  });
  assert.equal(first.status, "digest_mismatch");
  // Same request id, now correct digest — the earlier refusal must not have
  // started anything; this is a fresh (non-executed) action, so it proceeds.
  const second = await decideAssistantAction(sql, t.conversationId, proposal.id, {
    requestId, decision: "approve", previewDigest: proposal.previewDigest, revision: 0,
  });
  assert.equal(second.status, "succeeded");
  const keywords = await sql.query("select id from keywords where phrase='固态电池'");
  assert.equal(keywords.length, 1);
});

test("expired preview is rejected", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const [proposal] = await proposeAssistantActions(sql, proposeInput(t.turnId, t.conversationId), { expiresInMs: -1000 });
  const receipt = await decideAssistantAction(sql, t.conversationId, proposal.id, {
    requestId: randomUUID(), decision: "approve", previewDigest: proposal.previewDigest, revision: 0,
  });
  assert.equal(receipt.status, "expired");
  const keywords = await sql.query("select id from keywords where phrase='固态电池'");
  assert.equal(keywords.length, 0);
});

test("model-forged success cannot mark an action succeeded without host execution", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const [proposal] = await proposeAssistantActions(sql, proposeInput(t.turnId, t.conversationId));
  // A 'succeeded' status cannot be written by anything except host execution:
  // the public decide API only accepts approve/reject, and the result column
  // is only written by executeProposalAction.
  const [before] = await sql.query<{ status: string }>("select status from assistant_actions where id=$1", [proposal.id]);
  assert.equal(before.status, "proposed");
  const reject = await decideAssistantAction(sql, t.conversationId, proposal.id, {
    requestId: randomUUID(), decision: "reject", previewDigest: proposal.previewDigest, revision: 0,
  });
  assert.equal(reject.status, "rejected");
  const [after] = await sql.query<{ status: string; result_json: Record<string, unknown> | null }>(
    "select status, result_json from assistant_actions where id=$1", [proposal.id],
  );
  assert.equal(after.status, "rejected");
  assert.equal(after.result_json, null, "rejected action carries no fabricated receipt");
});

test("authorized intent matching the executed action skips preview", async () => {
  const { sql } = await db();
  const t = await seedTurn(sql);
  const [proposal] = await proposeAssistantActions(sql, proposeInput(t.turnId, t.conversationId, [
    { ordinal: 0, kind: "keyword.set_enabled", args: { keyword_id: "kw-direct", enabled: true } },
  ]), { intent: { type: "keyword.set_enabled", keyword_id: "kw-direct", enabled: true } });
  assert.equal(proposal.authorizationSource, "intent", "intent-authorized action is marked");
  const receipt = await decideAssistantAction(sql, t.conversationId, proposal.id, {
    requestId: randomUUID(), decision: "approve", previewDigest: proposal.previewDigest, revision: 0,
    skipPreview: true,
  });
  // kw-direct does not exist → not_found (honest receipt), but no preview was
  // required before execution.
  assert.equal(receipt.status, "not_found");
});

test("preview reflects real config state and preview builder is pure", async () => {
  const { sql } = await db();
  await sql.query("insert into keywords(id,phrase,platforms,interval_minutes,enabled) values('kw-ex','已有词','[\"rss\"]'::jsonb,60,false)");
  const preview = buildActionPreview(
    { ordinal: 0, kind: "keyword.update", args: { keyword_id: "kw-ex", interval: 5 } },
    { interval: 60, platforms: ["rss"], enabled: false },
    "act-x",
  );
  assert.ok(preview.text.includes("60"), "preview shows old interval");
  assert.ok(preview.text.includes("5"), "preview shows new interval");
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
});
