import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const origin = process.argv[2] || 'http://127.0.0.1:8186';
assert.ok(!['8182', '8080'].includes(new URL(origin).port), 'Isolated fixture instance required');
const tag = process.argv[3] || 'dev';
const browser = await chromium.launch();
const results = [];
mkdirSync('screenshots', { recursive: true });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(origin + '/inbox/qa-long');
    const article = page.locator('article');
    await article.waitFor();
    assert.ok((await article.innerText()).length > 24000);
    const field = page.locator('dd').first();
    assert.equal((await field.innerText()).length, 2100);
    const measure = () => page.evaluate(() => ({
      viewport: innerWidth, width: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('article, aside, dd')].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.tagName),
    }));
    const top = await measure();
    assert.ok(top.width <= width);
    assert.deepEqual(top.overflowing, []);
    await page.screenshot({ path: `screenshots/long-${tag}-${width}-top.png` });
    await article.locator('div.whitespace-pre-wrap').evaluate(n => {
      const text = n.lastChild;
      const r = document.createRange();
      r.setStart(text, text.textContent.lastIndexOf('TAIL-973'));
      r.setEnd(text, text.textContent.length);
      window.scrollBy({ top: r.getBoundingClientRect().top - 350, behavior: 'instant' });
    });
    assert.ok(await article.locator('div.whitespace-pre-wrap').evaluate(n => {
      const r = document.createRange();
      r.setStart(n.lastChild, n.lastChild.textContent.lastIndexOf('TAIL-973'));
      r.setEnd(n.lastChild, n.lastChild.textContent.length);
      const rect = r.getBoundingClientRect();
      return rect.top >= 70 && rect.bottom <= 780;
    }), 'Tail marker must actually be on screen');
    await page.screenshot({ path: `screenshots/long-${tag}-${width}-tail.png` });
    assert.ok((await article.innerText()).includes('TAIL-973：返工率3%。'));
    await page.locator('dd').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `screenshots/long-${tag}-${width}-fields.png` });
    const bottom = await measure();
    assert.ok(bottom.width <= width);
    const last = await page.locator('dd').last().boundingBox();
    assert.ok(last && last.y >= 0 && last.y + last.height <= 780, 'Last field must be above mobile navigation');
    await page.goto(origin + '/inbox/qa-empty');
    await page.locator('article').waitFor();
    await page.goto(origin + '/inbox/qa-pending');
    await page.locator('span').filter({ hasText: /^pending$/ }).waitFor();
    assert.deepEqual(errors, []);
    results.push({ width, top, bottom, errors, emptyDetail: true, pendingVisible: true });
    await page.close();
  }
  writeFileSync(`screenshots/long-${tag}.json`, JSON.stringify(results, null, 2));
  console.log('PASS: long body, 2100-character external_id, tail, bottom navigation, empty and pending detail; no generation actions');
} finally { await browser.close(); }
