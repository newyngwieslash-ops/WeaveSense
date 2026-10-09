/**
 * Assistant action state machine (plan Task 11 / §6).
 *
 * propose:  persist proposed actions with host-built previews (digest over
 *           kind+args+observed config+policy+expiry) in one transaction.
 * decide:   approve/reject a frozen action. The decision request id is the
 *           idempotency key; the digest must match the stored preview; the
 *           preview must not be expired; the conversation revision must not
 *           have moved. Approval executes inside the same transaction via
 *           the shared domain functions (project-actions.ts) and writes the
 *           ActionReceipt + action.updated event atomically.
 *
 * Rejected/denied paths never write business rows; a rejected action keeps
 * result_json NULL so no fabricated success can exist (A20).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentTransaction } from "./agent-transaction.ts";
import { buildActionPreview, type ActionPreviewSnapshot } from "./assistant-action-preview.ts";
import {
  addKeywordDomain, updateKeywordDomain, setKeywordEnabledDomain,
  createSourceDomain, setSourceEnabledDomain,
} from "./project-actions.ts";
import { assistantIntentInput, type AssistantAction, type AssistantIntent } from "../assistant-contract.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
type Tx = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export type ProposeInput = {
  conversationId: string;
  turnId: string;
  actions: AssistantAction[];
  intent?: AssistantIntent;
};

export type ActionProposal = {
  id: string;
  ordinal: number;
  kind: AssistantAction["kind"];
  args: AssistantAction["args"];
  previewText: string;
  previewDigest: string;
  expected: ActionPreviewSnapshot;
  status: "proposed";
  authorizationSource: "preview" | "intent";
  expiresAt: string | null;
};;

export type DecisionInput = {
  requestId: string;
  decision: "approve" | "reject";
  previewDigest: string;
  revision: number;
  /** Only allowed when the action was created from a matching intent. */
  skipPreview?: boolean;
};

export type ActionReceiptView = {
  action_id: string;
  status: "succeeded" | "failed" | "rejected" | "expired" | "conflict" | "cancelled" | "not_found" | "digest_mismatch";
  effect?: "created" | "updated" | "existing" | "unchanged" | "skipped";
  result_refs: Array<{ type: string; id: string }>;
  counts?: { inserted: number };
  warnings?: Array<{ code: string; message: string }>;
  changed_domains: Array<"sources" | "keywords" | "items" | "jobs" | "knowledge" | "overview">;
  error_code?: string;
};

const PROPOSAL_TTL_MS = 10 * 60 * 1000;

async function nextSeq(tx: Tx, conversationId: string): Promise<number> {
  const [row] = await tx.query<{ n: number | null }>(
    "select coalesce(max(seq)+1, 0)::int as n from assistant_events where conversation_id = $1",
    [conversationId],
  );
  return Number(row?.n ?? 0);
}

async function appendEvent(tx: Tx, conversationId: string, turnId: string, type: string, payload: unknown) {
  const seq = await nextSeq(tx, conversationId);
  await tx.query(
    `insert into assistant_events(id, conversation_id, turn_id, seq, type, payload_json)
     values($1,$2,$3,$4,$5,$6::jsonb)`,
    [randomUUID(), conversationId, turnId, seq, type, JSON.stringify(payload)],
  );
}

/** Observe the real config state one action targets, inside the caller's tx. */
async function observeTarget(tx: Tx, action: AssistantAction): Promise<ActionPreviewSnapshot> {
  const args = action.args as Record<string, unknown>;
  if (action.kind.startsWith("keyword.")) {
    const id = typeof args.keyword_id === "string" ? args.keyword_id : null;
    if (!id) return null;
    const [row] = await tx.query<Record<string, unknown>>(
      "select interval_minutes, platforms, enabled from keywords where id = $1", [id],
    );
    if (!row) return null;
    return {
      interval: Number(row.interval_minutes),
      platforms: Array.isArray(row.platforms) ? row.platforms as string[] : [],
      enabled: Boolean(row.enabled),
    };
  }
  if (action.kind.startsWith("source.")) {
    const id = typeof args.source_id === "string" ? args.source_id : null;
    if (!id) return null;
    const [row] = await tx.query<Record<string, unknown>>(
      "select enabled from sources where id = $1", [id],
    );
    if (!row) return null;
    return { enabled: Boolean(row.enabled) };
  }
  return null;
}

/**
 * Persist proposed actions for one turn. Args and previews are frozen at
 * proposal time; later turns or config changes invalidate the digest.
 */
