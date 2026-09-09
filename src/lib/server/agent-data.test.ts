import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { beginRun } from "./agent-runs.ts";
import { handleAgentData, hashRunToken } from "./agent-data.ts";

async function setup() {
  const pg = new PGlite();
  await pg.waitReady;
  for (const migration of ["0002_schema.sql","0004_production.sql","0011_ai_runs.sql","0012_ai_jobs.sql","0013_agent_checkpoints.sql","0014_agent_integrity.sql","0015_agent_budget_reservations.sql","0016_agent_terminal_states.sql","0017_agent_call_receipts.sql","0018_agent_checkpoint_facts.sql","0019_agent_material_revision.sql","0020_agent_daily_admission.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources (id, platform, name) values ('s','rss','信源')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','固态电池','正文内容足够长 100%_ok')");
  const sql = {
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return pg.transaction(async inner => fn({ async query<R>(text: string, params: unknown[] = []) { return (await inner.query<R>(text, params)).rows; } }));
    }, async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await pg.query<T>(text, params)).rows;
  } };
  const runToken = randomBytes(32).toString("hex");
  const begun = await beginRun(sql, {
    id: randomUUID(), requestId: randomUUID(), mode: "research", provider: "eino",
    inputHash: "h", materialHash: "m", policyVersion: "loom-agent-v1",
    requestJson: { question: "q" }, claimToken: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), dataTokenHash: hashRunToken(runToken),
  });
  assert.equal(begun.kind, "won");
  return { pg, sql, runId: begun.kind === "won" ? begun.run.id : "", runToken };
}

const token = "data-token";

test('V5 MCP receipts require authenticated started call, immutable contents and current run token',async()=>{
 const f=await setup();const before=process.env.AGENT_MCP_ALLOWED_TOOLS;process.env.AGENT_MCP_ALLOWED_TOOLS='mcp_lab_search';
 try {
  const params={call_id:randomUUID(),result_index:0,tool:'mcp_lab_search',title:'Lab',url:'https://example.com/evidence',text:'Exact verified quote'};
  const call=(action:string,p=params,runToken=f.runToken)=>handleAgentData({sql:f.sql,serviceToken:token,providedServiceToken:token,runToken,runId:f.runId,action,params:p});
  assert.equal((await call('mcp_receipt')).status,409);
  assert.equal((await call('mcp_start')).status,200);
  const receipt=await call('mcp_receipt');assert.equal(receipt.status,200);
  assert.equal((await call('mcp_receipt')).body.evidence_id,receipt.body.evidence_id);
  assert.equal((await call('mcp_receipt',{...params,text:'Forged quote'})).status,409);
  assert.equal((await call('mcp_receipt',params,'different-run-token')).status,403);
  assert.equal((await call('mcp_receipt',{...params,url:'javascript:alert(1)'})).status,400);
 }finally {if(before===undefined)delete process.env.AGENT_MCP_ALLOWED_TOOLS;else process.env.AGENT_MCP_ALLOWED_TOOLS=before;await f.pg.close();}
});

test("missing or empty service token is rejected before data access", async () => {
  const { pg, sql, runId, runToken } = await setup();
  let queries = 0;
  const counting = { async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
    if (text.includes("from items")) queries += 1;
    return sql.query<T>(text, params);
  } };
  const denied = await handleAgentData({
    sql: counting, serviceToken: token, providedServiceToken: "", runToken, runId,
    action: "search_items", params: { query: "电池" },
  });
  assert.equal(denied.status, 401);
  assert.equal(queries, 0);
  await pg.close();
});

test("wrong run token and expired run are denied", async () => {
  const { pg, sql, runId, runToken } = await setup();
  const wrong = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken: "nope", runId,
    action: "search_items", params: { query: "电池" },
  });
  assert.equal(wrong.status, 403);
  await sql.query("update ai_runs set expires_at = now() - interval '1 minute' where id = $1", [runId]);
  const expired = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken, runId,
    action: "search_items", params: { query: "电池" },
  });
  assert.equal(expired.status, 403);
  await pg.close();
});

test("ILIKE wildcards in the query do not expand the match", async () => {
  const { pg, sql, runId, runToken } = await setup();
  const result = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken, runId,
    action: "search_items", params: { query: "%" },
  });
  assert.equal(result.status, 400);
  const literal = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken, runId,
    action: "search_items", params: { query: "100%" },
  });
  assert.equal(literal.status, 200);
  await pg.close();
});

test("split keywords still find synonym and late-body facts", async () => {
  const { pg, sql, runId, runToken } = await setup();
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-2','s','rss','e2','产业纪要','前文很长很长很长很长很长很长很长很长很长很长很长很长很长很长 固态电池量产缺电解液')");
  const result = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken, runId,
    action: "search_items", params: { query: "固态电池量产卡点" },
  });
  assert.equal(result.status, 200);
  const ids = ((result.body.items as { item_id: string }[]) ?? []).map((row) => row.item_id);
  assert.ok(ids.includes("item-2"));
  await pg.close();
});

test("get_item cannot escape a saved run time range", async () => {
  const { pg, sql } = await setup();
  const runId = randomUUID();
  const runToken = randomBytes(32).toString("hex");
  const begun = await beginRun(sql, {
    id: runId, requestId: randomUUID(), mode: "research", provider: "eino",
    inputHash: "h", materialHash: "m", policyVersion: "loom-agent-v1",
    requestJson: { range: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" } },
    claimToken: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    dataTokenHash: hashRunToken(runToken),
  });
  assert.equal(begun.kind, "won");
  const result = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken, runId,
    action: "get_item", params: { item_id: "item-1" },
  });
  assert.equal(result.status, 403);
  await pg.close();
});

test("unknown action is rejected", async () => {
  const { pg, sql, runId, runToken } = await setup();
  const result = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken, runId,
    action: "select * from items", params: {},
  });
  assert.equal(result.status, 400);
  await pg.close();
});
