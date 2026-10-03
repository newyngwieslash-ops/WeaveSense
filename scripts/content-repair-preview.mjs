#!/usr/bin/env node
/**
 * T11: historical content-repair **preview** (read-only by default).
 *
 * Background: non-WeChat bodies were cut to 8,000 characters at ingestion, so any
 * stored article longer than that is missing its tail. This script reports what
 * that means per row so a repair can be *decided* rather than guessed:
 *
 *   - which item ids look truncated (length exactly at the old cut);
 *   - why (the reason recorded, or "at_cut_boundary" when nothing was recorded);
 *   - a short, non-identifying digest of the current vs. what a refetch would
 *     need to produce — never the full body text.
 *
 * It deliberately does NOT invent a tail. A truncated body cannot be reconstructed
 * from itself, so every candidate is marked `requires_authorized_refetch` unless a
 * stored, complete copy already exists. Applying a repair is NOT implemented here:
 * it would need an authorized recovery copy plus a fixed preview manifest, per the
 * plan (T11 step 5), and that path is intentionally absent until Gate B grants a
 * target.
 *
 * Usage:
 *   node scripts/content-repair-preview.mjs                  # against DATABASE_URL, read-only
 *   node scripts/content-repair-preview.mjs --pglite         # isolated in-memory DB (demo/QA)
 *   node scripts/content-repair-preview.mjs --limit 200 --json
 */
import { createHash } from "node:crypto";

const OLD_CUT = 8000;

function parseArgs(argv) {
  const args = { limit: 1000, json: false, pglite: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--pglite") args.pglite = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

/** A short, non-reversible digest used to compare candidates without printing text. */
const digest = (text) => createHash("sha256").update(text ?? "").digest("hex").slice(0, 12);

/**
 * Classify one candidate row. Pure, so the decision is testable without a DB.
 *
 * Note on the marker fields: they arrive from `jsonb -> 'x' ->> 'y'` as **strings**
 * ("true"/"false"), not booleans. Comparing against a boolean silently matched
 * nothing — a real defect this preview would otherwise have shipped.
 *
 * @param {{ id: string, platform: string, body: string, body_complete?: unknown,
 *           body_error?: unknown, backfilled_from?: unknown }} row
 */
export function classifyCandidate(row) {
  const body = String(row.body ?? "");
  const reasons = [];
  if (row.body_error === "body_too_large") reasons.push("body_too_large");
  // Accept both the string form (from `->>`) and a real boolean (direct row).
  if (row.body_complete === false || row.body_complete === "false") reasons.push("marked_incomplete");
  // The old cut produced bodies of *exactly* the limit; that is the signature of
  // truncation, but it is not proof (a body can legitimately be that long).
  if (body.length === OLD_CUT) reasons.push("at_cut_boundary");
  const truncated = reasons.length > 0;
  return {
    id: String(row.id),
    platform: String(row.platform ?? ""),
    body_length: body.length,
    body_sha256_12: digest(body),
    reasons,
    // A truncated body cannot be rebuilt from itself: the tail is simply absent.
    // Only an authorized refetch (or a stored complete copy) can supply it.
    action: truncated ? "requires_authorized_refetch" : "none",
  };
}

/** Rows worth looking at: incomplete markers, size errors, or exactly at the cut. */
const CANDIDATE_SQL = `
  select id, platform, body,
         extra->>'body_complete' as body_complete,
         extra->>'body_error' as body_error,
         extra->>'backfilled_from' as backfilled_from
    from items
   where extra->>'body_error' = 'body_too_large'
      or extra->>'body_complete' = 'false'
      or char_length(body) = $1
   order by char_length(body) desc, id
   limit $2`;

async function openSql(usePglite) {
  if (usePglite) {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.waitReady;
    // Minimal schema so the preview runs anywhere without touching a real DB.
    await pg.exec(`create table if not exists items (
      id text primary key,
      platform text not null default 'rss',
      body text not null default '',
      extra jsonb not null default '{}'::jsonb
    )`);
    return {
      kind: "pglite",
      query: async (text, params = []) => (await pg.query(text, params)).rows,
      close: () => pg.close(),
    };
  }
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required (or pass --pglite)");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  return {
    kind: "postgres",
    query: async (text, params = []) => (await pool.query(text, params)).rows,
    close: () => pool.end(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/content-repair-preview.mjs [--limit N] [--json] [--pglite]");
    return;
  }
  if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100_000) {
    throw new Error("--limit must be an integer between 1 and 100000");
  }

  const sql = await openSql(args.pglite);
  try {
    const rows = await sql.query(CANDIDATE_SQL, [OLD_CUT, args.limit]);
    const candidates = rows.map(classifyCandidate);
    const needing = candidates.filter((c) => c.action !== "none");
    const report = {
      generated_at: new Date().toISOString(),
      source: sql.kind,
      read_only: true,
      old_cut_characters: OLD_CUT,
      scanned: candidates.length,
      needs_refetch: needing.length,
      // Grouped counts only — no body text, no titles, no author names.
      by_reason: needing.reduce((acc, c) => {
        for (const reason of c.reasons) acc[reason] = (acc[reason] ?? 0) + 1;
        return acc;
      }, {}),
      // A bounded sample of ids so an operator can look them up; never full text.
      sample: needing.slice(0, 50).map(({ id, platform, body_length, body_sha256_12, reasons }) => ({
        id, platform, body_length, body_sha256_12, reasons,
      })),
      note: "预览只读；被截断的正文无法从自身重建，需要经授权的重抓（T22/Gate B）。本脚本不执行修复。",
    };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`候选扫描：${report.scanned} 行；需重抓：${report.needs_refetch} 行`);
      console.log(`原因分布：${Object.entries(report.by_reason).map(([k, v]) => `${k}=${v}`).join(" ") || "（无）"}`);
      for (const row of report.sample) {
        console.log(`  ${row.id}  ${row.platform}  ${row.body_length} 字符  ${row.body_sha256_12}  ${row.reasons.join(",")}`);
      }
      console.log(report.note);
    }
  } finally {
    await sql.close();
  }
}

import { isMainModule } from "./with-app-env.mjs";
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`[content-repair-preview] ${err?.message ?? err}`);
    process.exit(1);
  });
}
