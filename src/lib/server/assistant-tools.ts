/**
 * Assistant read-only tools + per-run tool ledger (plan Task 6 / §3.1).
 *
 * "Read-only" precisely means: no ensureSeeded, no business writes, no
 * expiry convergence, no external IO, no model calls. The tool ledger
 * (assistant_tool_calls, 0026) replays identical calls and refuses the same
 * call_id with different args, mirroring ai_tool_calls for research.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { hashCanonical } from "./agent-runs.ts";

type Queryable = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };

export const ASSISTANT_TOOLS = [
  "project_overview", "list_keywords", "list_sources", "search_items", "get_item",
  "list_notes", "get_note", "list_collection_jobs", "get_collection_job",
  "get_research_status", "get_operation", "get_service_status",
] as const;

export type AssistantTool = (typeof ASSISTANT_TOOLS)[number];

const TOOL_BUDGET_PER_RUN = 8;
const TOOL_RESULT_MAX_BYTES = 64 * 1024;
const BODY_CODE_POINT_CAP = 1200;

const argsSchema = z.object({
  note_id: z.string().trim().min(1).max(128).optional(),
  action_id: z.string().trim().min(1).max(128).optional(),
  item_id: z.string().trim().min(1).max(128).optional(),
  job_id: z.string().trim().min(1).max(128).optional(),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

export type ToolArgs = z.infer<typeof argsSchema>;

export type ToolOutcome =
  | { ok: true; value: unknown; replayed: boolean }
  | { ok: false; error_code: "run_not_active" | "tool_conflict" | "tool_budget_exceeded" | "unknown_tool" | "invalid_args" | "result_too_large" };

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function mapKeyword(row: Record<string, unknown>) {
  return {
    id: String(row.id), phrase: String(row.phrase),
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    interval_minutes: Number(row.interval_minutes), enabled: Boolean(row.enabled),
  };
}

function mapSource(row: Record<string, unknown>) {
  return {
    id: String(row.id), name: String(row.name), platform: String(row.platform),
    enabled: Boolean(row.enabled), status: String(row.status),
  };
}

function clipCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  // The ellipsis counts toward the cap: the result never exceeds max code points.
  return points.length <= max ? value : points.slice(0, max - 1).join("") + "…";
}

/**
 * Execute one assistant read tool for an active run. The run must exist,
 * still be running, not expired, and present the matching data token. The
 * per-run ledger arbitrates replays and conflicts before any query runs.
 */
export async function runAssistantTool(
  sql: Queryable,
  input: {
    runId: string;
    conversationId: string;
    turnId: string;
    dataTokenHash: string;
    callId: string;
    tool: string;
    args: Record<string, unknown>;
  },
): Promise<ToolOutcome> {
  if (!ASSISTANT_TOOLS.includes(input.tool as AssistantTool)) return { ok: false, error_code: "unknown_tool" };
  const parsedArgs = argsSchema.safeParse(input.args);
  if (!parsedArgs.success) return { ok: false, error_code: "invalid_args" };
  const args = parsedArgs.data as ToolArgs;
  const argsDigest = sha({ tool: input.tool, args });

  const [run] = await sql.query<Record<string, unknown>>(
    "select id, status, expires_at, data_token_hash from ai_runs where id = $1", [input.runId],
  );
  if (!run || String(run.status) !== "running" || Date.parse(String(run.expires_at)) <= Date.now()) {
    return { ok: false, error_code: "run_not_active" };
  }
  if (String(run.data_token_hash ?? "") !== input.dataTokenHash || !input.dataTokenHash) {
    return { ok: false, error_code: "run_not_active" };
  }

  const [existing] = await sql.query<Record<string, unknown>>(
    "select * from assistant_tool_calls where run_id = $1 and call_id = $2", [input.runId, input.callId],
  );
  if (existing) {
    if (String(existing.tool) !== input.tool || String(existing.args_digest) !== argsDigest) {
      return { ok: false, error_code: "tool_conflict" };
    }
    if (String(existing.state) === "completed" && existing.result_json != null) {
      const stored = typeof existing.result_json === "string" ? JSON.parse(existing.result_json) : existing.result_json;
      return { ok: true, value: stored, replayed: true };
    }
  }

  const [count] = await sql.query<{ n: number }>(
    "select count(*)::int as n from assistant_tool_calls where run_id = $1", [input.runId],
  );
  if (count.n >= TOOL_BUDGET_PER_RUN) return { ok: false, error_code: "tool_budget_exceeded" };

  if (!existing) {
    await sql.query(
      "insert into assistant_tool_calls(run_id, call_id, tool, args_digest, state) values($1,$2,$3,$4,'started')",
      [input.runId, input.callId, input.tool, argsDigest],
    );
  }

  const value = await executeRead(sql, input.conversationId, input.turnId, input.tool as AssistantTool, args);
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, "utf8") > TOOL_RESULT_MAX_BYTES) {
    return { ok: false, error_code: "result_too_large" };
  }
  await sql.query(
    `update assistant_tool_calls set state='completed', result_json=$3::jsonb, result_digest=$4, finished_at=clock_timestamp()
     where run_id=$1 and call_id=$2`,
    [input.runId, input.callId, serialized, sha(value ?? null)],
  );
  return { ok: true, value, replayed: false };
}

