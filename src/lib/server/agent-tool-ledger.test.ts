import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { researchTestDb, testResearchRun } from "../../../validation/agent/opencode/test-db.ts";
import { handleAgentData } from "./agent-data.ts";
import { hashCanonical } from "./agent-runs.ts";
import { hashRunToken } from "./agent-data.ts";

test("OpenCode tool admission counts one RPC, binds its parameters and replays only stored results", async () => {
  const { pg, sql } = await researchTestDb();
  try {
    const run = await testResearchRun(sql, { provider: "opencode", governed: true,
      policy: { version: "loom-agent-v1", max_model_calls: 7, max_tool_calls: 1, max_output_tokens_per_call: 1800 } });
    await sql.query("update ai_runs set data_token_hash=$2 where id=$1", [run.runId, hashRunToken("grant-data")]);
    await sql.query("insert into sources(id,platform,name) values('test-s','rss','测试')");
    await sql.query("insert into items(id,source_id,platform,external_id,title,body) values('a','test-s','rss','a','电池测试','电池证据A'),('b','test-s','rss','b','电池进展','电池证据B')");
    const send = (action: string, params: Record<string, unknown>) => handleAgentData({ sql, runId: run.runId,
      serviceToken: "service", providedServiceToken: "service", runToken: "grant-data", action, params });
    const call_id = randomUUID(), params = { query: "电池", limit: 8 };
    const request_digest = hashCanonical({ tool: "search_items", params });
    const intent = { call_id, tool: "search_items", request_digest };
    assert.equal((await send("search_items", params)).status, 403);
    assert.equal((await send("tool_start", intent)).body.disposition, "send_once");
    assert.equal((await send("tool_start", intent)).body.disposition, "already_started");
    assert.equal((await send("search_items", { ...params, query: "改动", call_id, request_digest })).status, 409);
    const result = await send("search_items", { ...params, call_id, request_digest });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal((result.body.items as unknown[]).length, 2);
    assert.deepEqual(await send("search_items", { ...params, call_id, request_digest }), result);
    assert.equal((await send("tool_complete", { ...intent, result_digest: hashCanonical(result.body) })).status, 200);
    assert.equal((await send("tool_start", { ...intent, call_id: randomUUID() })).status, 429);
    assert.equal((await sql.query("select * from ai_tool_calls")).length, 1);
    const [stored] = await sql.query<{ events_json: unknown[] }>("select events_json from ai_runs where id=$1", [run.runId]);
    assert.equal(stored.events_json.length, 2); // two evidence receipts, one budgeted RPC.
    assert.equal((await send("get_analysis", { item_id: "a" })).status, 403);
    assert.equal((await send("tool_start", { ...intent, run_id: randomUUID() })).status, 400);
  } finally { await pg.close(); }
});
