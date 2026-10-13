import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { control } from './b03-control.mjs';
import { CONCURRENT_BODY } from './b03-fixtures.mjs';

// Two real application processes share the fresh native-PG concurrency DB.
// No direct business function doubles or custom application endpoints.
export async function nativeSchedule({ first, second, firstControl, secondControl, screenshots }) {
  const browser = await chromium.launch(), report = { checks: [], errors: [] };
  try {
    const pages = await Promise.all([first, second].map(async origin => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
      await page.goto(origin + '/inbox/qa-b03-conflict-1280', { waitUntil: 'domcontentloaded' });
      await page.getByTestId('item-body').waitFor(); return page;
    }));
    const [a, b] = pages;
    await a.getByTestId('article-read-button').click();
    let state, deadline = Date.now() + 5000;
    do { state = await control(firstControl, { op: 'state' }); if (!state.metrics.requests.length) await new Promise(resolve => setTimeout(resolve, 30)); }
    while (!state.metrics.requests.length && Date.now() < deadline);
    assert.equal(state.metrics.requests.length, 1);
    await b.getByTestId('article-read-button').click();
    await b.getByText('已有原文读取任务，请稍后重试', { exact: true }).first().waitFor({ timeout: 5000 });
    await a.getByTestId('article-candidate-text').waitFor({ timeout: 10000 });
    assert.equal((await control(secondControl, { op: 'state' })).metrics.requests.length, 0);
    report.checks.push('cross-process active initial-preview lease refuses sibling without another reader call');
    await b.reload({ waitUntil: 'domcontentloaded' });
    await b.getByTestId('article-candidate-text').waitFor();
    await b.getByTestId('article-read-button').click();
    await b.getByTestId('article-read-button').waitFor({ state: 'visible' });
    await b.waitForFunction(() => !document.querySelector('[data-testid="article-read-button"]')?.disabled);
    assert.equal((await control(secondControl, { op: 'state' })).metrics.requests.length, 0);
    report.checks.push('sibling cached preview uses real shared PG candidate without refetch');
    let fence = true;
    await b.route('**/*', async route => {
      if (fence && route.request().method() === 'POST' && new URL(route.request().url()).origin === second) {
        fence = false; await control(secondControl, { op: 'change-material', itemId: 'qa-b03-conflict-1280' });
      }
      return new URL(route.request().url()).origin === second ? route.continue() : route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    });
    await b.getByTestId('article-adopt-button').click();
    await b.getByText('内容已更新，请重新读取后采用', { exact: true }).first().waitFor({ timeout: 10000 });
    const final = await control(secondControl, { op: 'state' });
    assert.equal(final.rows.find(row => row.id === 'qa-b03-conflict-1280').body, CONCURRENT_BODY);
    report.checks.push('real second PG connection material trigger fences stale adopt POST; concurrent body preserved');
    assert.deepEqual(report.errors, []); report.ok = true;
    for (const [index, page] of pages.entries()) await page.screenshot({ path: join(screenshots, 'native-schedule-' + index + '.png'), fullPage: true });
  } catch (error) { report.error = error.message; throw error; }
  finally { await browser.close(); writeFileSync(join(screenshots, 'native-schedule.json'), JSON.stringify(report, null, 2)); }
}
