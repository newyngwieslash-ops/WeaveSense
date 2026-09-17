import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync, statSync, realpathSync } from "node:fs";
import { resolve, basename } from "node:path";

export type ModelConfig = { baseURL: string; model: string; apiKey: string };
const revisionKey = randomBytes(32);
const invalid = () => new Error("模型配置无效，请检查服务端配置文件");
export function parseModelConfig(value: unknown): ModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["baseURL", "model", "apiKey"].includes(k)) ||
      typeof v.baseURL !== "string" || typeof v.model !== "string" || typeof v.apiKey !== "string") throw invalid();
  let url: URL;
  try { url = new URL(v.baseURL); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      v.baseURL.length > 2048 || !v.model.trim() || v.model.length > 200 || /[\r\n]/.test(v.model + v.apiKey) || v.apiKey.length > 8192) throw invalid();
  return { baseURL: url.href.replace(/\/+$/, ""), model: v.model.trim(), apiKey: v.apiKey.trim() };
}

function readDocument(path: string) {
  try {
    for (const candidate of [resolve(path), realpathSync(path)]) {
      if (!basename(candidate).endsWith(".local.json") || candidate.replaceAll("\\", "/").split("/").some(part => part.toLowerCase() === "public")) throw invalid();
    }
    if (statSync(path).size > 16384) throw invalid();
    const raw = readFileSync(path, "utf8");
    return { config: parseModelConfig(JSON.parse(raw)), revision: createHmac("sha256", revisionKey).update(raw).digest("hex") };
  } catch { throw invalid(); }
}

export function readModelConfig(): ModelConfig {
  const path = process.env.LOOM_MODEL_CONFIG?.trim();
  if (path) return readDocument(path).config;
  return { baseURL: "https://api.x.ai/v1", model: "grok-4.5", apiKey: process.env.XAI_API_KEY?.trim() ?? "" };
}

export function modelSettings(path = process.env.LOOM_MODEL_CONFIG?.trim()) {
  const { config, revision } = path ? readDocument(path) : { config: readModelConfig(), revision: "" };
  return { baseURL: config.baseURL, model: config.model, keyConfigured: Boolean(config.apiKey), revision,
    editable: Boolean(path), engine: process.env.AI_ENGINE ?? "legacy" };
}

export function saveModelSettings(input: unknown, path = process.env.LOOM_MODEL_CONFIG?.trim()) {
  if (!path) throw new Error("请先指定 LOOM_MODEL_CONFIG 配置文件");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "baseURL,model,revision" || typeof v.revision !== "string") throw invalid();
  let lock: number;
  try { lock = openSync(`${path}.lock`, "wx", 0o600); } catch { throw new Error("配置正在保存，请稍后重试"); }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const current = readDocument(path);
    if (v.revision !== current.revision) throw new Error("配置已被修改，请刷新后重新编辑");
    const config = parseModelConfig({ baseURL: v.baseURL, model: v.model, apiKey: current.config.apiKey });
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
    return modelSettings(path);
  } finally {
    closeSync(lock);
    try { unlinkSync(temp); } catch { /* temp already renamed */ }
    unlinkSync(`${path}.lock`);
  }
}

export async function checkModelConnection(config = readModelConfig()) {
  if (!config.apiKey) return { ok: false, message: "请先在配置文件中填写 API Key" };
  try {
    const res = await fetch(`${config.baseURL}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!res.ok) { await res.body?.cancel(); return { ok: false, message: `模型列表接口返回 HTTP ${res.status}` }; }
    const reader = res.body?.getReader();
    if (!reader) throw invalid();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) throw invalid(); chunks.push(value); }
    } finally { await reader.cancel(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const found = Array.isArray(body.data) && body.data.some((m: unknown) => m && typeof m === "object" && "id" in m && m.id === config.model);
    return { ok: found, message: found ? "接口认证成功，模型 ID 已找到。尚未测试生成。" : "接口已连接，但模型列表中未找到此模型 ID" };
  } catch { return { ok: false, message: "连接失败，请检查地址、服务状态和接口兼容性" }; }
}

export function localModelAccess(request: Request, peer: string | undefined) {
  const host = new URL(request.url);
  if (process.env.VERCEL || !process.env.LOOM_MODEL_CONFIG ||
      !(["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
        (peer === undefined && process.env.LOOM_MODEL_LOOPBACK_ONLY === "true")) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) return false;
  return request.method === "GET" || request.headers.get("origin") === host.origin;
}
