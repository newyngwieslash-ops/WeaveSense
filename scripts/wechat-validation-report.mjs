import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { evaluateWechatValidation, usageDaysForWindow } from "./wechat-validation-lib.mjs";

const HEADERS = ["canonical_id", "account_id", "account_name", "title", "published_at",
  "original_url", "provider_known"];
const ARGUMENTS = new Set(["reference", "collected-fixture", "database-url", "gateway-url",
  "gateway-token-env", "from", "to", "out"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_GATEWAY_BYTES = 1024 * 1024;
const MAX_DATABASE_ROWS = 100_000;

export const DATABASE_QUERIES = Object.freeze({
  items: `select external_id as canonical_id, coalesce(extra->>'account_id','') as account_id,
      author as account_name, title, published_at, collected_at, url as original_url,
      body, thumbnail_url as cover_url, extra->'providers_seen' as providers_seen
    from items where platform = 'wechat' and collected_at >= $1 and collected_at < $2
    order by collected_at limit 100001`,
  jobs: `select id, provider, attempts, paid_call from jobs
    where platform = 'wechat' and started_at >= $1 and started_at < $2
    order by started_at limit 100001`,
});

class CliError extends Error {}
const fail = (code) => { throw new CliError(code); };

function parseArguments(argv) {
  if (argv.length % 2) fail("wechat_validation_invalid_arguments");
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !ARGUMENTS.has(flag.slice(2)) || !value || value.startsWith("--") ||
      Object.hasOwn(args, flag.slice(2))) fail("wechat_validation_invalid_arguments");
    args[flag.slice(2)] = value;
  }
  const common = ["reference", "out"];
  const online = ["database-url", "gateway-url", "gateway-token-env", "from", "to"];
  if (args["collected-fixture"]) {
    if ([...common, "collected-fixture"].some((key) => !args[key]) || online.some((key) => args[key])) {
      fail("wechat_validation_invalid_arguments");
    }
    return { mode: "fixture", ...args };
  }
  if ([...common, ...online].some((key) => !args[key])) fail("wechat_validation_invalid_arguments");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(args["gateway-token-env"])) {
    fail("wechat_validation_invalid_arguments");
  }
  return { mode: "online", ...args };
}

function csvRecords(input) {
  const rows = [];
  let row = [], field = "", quoted = false, quoteClosed = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') { quoted = false; quoteClosed = true; }
      else field += char;
    } else if (char === '"' && field === "" && !quoteClosed) quoted = true;
    else if (char === ",") { row.push(field); field = ""; quoteClosed = false; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = ""; quoteClosed = false;
    } else {
      if (quoteClosed) fail("wechat_validation_reference_invalid");
      field += char;
    }
  }
  if (quoted) fail("wechat_validation_reference_invalid");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((record) => !(record.length === 1 && record[0] === ""));
}

