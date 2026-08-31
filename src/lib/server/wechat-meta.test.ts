import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeProvidersSeen, providerFromItems } from "./wechat-meta.ts";

describe("WeChat provider metadata", () => {
  it("derives primary, dajiala, mixed, and empty batches", () => {
    const item = (provider: string) => ({ extra: { provider } });
    assert.equal(providerFromItems([]), "");
    assert.equal(providerFromItems([item("primary")]), "primary");
    assert.equal(providerFromItems([item("dajiala")]), "dajiala");
    assert.equal(providerFromItems([item("primary"), item("dajiala")]), "mixed");
  });

  it("preserves unrelated extra and keeps provider history unique in first-seen order", () => {
    let extra = mergeProvidersSeen({ unrelated: "kept" }, "primary");
    extra = mergeProvidersSeen(extra, "dajiala");
    extra = mergeProvidersSeen(extra, "primary");
    assert.deepEqual(extra, { unrelated: "kept", providers_seen: ["primary", "dajiala"] });
  });
});
