import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "vite";

test("twenty minute production ticks retain paid analysis cadence, reservations and manual analysis", async () => {
  const env = {
    AUTO_ANALYZE: "true",
    AI_ENGINE: "eino",
    EXTRACT_AUTO: "true",
    AGENT_MODEL_NAME: "synthetic-priced",
    AGENT_PRICE_INPUT_RMB_PER_MILLION: "2",
    AGENT_PRICE_OUTPUT_RMB_PER_MILLION: "4",
    AUTO_ANALYZE_DAILY_LIMIT: "100",
    AUTO_ANALYZE_DAILY_BUDGET_RMB: "100",
    AUTO_ANALYZE_PRICE_VERSION: "synthetic-t07",
    AGENT_SERVICE_URL: "http://synthetic-agent",
    AGENT_SERVICE_TOKEN: "synthetic-token",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@": path.resolve("src") } },
    server: { middlewareMode: true, watch: null },
  });
  try {
    const { getSql } = await vite.ssrLoadModule("/src/lib/db.ts");
    const sql = await getSql();
    const { autoAnalyzeConfigFromEnv, enqueueReadyAnalyses } = await vite.ssrLoadModule(
      "/src/lib/server/agent-queue.ts",
    );
    const { recordModelCall } = await vite.ssrLoadModule("/src/lib/server/agent-budget.ts");
    const { hashRunToken } = await vite.ssrLoadModule("/src/lib/server/agent-data.ts");
    const { runProductionTick } = await vite.ssrLoadModule("/src/lib/server/nodes.ts");
    const { runStageOnce } = await vite.ssrLoadModule("/src/lib/server/stage-windows.ts");
    const { runCronStages } = await vite.ssrLoadModule("/src/lib/server/cron.ts");
    const { analyzeItemWith } = await vite.ssrLoadModule("/src/lib/server/analyze.ts");
    let dispatches = 0,
      reconciliations = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "http://synthetic-agent/v1/execute");
      dispatches++;
      const req = JSON.parse(String(init?.body));
      const token = hashRunToken(req.data_access_token);
      const receipt = {
        call_id: randomUUID(),
        model: "synthetic-priced",
        policy_version: req.policy.version,
      };
      assert.equal(
        await recordModelCall(sql, req.run_id, token, { ...receipt, phase: "started" }),
        true,
      );
      assert.equal(
        await recordModelCall(sql, req.run_id, token, {
          ...receipt,
          phase: "completed",
          input_tokens: 100,
          output_tokens: 20,
        }),
        true,
      );
      return Response.json({
        schema_version: 1,
        run_id: req.run_id,
        ok: true,
        result: {
          analysis: {
            summary: "Synthetic evidence summary",
            topics: [],
            entities: [],
            insights: "Synthetic insight",
            tags: [],
          },
          citations: [],
          insufficient_evidence: false,
          coverage: "full",
          warnings: [],
        },
        runtime: {
          model: "synthetic-priced",
          prompt_version: "test",
          skill_versions: {},
          input_tokens: 100,
          output_tokens: 20,
          model_calls: 1,
          tool_calls: 0,
          events: [],
        },
        evidence: [],
      });
    };
    await sql.query(
      "insert into sources(id,platform,name,handle,enabled) values('s','rss','synthetic','synthetic',false)",
    );
    for (let n = 0; n < 20; n++)
      await sql.query(
        "insert into items(id,source_id,platform,external_id,title,body,pipeline_status) values($1,'s','rss',$1,'Synthetic','Synthetic body evidence','extracted')",
        [`auto-${n}`],
      );
    const cfg = autoAnalyzeConfigFromEnv();
    assert.equal(cfg.autoAnalyze, true);
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    assert.equal((await enqueueReadyAnalyses(sql, cfg, day)).enqueued, 20);
    const base = Date.parse("2026-10-03T15:30:00Z");
    for (let minute = 0; minute < 20; minute++) {
      const now = base + minute * 60_000;
      await runCronStages({
        collection: async () => ({}),
        production: () => runProductionTick({ now: () => now }),
        reconciliation: () =>
          runStageOnce(
            sql,
            "reconcile",
            async () => {
              reconciliations++;
              return { ok: true };
            },
            now,
          ),
      });
    }
    assert.equal(dispatches, 1, "minute wake-ups must not multiply automatic paid dispatches");
    assert.equal(reconciliations, 1);
    assert.deepEqual(
      await sql.query(
        "select stage,count(*)::int as n from stage_windows group by stage order by stage",
      ),
      [
        { stage: "analyze", n: 1 },
        { stage: "extract", n: 1 },
        { stage: "ingest", n: 1 },
        { stage: "reconcile", n: 1 },
      ],
    );
    assert.equal((await sql.query("select id from ai_jobs where status='queued'")).length, 19);
    const [budget] = await sql.query(
      "select reserved_count,settled_count,settled_rmb from ai_budget_days",
    );
    assert.equal(budget.reserved_count, 19);
    assert.equal(budget.settled_count, 1);
    assert.equal(Number(budget.settled_rmb), 0.00028);
    await sql.query(
      "insert into items(id,source_id,platform,external_id,title,body,pipeline_status) values('manual','s','rss','manual','Synthetic','Explicit manual evidence','extracted')",
    );
    assert.equal(
      (await analyzeItemWith({ sql, itemId: "manual", requestId: "explicit-manual" })).ok,
      true,
    );
    assert.equal(dispatches, 2);
    await runProductionTick({ now: () => base + 19 * 60_000 });
    assert.equal(dispatches, 2);
    await runProductionTick({ now: () => base + 30 * 60_000 });
    assert.equal(dispatches, 3);
  } finally {
    await vite.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const pg = await (globalThis as any).__pgliteInstance__;
    if (pg) await pg.close();
    delete (globalThis as any).__pgliteInstance__;
  }
});