async function executeRead(
  sql: Queryable,
  conversationId: string,
  turnId: string,
  tool: AssistantTool,
  args: ToolArgs,
): Promise<unknown> {
  switch (tool) {
    case "list_keywords": {
      const limit = Math.min(args.limit ?? 50, 50);
      const rows = await sql.query<Record<string, unknown>>(
        `select id, phrase, platforms, interval_minutes, enabled from keywords order by created_at desc limit $1`, [limit + 1],
      );
      const truncated = rows.length > limit;
      return { keywords: rows.slice(0, limit).map(mapKeyword), truncated };
    }
    case "list_sources": {
      const limit = Math.min(args.limit ?? 50, 50);
      const rows = await sql.query<Record<string, unknown>>(
        `select id, name, platform, enabled, status from sources order by platform, name limit $1`, [limit + 1],
      );
      const truncated = rows.length > limit;
      return { sources: rows.slice(0, limit).map(mapSource), truncated };
    }
    case "get_item": {
      const itemId = args.item_id;
      if (!itemId) return { item: null };
      const [row] = await sql.query<Record<string, unknown>>(
        `select i.id, i.title, i.platform, i.body, i.url, i.published_at, s.name as source_name
         from items i join sources s on s.id = i.source_id where i.id = $1`, [itemId],
      );
      if (!row) return { item: null };
      return {
        item: {
          id: String(row.id), title: String(row.title ?? ""), platform: String(row.platform),
          source_name: String(row.source_name ?? ""), url: String(row.url ?? ""),
          published_at: row.published_at == null ? null : String(row.published_at),
          body: clipCodePoints(String(row.body ?? ""), BODY_CODE_POINT_CAP),
        },
      };
    }
    case "search_items": {
      const query = (args.query ?? "").trim();
      const limit = Math.min(args.limit ?? 8, 8);
      // Empty/short query = "latest collected" listing, so "最近收集了什么"
      // is answerable without a keyword; a real query still filters.
      const rows = Array.from(query).length < 2
        ? await sql.query<Record<string, unknown>>(
            `select i.id, i.title, i.platform, s.name as source_name, i.body
             from items i join sources s on s.id = i.source_id
             order by i.collected_at desc limit $1`, [limit])
        : await sql.query<Record<string, unknown>>(
            `select i.id, i.title, i.platform, s.name as source_name, i.body
             from items i join sources s on s.id = i.source_id
             where i.title ilike $1 or i.body ilike $1
             order by i.collected_at desc limit $2`,
            [`%${query.replace(/[%_]/g, "")}%`, limit]);
      return {
        items: rows.map((row) => ({
          id: String(row.id), title: String(row.title ?? ""), platform: String(row.platform),
          source_name: String(row.source_name ?? ""), snippet: clipCodePoints(String(row.body ?? ""), 300),
        })),
      };
    }
    case "get_note": {
      const noteId = args.note_id;
      if (!noteId) return { note: null };
      const [row] = await sql.query<Record<string, unknown>>(
        `select id, title, kind, content from knowledge_notes where id = $1`, [noteId],
      );
      if (!row) return { note: null };
      return { note: { id: String(row.id), title: String(row.title ?? ""), kind: String(row.kind ?? ""), content: clipCodePoints(String(row.content ?? ""), BODY_CODE_POINT_CAP) } };
    }
    case "list_notes": {
      const limit = Math.min(args.limit ?? 20, 20);
      const rows = await sql.query<Record<string, unknown>>(
        "select id, title, kind from knowledge_notes order by created_at desc limit $1", [limit + 1],
      );
      const truncated = rows.length > limit;
      return { notes: rows.slice(0, limit).map((r) => ({ id: String(r.id), title: String(r.title ?? ""), kind: String(r.kind ?? "") })), truncated };
    }
    case "list_collection_jobs": {
      const limit = Math.min(args.limit ?? 50, 50);
      const rows = await sql.query<Record<string, unknown>>(
        // jobs table has started_at, not created_at (production schema).
        `select id, kind, status, error, started_at, finished_at from jobs order by started_at desc limit $1`, [limit + 1],
      );
      const truncated = rows.length > limit;
      return {
        jobs: rows.slice(0, limit).map((r) => ({
          id: String(r.id), kind: String(r.kind ?? ""), status: String(r.status ?? ""),
          error: String(r.error ?? "").slice(0, 200),
          started_at: r.started_at == null ? null : String(r.started_at),
          finished_at: r.finished_at == null ? null : String(r.finished_at),
        })), truncated,
      };
    }
    case "get_collection_job": {
      const jobId = args.job_id;
      if (!jobId) return { job: null };
      const [row] = await sql.query<Record<string, unknown>>(
        "select id, kind, status, error, started_at, finished_at from jobs where id = $1", [jobId],
      );
      if (!row) return { job: null };
      return {
        job: {
          id: String(row.id), kind: String(row.kind ?? ""), status: String(row.status ?? ""),
          error: String(row.error ?? "").slice(0, 200),
          started_at: row.started_at == null ? null : String(row.started_at),
          finished_at: row.finished_at == null ? null : String(row.finished_at),
        },
      };
    }
    case "project_overview": {
      const [counts] = await sql.query<Record<string, unknown>>(
        `select
           (select count(*)::int from sources) as source_count,
           (select count(*)::int from sources where enabled) as source_enabled,
           (select count(*)::int from keywords) as keyword_count,
           (select count(*)::int from keywords where enabled) as keyword_enabled,
           (select count(*)::int from items) as item_count,
           (select count(*)::int from items where collected_at > now() - interval '24 hours') as new_24h,
           (select count(*)::int from knowledge_notes) as note_count`,
      );
      return { overview: counts };
    }
    case "get_research_status": {
      // Scope: only jobs this conversation's turns created (turn.job_id).
      const [row] = await sql.query<Record<string, unknown>>(
        `select j.id, j.status, j.error_code
         from ai_jobs j join assistant_turns t on t.job_id = j.id
         where j.id = $1 and t.conversation_id = $2`,
        [args.job_id ?? "", conversationId],
      );
      if (!row) return { research: null };
      return {
        research: {
          job_id: String(row.id), status: String(row.status),
          error_code: String(row.error_code ?? "").slice(0, 64) || undefined,
        },
      };
    }
    case "get_operation": {
      // Scope: only actions belonging to this conversation.
      const actionId = args.action_id;
      if (!actionId) return { operation: null };
      const [row] = await sql.query<Record<string, unknown>>(
        `select a.id, a.kind, a.status, a.result_json
         from assistant_actions a join assistant_turns t on t.id = a.turn_id
         where a.id = $1 and t.conversation_id = $2`,
        [actionId, conversationId],
      );
      if (!row) return { operation: null };
      const result = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
      return { operation: { action_id: String(row.id), kind: String(row.kind), status: String(row.status), result } };
    }
    case "get_service_status": {
      // Desensitized subset of node status: presence, not credentials.
      const rows = await sql.query<Record<string, unknown>>(
        `select id, platform, enabled, status from sources where enabled order by platform`,
      ).catch(() => [] as Record<string, unknown>[]);
      return { services: rows.map((r) => ({ platform: String(r.platform), status: String(r.status) })), observed_at: new Date().toISOString() };
    }
  }
}
