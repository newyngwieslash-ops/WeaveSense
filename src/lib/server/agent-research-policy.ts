import { hashCanonical } from "./agent-runs.ts";

export type ResearchRuntime = "eino" | "opencode";
export type ReviewMode = "off" | "shadow" | "enforce";
export function researchRuntime(value = process.env.AGENT_RESEARCH_RUNTIME ?? "eino"): ResearchRuntime {
  if (value !== "eino" && value !== "opencode") throw new Error("invalid_research_runtime");
  return value;
}
export function researchReviewMode(value = process.env.AGENT_RESEARCH_REVIEW ?? "off"): ReviewMode {
  if (value !== "off" && value !== "shadow" && value !== "enforce") throw new Error("invalid_research_review");
  return value;
}

export function researchIntentHash(snapshot: Record<string, unknown>, question: string): string {
  return hashCanonical(snapshot.governed ? { mode: "research", question, provider: snapshot.provider,
    scope: snapshot.scope, range: snapshot.range ?? null, review_policy: snapshot.review_policy,
    model_profile: snapshot.model_profile, skill_snapshot_digest: snapshot.skill_snapshot_digest,
    role_limits: snapshot.role_limits, policy: snapshot.policy } : { mode: "research", question });
}

/** These are operator configuration values, not fields accepted from a browser. */
export function researchGovernanceFromEnv(question: string, env: NodeJS.ProcessEnv = process.env) {
  const mode = researchReviewMode(env.AGENT_RESEARCH_REVIEW ?? "off");
  const model = env.AGENT_MODEL_NAME?.trim();
  const inputRate = Number(env.AGENT_PRICE_INPUT_RMB_PER_MILLION ?? "NaN");
  const outputRate = Number(env.AGENT_PRICE_OUTPUT_RMB_PER_MILLION ?? "NaN");
  const priceVersion = env.AGENT_RESEARCH_PRICE_VERSION?.trim() ?? "research-price-v1";
  const dailyLimit = Number(env.AGENT_RESEARCH_DAILY_LIMIT ?? 20), dailyBudget = Number(env.AGENT_RESEARCH_DAILY_BUDGET_RMB ?? 20);
  const skillDigest = env.AGENT_SKILL_SNAPSHOT_DIGEST?.trim() ?? "";
  if (!model || !Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0 ||
      !Number.isSafeInteger(dailyLimit) || dailyLimit <= 0 || !Number.isFinite(dailyBudget) || dailyBudget <= 0 ||
      !priceVersion || priceVersion.length > 64 || !/^[a-f0-9]{64}$/.test(skillDigest)) throw new Error("research_pricing_or_skills_unconfigured");
  const profile = { model, input_per_million: inputRate, output_per_million: outputRate, price_version: priceVersion };
  const producerCalls = 6, reviewerCalls = mode === "off" ? 0 : 1, total = producerCalls + reviewerCalls;
  // Serialized model requests are capped at 512KiB in trusted adapters. Reserve a byte-based upper bound,
  // including all paid auxiliary calls; a provider without a verified bound cannot enable this path.
  const inputTokenCap = 512 * 1024, outputTokenCap = 1800;
  const worstCostRmb = total * (inputTokenCap * inputRate + outputTokenCap * outputRate) / 1_000_000;
  return {
    governed: true, provider: researchRuntime(env.AGENT_RESEARCH_RUNTIME ?? "eino"),
    review_policy: { mode, version: "loom-agent-v1", question, model, max_output_tokens_per_call: outputTokenCap,
      model_profile_digest: hashCanonical(profile), skill_snapshot_digest: skillDigest },
    model_profile: profile, skill_snapshot_digest: skillDigest,
    role_limits: { producer: producerCalls, reviewer: reviewerCalls },
    policy: { version: "loom-agent-v1", max_model_calls: total, max_tool_calls: 4, max_output_tokens_per_call: outputTokenCap },
    budget: { dailyLimit, dailyBudgetRmb: dailyBudget, priceVersion, worstCostRmb, pricing: { ...profile, max_input_tokens_per_call: inputTokenCap, max_output_tokens_per_call: outputTokenCap } },
  };
}
