import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync, statSync, realpathSync } from "node:fs";
import { resolve, basename } from "node:path";

export type ModelConfig = { baseURL: string; model: string; apiKey: string };
export type ModelProfile = { id: string; name: string; baseURL: string; model: string; apiKey: string };
export type ModelDocument = { active: string; profiles: ModelProfile[] };

const revisionKey = randomBytes(32);
const MAX_PROFILES = 20;
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

function parseProfile(value: unknown): ModelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["id", "name", "baseURL", "model", "apiKey"].includes(k)) ||
      typeof v.id !== "string" || typeof v.name !== "string") throw invalid();
  const id = v.id.trim(), name = v.name.trim();
  if (!/^[\w.-]{1,64}$/.test(id) || !name || name.length > 60) throw invalid();
  const config = parseModelConfig({ baseURL: v.baseURL, model: v.model, apiKey: v.apiKey });
  return { id, name, ...config };
}

/** Accepts both the new multi-profile document and the legacy {baseURL,model,apiKey} file. */
function parseModelDocument(raw: string): ModelDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const v = parsed as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (keys === "active,profiles") {
    if (!Array.isArray(v.profiles) || v.profiles.length === 0 || v.profiles.length > MAX_PROFILES) throw invalid();
    const profiles = v.profiles.map(parseProfile);
    const ids = new Set(profiles.map(p => p.id));
    if (ids.size !== profiles.length) throw invalid();
    const active = typeof v.active === "string" ? v.active : "";
    if (!ids.has(active)) throw invalid();
    return { active, profiles };
  }
  // Legacy single-config file: one implicit "default" profile, always active.
  if (keys === "apiKey,baseURL,model") return { active: "default", profiles: [{ id: "default", name: "默认配置", ...parseModelConfig(parsed) }] };
  throw invalid();
}

function readDocument(path: string): { document: ModelDocument; revision: string } {
  try {
    for (const candidate of [resolve(path), realpathSync(path)]) {
      if (!basename(candidate).endsWith(".local.json") || candidate.replaceAll("\\", "/").split("/").some(part => part.toLowerCase() === "public")) throw invalid();
    }
    if (statSync(path).size > 16384) throw invalid();
    const raw = readFileSync(path, "utf8");
    return { document: parseModelDocument(raw), revision: createHmac("sha256", revisionKey).update(raw).digest("hex") };
  } catch { throw invalid(); }
}

function fallbackConfig(): ModelConfig {
  return { baseURL: "https://api.x.ai/v1", model: "grok-4.5", apiKey: process.env.XAI_API_KEY?.trim() ?? "" };
}

export function readModelConfig(): ModelConfig {
  const path = process.env.LOOM_MODEL_CONFIG?.trim();
  if (!path) return fallbackConfig();
  const { document } = readDocument(path);
  return document.profiles.find(p => p.id === document.active) ?? fallbackConfig();
}

export function modelSettings(path = process.env.LOOM_MODEL_CONFIG?.trim()) {
  if (!path) return { activeId: "", profiles: [], editable: false, engine: process.env.AI_ENGINE ?? "legacy" };
  const { document, revision } = readDocument(path);
  return {
    activeId: document.active,
    profiles: document.profiles.map(p => ({ id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, keyConfigured: Boolean(p.apiKey) })),
    revision, editable: true, engine: process.env.AI_ENGINE ?? "legacy",
  };
}

export type ModelSettingsPayload = ReturnType<typeof modelSettings>;

function writeDocument(path: string, document: ModelDocument): ModelSettingsPayload {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(document, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* already renamed */ }
  }
  return modelSettings(path);
}

/** Serialized mutation: one .lock at a time, optimistic revision check inside the lock. */
function mutateDocument(path: string, revision: string, mutate: (document: ModelDocument) => ModelDocument): ModelSettingsPayload {
  let lock: number;
  try { lock = openSync(`${path}.lock`, "wx", 0o600); } catch { throw new Error("配置正在保存，请稍后重试"); }
  try {
    const current = readDocument(path);
    if (revision !== current.revision) throw new Error("配置已被修改，请刷新后重新编辑");
    return writeDocument(path, mutate(current.document));
  } finally {
    closeSync(lock);
    unlinkSync(`${path}.lock`);
  }
}

