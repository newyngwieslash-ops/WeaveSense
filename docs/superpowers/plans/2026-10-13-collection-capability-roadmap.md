# 数据采集能力提升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提高现有信源的实际入库完整性、关键词来源覆盖和可用于研究的正文质量，再以独立验收的方式扩展视频字幕与新平台。

**Architecture:** 保留 `CollectorAdapter → NormalizedItem → scheduler → items`，复用现有 SQL、租约、任务账本、安全出口、OCR/ASR 和证据版本机制。工作拆成可单独发布的三个部分：采集完整性、按需正文补全、字幕及渠道验证。Agent-Reach 只作为渠道试验工具；Obscura 只在动态网页试点的收益被证明后接入。

**Tech Stack:** 现有 TypeScript、Node.js、TanStack Start、PostgreSQL/PGLite、fast-xml-parser、node:test、Playwright；正文试点使用 Jina Reader HTTP 接口；字幕试点使用独立 Python 环境中的 yt-dlp。

## A阶段历史快照（2026-10-13；不是当前执行状态）

以下只记录A-only阶段结束时的历史快照；后续用户已授权整份路线图，当前状态见0.1节。该阶段用户授权实施 A01—A05、隔离验证与独立本地提交；下方规划轮“本轮不实施”描述是历史约束。A01—A04 已实现并审查通过，A05 代码与离线验收通过。五个真实 Feed 的单次快照均被既有 publicFetch 拒绝（DNS 返回 198.18.0.0/15 非公网基准测试网段），未取得响应；24 小时观察仍待验收，未启动、未声称 live_passed。无生产发布；B/C/R01 发布任务尚未实施。详见 `docs/operations/collection-capability-acceptance.md`。

## Global Constraints

- 原规划轮只交付方案；后续用户已授权整份路线图实施与离线验证。真实付费调用、生产发布和未满足条件的实网/浏览器实验不由实施授权自动开启。
- 沿用 Ponytail full：“No new dependency if it can be avoided.”、“Fewest files possible.”。不新增通用采集框架、消息中间件、向量数据库或新的 Agent 框架。
- 根目录 `E:/AI-JIANSHI-20260825/WeaveSense`，命令默认从此目录执行；以下路径相对该根目录。实施时依据真实 Windows/Docker 环境，不把历史 `/workspace` 当作本机路径。
- 不重建已有数据库或登录系统；沿用本机服务边界，不扩展公网访问面。
- 外部抓取保留 `publicFetch` 的 URL/DNS/逐跳重定向/体积防护；新增服务不接受来自浏览器的任意内部地址、命令或 Cookie。
- 保留微信网关的主备策略、费用预算、outbox、来源元数据；网关故障不能绕过网关直接读取主源。
- 非平凡改动扩展现有 runnable check；不新增测试框架。不为了任务数量把配置、测试和业务拆成无法独立验收的提交。
- 所有连续运行时长和成功率都是拟议验收条件，不是本次已取得成绩。缺少账号、字幕、许可或付费额度的样本应记为未验证/不可用，不虚报成功。
- 所有迁移追加编号。当前最高 `0029_assistant_progress.sql`；本文唯一新增的核心迁移预定 `0030_collection_coverage.sql`，执行前若编号被占用，统一顺延代码、测试和文档引用。
- 不丢弃已有用户改动：当前 `src/routeTree.gen.ts` 已修改，`docker-compose.dev-hybrid.yml` 与 `docker-compose.override.yml` 是未跟踪文件。提交使用明确文件列表，不使用 `git add -A`。

---

## 0.1 执行状态（2026-10-13；代码与实网分别记录）

实现授权已覆盖整份路线图；沿用`codex/collection-capability`隔离工作树。A/B和C代码/条件评估已评审；R01统一离线/build/UI门禁通过；任务与整分支最终评审另由controller收尾。本轮没有部署，持续观察没有启动。原始条目含实网/发布条件时，离线通过不把整个复选框勾完。

- [x] A01–A04代码、定向检查与独立评审。
- [x] A05真实业务离线60条/重放和负载验证；五源快照失败证据保留。
- [ ] A05有效网络下真实24小时验收。
- [x] B01–B03有界读取、候选/CAS/恢复、nativePG/dev+built/移动端离线验证与评审。
- [x] B04固定20参考地址、未知结果账本、失败停止、portable public-template检查与评审。
- [ ] B04真实20篇正文/Feed分布/完整率及错误页误通过验收。
- [x] C01验证工具/固定工具版本和10合成字幕；C02默认关闭实现获用户例外授权。
- [ ] C01真实业务视频/人工自动字幕/时间轴验收。
- [x] C02协议/类型/私有存储/材料CAS/UI、Linux10/真实隔离、nativePG/privateMinIO/dev+built离线验证及worker修复评审。
- [ ] C02真实视频/节点重启/extractor目标主机完整性与启用门禁。
- [x] C03选择GitHub，三份停用清单与44合成调用、有限观察器和评审。
- [ ] C03真实72小时/新发布/参考IDs/实际费用；当前0小时。
- [x] C04条件评估经评审：waiting_for_verified_js_gap。
- [ ] C04条件成立后的20页同目标浏览器实验；当前未触发，不填not_needed。
- [x] R01稳定QA helper、Node常用入口与可选Python/Docker命令；portability RED后2/2 GREEN。
- [x] R01本轮完整npm545/gateway117/typecheck、lint0errors32warnings、一次nativePG完整npm build29ledger、正文/字幕devbuilt1280/390详情检查；原lint失败保留，真实20/50s仅引用既有证据。
- [ ] R01任务与整分支最终评审（controller负责，不能由门禁通过自动勾选）。
- [ ] 正式生产备份/发布/回滚镜像绑定与发布后72h观察。

最新证据与支持范围：[统一验收](../../operations/collection-capability-acceptance.md)、[当前状态](../../operations/loom-current-status.md)、[回退手册](../../operations/loom-release-runbook.md)。

## 1. 当前基线与旧计划关系

审阅日期：2026-10-13，当前 Git HEAD：`bec6212a`。这是本地代码基线，未核验生产容器中的代码。

旧计划 `docs/superpowers/plans/2026-10-02-collection-reliability-improvement.md` 保留作历史记录。本计划不重新执行其中“合并旧分支”的步骤：根 Compose 已标注 9 月 30 日合并，当前代码已有安全出口、B 站分页、关键词失败分类、完整长正文保存、材料版本和助手运行时。旧计划从 `0022` 开始的迁移编号也不能继续照抄。

旧计划中 Telegram 自恢复、媒体下载队列、自动备份等工作，仍应单独核查状态；它们不是此次正文补全的隐含前置，也不因本计划交付而自动完成。