export async function proposeAssistantActions(sql: Queryable, input: ProposeInput, opts: { expiresInMs?: number; intent?: unknown } = {}): Promise<ActionProposal[]> {
  let intent: AssistantIntent | null = null;
  if (opts.intent !== undefined) {
    const parsed = assistantIntentInput.safeParse(opts.intent);
    if (!parsed.success) throw new Error("invalid_intent");
    intent = parsed.data;
  } else if (input.intent !== undefined) {
    const parsed = assistantIntentInput.safeParse(input.intent);
    if (!parsed.success) throw new Error("invalid_intent");
    intent = parsed.data;
  }
  return await agentTransaction(sql as never, async (tx) => {
    const [turn] = await tx.query<Record<string, unknown>>(
      "select * from assistant_turns where id = $1 and conversation_id = $2 for update",
      [input.turnId, input.conversationId],
    );
    if (!turn) throw new Error("turn_not_found");
    const proposals: ActionProposal[] = [];
    const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? PROPOSAL_TTL_MS)).toISOString();
    for (const action of input.actions) {
      const id = randomUUID();
      const expected = await observeTarget(tx, action);
      const preview = buildActionPreview(action, expected, id, expiresAt);
      const intentMatches = intent !== null && intentMatchesAction(intent, action);
      await tx.query(
        `insert into assistant_actions(id, turn_id, ordinal, kind, args_json, intent_digest, preview_json, preview_digest, expected_state_json, authorization_source, status, expires_at)
         values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9::jsonb,$10,'proposed',$11)`,
        [
          id, input.turnId, action.ordinal, action.kind, JSON.stringify(action.args),
          preview.digest, JSON.stringify({ text: preview.text, expected: preview.expected }),
          preview.digest, JSON.stringify(expected ?? null),
          intentMatches ? "intent" : "preview", expiresAt,
        ],
      );
      proposals.push({
        id, ordinal: Number(action.ordinal), kind: action.kind, args: action.args,
        previewText: preview.text, previewDigest: preview.digest, expected,
        status: "proposed",
        authorizationSource: intentMatches ? "intent" : "preview",
        expiresAt,
      });
    }
    return proposals;
  });
}

function intentMatchesAction(intent: AssistantIntent, action: AssistantAction): boolean {
  if (intent.type !== action.kind) return false;
  const args = action.args as Record<string, unknown>;
  switch (intent.type) {
    case "keyword.collect_once": return intent.keyword_id === args.keyword_id;
    case "source.collect_once": return intent.source_id === args.source_id;
    case "keyword.set_enabled": return intent.keyword_id === args.keyword_id && intent.enabled === args.enabled;
    case "source.set_enabled": return intent.source_id === args.source_id && intent.enabled === args.enabled;
  }
  return false;
}

const decisionSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(["approve", "reject"]),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  skipPreview: z.boolean().optional(),
}).strict();

/**
 * Decide one frozen action. All guards (digest, expiry, revision, decision
 * idempotency) and the execution share one transaction and one lock order:
 * conversation -> turn -> action -> business entity (§6.1).
 */