export function upsertModelProfile(input: unknown, path = process.env.LOOM_MODEL_CONFIG?.trim()) {
  if (!path) throw new Error("请先指定 LOOM_MODEL_CONFIG 配置文件");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "apiKey,baseURL,id,model,name,revision" || typeof v.revision !== "string") throw invalid();
  const id = typeof v.id === "string" ? v.id.trim() : "";
  const incoming = parseProfile({ id: id || randomBytes(4).toString("hex"), name: v.name, baseURL: v.baseURL, model: v.model, apiKey: v.apiKey });
  return mutateDocument(path, v.revision, document => {
    const existing = document.profiles.find(p => p.id === incoming.id);
    if (!existing) {
      if (document.profiles.length >= MAX_PROFILES) throw new Error(`最多保存 ${MAX_PROFILES} 个模型档案`);
      // Empty key on create stays empty; the user can fill it in afterwards.
      return { active: document.active, profiles: [...document.profiles, incoming] };
    }
    // Empty apiKey on update means "keep the stored one" (the UI never shows keys).
    const apiKey = incoming.apiKey || existing.apiKey;
    const profiles = document.profiles.map(p => p.id === incoming.id ? { ...incoming, apiKey } : p);
    return { active: document.active, profiles };
  });
}

export function activateModelProfile(input: unknown, path = process.env.LOOM_MODEL_CONFIG?.trim()) {
  if (!path) throw new Error("请先指定 LOOM_MODEL_CONFIG 配置文件");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "id,revision" || typeof v.id !== "string" || typeof v.revision !== "string") throw invalid();
  const id = v.id.trim();
  return mutateDocument(path, v.revision, document => {
    if (!document.profiles.some(p => p.id === id)) throw new Error("档案不存在，请刷新后重试");
    return { active: id, profiles: document.profiles };
  });
}

export function deleteModelProfile(input: unknown, path = process.env.LOOM_MODEL_CONFIG?.trim()) {
  if (!path) throw new Error("请先指定 LOOM_MODEL_CONFIG 配置文件");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "id,revision" || typeof v.id !== "string" || typeof v.revision !== "string") throw invalid();
  const id = v.id.trim();
  return mutateDocument(path, v.revision, document => {
    if (document.profiles.length <= 1) throw new Error("至少保留一个模型档案");
    if (!document.profiles.some(p => p.id === id)) throw new Error("档案不存在，请刷新后重试");
    const profiles = document.profiles.filter(p => p.id !== id);
    return { active: document.active === id ? profiles[0].id : document.active, profiles };
  });
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

export function checkProfileConnection(id: string, path = process.env.LOOM_MODEL_CONFIG?.trim()) {
  if (!path) return Promise.resolve({ ok: false, message: "请先指定 LOOM_MODEL_CONFIG 配置文件" });
  let config: ModelConfig;
  try {
    const { document } = readDocument(path);
    const profile = document.profiles.find(p => p.id === id);
    if (!profile) return Promise.resolve({ ok: false, message: "档案不存在，请刷新后重试" });
    config = { baseURL: profile.baseURL, model: profile.model, apiKey: profile.apiKey };
  } catch { return Promise.resolve({ ok: false, message: "模型配置无效，请检查服务端配置文件" }); }
  return checkModelConnection(config);
}

export function localModelAccess(request: Request, peer: string | undefined) {
  const host = new URL(request.url);
  if (process.env.VERCEL || !process.env.LOOM_MODEL_CONFIG) return false;
  // Explicit deployment opt-out: the port binding is the trust boundary. The app
  // publishes only on the host loopback (127.0.0.1:8080), so every reachable peer
  // is already a local operator; the container cannot prove loopback via peer IP.
  const allowed = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
    (peer === undefined && process.env.LOOM_MODEL_LOOPBACK_ONLY === "true") ||
    process.env.LOOM_MODEL_MANAGE_ALLOWED === "true";
  if (!allowed ||
      !["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) return false;
  return request.method === "GET" || request.headers.get("origin") === host.origin;
}
