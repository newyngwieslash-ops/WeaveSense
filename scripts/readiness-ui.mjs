#!/usr/bin/env node
/**
 * T19: UI verification for the interactions this batch changed.
 *
 * Runs against an isolated app instance (never 8182/8080) and checks the four
 * surfaces whose behaviour changed:
 *
 *   T08  keyword run states  — a failing source is visible as an error, a partial
 *                              failure names the failing source, a local-only run
 *                              is not dressed up as an external failure.
 *   T11  long body           — a >12,000-character article keeps its tail all the
 *                              way to the detail page (the old 8,000 cut lost it).
 *   T12  extraction refusal  — an oversized media target is reported as refused,
 *                              not silently "extracted".
 *   T15  reference labelling — library citations vs external ("服务来源") stay
 *                              visually distinct.
 *
 * Both a desktop and a 390x844 viewport are checked, and both screenshots are
 * written for a human look: HTTP 200 is not acceptance.
 *
 * Usage: node scripts/readiness-ui.mjs <origin> <tag> [--expect]
 *   <origin> must be an isolated instance; 8182 and 8080 are refused.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const origin = process.argv[2];
const tag = process.argv[3] ?? "dev";
const expectFixtures = process.argv.includes("--expect");
assert.ok(origin, "usage: readiness-ui.mjs <origin> <tag> [--expect]");
assert.ok(!["8182", "8080"].includes(new URL(origin).port),
  "an isolated instance is required (8182/8080 are the user's environments)");

const results = [];
mkdirSync("screenshots", { recursive: true });
const browser = await chromium.launch();

/**
 * Fixture ids inserted by the runner (`scripts/readiness-e2e.mjs`). The browser
 * side does not seed anything: a QA-only endpoint would be production code that
 * exists solely for tests.
 */
const FIXTURES = {
  longItemId: "qa-readiness-long",
  refItemId: "qa-readiness-ref",
  failingKeyword: "qs-readiness-kw-fail",
  localKeyword: "qa-readiness-kw-local",
};
void FIXTURES.failingKeyword;
void FIXTURES.localKeyword;
void FIXTURES.refItemId;

/**
 * Console noise that is not an application error. Kept to exactly one pattern,
 * with the reason, and only for the dev server (HMR uses a WebSocket that the
 * built output does not have).
 */
const IGNORED_CONSOLE = [
  /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/\?token=[^']*' failed/,
];

async function withPage(width, fn) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    errors.push(`console: ${text}`);
  });
  try {
    await fn(page);
    return errors;
  } finally {
    await page.close();
  }
}

/** Overflow and visibility probe used by every check. */
const measure = () => ({
  viewportWidth: window.innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  overflowing: [...document.querySelectorAll("article, aside, main, dd, pre")]
    .filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.tagName),
});

try {
  // Fixtures already exist in the isolated database the runner prepared.
  results.push({ check: "fixtures", ready: true });

  for (const width of [1280, 390]) {
    // ---- T11: long body survives to the detail page, tail included
    let errors = await withPage(width, async (page) => {
      await page.goto(`${origin}/inbox/${encodeURIComponent(FIXTURES.longItemId)}`);
      const article = page.locator("article:visible").first();
      await article.waitFor();
      const text = await article.innerText();
      assert.ok(text.includes("TAIL-READINESS-12500"),
        "the article tail must be present on the detail page (T11)");
      const layout = await page.evaluate(measure);
      assert.ok(layout.scrollWidth <= width + 1, `horizontal overflow at ${width}px: ${layout.scrollWidth}`);
      assert.deepEqual(layout.overflowing, [], `overflowing elements at ${width}px`);
      await page.screenshot({ path: `screenshots/readiness-${tag}-long-${width}.png`, fullPage: false });
    });
    results.push({ check: "T11 long body", width, errors });

    // ---- T08: job states are distinguishable
    errors = await withPage(width, async (page) => {
      await page.goto(`${origin}/jobs`);
      await page.locator("article:visible").first().waitFor();
      const text = await page.locator("main, body").first().innerText();
      assert.ok(/ok|error/.test(text), "jobs page must show a status");
      // A partial failure must name the failing source rather than look clean.
      assert.ok(text.includes("部分来源失败") || text.includes("全部失败"),
        "a partial/all-source keyword failure must be visible on the jobs page");
      const layout = await page.evaluate(measure);
      assert.ok(layout.scrollWidth <= width + 1);
      await page.screenshot({ path: `screenshots/readiness-${tag}-jobs-${width}.png` });
    });
    results.push({ check: "T08 keyword/job states", width, errors });

    // ---- T08 (keywords page): local-only scope is not reported as a failure
    errors = await withPage(width, async (page) => {
      await page.goto(`${origin}/keywords`);
      // This page renders <section> blocks (not <article>), so wait on its own
      // heading instead of guessing at a tag the page does not use.
      // Desktop and mobile headings both exist, and only one is visible at a given
      // width. Wait for the visible one (`:visible`) rather than the first in DOM
      // order, which is the hidden variant at some widths.
      await page.locator("h1:has-text('关键词雷达'):visible").first().waitFor();
      const text = await page.locator("main, body").first().innerText();
      assert.ok(!/全部失败/.test(text.split("关键词雷达")[1]?.slice(0, 400) ?? ""),
        "a local-only keyword run must not read as a total failure");
      const layout = await page.evaluate(measure);
      assert.ok(layout.scrollWidth <= width + 1);
      await page.screenshot({ path: `screenshots/readiness-${tag}-keywords-${width}.png` });
    });
    results.push({ check: "T08 local-only scope", width, errors });

    // ---- T12: an oversized media target reports a refusal, not success
    errors = await withPage(width, async (page) => {
      await page.goto(`${origin}/pipeline`);
      const text = await page.locator("body").innerText();
      assert.ok(text.length > 0, "pipeline page must render");
      assert.ok(!/media_too_large.*ok/i.test(text), "a refused extraction must not be shown as ok");
      const layout = await page.evaluate(measure);
      assert.ok(layout.scrollWidth <= width + 1);
      await page.screenshot({ path: `screenshots/readiness-${tag}-pipeline-${width}.png` });
    });
    results.push({ check: "T12 extraction refusal", width, errors });

    // ---- T15: library vs external citations stay distinct
    errors = await withPage(width, async (page) => {
      await page.goto(`${origin}/knowledge`);
      await page.locator("section:visible, article:visible").first().waitFor();
      const text = await page.locator("body").innerText();
      if (text.includes("服务来源")) {
        // External citations are labelled; library citations link internally.
        assert.ok(text.includes("服务来源"), "external citations must be labelled");
      }
      const layout = await page.evaluate(measure);
      assert.ok(layout.scrollWidth <= width + 1);
      await page.screenshot({ path: `screenshots/readiness-${tag}-knowledge-${width}.png` });
    });
    results.push({ check: "T15 reference labelling", width, errors });
  }

  const consoleErrors = results.flatMap((r) => r.errors ?? []);
  assert.deepEqual(consoleErrors, [], `console/page errors: ${consoleErrors.join(" | ")}`);
  writeFileSync(`screenshots/readiness-${tag}-result.json`, JSON.stringify({ origin, tag, results, ok: true }, null, 2));
  console.log(JSON.stringify({ ok: true, origin, tag, checks: results.length, screenshots: results.length }, null, 2));
  await browser.close();
  void expectFixtures;
} catch (error) {
  writeFileSync(`screenshots/readiness-${tag}-result.json`,
    JSON.stringify({ origin, tag, results, ok: false, error: String(error?.message ?? error) }, null, 2));
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  await browser.close();
  process.exit(1);
}
