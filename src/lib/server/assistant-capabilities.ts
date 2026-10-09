/**
 * Assistant capabilities (plan §5.3 / A01): a read-only view of what the
 * assistant can do right now, with explicit reasons when it cannot. Reads
 * environment/config only — no model calls, no seeding, no runtime probing
 * that could start work.
 */

export type AssistantCapabilities = {
  enabled: boolean;
  reason?: "assistant_disabled" | "model_config_missing" | "research_governance_unconfigured";
  actions_enabled: boolean;
  profile: "assistant";
};

export async function assistantCapabilities(): Promise<AssistantCapabilities> {
  if (process.env.AGENT_ASSISTANT_ENABLED === "false") {
    return { enabled: false, reason: "assistant_disabled", actions_enabled: false, profile: "assistant" };
  }
  if (process.env.VERCEL || !process.env.LOOM_MODEL_CONFIG) {
    return { enabled: false, reason: "model_config_missing", actions_enabled: false, profile: "assistant" };
  }
  const governanceReady = Boolean(
    process.env.AGENT_MODEL_NAME && process.env.AGENT_SKILL_SNAPSHOT_DIGEST &&
    process.env.AGENT_PRICE_INPUT_RMB_PER_MILLION && process.env.AGENT_PRICE_OUTPUT_RMB_PER_MILLION,
  );
  if (!governanceReady) {
    return { enabled: false, reason: "research_governance_unconfigured", actions_enabled: false, profile: "assistant" };
  }
  return {
    enabled: true,
    actions_enabled: process.env.AGENT_ASSISTANT_ACTIONS_ENABLED !== "false",
    profile: "assistant",
  };
}
