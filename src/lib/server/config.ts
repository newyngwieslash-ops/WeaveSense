import { parseCronTickLimit } from "./cron.ts";
import { researchRuntime, researchReviewMode } from "./agent-research-policy.ts";

function read(name: string, fallback = ""): string {
  const raw = typeof process !== "undefined" ? process.env[name] : undefined;
  return (raw ?? fallback).trim();
}

export const prod = {
  telegramWorkerUrl: read("TELEGRAM_WORKER_URL").replace(/\/$/, ""),
  wechatGatewayUrl: read("WECHAT_GATEWAY_URL").replace(/\/$/, ""),
  wechatGatewayToken: read("WECHAT_GATEWAY_TOKEN"),
  cronSecret: read("CRON_SECRET"),
  cronTickLimit: parseCronTickLimit(read("CRON_TICK_LIMIT", "200")),
  minioEndpoint: read("MINIO_ENDPOINT").replace(/\/$/, ""),
  minioAccessKey: read("MINIO_ACCESS_KEY") || read("MINIO_ROOT_USER"),
  minioSecretKey: read("MINIO_SECRET_KEY") || read("MINIO_ROOT_PASSWORD"),
  minioBucket: read("MINIO_BUCKET", "loom"),
  minioRegion: read("MINIO_REGION", "us-east-1"),
  minioPublicUrl: read("MINIO_PUBLIC_URL").replace(/\/$/, ""),
  minioForcePathStyle: read("MINIO_FORCE_PATH_STYLE", "true") !== "false",
  tickLimit: Math.min(40, Math.max(1, Number(read("TICK_LIMIT", "5")) || 5)),
  extractAuto: read("EXTRACT_AUTO", "false") === "true",
  autoAnalyze: read("AUTO_ANALYZE", "false") === "true",
  autoAnalyzeDailyLimit: Math.max(0, Number(read("AUTO_ANALYZE_DAILY_LIMIT", "20")) || 0),
  autoAnalyzeDailyBudgetRmb: Math.max(0, Number(read("AUTO_ANALYZE_DAILY_BUDGET_RMB", "20")) || 0),
  autoAnalyzePriceVersion: read("AUTO_ANALYZE_PRICE_VERSION", "v1") || "v1",
  autoAnalyzeWorstCostRmb: Math.max(0.01, Number(read("AUTO_ANALYZE_WORST_COST_RMB", "1")) || 1),
  aiEngine: parseEngine(read("AI_ENGINE", "legacy")),
  agentServiceUrl: read("AGENT_SERVICE_URL").replace(/\/$/, ""),
  agentServiceToken: read("AGENT_SERVICE_TOKEN"),
  agentDataToken: read("AGENT_DATA_TOKEN"),
  agentAsyncResearch: read("AGENT_ASYNC_RESEARCH_ENABLED", "false") === "true",
  agentWorkerEnabled: read("AGENT_WORKER_ENABLED", "false") === "true",
  opencodeWorkerEnabled: read("AGENT_OPENCODE_WORKER_ENABLED", "false") === "true",
  opencodeWorkerToken: read("OPENCODE_WORKER_TOKEN"),
  agentResearchRuntime: parseResearchRuntime(read("AGENT_RESEARCH_RUNTIME", "eino")),
  agentResearchReview: parseResearchReview(read("AGENT_RESEARCH_REVIEW", "off")),
  assistantEnabled: read("AGENT_ASSISTANT_ENABLED", "false") === "true",
  assistantActionsEnabled: read("AGENT_ASSISTANT_ACTIONS_ENABLED", "false") === "true",
  assistantWorkerToken: read("ASSISTANT_WORKER_TOKEN"),
  assistantMaxModelCalls: Math.max(1, Math.min(20, Number(read("AGENT_ASSISTANT_MAX_MODEL_CALLS", "6")) || 6)),
  assistantMaxToolCalls: Math.max(0, Math.min(40, Number(read("AGENT_ASSISTANT_MAX_TOOL_CALLS", "8")) || 8)),
  assistantDailyLimit: Math.max(0, Number(read("AGENT_ASSISTANT_DAILY_LIMIT", "20")) || 0),
  assistantDailyBudgetRmb: Math.max(0, Number(read("AGENT_ASSISTANT_DAILY_BUDGET_RMB", "20")) || 0),
};

export function agentAsyncAvailable(): boolean {
  return prod.agentAsyncResearch && (prod.agentResearchRuntime === "opencode" ? prod.opencodeWorkerEnabled && Boolean(prod.opencodeWorkerToken) : prod.agentWorkerEnabled)
    && Boolean(prod.agentServiceUrl && prod.agentServiceToken && prod.agentDataToken);
}

function parseEngine(value: string): "legacy" | "eino" {
  if (value === "legacy" || value === "eino") return value;
  throw new Error("agent_unconfigured");
}

export function parseResearchRuntime(value: string): "eino" | "opencode" {
  return researchRuntime(value);
}

export function parseResearchReview(value: string): "off" | "shadow" | "enforce" {
  return researchReviewMode(value);
}

export function minioConfigured(): boolean {
  return Boolean(prod.minioEndpoint && prod.minioAccessKey && prod.minioSecretKey);
}

export function telethonConfigured(): boolean {
  return Boolean(prod.telegramWorkerUrl);
}

export function wechatGatewayConfigured(): boolean {
  return Boolean(prod.wechatGatewayUrl && prod.wechatGatewayToken);
}
