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
// Legacy single-config fixture: the UI must surface it as one profile.
writeFileSync(fixture, JSON.stringify({ baseURL: "http://127.0.0.1:8190/v1", model: "before", apiKey: key }));
const calls = [];
const gateway = createServer((req, res) => {
  calls.push(req.url);
  assert.equal(req.url, "/v1/models"); assert.equal(req.headers.authorization, `Bearer ${key}`);
  res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({data:[{id:"after"},{id:"before"}]}));
});
await new Promise(r => gateway.listen(8190, "127.0.0.1", r));
const browser = await chromium.launch({headless:true});
const errors = [];
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${origin}/model-settings`, { waitUntil: "domcontentloaded" });
  await page.getByText("模型档案").waitFor();
  // Legacy file renders as a single profile named 默认配置.
  await page.getByText("默认配置").waitFor();
  await page.getByText("http://127.0.0.1:8190/v1").waitFor();
  assert.equal(calls.length, 0);
  // Edit the existing profile: rename, change model, keep the stored key (empty input).
  await page.getByRole("button", {name:"编辑"}).click();
  await page.getByLabel("档案名称", {exact:true}).waitFor();
  await page.getByLabel("档案名称", {exact:true}).fill("网关A");
  await page.getByLabel("模型 ID", {exact:true}).fill("after");
  await page.getByLabel("API Key", {exact:true}).fill("");
  const [saved] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/model-settings") && r.request().method() === "POST"), page.getByRole("button", {name:"保存"}).click()]);
  assert.equal(saved.status(), 200, await saved.text());
  await page.getByText("档案已保存，后续同步请求使用新配置。").waitFor();
  await page.getByText("网关A").waitFor();
  await page.getByText("after").first().waitFor();
  assert.equal(JSON.parse(readFileSync(fixture, "utf8")).profiles[0].apiKey, key);
  assert.equal(JSON.parse(readFileSync(fixture, "utf8")).active, "default");
  assert.equal(calls.length, 0);
  // Create a second profile; it must not become active automatically.
  await page.getByRole("button", {name:"新增档案"}).click();
  await page.getByLabel("档案名称", {exact:true}).fill("网关B");
  await page.getByLabel("基础 URL", {exact:true}).fill("http://127.0.0.1:8190/v1");
  await page.getByLabel("模型 ID", {exact:true}).fill("before");
  await page.getByLabel("API Key", {exact:true}).fill(key);
  const [created] = await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/model-settings") && r.request().method() === "POST"), page.getByRole("button", {name:"保存"}).click()]);
  assert.equal(created.status(), 200, await created.text());
  await page.getByText("档案已新增。").waitFor();
  const doc = JSON.parse(readFileSync(fixture, "utf8"));
  assert.equal(doc.profiles.length, 2); assert.equal(doc.active, "default");
  const b = doc.profiles.find(p => p.name === "网关B");
  assert.equal(b.apiKey, key); // new profile with an explicit key stores it
  // Test connection on the active profile: hits the gateway /models once.
  await page.getByRole("button", {name:"测试连接"}).first().click();
  await page.getByText("接口认证成功，模型 ID 已找到。尚未测试生成。", {exact:true}).waitFor();
  assert.deepEqual(calls, ["/v1/models"]);
  assert(!(await page.content()).includes(key));
  const response = await page.request.get(`${origin}/api/model-settings`);
  assert.equal(response.status(),200); assert(!(await response.text()).includes(key));
  const csrf = await page.request.post(`${origin}/api/model-settings`, {headers:{origin:"http://evil.test"},data:{action:"test",id:"default"}});
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
