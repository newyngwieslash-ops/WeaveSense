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
 *   --article-only (or --article) --control-dir <isolated control path> runs B03 against
 *   the real seeded database/serverFns and controlled reader network only.
 *   <origin> must be an isolated instance; 8182 and 8080 are refused.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const origin = process.argv[2];
const tag = process.argv[3] ?? "dev";
const expectFixtures = process.argv.includes("--expect");
const skipArticleTimeout = process.argv.includes("--skip-timeouts");
const articleLayoutOnly = process.argv.includes("--article-layout-only");
const articleOnly = process.argv.includes("--article-only") || process.argv.includes("--article") || articleLayoutOnly;
const controlDir = process.argv[process.argv.indexOf("--control-dir") + 1];
if (articleOnly) assert.ok(process.argv.includes("--control-dir") && controlDir, "article QA requires isolated SQL control directory");
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
    if (!articleOnly && IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
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
  overflowing: [...document.querySelectorAll("article, aside, main, dd, pre, [data-testid=article-candidate], [data-testid=article-candidate-text]")]
    .filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.tagName),
});

async function checkArticles() {
  // Portable fixtures/control own isolated data and network; no app test endpoint.
  const fixtures = "../validation/collection/";
  const { control } = await import(new URL(fixtures + "b03-control.mjs", import.meta.url));
  const { ORIGINAL_BODY, CANDIDATE_BODY, CONCURRENT_BODY, SCRIPT_TEXT, LONG_TOKEN } = await import(new URL(fixtures + "b03-fixtures.mjs", import.meta.url));
  const state = () => control(controlDir, { op: "state" });
  const row = (snapshot, id) => snapshot.rows.find(item => item.id === id);
  for (const width of [1280, 390]) {
    const errors = await withPage(width, async page => {
      // Keep platform chrome script stub local; unexpected browser egress fails.
      await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(origin).origin) return route.continue();
        if (url.hostname === "fonts.googleapis.com" && url.pathname === "/css2") {
          return route.fulfill({ status: 200, contentType: "text/css", body: "" });
        }
        assert.equal(url.href, "https://grok.com/grok-app-builder/extensions.js", "unexpected browser external request");
        return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
      });
      const open = async kind => {
        const id = `qa-b03-${kind}-${width}`;
        await page.goto(`${origin}/inbox/${id}`, { waitUntil: "domcontentloaded" });
        await page.getByTestId("item-body").waitFor();
        return id;
      };
      const status = async text => {
        await page.getByTestId("article-status").filter({ hasText: text }).waitFor({ timeout: 30_000 });
      };
      const idle = async () => page.waitForFunction(() => !/读取中|采用中|恢复中/.test(document.querySelector('[data-testid="article-status"]')?.textContent ?? ""));
      const screenshot = async label => {
        const layout = await page.evaluate(measure);
        assert.ok(layout.scrollWidth <= width + 1, `article horizontal overflow at ${width}px: ${layout.scrollWidth}`);
        assert.deepEqual(layout.overflowing, []);
        for (const button of await page.locator('[data-testid^="article-"]:is(button)').all()) {
          const box = await button.boundingBox();
          assert.ok(box && box.height >= 44 && box.width >= 44, "article tap target must be at least 44px");
        }
        await page.screenshot({ path: `screenshots/readiness-${tag}-article-${label}-${width}.png`, fullPage: true });
      };
      const read = async (assertBusy = true) => {
        const button = page.getByRole("button", { name: "读取原文", exact: true });
        assert.equal(await button.isEnabled(), true);
        const response = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).origin === new URL(origin).origin);
        await button.click();
        if (assertBusy) {
          await page.getByRole("button", { name: "读取中…", exact: true }).waitFor();
          assert.equal(await page.getByTestId("article-read-button").isDisabled(), true);
        }
        await response;
      };
      const successId = await open("success");
      const before = await state();
      assert.ok(before.counts, "QA control must expose actual job/run/analysis counts");
      assert.equal(await page.getByTestId("item-body").innerText(), ORIGINAL_BODY);
      assert.equal(await page.getByTestId("analysis-stale").count(), 0, "unchanged run-material hash must remain current");
      await read();
      await page.getByTestId("article-candidate-text").waitFor();
      await idle();
      assert.equal(await page.getByTestId("article-candidate-text").innerText(), CANDIDATE_BODY);
      assert.ok(LONG_TOKEN?.length >= 2048 && CANDIDATE_BODY.includes(LONG_TOKEN), "candidate fixture must cover long unbroken text");
      assert.equal(await page.getByTestId("item-body").innerText(), ORIGINAL_BODY);
      assert.ok((await page.getByTestId("article-candidate").innerText()).includes("读取时间："));
      assert.ok((await page.getByTestId("article-candidate").innerText()).includes(SCRIPT_TEXT));
      assert.equal(await page.getByTestId("article-candidate").locator("script").count(), 0);
      assert.equal(await page.evaluate(() => globalThis.__B03_SCRIPT_EXECUTED__), undefined);
      assert.equal(await page.getByRole("link", { name: "候选来源：", exact: false }).getAttribute("href"), `https://article.qa.example/success/${width}`);
      await screenshot("candidate");
      if (articleLayoutOnly) {
        const region = await page.getByTestId("article-candidate-text").evaluate(node => ({
          overflowWrap: getComputedStyle(node).overflowWrap, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
          explicitWrap: node.classList.contains("[overflow-wrap:anywhere]"),
        }));
        assert.equal(region.overflowWrap, "anywhere");
        assert.ok(region.scrollWidth <= region.clientWidth + 1);
        assert.deepEqual((await state()).counts, before.counts);
        results.push({ check: "B03 long candidate region", width, region });
        return;
      }
      const previewed = await state();
      await page.reload();
      await page.getByTestId("article-candidate-text").waitFor();
      await read(false); await idle();
      assert.equal((await state()).metrics.requests.length, previewed.metrics.requests.length, "cached preview must not refetch");

      // Saved candidate adoption and restore remain usable after reader is off.
      await control(controlDir, { op: "reader-enabled", enabled: false });
      await page.reload(); await page.getByTestId("article-candidate-text").waitFor();
      assert.equal(await page.getByTestId("article-read-button").isDisabled(), true);
      await page.getByRole("button", { name: "采用正文", exact: true }).click();
      await page.getByRole("button", { name: "恢复此前正文", exact: true }).waitFor();
      await idle();
      assert.ok((await page.getByTestId("item-body").innerText()).includes(CANDIDATE_BODY));
      await page.getByTestId("analysis-stale").waitFor();
      const adopted = row(await state(), successId);
      assert.ok(Number(adopted.material_version) > Number(row(before, successId).material_version));
      assert.equal(adopted.pipeline_status, "ingested");
      assert.equal(adopted.extra.article_candidate, undefined);
      assert.equal(adopted.extra.body_complete, true);
      assert.ok((await page.locator("aside").last().innerText()).includes("B03 HISTORICAL-ANALYSIS"));
      assert.ok((await page.locator("body").innerText()).includes("B03 PRESERVED-OCR"));
      await page.reload(); await page.getByTestId("article-restore-button").waitFor();
      assert.ok((await page.getByTestId("item-body").innerText()).includes(CANDIDATE_BODY));
      await screenshot("adopted");
      await page.getByRole("button", { name: "恢复此前正文", exact: true }).click();
      await status("已恢复此前正文"); await idle();
      assert.equal(await page.getByTestId("item-body").innerText(), ORIGINAL_BODY);
      const restored = row(await state(), successId);
      assert.ok(Number(restored.material_version) > Number(adopted.material_version));
      assert.equal(restored.extra.body_complete, false);
      assert.equal(restored.extra.article_state, "restored");
      await screenshot("restored");
      await control(controlDir, { op: "reader-enabled", enabled: true });

      const conflictId = await open("conflict");
      await read(); await page.getByTestId("article-candidate-text").waitFor(); await idle();
      let fenced = false;
      const fence = async route => {
        if (!fenced && route.request().method() === "POST" && new URL(route.request().url()).origin === new URL(origin).origin) {
          fenced = true;
          await control(controlDir, { op: "change-material", itemId: conflictId });
        }
        await route.continue();
      };
      await page.route(`${origin}/**`, fence);
      await page.getByRole("button", { name: "采用正文", exact: true }).click();
      await status("内容已更新，请重新读取后采用"); await idle();
      assert.equal(fenced, true);
      assert.equal(row(await state(), conflictId).body, CONCURRENT_BODY);
      assert.equal(await page.getByTestId("item-body").innerText(), CONCURRENT_BODY);
      await page.unroute(`${origin}/**`, fence);
      await screenshot("conflict");

      for (const [kind, message] of [["blocked", "该来源尚未开放原文读取"], ["complete", "当前正文已完整"]]) {
        await open(kind); await status(message);
        assert.equal(await page.getByTestId("article-read-button").isDisabled(), true);
        assert.equal(await page.getByTestId("item-body").innerText(), ORIGINAL_BODY);
      }
      await open("malformed"); await read();
      await status("原文操作失败，请稍后重试"); await idle();
      assert.equal(await page.getByTestId("item-body").innerText(), ORIGINAL_BODY);
      await screenshot("failed");
      if (width === 1280 && !skipArticleTimeout) {
        await open("timeout"); const start = Date.now(); await read();
        await status("读取超时，请稍后重试"); await idle();
        assert.ok(Date.now() - start >= 19_000 && Date.now() - start < 30_000, "real 20s deadline must abort drip response");
        const network = (await state()).metrics;
        const slow = network.requests.find(request => request.path.includes("/timeout/"));
        assert.equal(slow.destroyed, true); assert.equal(slow.responseClosed, true);
        assert.equal(network.active, 0); assert.deepEqual(network.unexpected, []);
        assert.equal(await page.getByTestId("item-body").innerText(), ORIGINAL_BODY);
        await screenshot("timeout");
      }
      const final = await state();
      assert.deepEqual(final.metrics.unexpected, []);
      assert.deepEqual(final.counts, before.counts, "article actions must not launch analysis/extraction");
    });
    results.push({ check: articleLayoutOnly ? "B03 long token layout" : "B03 actual article read/cache/adopt/restore/conflict/refusal", width, errors });
  }
}

