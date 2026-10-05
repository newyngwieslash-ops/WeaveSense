import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { summarizePreflight, probeWorkers, probeEgress } from "./collection-preflight.mjs";
import { offlineEnv } from "./readiness-offline.mjs";

const ready = (rows, code) => rows.find((row) => row.code === code)?.ready;

test("Telegram credentials are presence only, never authorization or leaked values", () => {
  const result = summarizePreflight({ TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "SECRET_TEST" });
  assert.equal(ready(result, "telegram_credentials"), true);
  assert.equal(ready(result, "telegram_session"), false);
  assert.equal(ready(result, "telegram_worker_endpoint"), false);
  assert.equal(JSON.stringify(result).includes("SECRET_TEST"), false);
});

test("missing optional capabilities do not disable the configured core database", () => {
  const result = summarizePreflight({ DATABASE_URL: "postgres://fake:SECRET_TEST@postgres/loom", TELEGRAM_WORKER_URL: "http://telethon:8787" });
  assert.equal(ready(result, "database_configuration"), true);
  for (const code of ["telegram_credentials", "telegram_session", "wechat_gateway_configuration", "wechat_primary_allowlist", "wechat_paid_credentials", "minio_configuration", "xai_credentials", "scheduler_credentials"]) {
    assert.equal(ready(result, code), false, code);
  }
  assert.equal(ready(result, "telegram_worker_endpoint"), true); // Endpoint presence cannot prove connectivity.
  assert.equal(JSON.stringify(result).includes("SECRET_TEST"), false);
});

test("gateway allowlist and media dependencies are independently validated", () => {
  const result = summarizePreflight({ DATABASE_URL: "garbage", WECHAT_GATEWAY_URL: "http://wechat-gateway:8790", WECHAT_GATEWAY_TOKEN: "SECRET_TEST", WECHAT_PRIMARY_ALLOWED_HOSTS: "https://not-a-host", MINIO_ENDPOINT: "http://minio:9000", MINIO_ACCESS_KEY: "fake", MINIO_SECRET_KEY: "SECRET_TEST" });
  assert.equal(ready(result, "database_configuration"), false);
  assert.equal(ready(result, "wechat_gateway_configuration"), true);
  assert.equal(ready(result, "wechat_primary_allowlist"), false);
  assert.equal(ready(result, "minio_configuration"), true);
  assert.equal(ready(summarizePreflight({ WECHAT_PRIMARY_ALLOWED_HOSTS: "host.docker.internal,rss.example.com" }), "wechat_primary_allowlist"), true);
});

test("MinIO accepts the deployed Telethon host:port shape without inferring connectivity", () => {
  const credentials = { MINIO_ACCESS_KEY: "SYNTHETIC_ONLY", MINIO_SECRET_KEY: "SYNTHETIC_ONLY" };
  const deployedEndpoint = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").match(/^\s+MINIO_ENDPOINT: (\S+)/m)?.[1];
  assert.ok(deployedEndpoint === "minio:9000", "regression must cover the deployed Telethon endpoint shape");
  for (const endpoint of [deployedEndpoint, "http://minio:9000", "https://minio:9000"]) {
    const rows = summarizePreflight({ ...credentials, MINIO_ENDPOINT: endpoint });
    assert.equal(ready(rows, "minio_configuration"), true);
    assert.ok(rows.every((row) => !row.code.includes("connectivity")));
    assert.ok(!JSON.stringify(rows).includes("SYNTHETIC_ONLY"));
  }
  for (const endpoint of ["", "minio:not-a-port", "minio:65536", "minio:0", "minio:9000/path", "secret@minio:9000", "minio:9000?key=hidden", "ftp://minio:9000", "http://secret@minio:9000"]) {
    assert.equal(ready(summarizePreflight({ ...credentials, MINIO_ENDPOINT: endpoint }), "minio_configuration"), false);
  }
  assert.equal(ready(summarizePreflight({ MINIO_ENDPOINT: "minio:9000" }), "minio_configuration"), false);
});

