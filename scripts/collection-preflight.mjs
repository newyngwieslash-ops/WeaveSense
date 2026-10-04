#!/usr/bin/env node
// Configuration presence is not authorization, worker connectivity or collection success.
import { statSync } from "node:fs";
import { parseEgressCidrs, pinnedTransport, publicFetch, readCapped } from "../src/lib/server/outbound-policy.ts";
import { isMainModule } from "./with-app-env.mjs";

const present = (value) => Boolean(value?.trim());
function endpoint(value, protocols = ["http:", "https:"]) {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** @param {Record<string, string|undefined>} env @returns {{code:string,ready:boolean}[]} */
export function summarizePreflight(env) {
  const all = (...names) => names.every((name) => present(env[name]));
  let database = false;
  try { database = ["postgres:", "postgresql:"].includes(new URL(env.DATABASE_URL).protocol); } catch { /* missing/invalid */ }
  const hosts = (env.WECHAT_PRIMARY_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim());
  const positive = (name) => present(env[name]) && Number.isFinite(Number(env[name])) && Number(env[name]) > 0;
  const egressEntries = (env.LOOM_EGRESS_CIDRS ?? "").split(",").filter((entry) => entry.trim());
  return [
    { code: "database_configuration", ready: database },
    { code: "scheduler_credentials", ready: all("CRON_SECRET") },
    { code: "telegram_credentials", ready: all("TELEGRAM_API_ID", "TELEGRAM_API_HASH") },
    { code: "telegram_session", ready: all("TELEGRAM_SESSION") },
    { code: "telegram_worker_endpoint", ready: endpoint(env.TELEGRAM_WORKER_URL) },
    { code: "wechat_gateway_configuration", ready: endpoint(env.WECHAT_GATEWAY_URL) && all("WECHAT_GATEWAY_TOKEN") },
    { code: "wechat_primary_allowlist", ready: hosts.every((host) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) },
    { code: "wechat_paid_credentials", ready: all("DAJIALA_KEY") },
    { code: "wechat_paid_cost_bounds", ready: positive("DAJIALA_LIST_COST_RMB") && positive("DAJIALA_DETAIL_COST_RMB") },
    { code: "minio_configuration", ready: endpoint(env.MINIO_ENDPOINT) && Boolean((env.MINIO_ACCESS_KEY || env.MINIO_ROOT_USER)?.trim()) && Boolean((env.MINIO_SECRET_KEY || env.MINIO_ROOT_PASSWORD)?.trim()) },
    { code: "xai_credentials", ready: all("XAI_API_KEY") },
    { code: "collection_egress_policy", ready: !present(env.LOOM_EGRESS_CIDRS) || parseEgressCidrs(env.LOOM_EGRESS_CIDRS).length === egressEntries.length },
  ];
}

/** Operator-configured internal endpoints only; never fetch feeds or paid APIs. */
export async function probeWorkers(env, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const result = [];
  for (const [service, variable, path] of [["telegram_worker", "TELEGRAM_WORKER_URL", "/health"], ["wechat_gateway", "WECHAT_GATEWAY_URL", "/v1/health"]]) {
    if (!endpoint(env[variable]) || (service === "wechat_gateway" && !present(env.WECHAT_GATEWAY_TOKEN))) {
      result.push({ code: `${service}_configuration_missing`, ready: false });
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(path, env[variable]), { redirect: "error", signal: controller.signal,
        headers: service === "wechat_gateway" ? { Authorization: `Bearer ${env.WECHAT_GATEWAY_TOKEN}` } : {} });
      if (!response.ok) throw new Error("worker_http_error");
      const data = JSON.parse(new TextDecoder().decode(await readCapped(response.body, 16 * 1024)));
      if (service === "telegram_worker" && (typeof data.ok !== "boolean" || typeof data.authorized !== "boolean")) throw new Error("worker_invalid_health");
      if (service === "wechat_gateway" && (!Array.isArray(data.sources) || !data.limits)) throw new Error("worker_invalid_health");
      result.push({ code: `${service}_connectivity`, ready: true });
      if (service === "telegram_worker") result.push({ code: "telegram_session_authorized", ready: data.ok && data.authorized });
    } catch {
      result.push({ code: `${service}_connectivity`, ready: false });
      if (service === "telegram_worker") result.push({ code: "telegram_session_authorization_unchecked", ready: false });
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return result;
}

export async function probeEgress({ publicFetchImpl = publicFetch, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    await Promise.race([
      // Reuse DNS pinning, SSRF rules and body caps; one fixed public request, no redirects.
      publicFetchImpl("https://example.com/", { timeoutMs, maxBytes: 16 * 1024, maxRedirects: 0,
        transport: pinnedTransport({ signals: { abortSignal: controller.signal } }) }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs); }),
    ]);
    return { code: "collection_egress_connectivity", ready: true };
  } catch { return { code: "collection_egress_connectivity", ready: false }; }
  finally { clearTimeout(timer); controller.abort(); }
}

async function main(argv) {
  if (argv.includes("--help")) {
    console.log("usage: node --experimental-strip-types scripts/collection-preflight.mjs [--probe-workers] [--probe-egress]");
    return;
  }
  if (argv.some((arg) => !["--probe-workers", "--probe-egress"].includes(arg))) throw new Error("invalid_arguments");
  const result = summarizePreflight(process.env);
  // Metadata only: a path string is not evidence that a session file exists.
  if (!result.find((row) => row.code === "telegram_session").ready && process.env.TELEGRAM_SESSION_PATH) {
    try { result.find((row) => row.code === "telegram_session").ready = statSync(process.env.TELEGRAM_SESSION_PATH).isFile(); } catch { /* absent */ }
  }
  const probes = argv.includes("--probe-workers") ? await probeWorkers(process.env) : [];
  if (argv.includes("--probe-egress")) {
    probes.push(await probeEgress());
  }
  console.log(JSON.stringify([...result, ...probes], null, 2));
  // Missing optional capabilities affect their own rows, not database/core readiness.
  if (!result[0].ready || probes.some((row) => !row.ready)) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2)).catch(() => {
  console.error(JSON.stringify([{ code: "preflight_failed", ready: false }]));
  process.exitCode = 1;
});
