import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analysisSchema, parseExecuteRequest, parseExecuteResponse, type ExecuteMode } from "../agent-contract.ts";

const fixtures = new URL("../../../validation/agent/contracts/", import.meta.url);

function load(name: string) {
  return JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
}

test("analysis output rejects string topics", () => {
  const result = analysisSchema.safeParse({
    summary: "摘要",
    topics: "主题",
    entities: [],
    insights: "洞察",
    tags: [],
  });
  assert.equal(result.success, false);
});

test("analysis output rejects extra fields and overlong labels", () => {
  assert.equal(analysisSchema.safeParse({
    summary: "摘要", topics: ["主题"], entities: [], insights: "洞察", tags: [], extra: true,
  }).success, false);
  assert.equal(analysisSchema.safeParse({
    summary: "摘要",
    topics: ["😀".repeat(81)],
    entities: [],
    insights: "洞察",
    tags: [],
  }).success, false);
  assert.equal(analysisSchema.safeParse({
    summary: "x".repeat(1201),
    topics: ["主题"],
    entities: [],
    insights: "洞察",
    tags: [],
  }).success, false);
});

test("valid analyze/briefing/research fixtures parse", () => {
  for (const name of ["analyze-valid.json", "briefing-valid.json", "research-valid.json"]) {
    const fixture = load(name);
    assert.equal(parseExecuteRequest(JSON.stringify(fixture.request)).ok, true, name);
    assert.equal(parseExecuteResponse(JSON.stringify(fixture.response), fixture.request.mode).ok, true, name);
  }
});

test("invalid fixtures are rejected on both sides of the contract", () => {
  const cases = load("invalid-cases.json") as Array<{
    id: string; kind: string; mode?: string; payload?: unknown; raw?: string;
  }>;
  for (const item of cases) {
    if (item.kind === "analysis") {
      assert.equal(analysisSchema.safeParse(item.payload).success, false, item.id);
      continue;
    }
    if (item.kind === "request") {
      const parsed = parseExecuteRequest(JSON.stringify(item.payload));
      assert.equal(parsed.ok, false, item.id);
      continue;
    }
    if (item.kind === "response") {
      const parsed = parseExecuteResponse(JSON.stringify(item.payload), (item.mode ?? "analyze_item") as ExecuteMode);
      assert.equal(parsed.ok, false, item.id);
      continue;
    }
    if (item.kind === "raw_response") {
      const parsed = parseExecuteResponse(item.raw ?? "", "analyze_item");
      assert.equal(parsed.ok, false, item.id);
    }
  }
});