test("worker probe distinguishes missing endpoint, connectivity failure and unauthorized session", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return new Response(JSON.stringify({ ok: true, authorized: false, me: "SECRET_TEST" }));
  };
  assert.equal(ready(await probeWorkers({}, { fetchImpl }), "telegram_worker_configuration_missing"), false);
  assert.equal(calls, 0);
  const unauthorized = await probeWorkers({ TELEGRAM_WORKER_URL: "http://telethon:8787" }, { fetchImpl });
  assert.equal(ready(unauthorized, "telegram_worker_connectivity"), true);
  assert.equal(ready(unauthorized, "telegram_session_authorized"), false);
  assert.equal(JSON.stringify(unauthorized).includes("SECRET_TEST"), false);
  const failed = await probeWorkers({ TELEGRAM_WORKER_URL: "http://telethon:8787" }, { fetchImpl: async () => { throw new Error("SECRET_TEST"); } });
  assert.equal(ready(failed, "telegram_worker_connectivity"), false);
  assert.equal(ready(failed, "telegram_session_authorization_unchecked"), false);
  assert.equal(JSON.stringify(failed).includes("SECRET_TEST"), false);
});

test("egress configuration is independent and explicit probe is bounded without exposing errors", async () => {
  assert.equal(ready(summarizePreflight({}), "collection_egress_policy"), true); // Normal public DNS needs no override.
  assert.equal(ready(summarizePreflight({ LOOM_EGRESS_CIDRS: "198.18.0.0/15" }), "collection_egress_policy"), true);
  assert.equal(ready(summarizePreflight({ LOOM_EGRESS_CIDRS: "SECRET_TEST" }), "collection_egress_policy"), false);
  const result = await probeEgress({ publicFetchImpl: async (url, options) => {
    assert.equal(url, "https://example.com/");
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.maxBytes, 16 * 1024);
    throw new Error("SECRET_TEST");
  } });
  assert.equal(result.ready, false);
  assert.equal(JSON.stringify(result).includes("SECRET_TEST"), false);
  assert.equal((await probeEgress({ timeoutMs: 20, publicFetchImpl: () => new Promise(() => {}) })).ready, false);
});

test("worker fetch timeout and gateway authorization remain bounded health requests", async () => {
  const rows = await probeWorkers({ TELEGRAM_WORKER_URL: "http://telethon:8787", WECHAT_GATEWAY_URL: "http://wechat-gateway:8790", WECHAT_GATEWAY_TOKEN: "SECRET_TEST" }, { timeoutMs: 20, fetchImpl: async (url, options) => {
    if (String(url).includes("wechat")) {
      assert.equal(options.headers.Authorization, "Bearer SECRET_TEST");
      return new Response(JSON.stringify({ sources: [], limits: { paid_configured: false } }));
    }
    await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("SECRET_TEST")), { once: true }));
  } });
  assert.equal(ready(rows, "telegram_worker_connectivity"), false);
  assert.equal(ready(rows, "wechat_gateway_connectivity"), true);
});

test("probe only calls health endpoints, rejects redirects, oversized bodies and untrusted endpoint syntax", async () => {
  const env = { TELEGRAM_WORKER_URL: "http://telethon:8787", WECHAT_GATEWAY_URL: "http://wechat-gateway:8790", WECHAT_GATEWAY_TOKEN: "SECRET_TEST" };
  const urls = [];
  const result = await probeWorkers(env, { fetchImpl: async (url) => {
    urls.push(String(url));
    return new Response("x".repeat(20_000));
  } });
  assert.deepEqual(urls, ["http://telethon:8787/health", "http://wechat-gateway:8790/v1/health"]);
  assert.equal(ready(result, "telegram_worker_connectivity"), false);
  assert.equal(ready(result, "wechat_gateway_connectivity"), false);
  let calls = 0;
  await probeWorkers({ TELEGRAM_WORKER_URL: "http://secret@worker:8787?token=secret" }, { fetchImpl: () => { calls++; } });
  assert.equal(calls, 0);
});