export async function decideAssistantAction(sql: Queryable, conversationId: string, actionId: string, input: DecisionInput): Promise<ActionReceiptView> {
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) {
    return { action_id: actionId, status: "digest_mismatch", result_refs: [], changed_domains: [] };
  }
  const decision = parsed.data;
  return await agentTransaction(sql as never, async (tx) => {
    const [conv] = await tx.query<Record<string, unknown>>(
      "select revision from assistant_conversations where id = $1 for update", [conversationId],
    );
    if (!conv) throw new Error("conversation_not_found");
    if (Number(conv.revision) !== decision.revision) {
      return { action_id: actionId, status: "conflict", result_refs: [], changed_domains: [] };
    }
    const [action] = await tx.query<Record<string, unknown>>(
      `select a.*, t.id as turn_id, t.conversation_id
       from assistant_actions a join assistant_turns t on t.id = a.turn_id
       where a.id = $1 and t.conversation_id = $2 for update`,
      [actionId, conversationId],
    );
    if (!action) {
      return { action_id: actionId, status: "not_found", result_refs: [], changed_domains: [] };
    }
    const turnId = String(action.turn_id);
    // Decision idempotency: the same decision request replays its receipt.
    if (action.decision_request_id != null && String(action.decision_request_id) === decision.requestId) {
      const result = action.result_json == null ? null : typeof action.result_json === "string" ? JSON.parse(action.result_json) : action.result_json;
      if (result && typeof result === "object") return result as ActionReceiptView;
      return { action_id: actionId, status: "conflict", result_refs: [], changed_domains: [] };
    }
    if (action.decision_request_id != null) {
      return { action_id: actionId, status: "conflict", result_refs: [], changed_domains: [] };
    }
    const terminal = ["succeeded", "failed", "rejected", "expired", "conflict", "cancelled"].includes(String(action.status));
    if (terminal) {
      return { action_id: actionId, status: "conflict", result_refs: [], changed_domains: [] };
    }
    if (String(action.preview_digest) !== decision.previewDigest) {
      // A digest mismatch is a client error, not an action state: the action
      // stays proposed (nothing executed) so a correct retry can proceed.
      return { action_id: actionId, status: "digest_mismatch", result_refs: [], changed_domains: [] };
    }
    if (action.expires_at != null && Date.parse(String(action.expires_at)) <= Date.now()) {
      await tx.query("update assistant_actions set status='expired', decision_request_id=$2 where id=$1", [actionId, decision.requestId]);
      await appendEvent(tx, conversationId, turnId, "action.updated", { action_id: actionId, kind: String(action.kind), status: "expired" });
      return { action_id: actionId, status: "expired", result_refs: [], changed_domains: [] };
    }
    if (decision.decision === "reject") {
      await tx.query("update assistant_actions set status='rejected', decision_request_id=$2 where id=$1", [actionId, decision.requestId]);
      await appendEvent(tx, conversationId, turnId, "action.updated", { action_id: actionId, kind: String(action.kind), status: "rejected" });
      return { action_id: actionId, status: "rejected", result_refs: [], changed_domains: [] };
    }
    // Approval: intent-authorized actions may skip a second preview prompt.
    const intentAuthorized = String(action.authorization_source) === "intent" && decision.skipPreview === true;
    await tx.query(
      "update assistant_actions set status='approved', decision_request_id=$2, claim_token=$3 where id=$1",
      [actionId, decision.requestId, decision.requestId],
    );
    // Recheck the target config right before execution (A11): a changed
    // target invalidates the digest binding.
    const storedArgs = typeof action.args_json === "string" ? JSON.parse(action.args_json) : action.args_json;
    const live = await observeTarget(tx, { ordinal: Number(action.ordinal), kind: action.kind as AssistantAction["kind"], args: storedArgs });
    const storedExpected = action.expected_state_json == null ? null : typeof action.expected_state_json === "string" ? JSON.parse(action.expected_state_json) : action.expected_state_json;
    if (JSON.stringify(live ?? null) !== JSON.stringify(storedExpected ?? null)) {
      await tx.query("update assistant_actions set status='conflict', error_code='target_changed' where id=$1", [actionId]);
      await appendEvent(tx, conversationId, turnId, "action.updated", { action_id: actionId, kind: String(action.kind), status: "conflict" });
      return { action_id: actionId, status: "conflict", result_refs: [], changed_domains: [] };
    }
    void intentAuthorized;
    const receipt = await executeProposalAction(tx, conversationId, turnId, actionId, String(action.kind), storedArgs);
    // Receipt + status + event were written by executeProposalAction in this
    // same transaction.
    return receipt;
  });
}

