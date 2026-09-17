import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

// Offline only: the app must use this fixture path through LOOM_MODEL_CONFIG.
const origin = process.argv[2] || "http://127.0.0.1:8182";
assert(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const label = process.argv[3] || "dev";
assert(/^[a-z-]+$/.test(label));
const fixture = resolve("artifacts/model-settings-qa/model.local.json");
mkdirSync("artifacts/model-settings-qa", { recursive: true });
mkdirSync("screenshots", { recursive: true });
const key = "offline-model-settings-fixture";
writeFileSync(fixture, JSON.stringify({ baseURL: "http://127.0.0.1:8190/v1", model: "before", apiKey: key }));
const calls = [];
const gateway = createServer((req, res) => {
  calls.push(req.url);
  assert.equal(req.url, "/v1/models"); assert.equal(req.headers.authorization, `Bearer ${key}`);
  res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({data:[{id:"after"}]}));
});
await new Promise(r => gateway.listen(8190, "127.0.0.1", r));
const browser = await chromium.launch({headless:true});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${origin}/model-settings`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("模型 ID", {exact:true}).waitFor();
  assert.equal(await page.getByLabel("模型 ID", {exact:true}).inputValue(), "before");
  assert.equal(await page.getByLabel("基础 URL", {exact:true}).inputValue(), "http://127.0.0.1:8190/v1");
  await page.getByText("配置版本：").waitFor();
  assert.equal(calls.length, 0);
  await page.getByLabel("模型 ID", {exact:true}).fill("after");
  const [saved] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/model-settings") && r.request().method() === "POST"), page.getByRole("button", {name:"保存设置"}).click()]);
  assert.equal(saved.status(), 200, await saved.text());
  await page.reload({ waitUntil: "domcontentloaded" }); await page.getByLabel("模型 ID", {exact:true}).waitFor();
  assert.equal(await page.getByLabel("模型 ID", {exact:true}).inputValue(), "after");
  assert.equal(JSON.parse(readFileSync(fixture, "utf8")).apiKey, key); assert.equal(calls.length, 0);
  await page.getByRole("button", {name:"测试连接"}).click();
  await page.getByText("接口认证成功，模型 ID 已找到。尚未测试生成。", {exact:true}).waitFor();
  assert.deepEqual(calls, ["/v1/models"]);
  assert(!(await page.content()).includes(key));
  const response = await page.request.get(`${origin}/api/model-settings`);
  assert.equal(response.status(),200); assert(!(await response.text()).includes(key));
  const csrf = await page.request.post(`${origin}/api/model-settings`, {headers:{origin:"http://evil.test"},data:{action:"test"}});
  assert.equal(csrf.status(),403); assert.equal(calls.length,1);
  const leaked = await page.request.get(`${origin}/@fs/${fixture.replaceAll("\\", "/")}`);
  assert(!(await leaked.text()).includes(key));
  await page.screenshot({path:`screenshots/model-settings-${label}.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({path:`screenshots/model-settings-${label}-mobile.png`,fullPage:true});
  assert.deepEqual(errors, []);
  writeFileSync(`screenshots/model-settings-${label}.json`,JSON.stringify({ok:true,calls,errors,desktop:true,mobile:true,secretExposed:false},null,2));
  console.log(JSON.stringify({ok:true,calls,errors}));
} finally { await browser.close(); await new Promise(r => gateway.close(r)); }