| 本次证据 | 文件/符号 | 具体结论 |
|---|---|---|
| Feed 额外截断 | `src/lib/server/rss-parser.ts:parseFeedXml` | `items.slice(0, 24)` 丢弃当前响应中的后续条目 |
| 微信同类截断 | `workers/wechat-gateway/primary.mjs:fetchPrimary` | 同样有 `entries.slice(0, 24)`；必须一起修 |
| 来源分配不公平 | `src/lib/server/collectors/keyword.ts:collectKeyword` | 固定顺序拼接，再统一截取 40 条，后续来源可能完全消失 |
| 覆盖信息未闭环 | `collectors/types.ts`、`scheduler.ts` | 有 `CollectorCoverage`，B 站有使用；普通 Feed 没有声明窗口限制，job 未保存覆盖信息 |
| 原文补全缺口 | `rss.ts`、`rss-parser.ts`、`extract.ts` | 前者读取 Feed，后者做媒体 OCR/ASR；没有通用原文补全入口 |
| 视频资料缺口 | `collectors/index.ts:youtubeAdapter/biliAdapter` | Feed/简介/封面不等于字幕或音轨 |
| 现有合并能力 | `scheduler-atomic.ts:mergeExistingItem` | 能补充完整正文，保留已有 OCR/ASR 尾段；应扩展并复用 |
| 材料修订机制 | `migrations/0019_agent_material_revision.sql` | 正文变化会推进 `material_version`，不可绕过它制造过期证据 |
| MCP 边界 | `workers/agent/internal/agent/mcp.go` | 研究工具接入与定时采集是两条链；装工具不等于定时入库 |

## 2. 发布切分和完整任务清单

建议按三个子项目推进。每个子项目有独立交付物；C 的条件项不阻塞 A/B。

| ID | 优先级 | 子项目 / 任务 | 依赖 | 完成标准 |
|---|---|---|---|---|
| A01 | P0 | 执行基线、隔离测试与现有能力复核 | 无 | 记录源码/依赖/本轮改动边界 |
| A02 | P0 | RSS 与微信 Feed 去除 24 条截断、拒绝伪 Feed | A01 | 60 条输入完整返回；坏响应失败 |
| A03 | P0 | 关键词各来源公平合并 | A01 | 5 个成功来源均有机会进入 40 条结果 |
| A04 | P1 | 窗口覆盖、缺口与任务记录 | A02 | 不把有限 Feed 声称为历史全量；保留 B 站游标防线 |
| A05 | P1 | 完整性回归、真实小样本与 A 版交付 | A02—A04 | 重复采集不增重复；缺口可见 |
| B01 | P1 | 按需读取原文、严格响应校验 | A01 | 从已入库条目读取，返回候选正文，失败保留旧内容 |
| B02 | P1 | 候选正文保存与原子采用 | B01 | 幂等、版本冲突可见、OCR/ASR 保留 |
| B03 | P1 | 详情页正文状态与采用流程 | A04、B02 | 手机/桌面可用；无自动付费分析 |
| B04 | P1 | 正文真实验收、回滚和 B 版交付 | B03 | 代表样本有对照证据，关闭功能不影响采集 |
| C01 | P2 | YouTube 字幕可行性验证 | A05 | 明确人工字幕、自动字幕、无字幕和失败边界 |
| C02 | P2 | 单平台字幕读取与入库 | 用户允许默认关闭实现；真实启用仍需C01通过 | 用户按需提取；字幕进入同一材料和引用链 |
| C03 | P2 | 一个新渠道的 Agent-Reach/上游工具试点 | A05 | 有新增且有用的材料，明确固定信源与搜索差异 |
| C04 | 条件 | 动态网页 Playwright/Obscura 对照试验 | B04 且有 JS 页面缺口 | 同样本同限制比较，不凭项目宣传换引擎 |
| R01 | 发布门 | 每个子项目的文档、版本、持续观测 | 对应子项目 | 代码、镜像、验收范围一致；可回退 |

先交付 A，再交付 B。C01 可在 A 完成后独立进行。默认不同时开发 C02、C03、C04，不一次接全平台。

