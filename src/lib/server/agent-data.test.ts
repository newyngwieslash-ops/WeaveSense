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
  for (const migration of ["0002_schema.sql", "0011_ai_runs.sql"]) {
    await pg.exec(readFileSync(new URL(`../../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  await pg.query("insert into sources (id, platform, name) values ('s','rss','信源')");
  await pg.query("insert into items (id,source_id,platform,external_id,title,body) values ('item-1','s','rss','e1','固态电池','正文内容足够长 100%_ok')");
  const sql = { async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
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

test("missing or empty service token is rejected before data access", async () => {
  const { pg, sql, runId, runToken } = await setup();
  let queries = 0;
  const counting = { query: async (text: string, params?: unknown[]) => {
    if (text.includes("from items")) queries += 1;
    return sql.query(text, params);
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

test("unknown action is rejected", async () => {
  const { pg, sql, runId, runToken } = await setup();
  const result = await handleAgentData({
    sql, serviceToken: token, providedServiceToken: token, runToken, runId,
    action: "select * from items", params: {},
  });
  assert.equal(result.status, 400);
  await pg.close();
});
