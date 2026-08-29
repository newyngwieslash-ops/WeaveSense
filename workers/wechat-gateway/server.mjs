import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { toAtom } from "./atom.mjs";
import { fetchPrimary } from "./primary.mjs";
import { openStore } from "./store.mjs";

export function authorize(headers, token) {
  return Boolean(token) && headers.get("authorization") === `Bearer ${token}`;
}

export function validateSourceInput(input) {
  const required = ["id", "name", "sample_url", "primary_feed_url", "account_id"];
  for (const field of required) {
    if (typeof input?.[field] !== "string" || !input[field].trim()) throw new Error(`${field} is required`);
  }
  let sample;
  let feed;
  try { sample = new URL(input.sample_url); } catch { throw new Error("sample_url must be a WeChat URL"); }
  try { feed = new URL(input.primary_feed_url); } catch { throw new Error("primary_feed_url must be HTTP(S)"); }
  if (sample.hostname !== "mp.weixin.qq.com") throw new Error("sample_url must be a WeChat URL");
  if (!["http:", "https:"].includes(feed.protocol)) throw new Error("primary_feed_url must be HTTP(S)");
  const priority = input.priority ?? "normal";
  if (!['normal', 'high'].includes(priority)) throw new Error("priority must be normal or high");
  return { id: input.id.trim(), name: input.name.trim(), account_id: input.account_id.trim(), priority,
    sample_url: sample.toString(), primary_feed_url: feed.toString() };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createGatewayServer({ store, token }) {
  return createServer(async (req, res) => {
    try {
      if (!authorize(new Headers(req.headers), token)) return json(res, 401, { error: "unauthorized" });
      const url = new URL(req.url, "http://gateway.local");
      let match = url.pathname.match(/^\/v1\/sources\/([^/]+)$/);
      if (req.method === "PUT" && match) {
        let input;
        try {
          input = validateSourceInput({ ...(await readJson(req)), id: decodeURIComponent(match[1]) });
        } catch (error) {
          return json(res, 422, { error: error instanceof Error ? error.message : "invalid source input" });
        }
        store.upsertSource(input);
        return json(res, 200, { ok: true });
      }
      match = url.pathname.match(/^\/v1\/sources\/([^/]+)\/health$/);
      if (req.method === "GET" && match) {
        const source = store.getSource(decodeURIComponent(match[1]));
        return source ? json(res, 200, source) : json(res, 404, { error: "source not found" });
      }
      match = url.pathname.match(/^\/v1\/feeds\/([^/]+)\.atom$/);
      if (req.method === "GET" && match) {
        const source = store.getSource(decodeURIComponent(match[1]));
        if (!source) return json(res, 404, { error: "source not found" });
        try {
          const items = await fetchPrimary(source);
          store.recordPrimarySuccess(source.source_id);
          res.writeHead(200, { "content-type": "application/atom+xml; charset=utf-8" });
          return res.end(toAtom(source.source_id, source.name, items));
        } catch (error) {
          store.recordPrimaryFailure(source.source_id);
          return json(res, 502, { error: error instanceof Error ? error.message : "primary feed failed" });
        }
      }
      return json(res, 404, { error: "not found" });
    } catch {
      return json(res, 500, { error: "internal error" });
    }
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = requiredEnv("WECHAT_GATEWAY_TOKEN");
  const dbPath = requiredEnv("GATEWAY_DB_PATH");
  const port = Number(requiredEnv("PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid port");
  createGatewayServer({ store: openStore(dbPath), token }).listen(port, "0.0.0.0");
}