## 3. 文件职责与稳定接口

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/lib/server/rss-parser.ts`、`rss.test.ts` | 修改 | Feed 结构、上限和完整条目解析 |
| `workers/wechat-gateway/primary.mjs`、`gateway.test.mjs` | 修改 | 微信主源对应修复 |
| `src/lib/server/collectors/keyword.ts`、`keyword-contract.test.mjs` | 修改 | 公平合并，保留各来源 attempt |
| `src/lib/server/collectors/types.ts`、`index.ts` | 修改 | 窗口覆盖契约，所有 Feed 调用路径一致 |
| `src/lib/server/scheduler.ts`、`scheduler-atomic.ts` | 修改 | 覆盖信息入账、旧正文保护 |
| `migrations/0030_collection_coverage.sql` | 新增 | jobs 增量覆盖元数据，不修改旧迁移 |
| `src/lib/types.ts`、`src/lib/server/queries.ts` | 修改 | 覆盖信息与正文状态传给 UI |
| `src/lib/server/article-reader.ts`、`article-reader.test.ts` | 新增 | 唯一 Jina 读取实现、候选结构与限制 |
| `src/lib/server/article-enrichment.ts`、`article-enrichment.test.ts` | 新增 | 按条目读取、候选 CAS、采用与回退 |
| `src/lib/server/fns.ts` | 修改 | 服务端入口，仅收 item ID/候选摘要/版本 |
| `src/routes/inbox.$itemId.tsx`、`src/routes/jobs.tsx` | 修改 | 候选展示、操作状态、覆盖范围 |
| `scripts/readiness-ui.mjs` | 修改 | 在既有隔离 QA 中验证新操作 |
| `env.example`、`env-templates/app.env` | 修改 | 开关/白名单的无秘密示例 |
| `docs/operations/collection-capability-acceptance.md` | 新增 | 基线、测试证据、支持范围、回滚记录 |
| `workers/subtitle/` | C02 才创建 | 独立字幕节点，不修改 Telethon 工作职责 |

`CollectorMeta.provider` 当前是微信来源枚举，保持原义，不把 jina/yt-dlp 填进这个字段。正文使用标量 `extra.article_*`，字幕使用标量 `extra.transcript_*`，因为 `mapItem()` 的 `toScalarRecord()` 会剔除嵌套对象。库内证据仍引用同一个 item ID。

### 内容质量口径

- `body_complete === true`：上游有明确完整标记，或操作人核对并采用正文；不按长度猜完整。
- `article_state = candidate`：拿到候选，尚未替换原内容。
- `article_state = adopted`：采用候选，保留回退快照及版本。
- `article_state = error`：最近读取失败；已有 body 保留。
- 视频 `transcript_state = available` 只表示拿到了指定语言字幕，不能声明整段音视频语义全覆盖。
- 未知内容状态显示“完整性未核验”；纯摘要与视频简介不能显示“全文”。

## 4. A：采集完整性详细任务

### A01：固定本轮基线与测试边界

**Files:** 新建 `docs/operations/collection-capability-acceptance.md`；只读 `package.json`、锁文件、`scripts/readiness-offline.mjs`、`docker-compose.yml`。

**Interfaces:** 输入是当前 checkout；输出是基线 SHA、已存在改动清单、可运行检查命令。不能把旧状态文档当作当前在线事实。

- [x] 记录实际基线；命令如下，不读取任何秘密文件：

```powershell
git rev-parse HEAD
git status --short
node --version
Get-ChildItem migrations -Name
Get-ChildItem -Name package-lock.json,pnpm-lock.yaml,yarn.lock -ErrorAction SilentlyContinue
```

- [x] 核对本计划列出的源码符号仍存在；已有实现直接跑对应检查，不能重复写一套。需要 worktree 时在执行阶段按 using-git-worktrees 技能创建；不复制用户未提交文件。
- [x] 将验收报告写成以下结构，当前未运行项保留 `not_run`，后续逐项替换：

```json
{"scope":"collection-capability","baseline":"bec6212a","checks":[],"live_status":"not_run","release_status":"not_deployed"}
```

- [x] 在隔离环境跑现有定向检查：

```text
node --experimental-strip-types --test src/lib/server/rss.test.ts src/lib/server/cursor.test.ts src/lib/server/scheduler-atomic.test.ts
node --test src/lib/server/collectors/keyword-contract.test.mjs src/lib/server/collectors/pagination.test.mjs
node --test workers/wechat-gateway/gateway.test.mjs
```

- [x] 记录真实退出码；缺依赖按锁文件安装到执行工作区，不全局升级工具。独立提交：`docs: record collection capability baseline`。

### A02：修复两个 Feed 入口的截断与错误根节点

**Files:** 修改 `src/lib/server/rss-parser.ts`、`src/lib/server/rss.test.ts`、`workers/wechat-gateway/primary.mjs`、`workers/wechat-gateway/gateway.test.mjs`。

**Interfaces:** 保留 `parseFeedXml(xml, sourceId, platform): NormalizedItem[]` 和 `fetchPrimary(source, now, allowedFeedHosts)`。返回当前响应中所有合法条目；超过 1000 条显式失败，不静默裁剪。网络已有字节上限仍生效。

- [x] 在 `rss.test.ts` 加入以下失败检查：

```ts
it('keeps every entry in a bounded feed', () => {
  const entries = Array.from({ length: 60 }, (_, i) =>
    `<item><guid>entry-${i}</guid><link>https://example.com/${i}</link><title>${i}</title></item>`).join('');
  const items = parseFeedXml(`<rss><channel>${entries}</channel></rss>`, 's', 'rss');
  assert.equal(items.length, 60);
  assert.equal(items.at(-1)?.external_id, 'entry-59');
  assert.throws(() => parseFeedXml('<html><body>login</body></html>', 's', 'rss'), /invalid_feed/);
  assert.throws(() => parseFeedXml('<rss><channel>', 's', 'rss'), /invalid_feed/);
  assert.deepEqual(parseFeedXml('<rss><channel/></rss>', 's', 'rss'), []);
});
```

- [x] 执行 `node --experimental-strip-types --test src/lib/server/rss.test.ts`，确认现有实现失败在 24/60 或伪 Feed 断言，而不是模块加载。
- [x] 使用已安装的 `fast-xml-parser` 完成验证。将 import 改为 `{ XMLParser, XMLValidator }`；在 parse 前验证 XML，在选择根节点时拒绝未知根；将最终 `items.slice(0, 24).map` 改成 `items.map`。条目集合形成后加上界：

```ts
if (XMLValidator.validate(xml) !== true) throw new Error('invalid_feed_xml');
// 放在 rss/atom/rdf 三分支之后、条目 map 之前。
if (!['rss', 'feed', 'rdf:RDF'].some(root => Object.hasOwn(doc, root))) {
  throw new Error('invalid_feed_root');
}
if (items.length > 1000) throw new Error('feed_entry_limit');
```

- [x] 微信入口已有 XMLValidator，保留它；将截断循环替换为：

```js
if (entries.length > 1000) throw new Error('primary_feed_entry_limit');
for (const [index, entry] of entries.entries()) {
  try { items.push(normalizeEntry(entry, source, discoveredAt)); }
  catch (error) {
    invalid.push({ index, error: error instanceof Error ? error.message : 'invalid primary entry' });
  }
}
```

现有单条无效日志与“全部条目无效则失败”规则保留。在现有 gateway 测试的本地 HTTP server 中生成 60 个唯一公众号文章 URL，调用实际 `fetchPrimary`，断言数量及第 60 条 ID；1001 条必须失败。测试不走真实主源或付费兜底。

- [x] 重跑上述两个测试文件，再跑 `content-integrity.test.ts`；60 条完整、1001 条明确拒绝、长正文尾标仍在。提交：`fix: preserve all entries in bounded feeds`。

**边界：** 这只消除本系统的额外截断，不恢复上游根本没返回的历史条目；由 A04 如实标注。

### A03：在 40 条预算内公平合并关键词来源

**Files:** 修改 `src/lib/server/collectors/keyword.ts`、`src/lib/server/collectors/keyword-contract.test.mjs`。

**Interfaces:** 保持 `collectKeyword(phrase, platforms, io): Promise<KeywordBatch>`；添加同文件导出 `mergeKeywordResults(groups: NormalizedItem[][], limit = 40): NormalizedItem[]`。attempt.count 保留“来源返回数”，不是截取后数量。

- [x] 利用该测试文件已有 Vite SSR 加载方式同时获取新导出；构造五组各 24 条唯一 URL，断言总量 40、每组 8 条。另构造重复 URL，断言去重后继续补足配额。具体断言：

```js
const groups = Array.from({length: 5}, (_, g) => Array.from({length: 24}, (_, i) => ({
  external_id: `${g}-${i}`, url: `https://example.com/${g}/${i}`,
  extra: {origin: `group-${g}`},
})));
const merged = mergeKeywordResults(groups);
assert.equal(merged.length, 40);
for (let g = 0; g < 5; g++) {
  assert.equal(merged.filter(x => x.extra.origin === `group-${g}`).length, 8);
}
assert.equal(mergeKeywordResults([[groups[0][0]], [groups[0][0]]]).length, 1);
assert.equal(mergeKeywordResults(groups, 0).length, 0);
```

- [x] 运行 `node --test src/lib/server/collectors/keyword-contract.test.mjs`，确认失败后实现：

```ts
export function mergeKeywordResults(groups: NormalizedItem[][], limit = 40): NormalizedItem[] {
  const result: NormalizedItem[] = [];
  const seen = new Set<string>();
  const positions = groups.map(() => 0);
  const cap = Number.isSafeInteger(limit) ? Math.max(0, Math.min(40, limit)) : 40;
  while (result.length < cap) {
    let added = false;
    for (let g = 0; g < groups.length && result.length < cap; g++) {
      while (positions[g] < groups[g].length) {
        const item = groups[g][positions[g]++];
        const key = item.url || item.external_id;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return result;
}
```

- [x] 将 `collectKeyword` 的 settled 后合并整体替换成：

```ts
return {
  items: mergeKeywordResults(settled.map(({items}) => items)),
  attempts: settled.map(({attempt}) => attempt),
};
```

- [x] 通过真实 `collectKeyword` + 现有 routedTransport 补一个整链检查：新闻返回大量结果仍保留 B 站结果；所有失败/局部失败/本地范围不出网测试继续通过。提交：`fix: fairly merge keyword search sources`。

**不扩大范围：** 本项不增加搜索 API、不修改关键词平台含义，不实现跨轮搜索分页或跨文章模糊去重。

### A04：把有限窗口和断档风险写进账本

**Files:** 修改 `collectors/index.ts`、`collectors/types.ts`、`collectors/pagination.test.mjs`、`scheduler.ts`、`scheduler-atomic.ts`、`scheduler-atomic.test.ts`、`src/lib/types.ts`、`queries.ts`、`queries.test.ts`、`src/routes/jobs.tsx`；新增 `migrations/0030_collection_coverage.sql`。

**Interfaces:** 沿用 `CollectorCoverage`。窗口源始终 `complete:false, window_only:true`；note 固定为 `initial_window|window_overlap|window_gap|empty_window`。B 站分页现有 `complete` 语义不变。

- [x] 在 collector 现有 SSR 测试加四组：无旧 cursor、有重叠、无重叠、空 Feed。返回 items 正常，coverage 必须明确。使用 RSS、YouTube、Telegram Feed override、rsshub、微信网关和最终 RSS fallback 各验证一次，避免只修主路径。
- [x] 增加同文件函数，所有“有限 Feed/网页窗口”出口统一调用；不要给完整 Telethon 分页结果套上窗口标签：

```ts
function windowCoverage(items: NormalizedItem[], previous = '') {
  const note = !items.length ? 'empty_window' : !previous ? 'initial_window'
    : items.some(item => item.external_id === previous) ? 'window_overlap' : 'window_gap';
  return { complete: false, window_only: true, note };
}
```

- [x] 分开“发现水位”和“完整历史边界”：在现有 scheduler 中，窗口允许更新发现水位用于下次 overlap 检查，但不能声称全量；可分页采集器仍只有 complete 才推进。替换 `cursorSafe`：

```ts
const cursorSafe = coverage === undefined || coverage.window_only === true || coverage.complete;
```

`coverage` 保持可选：本任务给所有 Feed/网页窗口补上显式信息；Telethon 当前返回 items 数组、不返回覆盖证明，保留其已有推进逻辑，jobs 存 `{}`、显示“覆盖未知”。`undefined` 分支仅用于兼容原有增量行为，不解释为“历史完整”。新适配器必须显式给出 coverage。不要为了状态显示扩大本任务到 Telethon 协议重构，也不能把有上限的历史请求直接声明为全量。

- [x] 追加向后兼容列，并扩展 `finishSourceJob` 最后一个参数 `coverage?: CollectorCoverage`；SQL 写入参数化 JSON：

```sql
alter table jobs add column if not exists coverage jsonb not null default '{}'::jsonb;
```

所有成功调用传 collected.coverage，失败调用默认 `{}`。在 JobRow 增加 `coverage: {complete?:boolean;window_only?:boolean;note?:string}`，`mapJob` 显式检查字段类型；历史 `{}` 显示“覆盖未知”。UI 文案固定为“有限窗口”“窗口未衔接”“已到达上次边界”，不把 window_gap 直接声称为已证实漏文。

- [x] PGLite 中应用该迁移，调用真实 `finishSourceJob` 后读取 JSON；断言旧行兼容。测试 B 站 page_cap 时 cursor 不推进、RSS overlap 正常推进发现水位、window_gap 的 warning 落账。提交：`feat: record collection window coverage`。

**回补边界：** 上游没有历史接口时只记录无法回补；不不断重试同一页。B 站跨轮续页属于旧稳定性计划的独立任务，不在此次窗口状态改造中暗中实现。

### A05：验证 A 版并保留对照证据

**Files:** 扩展 `src/lib/server/scheduler.test.ts`、`scripts/collection-load-check.mjs`；更新验收报告。

**Interfaces:** 报告输入是明确可访问的参考 ID 集；输出包含 `returned_by_upstream/persisted/missing/duplicates/window_status`。

- [x] 在既有 scheduler 测试环境提供 60 条 Feed，调用实际采集/入库路径两次；按 external_id 对照，不能仅手动 insert 后声称采集通过：

```ts
assert.equal(first.items_new, 60);
assert.equal(second.items_new, 0);
assert.equal(storedIds.length, 60);
assert.deepEqual(expectedIds.filter(id => !storedIds.includes(id)), []);
```

这些变量分别来自 `runSourceJob()` 两次返回、SQL 查询及 fixture 的预期 ID。测试中通过现有 Vite/隔离数据库入口获取 scheduler，不另写业务副本。

- [x] 运行 A01 定向检查、网关完整测试、typecheck，再运行现有 collection-load-check，确认放宽条数未造成失控请求或内存增长。
- [ ] 真实观察待验收（单次五源快照均因非公网 DNS 地址被拒绝；24 小时观察未启动）：选 5 个无需登录的既有源，低频观察 24 小时：保存每轮实际响应的 ID 清单与入库 ID；统计相对于上游响应的漏项，另列上游窗口外不可观测范围。
- [ ] A 版实时验收待完成（代码/确定性样本/公平合并/离线回归已通过；真实 24 小时观察仍待验收）：A 版通过条件：确定性样本遗漏/重复为 0；各来源公平合并通过；无新未捕获错误；真实未完成观察保持“待验收”。提交：`test: verify bounded feed ingestion end to end`。

## 5. B：按需正文补全详细任务

### B01：接入唯一正文读取后端

**Files:** 新增 `src/lib/server/article-reader.ts`、`article-reader.test.ts`；按需要修改 `src/lib/server/outbound-policy.ts` 及已有测试以支持真正的总截止时间；修改 `env.example`、`env-templates/app.env`。

**Interfaces:** `readArticle(url: string, options: {allowedHosts: Set<string>; io?: FetchIo}): Promise<ArticleCandidate>`；测试 seam 不作为生产参数入口。

```ts
export type ArticleCandidate = {
  body: string;
  sourceUrl: string;
  title: string;
  provider: 'jina';
  fetchedAt: string;
  digest: string;
};
```

- [x] 写失败检查，覆盖：私网输入、带凭据 URL、未许可域名、带 query/hash 输入（首版保守拒绝，避免传递签名/访问令牌）、坏 JSON、空正文、超大正文、登录/挑战页。失败不能返回 body_complete:true。至少一次通过实际 reader 的 `publicFetch` seam，而不是只测试字符串函数。
- [x] 正文开关 `ARTICLE_READER_ENABLED=false`；`ARTICLE_READER_ALLOWED_HOSTS` 默认空；首版只允许 HTTPS、443 端口、精确 hostname，不接受通配符。默认仅供无需凭据的公开文章试点；微信继续由网关处理。输入来源为数据库中的 item.url，不接受浏览器传任意 URL。
- [x] 复用 `assertPublicUrl()` 与 `resolvePublicAddresses()` 检查原文，固定请求 `https://r.jina.ai/`，不让客户端指定代理地址。原文 hash/query 不能静默删除后读取另一份资源。reader 请求设置：

```ts
const response = await publicFetch(`https://r.jina.ai/${target.href}`, {
  headers: { Accept: 'application/json', 'x-retain-images': 'none' },
  timeoutMs: 20000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 0,
  resolver: options.io?.resolver,
  transport: options.io?.transport,
});
```

`target` 是已通过前述验证的 URL。官方 JSON 模式已核对，但字段形状以执行时的公开样本固化到测试；只接收 `data.content`、`data.url`、`data.title` 的已验证字段。响应来源 URL 必须再次通过相同 allowlist/公网验证；不把代理域名当作原文引用。托管服务自身下游导航不受本机 DNS pinning 控制，文档须明确这一信任边界；需要完全控制下游时转 C04 隔离自托管试点。

- [x] 使用 zod 校验响应，标准库生成摘要；不要使用会主动裁剪文本的 token-limit 参数，不生成 AI 正文：

```ts
const readerEnvelope = z.object({
  data: z.object({title: z.string().default(''), url: z.string().url(), content: z.string().min(1)}),
});
const value = readerEnvelope.parse(JSON.parse(response.text ?? '')).data;
const body = value.content.trim();
if (!body || Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) throw new Error('article_invalid_body');
const digest = createHash('sha256').update(value.url).update('\0').update(body).digest('hex');
```

z、createHash 在文件顶部分别从 `zod`、`node:crypto` 导入。挑战页只做保守拒绝，不能用“未命中几个词”作为全文证明；最终是否采用由 B03 展示内容后决定。

- [x] 先验证现有 transport 的 timeout 是否覆盖 DNS、重定向和慢速读体；当前 `publicFetch` 没有全程 signal 参数。为它增加可选 `signal?: AbortSignal`，默认组合内部 `AbortSignal.timeout(timeoutMs)`，传给 pinnedTransport 并在读体时取消底层流；不能只 Promise.race 放弃等待。慢速滴送测试必须在 20 秒总期限内结束，socket/reader 被释放。若该基础修复未通过，B 不能发布。
- [x] 执行 `node --experimental-strip-types --test src/lib/server/article-reader.test.ts src/lib/server/outbound-policy.test.ts src/lib/server/outbound-policy.integration.test.ts`，全通过后提交：`feat: read bounded public article candidates`。

### B02：保存候选、采用与回退，不覆盖并发内容

**Files:** 新增 `src/lib/server/article-enrichment.ts`、`article-enrichment.test.ts`；修改 `src/lib/server/scheduler-atomic.ts`、`scheduler-atomic.test.ts`、`src/lib/server/queries.ts`。

**Interfaces:** 导出 `previewArticle(itemId: string)`、`adoptArticle(itemId: string, digest: string, expectedVersion: number)`、`restoreArticle(itemId: string, expectedVersion: number)`。只在服务端读写候选正文；客户端不能提交正文、provider、sourceUrl 或 body_complete。

- [x] 在 PGLite 中加载 items 相关真实迁移和材料版本 trigger；调用真实业务函数验证：首次保存候选不改 body；重复读取不重复出网；采用一次推进版本，再次采用不附加第二份；版本冲突拒绝；OCR/ASR 保留；完整正文不被自动降级；失败旧正文不变。
- [x] 候选与审计使用扁平 extra 字段：

```ts
type ArticleExtra = {
  article_state: 'candidate' | 'adopted' | 'error' | 'restored';
  article_candidate?: string;
  article_digest?: string;
  article_source_url?: string;
  article_provider?: 'jina';
  article_fetched_at?: string;
  article_candidate_version?: number;
  article_previous_body?: string;
  article_previous_complete?: boolean;
  article_adopted_version?: number;
  article_error?: string;
};
```

候选最大 2 MiB；旧正文快照最多保留一份。已采用/恢复候选时清除 `article_candidate` 大字段，保留摘要、来源、时间。正文长度不是完整性依据。

- [x] `previewArticle` 流程：读取条目和 version → 检查平台 article、开关/白名单 → 若相同 URL/版本有 24 小时内候选直接返回 → 抓取 → CAS 保存候选。单进程全局一个 reader in-flight，超过直接 `article_busy`；同条目 DB 中用短租约进一步防重复。租约字段放 `extra.article_claim_token/article_claimed_at`，原子 UPDATE 领取、按 token 释放，不在 HTTP 期间持有事务。

```sql
update items set extra = extra || $3::jsonb
where id = $1 and material_version = $2
  and (extra->>'article_claim_token' is null
    or (extra->>'article_claimed_at')::timestamptz < now() - interval '60 seconds')
returning id;
```

所有 lease 字段仅本功能写入 ISO 时间，释放使用 `extra - 'article_claim_token' - 'article_claimed_at'` 并检查 token；异常与取消也释放。首版注释：`ponytail: one reader request per app process; use a shared admission limit before multi-replica enrichment.` 不声称此限制是每日费用硬上限；首版不配置付费 Key、不后台批量调用。

- [x] `adoptArticle` 使用现有 Sql.transaction（不能用连接池上散发 BEGIN/COMMIT）：锁定 item → 检查 digest、candidate_version、expectedVersion → 保留旧 body/complete 快照 → 调用 `mergeExistingItem` → 清理候选、释放锁。同一事务重新按 `itemMatchesPhrase` 计算新增正文命中的启用关键词，传给 merge，不让补全文字永远无法被检索/打标。

```ts
if (row.material_version !== expectedVersion) throw new Error('article_conflict');
if (extra.article_digest !== digest || extra.article_candidate_version !== expectedVersion) {
  throw new Error('article_candidate_stale');
}
if (extra.body_complete === true) throw new Error('article_already_complete');
await mergeExistingItem(tx, itemId, {
  ...normalizedItem,
  body: extra.article_candidate,
  extra: {...normalizedItem.extra, body_complete: true, article_state: 'adopted'},
}, matchedPhrases);
```

`normalizedItem` 从锁定 row 构建现有 merge 所需字段，`matchedPhrases` 来自同一事务读取的启用关键词。`tx` 使用现有事务回调提供的连接。查询后的 version 强制转为安全整数后比较，不拿 PG bigint 字符串与 number 直接比较。完整标记只在用户采用动作发生后写入。

- [x] 补充 `mergeExistingItem` 对文章元数据的保护：普通 Feed 更新不得清除/覆盖 `article_*` 审计与快照。源上报完整正文的逻辑维持；摘要不能覆盖采用后的完整 body。更新 `mapItem()`，返回校验后的 `material_version`，候选内容只能在条目详情中返回；列表不要携带大候选字段。
- [x] `restoreArticle` 仅在当前 version 等于 article_adopted_version 且 expectedVersion 一致时恢复快照；有新 OCR/ASR 或后续编辑时返回冲突，不能回滚掉它们。采用正文后，在同一事务内读取 trigger 生成的实际 material_version，写入 article_adopted_version，不在客户端估算加一。采用和恢复都将 pipeline_status 置 ingested，旧分析保持历史，不自动重跑付费模型。
- [x] 同一测试中验证材料版本 trigger 生效，已有 Agent 检查点失效机制被触发；详情旧分析标为“正文已更新，分析可能过期”。执行 `node --experimental-strip-types --test src/lib/server/article-enrichment.test.ts src/lib/server/scheduler-atomic.test.ts src/lib/server/agent-integrity.test.ts`。提交：`feat: adopt article candidates with version checks`。

### B03：详情页提供清楚的读取与采用流程

**Files:** 修改 `src/lib/server/fns.ts`、`src/routes/inbox.$itemId.tsx`、`scripts/readiness-ui.mjs`；沿用现有 Button、Badge、toast 和 TanStack Query。

**Interfaces:** 新增 `previewArticleFn({id})`、`adoptArticleFn({id,digest,material_version})`、`restoreArticleFn({id,material_version})`；响应固定 `{ok:boolean,error?:string}`，刷新后由 getItemFn 提供当前状态。

- [x] 使用 zod strict 验证入口，禁止混入任意 URL/正文；例如：

```ts
const articleAdoptInput = z.object({
  id: z.string().min(1).max(128),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  material_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const adoptArticleFn = createServerFn({method: 'POST'})
  .validator((input: unknown) => articleAdoptInput.parse(input))
  .handler(async ({data}) => adoptArticle(data.id, data.digest, data.material_version));
```

preview/restore 使用同一字段定义 pick 出对应字段；业务错误映射固定中文文案，不透传外部响应或 secret。

- [x] 按 design-ui 指引复用现有详情页样式。原文正文仍为主内容，候选单独区域：来源链接、读取时间、候选文本、“采用正文”按钮；采用后提供“恢复此前正文”。候选不得用 dangerouslySetInnerHTML 渲染。
- [x] mutation 使用与现有 extract 相同的 invalidateQueries 模式；只刷新 `item/inbox/overview`，不触发 analyze/extract。按未配置、读取中、候选就绪、失败、版本冲突、已采用分别显示状态。

```tsx
<Button variant="outline" disabled={preview.isPending || !item || !readerAvailable}
  onClick={() => preview.mutate()}>
  {preview.isPending ? '读取中…' : '读取原文'}
</Button>
```

`readerAvailable` 从服务端详情返回的开关/条目资格决定，不根据浏览器 env 猜测；所有 endpoint 仍重复校验。冲突文案为“内容已更新，请重新读取后采用”，不能覆盖新内容。

- [x] 在现有 readiness UI 用离线候选条目操作：读取、核对、采用、刷新、恢复、版本冲突；mock 只替换受控 reader 网络输入，数据库及服务端入口真实执行。检查候选脚本文本被显示为文本、按钮有可访问名称、390px 无溢出、错误无未捕获异常。
- [x] 同一场景验证开发与构建产物，截图写 `screenshots/`；提交：`feat: expose article enrichment in item details`。

### B04：正文实测与开关回退

**Files:** 更新 `docs/operations/collection-capability-acceptance.md`、`docs/使用指南.md`、`env-templates/README.md`；按实际需要更新 `scripts/service-env-least-privilege.test.mjs`。

**Interfaces:** 固定 20 个公开文章样本，每项记录原 Feed 内容、原文开头/末尾标记、候选结果、异常与采用状态。

- [ ] 选 2—3 个业务相关的公开站点，20 篇样本，含短文、长文、图文、正文缺失及正文已有条目。首版只把验证过的 hostname 加入 allowlist；带 query 的地址标为首版不支持，不能悄悄换 URL。
- [ ] 对比题目、来源域名、正文开头/末尾及 3 处中间事实；登录页/导航页/错误页不得作为可采用正文通过验收。指标分开记录请求成功率、候选可用率、经核验完整率，unknown 不进入完整分子。
- [ ] 通过条件：20 项均有明确结果；可访问且在声明范围内的样本候选可用率目标 ≥90%；错误页误通过为 0；失败旧正文保持不变；重复采用/并发冲突检查通过。达不到时缩小支持站点，不自动换重型浏览器扩大承诺。
- [x] 验证 `ARTICLE_READER_ENABLED=false` 后禁止新读取，原有采集、已采用 body 和回退仍可使用；已经完成的候选不删除。服务端配置和源码包不含 Key/Cookie。
- [ ] 以 R01 发布门交付 B 版。提交：`docs: publish verified article enrichment scope`。

## 6. C：视频字幕与渠道扩展任务

### C01：先验证字幕，不立即建设视频下载系统

**Files:** 执行时新建 `validation/collection/subtitle-samples.json`、`docs/operations/subtitle-pilot.md`；只安装在隔离工具环境，不改应用依赖。

**Interfaces:** 样本 `{url,language,expected_kind}`；报告 `{url,tool_version,kind,language,status,chars,duration_ms,error_code}`，kind 为 manual/automatic/none。

- [ ] 从已有 YouTube 内容选 10 条公开视频：覆盖人工字幕、自动字幕、无字幕和失效视频。记录版本与固定样本，不扫描频道全集。
- [ ] 针对每个视频列出字幕；调用参数数组，不拼 shell：

```python
subprocess.run([
    sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-playlist',
    '--skip-download', '--list-subs', '--socket-timeout', '10',
    '--retries', '0', '--', video_url,
], check=False, timeout=45, capture_output=True, text=True)
```

执行文件导入 Python 标准库 `subprocess`、`sys`；video_url 来自样本列表，经 YouTube hostname/video ID 检查。环境不继承浏览器 Cookie 或用户 yt-dlp 配置；stdout/stderr 先脱敏再写报告。

- [ ] 人工字幕优先，同语言没有人工字幕时才取自动字幕。下载限制为单条视频、单一已列出的 language、JSON3 字幕；使用 `--write-subs --write-auto-subs --sub-format json3 --sub-langs <已验证语言>`，保留 `--skip-download --no-playlist --ignore-config`。临时目录独立，45 秒硬截止。
- [ ] 核对文字与时间轴；没有字幕必须明确记录，不自动调用 ASR、不自动下载音轨。yt-dlp 所需 JS runtime/附加组件按本次版本检查并记录，不能假定单个包足够。
- [ ] 用户已明确允许C01实网未通过时实现/离线验证C02，feature/profile必须关闭；真实启用仍要求C01通过：公开且实际提供目标语言字幕的样本可读取；人工/自动来源准确；无字幕不会伪造文本。提交仅样本的公开 URL 与脱敏报告：`docs: verify youtube subtitle pilot`。

### C02：字幕作为独立可选节点接入

**Files:** 新建 `workers/subtitle/server.py`、`workers/subtitle/test_server.py`、`workers/subtitle/requirements.txt`、`workers/subtitle/Dockerfile`、`src/lib/server/subtitles.ts`、`subtitles.test.ts`；修改 `docker-compose.yml`、`env-templates/app.env`、`src/lib/server/fns.ts`、`src/routes/inbox.$itemId.tsx`、`article-enrichment.ts`。

**Interfaces:** 内部 `POST /v1/transcript` 只收 `{video_id, language}`；host 固定 YouTube，Bearer 独立凭据。返回 `{status:'ok'|'no_subtitles',video_id,language,kind:'manual'|'automatic'|'none',text}`；技术失败为非 2xx 稳定错误码。控制面 `readSubtitle(itemId)` 从 DB 解析 video ID。

- [x] 先写协议检查：缺 token 401、非法 ID 400、插件自定义参数不能输入、无字幕 no_subtitles、上游失败非成功、超时进程回收；单字幕超过 2 MiB 显式失败。test_server.py 使用 unittest 和假的 yt-dlp 子进程输出，不需要真实账号。
- [x] 将 C01 已固定且通过工具/合成验证的版本写入 requirements/镜像（C01真实视频字幕验收仍pending），独立 profile `subtitles` 默认不启用，不给 Telethon 镜像增加无关包。节点并发 1、单任务 45 秒、客户端期限 50 秒；请求 JSON 4 KiB、输出 2 MiB。生产节点以 asyncio 子进程流式累计 stdout/stderr，达到上限立即终止并回收，不能直接沿用 C01 的 capture_output 后置检查；临时卷固定 32 MiB，单文件 2 MiB，finally 清理，关闭匿名健康以外接口。
- [x] JSON3 文本解析首版保留事件顺序，只去掉完全相同的相邻段；不做会吞掉真实重复语句的全文 set 去重：

```python
def transcript_text(payload):
    chunks = []
    for event in payload.get('events', []):
        text = ''.join(s.get('utf8', '') for s in event.get('segs', [])).strip()
        if text and (not chunks or text != chunks[-1]):
            chunks.append(text)
    return '\n'.join(chunks)
```

解析前检查 events/list、segs/list、utf8/string 并限制元素总量 100000；坏结构返回 invalid_response。滚动字幕可能有重叠，保存原始 JSON3 在受限对象存储以便后续校正；首版不承诺逐字去重质量。通过 `MinIO/storage.ts` 的既有存储入口，不直接把本地临时文件路径暴露给产品。

- [x] 控制面收到结果后，以现有 material_version 做 CAS，在 body 末尾添加一个明确的 `[字幕: language; manual|automatic]` 区块；保存 `extra.transcript_language/kind/provider/digest/state`。重复 digest 不追加；不同字幕不自动覆盖已有字幕，先返回冲突/重新选择提示。更新共享正文合并逻辑，同时保留 OCR/ASR/字幕附加区块，添加混合正文回归；不得只改详情页。
- [ ] 节点出口只允许完成该固定 extractor 所需的公开目标，拒绝私网和任意 extractor 跳转；应用只收 video ID 不等于下游请求安全，容器网络出口隔离和 DNS 规则需与协议测试一起验收。功能开关关闭时不发外部请求，节点不可用返回 subtitle_unavailable，RSS 视频列表照常入库。
- [x] UI 在 YouTube 条目显示“读取字幕”，成功标注人工/自动及语言；无字幕显示“此视频未提供可用字幕”。不接入自动付费 ASR。定向检查：

```text
python -m unittest discover -s workers/subtitle -p test_server.py
node --experimental-strip-types --test src/lib/server/subtitles.test.ts src/lib/server/article-enrichment.test.ts
```

- [ ] 用 C01 的同一组视频验证重复提取、节点重启、无字幕、超时，按 R01 发布。提交：`feat: add optional youtube subtitle enrichment`。

### C03：新平台只做一个渠道试点

**Files:** 执行时新建 `docs/operations/channel-pilot.md`；若平台以 Feed 交付，复用现有 source 配置，不新增代码。只有通过试点后确需原生 adapter 时才修改 `collectors/index.ts`、`collectors/types.ts`、`platforms.ts` 和现有 collector 测试。

**Interfaces:** 固定信源必须归一化到 CollectorBatch；关键词搜索必须归一化到 KeywordBatch，并通过 A03 公平合并。两者的能力、配额和可回补范围分别记录。

- [x] 根据当前缺失的业务材料选一个平台。默认优先补已有信源的可用性；不因工具支持平台多就全部开启。平台/具体账号未确定前，本任务状态为 `waiting_for_target`，不阻塞 A/B/C01。
- [ ] 若需要 Agent-Reach，按用户已安装的 agent-reach 技能和官方安装说明，在隔离环境只检查目标 channel；不批量安装其全部上游组件、不修改全局 Agent 配置。报告记录 doctor 和真实读取结果，两者分开。
- [ ] 对 3 个固定信源或 5 个关键词验证：首次读取、重复读取、新条目、过期登录、限流、暂时失败。保存参考 ID 和原始公开 URL。不要把“登录态已存在”当作后台长期稳定的证据。
- [x] Feed 可满足则直接接现有 rsshubAdapter；原生 adapter 必须返回统一契约，覆盖与错误码不可省略：

```ts
return {
  items,
  meta: {provider: '', attempts: [adapterId], paid_call: false},
  coverage: {complete: false, window_only: true, note: 'initial_window'},
};
```

这里 items 是经过边界校验的 NormalizedItem[]，adapterId 是该单平台固定配置，非用户输入。如果工具收费，paid_call 按实际调用记录，不使用上述 false。来源元信息记录在 item.extra，不能冒充微信 provider。

- [ ] 连续 72 小时小规模运行；相对于可访问参考集，漏项/重复可解释，登录失效不无限重试，实际费用和运维成本有记录。未通过则保留试验报告，不引入生产依赖。提交：`docs: record single-channel collection evidence`，原生 adapter 另做通过检查后的独立提交。

### C04：Obscura 仅在动态网页需求成立时比较

**Files:** 条件成立时新建 `validation/collection/browser-samples.json`、`scripts/browser-collection-benchmark.mjs`、`docs/operations/browser-collection-decision.md`；不提前创建生产 browser-collector 服务。

**Interfaces:** 同一 20 个公开页面、同一提取目标；输出 `{engine,version,url,status,expected_marker_found,duration_ms,peak_rss_bytes,error_code}`。

- [ ] 只选 B 版实际缺失且需要 JS 的目标；页面账号需求、可访问范围和必须提取的标记先固定。如果普通 HTTP/Feed 已满足需求，记录 `not_needed` 并结束本项。
- [ ] 先用已有 Playwright + Chromium 跑单页 30 秒、并发 1的基线；每页新 context，finally 关闭。随后通过同一 CDP 提取脚本连接固定版本 Obscura；禁止只对 Obscura 更改页面/等待条件。

```js
const context = await browser.newContext();
try {
  const page = await context.newPage();
  await page.goto(sample.url, {waitUntil: 'domcontentloaded', timeout: 30000});
  const text = await page.locator(sample.selector).innerText({timeout: 10000});
  return {expected_marker_found: text.includes(sample.expected_marker)};
} finally {
  await context.close();
}
```

整个任务另设 30 秒总截止，不能让 goto 30 秒后再额外等待 10 秒。sample 来自固定文件；浏览器的导航、子资源、WebSocket、service worker 和下载都置于受控出口，不能仅校验起始 URL。

- [ ] 通过条件：关键页面正确性不低于 Chromium；无新增资源泄漏；峰值内存或处理耗时至少一项改善 ≥30%，才值得新增运维组件。20 页是试点评估，不能推导出“全平台兼容”。
- [ ] 比较失败保留 Chromium/原有流程，不安装 Obscura 进主应用。比较通过后再按该唯一目标制定 browser-collector 的具体 adapter 实现，复用 CollectorBatch 与现有调度。报告明确接入原因、版本、出口防护、关闭方式。提交：`docs: decide browser engine from target samples`。

## 7. R01：统一验证、发布与回退

**Files:** 更新 `docs/operations/collection-capability-acceptance.md`、`docs/operations/loom-current-status.md`、`docs/operations/loom-release-runbook.md`、`docs/使用指南.md`；修改实际有变更的 package 测试入口，把新测试纳入常用检查命令。

**Interfaces:** 每次发布绑定 SHA、镜像 ID、迁移版本、开关、测试报告路径、支持站点/平台、回滚镜像。不能把 A 通过写成 C 全部完成。

- [ ] 每个任务遵循：写行为检查 → 运行确认对应旧行为失败 → 实施 → 同一检查通过 → 明确文件列表提交。已存在正确实现直接复用并记录通过，不制造无意义失败。
- [ ] 所有本轮涉及的定向测试通过后，运行 `npm test`、`npm run gateway:test`、`npm run typecheck`、`npm run lint`；新增正文/字幕测试需纳入 package.json 或独立有文档的 npm script。
- [ ] `npm run build` 含 db:migrate，必须在新建隔离工作区/隔离数据库下运行。以下隔离配置只包含测试值，使用既有 offline wrapper；不要继承生产 DATABASE_URL：

```powershell
$env:LOOM_OFFLINE_OVERRIDES = '{"LOOM_RUNTIME_MODE":"development","LOOM_MODEL_CONFIG":"validation/collection/no-model-config.json","AUTO_ANALYZE":"false","EXTRACT_AUTO":"false","AGENT_WORKER_ENABLED":"false","AGENT_ASYNC_RESEARCH_ENABLED":"false","ARTICLE_READER_ENABLED":"false"}'
node scripts/readiness-offline.mjs -- node scripts/with-app-env.mjs vite build
```

上例是构建的无迁移预检查，不替代完整 npm build。完整 build 使用 `scripts/readiness-e2e.mjs` 既有隔离 PostgreSQL 和子进程启动方式；先核对其环境不继承真实凭据，再通过 npm 的实际入口执行 build。执行结束恢复该终端原来的 LOOM_OFFLINE_OVERRIDES。

- [ ] 开发与构建产物各跑浏览器检查；沿用现有启动脚本和隔离实例，不重启用户正在使用的服务。UI 检查必须实测新增详情操作，首页 smoke 不能代替。命令格式：

```text
node scripts/browser-smoke.mjs http://127.0.0.1:8080/ screenshots/collection-dev.png
node scripts/browser-smoke.mjs http://127.0.0.1:8081/ screenshots/collection-built.png --baseline screenshots/collection-dev.json
```

若上述端口由用户服务占用，使用隔离 QA 返回的地址替换；截图仍在 screenshots。人工查看开发版桌面和手机截图；产物无差异时以 JSON 对照为准，异常时再查看产物截图。

- [ ] 发布前备份 DB；A04 是追加列，旧代码可运行，不删列回退。B 关闭 reader 即停止新读取，已采用正文与快照保留；C 关闭 subtitles profile 即停字幕功能。任何回退不重置采集 cursor、不删除 items、不覆盖用户原始改动。
- [ ] 发布后观察 72 小时，记录源任务失败率、相对于实际响应的遗漏、重复率、窗口未衔接次数、候选可用率、超时、内存和正文冲突。微信费用继续由原有账本约束；第三方未知费用不得报 0。
- [ ] 验收报告区分 `implemented / offline_passed / live_passed / deployed`。72 小时未满就不勾选 live_passed；是否完成生产发布以实际授权与发布工具结果为准，本计划本身不启动部署。

## 8. 首版明确不做与升级条件

| 暂不做 | 原因 | 何时再加 |
|---|---|---|
| 全局安装 Agent-Reach 全家桶 | 安装不等于产品采集接入 | C03 的一个渠道明确需要它 |
| Obscura 默认替换浏览器 | 未有目标站点比较证据 | C04 达到正确性和收益门槛 |
| 后台自动全库正文补全 | 成本、误抓、限流与队列复杂度 | 按需流程有稳定样本且确有批量需求 |
| 无字幕自动付费 ASR | 当前缺少可靠音轨和预算验收 | 单独验证音轨获取、费用上限及文字质量 |
| 全网通用搜索 API | 当前先修已有来源分配 | 新关键词参考集显示现有搜索漏掉关键材料 |
| 历史全量采集承诺 | Feed 只能证明返回窗口 | 上游确有分页/归档 API 且断点续扫通过 |
| 新监控平台或消息队列 | 现有 jobs/SQL 足够支持首版 | 实测容量或告警需求超出现有能力 |

## 9. 依据与自检

官方依据核对日期：2026-10-13。只用于确认工具能力，不视为本项目实测成绩：

- [Agent-Reach](https://github.com/Panniantong/Agent-Reach)：渠道工具选型、配置、诊断；具体平台的上游调用需要单独接入。
- [Obscura](https://github.com/h4ckf0r0day/obscura)：独立浏览器引擎及 CDP 接入；兼容性按目标页面验证。
- [Jina Reader](https://github.com/jina-ai/reader)：JSON 响应、正文读取与请求头；不把 token 裁剪选项用于完整原文保存。
- [yt-dlp 字幕选项](https://github.com/yt-dlp/yt-dlp#subtitle-options)：人工/自动字幕和字幕格式；ASR 是另一个能力。

自检映射：采集条数 A02；关键词公平 A03；窗口与历史边界 A04；原文读取 B01；无损合并/版本/回退 B02；可操作界面 B03；真实质量 B04；字幕 C01/C02；新平台 C03；浏览器 C04；验证/发布/观测 R01。旧稳定性计划中的独立议题没有被伪装成已完成。

执行方式可选：按任务委派实施，或当前会话顺序实施。实施已完成至C04条件评估并R01统一门禁通过并等待最终整分支评审；A/B不依赖尚待实网验收的新平台。本轮实施/离线进度已在0.1节与各任务复选框更新；真实样本、条件实验、持续运行和部署门禁保持未勾选。不能把代码完成写成完整实网验收。