async function readBounded(file, errorCode) {
  try {
    const value = await readFile(file);
    if (value.byteLength > MAX_FILE_BYTES) fail(errorCode);
    return value.toString("utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail(errorCode);
  }
}

async function readReference(file) {
  const rows = csvRecords((await readBounded(file, "wechat_validation_reference_unavailable")).replace(/^\uFEFF/, ""));
  if (!rows.length || rows[0].length !== HEADERS.length ||
    rows[0].some((header, index) => header !== HEADERS[index])) fail("wechat_validation_reference_invalid");
  return rows.slice(1).map((values) => {
    if (values.length !== HEADERS.length || !["true", "false"].includes(values[6])) {
      fail("wechat_validation_reference_invalid");
    }
    return Object.fromEntries(HEADERS.map((header, index) => [header,
      header === "provider_known" ? values[index] === "true" : values[index].trim()]));
  });
}

async function readFixture(file) {
  try {
    const parsed = JSON.parse(await readBounded(file, "wechat_validation_fixture_unavailable"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("wechat_validation_fixture_invalid");
    return parsed;
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("wechat_validation_fixture_invalid");
  }
}

export async function readValidationDatabase(pool, window) {
  const [items, jobs] = await Promise.all([
    pool.query(DATABASE_QUERIES.items, [window.from, window.to]),
    pool.query(DATABASE_QUERIES.jobs, [window.from, window.to]),
  ]);
  if (items.rows.length > MAX_DATABASE_ROWS || jobs.rows.length > MAX_DATABASE_ROWS) {
    fail("wechat_validation_database_unavailable");
  }
  const iso = (value) => value instanceof Date ? value.toISOString() : value;
  return { items: items.rows.map((row) => ({ ...row, published_at: iso(row.published_at),
    collected_at: iso(row.collected_at) })), jobs: jobs.rows };
}

async function readDatabase(databaseUrl, window) {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000, max: 1 });
  try {
    return await readValidationDatabase(pool, window);
  } catch {
    fail("wechat_validation_database_unavailable");
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function readValidationGateway(baseUrl, token, window, fetchImpl = fetch) {
  let url;
  try {
    url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/health`;
    const expectedDays = usageDaysForWindow(window);
    url.searchParams.set("from", expectedDays[0]);
    url.searchParams.set("to", new Date(Date.parse(`${expectedDays.at(-1)}T00:00:00.000Z`) +
      86_400_000).toISOString().slice(0, 10));
  } catch { fail("wechat_validation_gateway_unavailable"); }
  let response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch { fail("wechat_validation_gateway_unavailable"); }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* best-effort */ }
    fail("wechat_validation_gateway_unavailable");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_GATEWAY_BYTES) {
    try { await response.body?.cancel(); } catch { /* best-effort */ }
    fail("wechat_validation_gateway_unavailable");
  }
  let bytes = 0, body = "";
  try {
    if (!response.body) fail("wechat_validation_gateway_unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf8", { fatal: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_GATEWAY_BYTES) { await reader.cancel(); fail("wechat_validation_gateway_unavailable"); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const data = JSON.parse(body);
    const expectedDays = usageDaysForWindow(window);
    const asOf = typeof data?.as_of === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(data.as_of)
      ? Date.parse(data.as_of) : Number.NaN;
    const to = Date.parse(window.to);
    if (!data || typeof data !== "object" || !Array.isArray(data.sources) || data.sources.length > 1_000 ||
      !Number.isFinite(asOf) || asOf < to || asOf > to + 2 * 60 * 60 * 1000 ||
      !data.usage || typeof data.usage !== "object" || Array.isArray(data.usage) ||
      !Array.isArray(data.usage.days) || data.usage.days.length !== expectedDays.length ||
      data.usage.days.some((row, index) => !row || typeof row !== "object" || Array.isArray(row) ||
        row.day !== expectedDays[index] || !Number.isSafeInteger(row.calls) || row.calls < 0 ||
        !Number.isFinite(row.amount) || row.amount < 0) ||
      !data.limits || typeof data.limits !== "object" || Array.isArray(data.limits)) {
      fail("wechat_validation_gateway_unavailable");
    }
    try {
      evaluateWechatValidation({ window, asOf: data.as_of, health: data.sources,
        usage: data.usage, limits: data.limits });
    } catch {
      fail("wechat_validation_gateway_unavailable");
    }
    return { as_of: data.as_of, health: data.sources, usage: data.usage, limits: data.limits };
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("wechat_validation_gateway_unavailable");
  }
}

async function atomicReport(file, report) {
  const parent = path.dirname(path.resolve(file));
  const temp = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(parent, { recursive: true });
    await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temp, path.resolve(file));
  } catch {
    await rm(temp, { force: true }).catch(() => {});
    fail("wechat_validation_output_unavailable");
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArguments(argv);
    const reference = await readReference(args.reference);
    let input;
    if (args.mode === "fixture") {
      input = await readFixture(args["collected-fixture"]);
    } else {
      const token = process.env[args["gateway-token-env"]];
      if (!token) fail("wechat_validation_gateway_token_missing");
      const window = { from: args.from, to: args.to };
      evaluateWechatValidation({ window, asOf: window.to });
      const database = await readDatabase(args["database-url"], window);
      const gateway = await readValidationGateway(args["gateway-url"], token, window);
      input = { window, generated_at: new Date().toISOString(), ...database, ...gateway };
    }
    if (!reference.length || !Array.isArray(input.items) || !input.items.length ||
      !Array.isArray(input.health) || !input.health.length || !input.usage || !input.limits) {
      fail("wechat_validation_data_unavailable");
    }
    const report = evaluateWechatValidation({ reference, items: input.items, health: input.health,
      usage: input.usage, limits: input.limits, jobs: input.jobs ?? [], window: input.window,
      asOf: input.as_of,
      generatedAt: input.generated_at ?? input.window?.to, mode: args.mode });
    await atomicReport(args.out, report);
    return report.overall ? 0 : 1;
  } catch (error) {
    const code = error instanceof CliError ? error.message
      : error instanceof Error && error.message === "validation_invalid_input"
        ? "wechat_validation_invalid_input" : "wechat_validation_unavailable";
    process.stderr.write(`${code}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
