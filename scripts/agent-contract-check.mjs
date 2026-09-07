#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "validation", "agent", "contracts");
const contractURL = pathToFileURL(join(root, "src", "lib", "agent-contract.ts")).href;
const { analysisSchema, parseExecuteRequest, parseExecuteResponse } = await import(contractURL);

function load(name) {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

const ts = { accept: [], reject: [] };
for (const name of ["analyze-valid.json", "briefing-valid.json", "research-valid.json"]) {
  const fixture = load(name);
  const req = parseExecuteRequest(JSON.stringify(fixture.request));
  const res = parseExecuteResponse(JSON.stringify(fixture.response), fixture.request.mode);
  if (req.ok && res.ok) ts.accept.push(name);
  else ts.reject.push(name);
}
for (const item of load("invalid-cases.json")) {
  let ok = false;
  if (item.kind === "analysis") ok = analysisSchema.safeParse(item.payload).success;
  else if (item.kind === "request") ok = parseExecuteRequest(JSON.stringify(item.payload)).ok;
  else if (item.kind === "response") ok = parseExecuteResponse(JSON.stringify(item.payload), item.mode ?? "analyze_item").ok;
  else if (item.kind === "raw_response") ok = parseExecuteResponse(item.raw ?? "", "analyze_item").ok;
  (ok ? ts.accept : ts.reject).push(item.id);
}

const go = spawnSync("go", ["-C", "workers/agent", "test", "./internal/agent", "-run", "TestContract", "-count=1"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" },
});
if (go.status !== 0) {
  process.stderr.write(go.stdout + go.stderr);
  process.exit(1);
}

const expectedReject = load("invalid-cases.json").map((item) => item.id);
const expectedAccept = ["analyze-valid.json", "briefing-valid.json", "research-valid.json"];
const missingAccept = expectedAccept.filter((id) => !ts.accept.includes(id));
const leaked = expectedReject.filter((id) => ts.accept.includes(id));
if (missingAccept.length || leaked.length) {
  console.error(JSON.stringify({ missingAccept, leaked, ts }, null, 2));
  process.exit(1);
}
console.log("agent-contract-check: ok");
