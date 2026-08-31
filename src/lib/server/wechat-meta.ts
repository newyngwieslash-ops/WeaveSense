import type { NormalizedItem } from "./collectors/types.ts";

export type WechatProvider = "" | "primary" | "dajiala" | "mixed";

function providers(value: unknown): Array<"primary" | "dajiala"> {
  const values = value === "mixed" ? ["primary", "dajiala"]
    : Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map((entry) => String(entry).trim())
    .filter((entry): entry is "primary" | "dajiala" => entry === "primary" || entry === "dajiala");
}

export function providerFromItems(items: ReadonlyArray<Pick<NormalizedItem, "extra">>): WechatProvider {
  const seen = new Set(items.flatMap((item) => providers(item.extra.provider)));
  return seen.size === 0 ? "" : seen.size === 2 ? "mixed" : [...seen][0]!;
}

export function mergeProvidersSeen(
  existingExtra: Record<string, unknown> | null | undefined,
  incomingProvider: unknown,
): Record<string, unknown> {
  const extra = { ...(existingExtra ?? {}) };
  extra.providers_seen = [...new Set([
    ...providers(extra.providers_seen),
    ...providers(incomingProvider),
  ])];
  return extra;
}
