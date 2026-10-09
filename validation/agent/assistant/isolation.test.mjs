#!/usr/bin/env node
// Assistant isolation acceptance (plan Task 18 / §9 A19): run in-process
// against the real Go-tested contracts ported to fixture form. No network,
// no model, no runtime binary. Explicit --run required.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (!args.includes("--run")) {
  console.log(JSON.stringify({ ok: true, checks: 0, mode: "import-only" }));
  process.exit(0);
}

const results = [];
const record = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); };

// A19 (contract surface): the compiled Go bridge/runtime test suite covers
// profile-tool isolation. This harness re-runs the decisive subset so the
// acceptance matrix can point at a single entry point.
{
  let out = "";
  try {
    out = execFileSync("go", ["test", "./internal/opencode", "-run",
      "TestPrepareProfileManifestExactness|TestAssistantTerminalDecoderSeparateFromResearch|TestBridgeAssistantProfileToolSurface|TestBridgeResearchGrantCannotCallAssistantTools|TestBridgeAssistantGrantCannotCallCorpusTools|TestBridgeAssistantToolsCallSameProfileEndpoint",
      "-count=1", "-v"], { cwd: "workers/agent", encoding: "utf8", timeout: 300000 });
  } catch (error) {
    out = String(error.stdout ?? "") + String(error.message ?? "");
  }
  const passed = (out.match(/^--- PASS/gm) ?? []).length;
  const failed = (out.match(/^--- FAIL/gm) ?? []).length;
  record("A19", failed === 0 && passed >= 5, `go isolation tests: ${passed} pass, ${failed} fail`);
}

// A20 (contract surface): forged receipts cannot enter via the browser
// decision route — asserted at the TS layer; re-run the decisive check.
{
  const { actionDecisionInput } = await import("../../../src/lib/assistant-contract.ts");
  const forged = actionDecisionInput.safeParse({
    request_id: randomUUID(), decision: "approve",
    preview_digest: "f".repeat(64), expected_revision: 0,
    result: { status: "succeeded" }, // forged success smuggled in the decision
  });
  record("A20-decision-shape", forged.success === false, "unknown field 'result' refused");
}

// A25 (contract surface): a generic autoApprove flag can never authorize.
{
  const { assistantMessageInput } = await import("../../../src/lib/assistant-contract.ts");
  const attempt = assistantMessageInput.safeParse({
    request_id: randomUUID(), expected_revision: 0, text: "全部同意",
    context: { page: "overview", filters: {}, references: [] },
    autoApprove: true, permissions: "*",
  });
  record("A25-shape", attempt.success === false, "autoApprove/permissions fields refused");
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.length }));
process.exit(failed.length === 0 ? 0 : 1);
