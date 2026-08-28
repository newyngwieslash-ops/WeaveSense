#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = "/workspace";
const staging = "/tmp/zhishi-loom";
const zipName = "zhishi-loom-source.zip";
const destPublic = join(root, "public", zipName);
const destArtifacts = join(root, "artifacts", zipName);

const INCLUDE = [
  "README.md",
  "LICENSE",
  "Dockerfile",
  "docker-compose.yml",
  "env.example",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "eslint.config.mjs",
  "docs",
  "migrations",
  "scripts",
  "server",
  "src",
  "workers",
  "public/favicon.svg",
  "public/hero-area.jpg",
  "public/hero-area.mp4",
  "public/og.jpg",
  ".grok/app-env.json",
];

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(join(staging, "public"), { recursive: true });
mkdirSync(join(staging, ".grok"), { recursive: true });

for (const rel of INCLUDE) {
  const from = join(root, rel);
  if (!existsSync(from)) continue;
  cpSync(from, join(staging, rel), { recursive: true });
}

rmSync(join(staging, "workers/telethon/__pycache__"), { recursive: true, force: true });

const zipPath = `/tmp/${zipName}`;
rmSync(zipPath, { force: true });

const py = `
import os, zipfile
root = "/tmp/zhishi-loom"
out = "/tmp/zhishi-loom-source.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {".git", "__pycache__", "node_modules"}]
        for name in filenames:
            full = os.path.join(dirpath, name)
            arc = os.path.join("zhishi-loom", os.path.relpath(full, root))
            z.write(full, arc)
print("wrote", os.path.getsize(out))
`;
writeFileSync("/tmp/pack-source.py", py);
const packed = spawnSync("python3", ["/tmp/pack-source.py"], { stdio: "inherit" });
if (packed.status !== 0) process.exit(packed.status ?? 1);

mkdirSync(join(root, "artifacts"), { recursive: true });
cpSync(zipPath, destPublic);
cpSync(zipPath, destArtifacts);
const bytes = statSync(destPublic).size;
console.log(`[pack] ${zipName} ${(bytes / 1024).toFixed(0)} KB → public/ and artifacts/`);
