import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankRetrievedItems } from "../src/lib/server/agent-context.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(root, "validation/agent/retrieval-cases.json"), "utf8"));

function baselineSearch(query, corpus, limit = 8) {
  const needle = query.toLowerCase();
  return corpus
    .filter((row) => `${row.title} ${row.body} ${row.author}`.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((row) => row.id);
}

function metrics(cases, retrieve) {
  let hits = 0;
  let expected = 0;
  let falsePos = 0;
  const failures = [];
  for (const c of cases) {
    const got = retrieve(c.query);
    const want = new Set(c.expected_ids);
    expected += want.size;
    for (const id of want) if (got.includes(id)) hits += 1;
    if (c.none && got.length > 0) {
      falsePos += got.length;
      failures.push({ id: c.id, query: c.query, got, reason: "none_should_be_empty" });
    } else if (!c.none && !c.expected_ids.some((id) => got.includes(id))) {
      failures.push({ id: c.id, query: c.query, got, expected: c.expected_ids });
    }
  }
  return {
    recall_at_8: expected ? Number((hits / expected).toFixed(4)) : 0,
    hits,
    expected,
    false_positives_on_none: falsePos,
    failures,
  };
}

const baseline = metrics(fixture.cases, (q) => baselineSearch(q, fixture.corpus));
const improved = metrics(fixture.cases, (q) => rankRetrievedItems(q, fixture.corpus, 8).map((row) => row.id));
const out = {
  cases: fixture.cases.length,
  baseline,
  improved,
  delta_recall: Number((improved.recall_at_8 - baseline.recall_at_8).toFixed(4)),
  vector_db: "not_introduced",
};
writeFileSync(join(root, "validation/agent/retrieval-eval-2026-09-07.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (improved.recall_at_8 + 1e-9 < baseline.recall_at_8) process.exit(1);
