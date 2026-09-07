import {
  parseExecuteResponse,
  type ExecuteRequest,
  type ExecuteResponse,
} from "../agent-contract.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

export type AgentClientConfig = {
  engine: "legacy" | "eino";
  serviceUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function agentClientConfig(): AgentClientConfig {
  const engine = (typeof process === "undefined" ? "legacy" : process.env.AI_ENGINE?.trim() || "legacy");
  if (engine !== "legacy" && engine !== "eino") throw new AgentClientError("agent_unconfigured");
  return {
    engine,
    serviceUrl: (process.env.AGENT_SERVICE_URL ?? "").trim().replace(/\/$/, ""),
    serviceToken: (process.env.AGENT_SERVICE_TOKEN ?? "").trim(),
  };
}

export class AgentClientError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

function redact(value: string, token: string): string {
  return token ? value.split(token).join("[redacted]") : value;
}

export async function executeAgent(
  request: ExecuteRequest,
  config: AgentClientConfig,
): Promise<ExecuteResponse> {
  if (config.engine !== "eino") {
    throw new AgentClientError("agent_unconfigured", "AI_ENGINE is not eino");
  }
  if (!config.serviceUrl || !config.serviceToken) {
    throw new AgentClientError("agent_unconfigured");
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${config.serviceUrl.replace(/\/$/, "")}/v1/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.serviceToken}`,
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : "fetch_failed", config.serviceToken);
    const timeoutLike = error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError" || error.message === "aborted");
    throw new AgentClientError(timeoutLike ? "model_timeout" : "agent_unavailable", message);
  } finally {
    clearTimeout(timeout);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    throw new AgentClientError("invalid_output", "response_too_large");
  }
  const raw = buf.toString("utf8");
  if (!contentType.includes("application/json")) {
    throw new AgentClientError("invalid_output", "non_json_response");
  }
  const parsed = parseExecuteResponse(raw, request.mode);
  if (!parsed.ok) throw new AgentClientError("invalid_output", parsed.error);
  if (parsed.value.run_id !== request.run_id) {
    throw new AgentClientError("invalid_output", "run_id_mismatch");
  }
  return parsed.value;
}
