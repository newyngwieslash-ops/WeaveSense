#!/usr/bin/env node
/**
 * Pack a reviewable source bundle.
 *
 * Portable by design: the previous version hard-coded `/workspace`, `/tmp` and
 * `python3`, so it could only run inside one Linux sandbox. This version stages
 * and zips with Node only, writes next to the project, and enforces the T04
 * exclusion policy before anything is added.
 *
 * The exclusion decision is imported from `deployment-policy.mjs`, so the pack
 * and the tests can never disagree about what "excluded" means.
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { packExcluded } from "./deployment-policy.mjs";
import { zipDirectory } from "./zip.mjs";

const root = process.cwd();
const staging = resolve(root, "artifacts", ".pack-staging");
const zipName = "zhishi-loom-source.zip";
const destArtifacts = join(root, "artifacts", zipName);
// The in-app "download source" link serves this from public/ (src/routes/guide.tsx),
// so the copy stays. It is excluded from the Docker build context, and the
// exclusion policy above is what keeps it from carrying secrets into that URL.
const destPublic = join(root, "public", zipName);

const INCLUDE = [
  "README.md",
  "LICENSE",
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "env.example",
  "config/model.example.json",
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

const skipped = [];
for (const rel of INCLUDE) {
  const from = join(root, rel);
  if (!existsSync(from)) continue;
  cpSync(from, join(staging, rel), {
    recursive: true,
    filter: (source) => {
      const relPath = relative(root, source).replaceAll("\\", "/");
      if (!relPath) return true;
      if (packExcluded(relPath)) {
        skipped.push(relPath);
        return false;
      }
      return true;
    },
  });
}

// Fail closed: if a policy-excluded path still reached staging, stop here rather
// than ship it. Catches a future INCLUDE entry (or a copy edge case) that
// bypasses the filter above.
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const leaked = walk(staging)
  .map((file) => relative(staging, file).replaceAll("\\", "/"))
  .filter((rel) => packExcluded(rel));
if (leaked.length) {
  console.error(`[pack] refusing to ship excluded paths: ${leaked.join(", ")}`);
  process.exit(1);
}

rmSync(destArtifacts, { force: true });
const bytes = zipDirectory(staging, destArtifacts);
mkdirSync(join(root, "public"), { recursive: true });
copyFileSync(destArtifacts, destPublic);
console.log(
  `[pack] ${zipName} ${(bytes / 1024).toFixed(0)} KB → artifacts/ 和 public/ (${skipped.length} 个被排除路径已跳过)`,
);