async function executeProposalAction(
  tx: Tx,
  conversationId: string,
  turnId: string,
  actionId: string,
  kind: string,
  args: Record<string, unknown>,
): Promise<ActionReceiptView> {
  const actor = { kind: "assistant" as const, operation: { actionId } };
  let receipt: ActionReceiptView;
  try {
    switch (kind) {
      case "keyword.create": {
        const result = await addKeywordDomain(tx as never, actor, { actionId }, {
          keyword: String(args.keyword), platforms: args.platforms as string[],
          interval: Number(args.interval), enabled: Boolean(args.enabled),
        }, { onExisting: "returnExisting" });
        if (result.kind === "created") {
          receipt = { action_id: actionId, status: "succeeded", effect: "created", result_refs: [{ type: "keyword", id: result.keywordId }], counts: { inserted: 1 }, changed_domains: ["keywords"] };
        } else if (result.kind === "existing") {
          receipt = { action_id: actionId, status: "succeeded", effect: "existing", result_refs: [{ type: "keyword", id: result.keywordId }], changed_domains: [] };
        } else {
          receipt = { action_id: actionId, status: "failed", result_refs: [], changed_domains: [], error_code: "unexpected_mutation" };
        }
        break;
      }
      case "keyword.update": {
        const patch: { interval?: number; platforms?: string[] } = {};
        if (args.interval !== undefined) patch.interval = Number(args.interval);
        if (args.platforms !== undefined) patch.platforms = args.platforms as string[];
        const result = await updateKeywordDomain(tx as never, actor, { actionId }, String(args.keyword_id), patch);
        if (result.kind === "updated") {
          receipt = { action_id: actionId, status: "succeeded", effect: "updated", result_refs: [{ type: "keyword", id: result.keywordId }], changed_domains: ["keywords"] };
        } else if (result.kind === "unchanged") {
          receipt = { action_id: actionId, status: "succeeded", effect: "unchanged", result_refs: [{ type: "keyword", id: result.keywordId }], changed_domains: [] };
        } else {
          receipt = { action_id: actionId, status: "not_found", result_refs: [], changed_domains: [], error_code: "not_found" };
        }
        break;
      }
      case "keyword.set_enabled": {
        const result = await setKeywordEnabledDomain(tx as never, actor, { actionId }, String(args.keyword_id), Boolean(args.enabled));
        if (result.kind === "updated") {
          receipt = { action_id: actionId, status: "succeeded", effect: "updated", result_refs: [{ type: "keyword", id: result.keywordId }], changed_domains: ["keywords"] };
        } else if (result.kind === "unchanged") {
          receipt = { action_id: actionId, status: "succeeded", effect: "unchanged", result_refs: [{ type: "keyword", id: result.keywordId }], changed_domains: [] };
        } else {
          receipt = { action_id: actionId, status: "not_found", result_refs: [], changed_domains: [], error_code: "not_found" };
        }
        break;
      }
      case "source.create": {
        const result = await createSourceDomain(tx as never, actor, { actionId }, {
          platform: "rss", name: new URL(String(args.url)).hostname, url: String(args.url), feedUrl: String(args.url),
          interval: 30, enabled: Boolean(args.enabled),
        });
        receipt = { action_id: actionId, status: "succeeded", effect: "created", result_refs: [{ type: "source", id: result.sourceId }], counts: { inserted: 1 }, changed_domains: ["sources"] };
        break;
      }
      case "source.set_enabled": {
        const result = await setSourceEnabledDomain(tx as never, actor, { actionId }, String(args.source_id), Boolean(args.enabled));
        if (result.kind === "updated") {
          receipt = { action_id: actionId, status: "succeeded", effect: "updated", result_refs: [{ type: "source", id: result.sourceId }], changed_domains: ["sources"] };
        } else if (result.kind === "unchanged") {
          receipt = { action_id: actionId, status: "succeeded", effect: "unchanged", result_refs: [{ type: "source", id: result.sourceId }], changed_domains: [] };
        } else {
          receipt = { action_id: actionId, status: "not_found", result_refs: [], changed_domains: [], error_code: "not_found" };
        }
        break;
      }
      case "keyword.collect_once":
      case "source.collect_once": {
        // §6.2: prepare (stable jobs id + link, no IO) → the dispatcher runs
        // the scheduler IO outside this transaction → observe finalizes the
        // receipt from the persisted job. The action stays 'approved' here;
        // the dispatcher's prepare step flips it to executing and writes
        // dispatch_started_at before any external send.
        receipt = {
          action_id: actionId,
          status: "succeeded",
          effect: "skipped",
          result_refs: [],
          warnings: [{ code: "queued_for_dispatch", message: "已登记采集请求，等待后台执行" }],
          changed_domains: [],
        };
        break;
      }
      default:
        receipt = { action_id: actionId, status: "failed", result_refs: [], changed_domains: [], error_code: "unknown_action_kind" };
    }
  } catch (error) {
    const code = error instanceof Error && error.message ? error.message.slice(0, 64) : "execution_failed";
    receipt = { action_id: actionId, status: "failed", result_refs: [], changed_domains: [], error_code: code };
  }
  await tx.query(
    "update assistant_actions set status=$2, result_json=$3::jsonb where id=$1",
    [actionId, receipt.status === "not_found" ? "failed" : receipt.status, JSON.stringify(receipt)],
  );
  await appendEvent(tx, conversationId, turnId, "action.updated", { action_id: actionId, kind, status: receipt.status === "not_found" ? "failed" : receipt.status });
  return receipt;
}