test("default CLI is offline and session path existence does not prove authorization", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-preflight-"));
  try {
    const session = join(dir, "synthetic.session");
    writeFileSync(session, "SYNTHETIC_ONLY");
    const child = spawnSync(process.execPath, ["scripts/collection-preflight.mjs"], {
      encoding: "utf8", windowsHide: true,
      env: offlineEnv(process.env, { DATABASE_URL: "postgres://fake:SECRET_TEST@localhost/loom", TELEGRAM_SESSION_PATH: session }),
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(ready(JSON.parse(child.stdout), "telegram_session"), true);
    assert.equal(child.stdout.includes("SECRET_TEST"), false);
    assert.equal(child.stdout.includes("authorized"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("synthetic Compose env_file values survive absent host credentials", (t) => {
  const version = spawnSync("docker", ["compose", "version"], { encoding: "utf8", env: offlineEnv(process.env), windowsHide: true, timeout: 10_000 });
  if (version.status !== 0) return t.skip("Docker Compose CLI is unavailable; no real environment files are used");
  const dir = mkdtempSync(join(tmpdir(), "loom-compose-config-"));
  try {
    const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const selected = ["telethon", "wechat-gateway", "app"];
    const secrets = { TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "SYNTHETIC_TELEGRAM_ONLY", TELEGRAM_SESSION: "SYNTHETIC_SESSION_ONLY", DAJIALA_KEY: "SYNTHETIC_PAID_ONLY", DAJIALA_VERIFYCODE: "SYNTHETIC_VERIFY_ONLY", XAI_API_KEY: "SYNTHETIC_XAI_ONLY" };
    const services = {};
    for (const service of selected) {
      const body = compose.split(`\n  ${service}:`)[1]?.split(/\n  [a-z-]+:/)[0];
      const environmentText = body?.split("    environment:\n")[1]?.split(/\n    [a-z_]+:/)[0];
      assert.ok(environmentText, `${service} environment block exists`);
      const environment = Object.fromEntries(environmentText.split(/\r?\n/).flatMap((line) => {
        const match = /^      ([A-Z_]+): (.*)$/.exec(line);
        return match ? [[match[1], match[2].replace(/^"(.*)"$/, "$1")]] : [];
      }));
      const envPath = join(dir, `${service}.env`);
      const keys = service === "telethon" ? ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION"] : service === "app" ? ["XAI_API_KEY"] : ["DAJIALA_KEY", "DAJIALA_VERIFYCODE"];
      writeFileSync(envPath, keys.map((key) => `${key}=${secrets[key]}`).join("\n"));
      services[service] = { image: "synthetic/no-pull:unused", env_file: [envPath], environment };
    }
    const file = join(dir, "compose.json");
    writeFileSync(file, JSON.stringify({ services }));
    const result = spawnSync("docker", ["compose", "--project-name", "loom-t02-fake", "-f", file, "config", "--format", "json"], { encoding: "utf8", env: offlineEnv(process.env, { XAI_API_KEY: undefined }), windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, "Synthetic Compose configuration must parse (no secret output is printed)");
    const config = JSON.parse(result.stdout);
    for (const [service, keys] of [["telethon", ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION"]], ["wechat-gateway", ["DAJIALA_KEY", "DAJIALA_VERIFYCODE"]], ["app", ["XAI_API_KEY"]]]) {
      for (const key of keys) assert.ok(config.services[service].environment[key] === secrets[key], `${service}:${key} must retain env_file value`);
    }
    // Positive control: the old empty interpolation MUST destroy env_file values.
    for (const service of selected) {
      const keys = service === "telethon" ? ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_SESSION"] : service === "app" ? ["XAI_API_KEY"] : ["DAJIALA_KEY", "DAJIALA_VERIFYCODE"];
      for (const key of keys) services[service].environment[key] = `\${${key}:-}`;
    }
    writeFileSync(file, JSON.stringify({ services }));
    const oldResult = spawnSync("docker", ["compose", "--project-name", "loom-t02-fake", "-f", file, "config", "--format", "json"], { encoding: "utf8", env: offlineEnv(process.env, { XAI_API_KEY: undefined }), windowsHide: true, timeout: 10_000 });
    assert.equal(oldResult.status, 0, "Synthetic broken Compose control must parse");
    const oldConfig = JSON.parse(oldResult.stdout);
    for (const [service, key] of [["telethon", "TELEGRAM_API_HASH"], ["wechat-gateway", "DAJIALA_KEY"], ["app", "XAI_API_KEY"]]) {
      assert.ok(oldConfig.services[service].environment[key] === "", `${service}:${key} detects the original empty override`);
    }
    assert.ok(existsSync(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("worker recovery states do not report an unauthorized session", async () => {
  for (const state of ["connecting", "unavailable", "unconfigured", "cooldown", "ready", "unauthorized"]) {
    const authorized = ["ready", "cooldown"].includes(state);
    const rows = await probeWorkers({ TELEGRAM_WORKER_URL: "http://telethon:8787" }, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: !["connecting", "unavailable"].includes(state), authorized, state, retry_after_seconds: 5 })),
    });
    assert.equal(ready(rows, "telegram_worker_connectivity"), true);
    assert.equal(ready(rows, `telegram_state_${state}`), authorized);
    if (["connecting", "unavailable", "unconfigured"].includes(state)) {
      assert.equal(rows.some(row => row.code === "telegram_session_authorized"), false);
      assert.equal(ready(rows, "telegram_session_authorization_unchecked"), false);
    } else assert.equal(ready(rows, "telegram_session_authorized"), authorized);
  }
});
