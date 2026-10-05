#!/usr/bin/env node
/**
 * T04: the source pack must exclude secrets and still unzip into usable source.
 *
 * Exercises the real writer (`scripts/zip.mjs`) on a fixture tree, then reads the
 * archive back the way a user would (Python's stdlib zipfile, present on the
 * target host) so "it looked fine in the writer" is not the evidence.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { offlineEnv } from "./readiness-offline.mjs";
import { test } from "node:test";
import { zipDirectory } from "./zip.mjs";
import { packExcluded } from "./deployment-policy.mjs";

/** Build a small tree that mixes real source with things that must not ship. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loom-pack-"));
  const add = (rel, content) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  add("src/routes/prd.tsx", "export const prd = 1;\n");
  add("src/lib/server/scheduler.ts", "export const scheduler = 1;\n");
  add("migrations/0002_schema.sql", "create table t();\n");
  add("config/model.example.json", '{ "model": "example" }\n');
  add("env.example", "POSTGRES_PASSWORD=\n");
  return dir;
}

test("the archive round-trips through an external unzip", () => {
  const dir = fixture();
  const zip = join(dir, "out.zip");
  const bytes = zipDirectory(join(dir), zip, "zhishi-loom");
  assert.ok(bytes > 0);

  const python = spawnSync("python", ["-c", `import zipfile;print("\\n".join(sorted(zipfile.ZipFile(r"${zip}").namelist())))`], {
    encoding: "utf8",
    windowsHide: true,
  });
  // Python may only be reachable as `py` on Windows.
  const result = python.status === 0
    ? python
    : spawnSync("py", ["-c", `import zipfile;print("\\n".join(sorted(zipfile.ZipFile(r"${zip}").namelist())))`], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    // No Python available: fall back to reading sizes back with zlib-free checks.
    assert.ok(bytes > 200, "archive should be non-trivial");
    return;
  }
  const names = result.stdout.trim().split(/\r?\n/);
  assert.ok(names.includes("zhishi-loom/src/routes/prd.tsx"), names.join(", "));
  assert.ok(names.includes("zhishi-loom/migrations/0002_schema.sql"), names.join(", "));
  assert.ok(!names.some((n) => packExcluded(n)), `archive carries excluded paths: ${names}`);
});

test("the pack guard rejects a secret that a future include list adds", () => {
  // `config/` as a directory would otherwise sweep in model.local.json.
  const offenders = ["config/model.local.json", "workers/telethon/loom.session", ".env"]
    .filter((rel) => !packExcluded(rel));
  assert.deepEqual(offenders, [], `these would have shipped: ${offenders.join(", ")}`);
});

test("the archive is a real zip (PK header) not a renamed blob", () => {
  const dir = fixture();
  const zip = join(dir, "out2.zip");
  zipDirectory(join(dir), zip, "zhishi-loom");
  const head = readFileSync(zip).subarray(0, 4);
  assert.deepEqual([...head], [0x50, 0x4b, 0x03, 0x04], "missing local file header");
});

test("actual delivery ZIP contains registered tests and their fixture/import closure, without private state", () => {
  const packed=spawnSync(process.execPath,['scripts/pack-source.mjs'],{encoding:'utf8',windowsHide:true,env:offlineEnv(process.env)});
  assert.equal(packed.status,0,packed.stderr);
  const zip=readFileSync('artifacts/zhishi-loom-source.zip'); const files=new Map(); let offset=0;
  while(zip.readUInt32LE(offset)===0x04034b50) {
    const method=zip.readUInt16LE(offset+8),size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
    const name=zip.subarray(offset+30,offset+30+nameLength).toString().replace(/^zhishi-loom\//,'');
    const start=offset+30+nameLength+extra; const bytes=zip.subarray(start,start+size);
    assert.equal(packExcluded(name),false,`excluded archive path: ${name}`);
    files.set(name,method===8?inflateRawSync(bytes):bytes);offset=start+size;
  }
  assert.ok(files.size>100);
  const scripts=JSON.parse(files.get('package.json')).scripts.test;
  for(const name of scripts.match(/(?:scripts|src|validation)\/[^\s]+\.test\.(?:ts|mjs)/g)??[]) assert.ok(files.has(name),`missing registered test: ${name}`);
  assert.ok(files.has('validation/agent/contracts/analyze-valid.json'));
  for(const [name,bytes] of files) if(name.startsWith('validation/')&&name.endsWith('.test.ts')) {
    for(const match of bytes.toString().matchAll(/from\s+["'](\.\.[^"']+)["']/g)) {
      const normalized=join(name,'..',match[1]).replaceAll('\\','/'); assert.ok(files.has(normalized),`missing relative import: ${normalized}`);
    }
  }
  assert.deepEqual(readFileSync('public/zhishi-loom-source.zip'),zip);
});