try {
  // Fixtures already exist in the isolated database the runner prepared.
  results.push({ check: "fixtures", ready: true });

  if (articleOnly) await checkArticles();
  else for (const width of [1280, 390]) {
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
  writeFileSync(`screenshots/readiness-${tag}-result.json`, JSON.stringify({ origin, tag, timeouts_skipped: articleOnly && skipArticleTimeout, timeout_evidence: articleOnly && skipArticleTimeout ? { source_sha: "c818665a1ebccb7c910e99e65fea755b023f7a51", report: "docs/operations/collection-capability-acceptance.md#b01b04-article-enrichment-scope-2026-10-13" } : null, results, ok: true }, null, 2));
  console.log(JSON.stringify({ ok: true, origin, tag, checks: results.length, screenshots: results.length }, null, 2));
  await browser.close();
  void expectFixtures;
} catch (error) {
  writeFileSync(`screenshots/readiness-${tag}-result.json`,
    JSON.stringify({ origin, tag, timeouts_skipped: articleOnly && skipArticleTimeout, timeout_evidence: articleOnly && skipArticleTimeout ? { source_sha: "c818665a1ebccb7c910e99e65fea755b023f7a51", report: "docs/operations/collection-capability-acceptance.md#b01b04-article-enrichment-scope-2026-10-13" } : null, results, ok: false, error: String(error?.message ?? error) }, null, 2));
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
  await browser.close();
  process.exit(1);
}
