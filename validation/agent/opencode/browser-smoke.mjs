// Reuse the unchanged project smoke script with an explicitly installed browser.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const channel = process.env.PLAYWRIGHT_CHANNEL;
if (channel || process.env.LOOM_SMOKE_READY_TEXT) {
  if (channel) assert.ok(['msedge', 'chrome'].includes(channel));
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async options => {
    const browser = await launch({ ...options, ...(channel ? { channel } : {}) });
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async options => {
      const page = await newPage(options), goto = page.goto.bind(page);
      page.goto = async (...args) => {
        const response = await goto(...args);
        if (process.env.LOOM_SMOKE_READY_TEXT) await page.getByRole('heading', { name: process.env.LOOM_SMOKE_READY_TEXT, exact: true }).waitFor({ timeout: 20000 });
        return response;
      };
      return page;
    };
    return browser;
  };
}
process.argv = [process.execPath, resolve('scripts/browser-smoke.mjs'), ...process.argv.slice(2)];
await import('../../../scripts/browser-smoke.mjs');
