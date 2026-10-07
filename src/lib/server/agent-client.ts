import {
  parseExecuteResponse,
  type ExecuteRequest,
  type ExecuteResponse,
} from "../agent-contract.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 130_000;

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
  const executeMs = Number(process.env.AGENT_EXECUTE_TIMEOUT_MS ?? 120_000);
  const timeoutMs = Number(process.env.AGENT_HTTP_TIMEOUT_MS ?? executeMs + 10_000);
  if (!Number.isSafeInteger(executeMs) || executeMs < 1000 || executeMs > 900_000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < executeMs + 10_000 || timeoutMs > 910_000) {
    throw new AgentClientError("invalid_agent_timeout");
  }
  return {
    engine,
    serviceUrl: (process.env.AGENT_SERVICE_URL ?? "").trim().replace(/\/$/, ""),
    serviceToken: (process.env.AGENT_SERVICE_TOKEN ?? "").trim(),
    timeoutMs,
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
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  }

  const contentType = res.headers.get("content-type") ?? "";
  let raw: string;
  try {
    if (!res.body) {
      raw = await res.text();
    } else {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (Date.now() > deadline) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new AgentClientError("model_timeout", "aborted");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new AgentClientError("invalid_output", "response_too_large");
          }
          chunks.push(value);
        }
      }
      raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    }
  } catch (error) {
    if (error instanceof AgentClientError) throw error;
    const timeoutLike = error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError" || error.message === "aborted");
    throw new AgentClientError(timeoutLike ? "model_timeout" : "agent_unavailable", "read_failed");
  } finally {
    clearTimeout(timeout);
  }
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
