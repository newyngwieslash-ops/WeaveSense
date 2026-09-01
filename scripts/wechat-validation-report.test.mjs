import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DATABASE_QUERIES, readValidationDatabase,
  readValidationGateway } from "./wechat-validation-report.mjs";

const root = path.resolve(import.meta.dirname, "..");
const command = path.join(root, "scripts/wechat-validation-report.mjs");
const reference = path.join(root, "validation/fixtures/reference.csv");
const fixture = path.join(root, "validation/fixtures/collected.json");
const run = (args, env = {}) => spawnSync(process.execPath, [command, ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, ...env },
});

test("fixture CLI writes every passing metric and exits zero", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wechat-validation-pass-"));
  const out = path.join(dir, "report.json");
  const result = run(["--reference", reference, "--collected-fixture", fixture, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.version, "wechat-validation/v1");
  assert.equal(report.mode, "fixture");
  assert.equal(report.generated_at, "2026-08-29T00:00:00.000Z");
  assert.equal(report.overall, true);
  assert.deepEqual(Object.keys(report.metrics), ["required_fields", "discovery_within_2h",
    "provider_known_missing", "duplicate_rate", "body_coverage", "cover_coverage",
    "outage_alerts", "paid_calls", "paid_amount"]);
  assert.ok(Object.values(report.metrics).every((metric) => metric.pass));
});

test("metric failure exits one after atomically writing the complete report", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wechat-validation-fail-"));
  const failedFixture = path.join(dir, "collected.json");
  const data = JSON.parse(readFileSync(fixture, "utf8"));
  data.items = data.items.map((item) => ({ ...item, body: "" }));
  writeFileSync(failedFixture, JSON.stringify(data));
  const out = path.join(dir, "evidence/report.json");
  const result = run(["--reference", reference, "--collected-fixture", failedFixture, "--out", out]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.overall, false);
  assert.equal(report.metrics.body_coverage.pass, false);
  assert.equal(Object.keys(report.metrics).length, 9);
});

test("bad and secret-bearing arguments exit two without echoing secrets", () => {
  const fakeSecret = "fixture-super-secret";
  const result = run(["--reference", reference, "--gateway-token", fakeSecret,
    "--out", path.join(tmpdir(), "must-not-write.json")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^wechat_validation_invalid_arguments\s*$/);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(fakeSecret));

  const duplicate = run(["--reference", reference, "--collected-fixture", fixture,
    "--out", "first.json", "--out", "second.json"]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /^wechat_validation_invalid_arguments\s*$/);

  const missingToken = run(["--reference", reference,
    "--database-url", `postgres://user:${fakeSecret}@database.invalid/db`,
    "--gateway-url", "https://gateway.invalid", "--gateway-token-env", "MISSING_FIXTURE_TOKEN",
    "--from", "2026-08-28T00:00:00.000Z", "--to", "2026-08-29T00:00:00.000Z",
    "--out", path.join(tmpdir(), "must-not-write-online.json")], { MISSING_FIXTURE_TOKEN: "" });
  assert.equal(missingToken.status, 2);
  assert.match(missingToken.stderr, /^wechat_validation_gateway_token_missing\s*$/);
  assert.doesNotMatch(missingToken.stderr + missingToken.stdout, new RegExp(fakeSecret));
});

test("database reads use collection time half-open windows and reject silent truncation", async () => {
  const seen = [];
  const pool = { query: async (sql, parameters) => {
    seen.push({ sql, parameters });
    return sql === DATABASE_QUERIES.items ? { rows: [{ canonical_id: "wx:null-published",
      published_at: null, collected_at: new Date("2026-08-28T01:00:00.000Z") }] } : { rows: [] };
  } };
  const window = { from: "2026-08-28T00:00:00.000Z", to: "2026-08-29T00:00:00.000Z" };
  const result = await readValidationDatabase(pool, window);
  assert.equal(result.items[0].published_at, null);
  assert.equal(result.items[0].collected_at, "2026-08-28T01:00:00.000Z");
  assert.deepEqual(seen.map(({ parameters }) => parameters), [[window.from, window.to],
    [window.from, window.to]]);
  assert.match(DATABASE_QUERIES.items, /collected_at >= \$1 and collected_at < \$2/);
  assert.doesNotMatch(DATABASE_QUERIES.items, /published_at\s*[<>]=?/);
  assert.match(DATABASE_QUERIES.jobs, /started_at >= \$1 and started_at < \$2/);
  assert.match(DATABASE_QUERIES.items, /limit 100001/i);
  assert.match(DATABASE_QUERIES.jobs, /limit 100001/i);

  const overflow = Array.from({ length: 100_001 }, () => ({}));
  for (const query of [DATABASE_QUERIES.items, DATABASE_QUERIES.jobs]) {
    const tooMany = { query: async (sql) => ({ rows: sql === query ? overflow : [] }) };
    await assert.rejects(readValidationDatabase(tooMany, window),
      /wechat_validation_database_unavailable/);
  }
});

test("fixture snapshots require complete days and an as-of within two hours", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wechat-validation-snapshot-"));
  const data = JSON.parse(readFileSync(fixture, "utf8"));
  for (const mutate of [
    (value) => { value.usage.days.pop(); },
    (value) => { value.as_of = "2026-08-29T02:00:00.001Z"; },
  ]) {
    const input = structuredClone(data);
    mutate(input);
    const collected = path.join(dir, `${Math.random()}.json`);
    const out = path.join(dir, `${Math.random()}.report.json`);
    writeFileSync(collected, JSON.stringify(input));
    const result = run(["--reference", reference, "--collected-fixture", collected, "--out", out]);
    assert.equal(result.status, 2, result.stderr);
  }
});

test("live gateway requests and validates the exact Shanghai-day window", async () => {
  let requested;
  const window = { from: "2026-08-28T00:00:00.000Z", to: "2026-08-29T00:00:00.000Z" };
  const body = {
    as_of: window.to, sources: [],
    usage: { day: "2026-08-28", calls: 1, amount: 0.1, days: [
      { day: "2026-08-28", calls: 1, amount: 0.1 },
      { day: "2026-08-29", calls: 0, amount: 0 },
    ] },
    limits: { daily_calls: 250, daily_rmb: 20, paid_configured: true },
  };
  const gateway = await readValidationGateway("https://gateway.example/base", "secret", window,
    async (input, init) => {
      requested = { url: String(input), headers: new Headers(init.headers) };
      return Response.json(body);
    });
  assert.equal(requested.url,
    "https://gateway.example/base/v1/health?from=2026-08-28&to=2026-08-30");
  assert.equal(requested.headers.get("authorization"), "Bearer secret");
  assert.equal(gateway.as_of, window.to);

  await assert.rejects(readValidationGateway("https://gateway.example", "secret", window,
    async () => Response.json({ ...body, as_of: "2026-08-29T02:00:00.001Z" })),
  /wechat_validation_gateway_unavailable/);
  await assert.rejects(readValidationGateway("https://gateway.example", "secret", window,
    async () => Response.json({ ...body, usage: { ...body.usage, days: body.usage.days.slice(0, 1) } })),
  /wechat_validation_gateway_unavailable/);
});
