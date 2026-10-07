import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { beginRun, receiptsForRun, validateEvidenceSnapshot } from "./agent-runs.ts";
import { handleAgentData, hashRunToken } from "./agent-data.ts";
import { materialFingerprint } from "./agent-context.ts";

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

test('A12 get_analysis marks changed material stale and current fingerprint fresh', async () => {
  const f = await setup();
  try {
    const fingerprint = async () => {
      const [row] = await f.sql.query<any>('select i.*,s.name as source_name from items i join sources s on s.id=i.source_id where i.id=$1', ['item-1']);
      return materialFingerprint(row);
    };
    await f.sql.query('update ai_runs set material_hash=$1 where id=$2', [await fingerprint(), f.runId]);
    await f.sql.query("insert into analyses(id,item_id,summary,run_id) values('freshness','item-1','旧分析',$1)", [f.runId]);
    const read = () => handleAgentData({ sql:f.sql, serviceToken:token, providedServiceToken:token, runToken:f.runToken, runId:f.runId, action:'get_analysis', params:{item_id:'item-1'} });
    const first = await read();
    assert.equal(first.status, 200); assert.equal(first.body.stale, false);
    await f.sql.query("update items set body='材料已经变更为96%' where id='item-1'");
    const changed = await read();
    assert.equal(changed.status, 200); assert.equal(changed.body.stale, true);
    assert.equal(changed.body.summary, '旧分析');
    // Model generation is covered separately; here isolate the freshness contract.
    await f.sql.query('update ai_runs set material_hash=$1 where id=$2', [await fingerprint(), f.runId]);
    const current = await read();
    assert.equal(current.status, 200); assert.equal(current.body.stale, false);
  } finally { await f.pg.close(); }
});

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

test("corpus tool receipts preserve trusted metadata and publication detects version-only changes", async () => {
  const f = await setup();
  try {
    const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
    await f.sql.query("update items set body=$1,published_at='2026-10-01T01:00:00.123Z' where id='item-1'", ["😀\r\n电池" + "正文".repeat(2400)]);
    await f.sql.query("update ai_runs set request_json=$1::jsonb where id=$2", [JSON.stringify({ range }), f.runId]);
    const call = (action: string, params: Record<string, unknown>) => handleAgentData({ sql: f.sql, serviceToken: token, providedServiceToken: token, runToken: f.runToken, runId: f.runId, action, params });
    assert.equal((await call("search_items", { query: "电池" })).status, 200);
    const read = await call("get_item", { item_id: "item-1", start: 2 });
    assert.equal(read.status, 200);
    const receipts = await receiptsForRun(f.sql, f.runId);
    assert.equal(receipts.size, 2);
    for (const receipt of receipts.values()) {
      assert.match(receipt.material_fingerprint!, /^[a-f0-9]{64}$/);
      assert.equal(receipt.material_version, 1);
      assert.deepEqual(receipt.authorized_range, range);
      assert.equal(receipt.published_at, "2026-10-01T01:00:00.123Z");
      assert.equal(receipt.coverage, "partial");
      assert.equal(receipt.end! - receipt.start!, Array.from(receipt.text).length);
    }
    assert.deepEqual(await f.sql.transaction(tx => validateEvidenceSnapshot(tx, [...receipts.values()])), { ok: true });
    await f.sql.query("update items set material_version=material_version+1 where id='item-1'");
    assert.deepEqual(await f.sql.transaction(tx => validateEvidenceSnapshot(tx, [...receipts.values()])), { ok: false, error: "input_changed" });
  } finally { await f.pg.close(); }
});

test("snapshot validation rejects legacy, forged spans and escaped authorized range without inventing metadata", async () => {
  const f = await setup();
  try {
    const read = await handleAgentData({ sql: f.sql, serviceToken: token, providedServiceToken: token, runToken: f.runToken, runId: f.runId, action: "get_item", params: { item_id: "item-1" } });
    assert.equal(read.status, 200);
    const receipt = (await receiptsForRun(f.sql, f.runId)).get(String(read.body.evidence_id))!;
    const validate = (evidence: typeof receipt[]) => f.sql.transaction(tx => validateEvidenceSnapshot(tx, evidence));
    assert.deepEqual(await validate([receipt]), { ok: true });
    assert.deepEqual(await validate([{ ...receipt, text: "伪造" }]), { ok: false, error: "input_changed" });
    assert.deepEqual(await validate([{ ...receipt, coverage: "partial" }]), { ok: false, error: "input_changed" });
    assert.deepEqual(await validate([{ ...receipt, authorized_range: { from: "2000-01-01T00:00:00.000Z", to: "2000-01-02T00:00:00.000Z" } }]), { ok: false, error: "out_of_range" });
    await f.sql.query("update sources set name='已更新信源' where id='s'");
    assert.deepEqual(await validate([receipt]), { ok: false, error: "input_changed" });
    const legacy = { type: "evidence", evidence_id: "old", item_id: "item-1", text: "正文", origin: "internal" };
    await f.sql.query("update ai_runs set events_json=$1::jsonb where id=$2", [JSON.stringify([legacy]), f.runId]);
    const old = (await receiptsForRun(f.sql, f.runId)).get("old")!;
    assert.equal("material_version" in old, false);
    assert.equal("material_fingerprint" in old, false);
    assert.equal("authorized_range" in old, false);
    assert.deepEqual(await validate([old]), { ok: false, error: "incomplete_evidence_metadata" });
    assert.equal((await handleAgentData({ sql: f.sql, serviceToken: token, providedServiceToken: token, runToken: f.runToken, runId: f.runId, action: "get_item", params: { item_id: "item-1", start: 0.5 } })).status, 400);
  } finally { await f.pg.close(); }
});
