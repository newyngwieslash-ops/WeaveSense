/**
 * Effect enum → cache mapping (plan Task 16 / §2.4). Receipt domains are the
 * ONLY source of cache invalidation; model text, URLs and arbitrary query
 * keys are structurally impossible here because the mapping is a closed
 * table over the contract's ASSISTANT_DOMAINS.
 */
import type { ActionReceiptPublic } from "@/lib/server/assistant-action-receipt.ts";
import { ASSISTANT_DOMAINS } from "./assistant-contract.ts";

export type AssistantDomain = (typeof ASSISTANT_DOMAINS)[number];

const DOMAIN_TO_QUERY_KEYS: Record<AssistantDomain, string[]> = {
  keywords: ["keywords"],
  sources: ["sources"],
  items: ["items"],
  jobs: ["jobs"],
  knowledge: ["knowledge"],
  overview: ["overview"],
};

export function effectQueryKeys(domains: string[]): string[][] {
  const keys: string[][] = [];
  for (const domain of domains) {
    const mapped = DOMAIN_TO_QUERY_KEYS[domain as AssistantDomain];
    if (!mapped) throw new Error(`unknown_assistant_domain:${domain}`);
    keys.push([...mapped]);
  }
  return keys;
}

/**
 * The QueryClient keys to invalidate for one receipt. Terminal-but-empty
 * statuses (failed/skipped) invalidate nothing — there is nothing new to
 * show, and a stale-but-honest view is better than a pointless refetch.
 */
export function effectsForReceipt(receipt: ActionReceiptPublic): string[][] {
  if (receipt.status === "failed" || receipt.status === "skipped" || receipt.status === "not_found") {
    return [];
  }
  return effectQueryKeys(receipt.changed_domains);
}
