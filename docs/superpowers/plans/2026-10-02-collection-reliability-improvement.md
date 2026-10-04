# 数据采集稳定性、健壮性与爬虫能力提升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在复用已有生产加固代码的基础上，让采集具备可证明的完整性、可恢复的失败处理、准确的健康状态，并按实际需求补齐正文与媒体获取能力。

**Architecture:** 保留现有 TypeScript 控制面、PostgreSQL/PGLite、Telethon 和微信网关。先对齐源码与部署版本，再在现有 HTTP、collector、scheduler、media 层补齐行为；继续使用数据库租约、唯一约束、已有 outbox 和阶段窗口，不新增消息中间件或通用爬虫框架。

**Tech Stack:** Node.js、TypeScript、TanStack Start、PostgreSQL/PGLite、fast-xml-parser、Python asyncio/aiohttp/Telethon、SQLite、MinIO；测试优先使用已有 node:test、PGLite、Python unittest。

## Global Constraints

- 用户本轮要求是评估与完整任务清单。本文件是计划，本轮不实施业务代码、不发布、不触发真实采集或付费调用。
- Ponytail full：先复用、再标准库、再已安装依赖；不因这份计划引入 Redis、Kafka、Celery、分布式爬虫平台或新的 Agent 框架。
- 每个非平凡改动留下一个能失败的行为检查；已有测试覆盖则扩展，不再建立重复测试体系。
- 当前实际工作区为 Windows：`E:/AI-JIANSHI-20260825/WeaveSense`。仓库内历史 Linux/旧盘符说明不代表当前运行环境。
- 业务源码与部署配置分别核对；不得整树覆盖、删除用户文件、重置游标或直接迁移生产数据库。
- 微信网关保持生产单副本；保留预算硬上限、付费调用保守预留、outbox 入库后 ACK、提取目标幂等与租约 fencing。
- 公共 URL 继续执行 SSRF、DNS 固定、逐跳重定向和体积限制；内部服务只使用运营配置的固定地址，不接受用户指定内部目标。
- 保持无登录的本机部署边界，不在本计划中扩大公网访问范围。配置、Cookie、账号会话和 API Key 不写进报告、日志、源码包。
- 所有新迁移在基线对齐后接续编号；以下预留 `0022` 起的文件名，若执行时已占用，先统一顺延再实施，不能修改已经部署的迁移。
- 真实成功率、账号限制和容量以新采集证据为准；历史记录不能作为今天的在线状态。可选扩展仅在对应需求成立时执行。

---

## 1. 结论与证据范围

**能提升，而且应先改善完整性和恢复能力，再扩大平台覆盖。** 当前不是从零建设：租约、去重、微信付费预算、对账 outbox、OCR/ASR 重试已经存在。另一条分支还有大量已完成的生产加固，首先应收回这些成果。

本次只读检查基线：

| 对象 | 本次确认 | 结论边界 |
|---|---|---|
| 当前源码 | `main`，`7151715`；初始工作区干净；迁移最高 `0020` | 下述“当前主线问题”确实存在于本地代码 |
| 本地远端跟踪引用 | `origin/comet/local-model-settings`，`0028a81`，2026-09-29 | 已通过 `git show` 阅读代码；未 fetch，不能保证是远端最新提交 |
| 部署描述 | 根 `docker-compose.yml` 引用 `loom-app:readiness-20260930-modelui` | 没有检查运行镜像内容，不能保证与任一 Git 引用完全一致 |
| 交付状态 | `docs/operations/loom-current-status.md` 指向历史工作树；本地 `git worktree list` 只有主线 | 文档、源码、镜像存在版本断层，必须先处理 |
| 真实事故记录 | 2026-09-30 信源故障修复文档 | 记录了配置覆盖、出口故障、Telethon 启动连接失败、微信上游风控、B 站限制；是历史事实，不是本次在线复测 |
| 测试环境 | Node v24.16.0；当前目录没有 `node_modules` | 本轮未安装依赖、未运行业务测试或真实链路；所有指标均为拟议验收标准 |

### 已有能力：复用，不重做

| 能力 | 当前主线 / 可复用分支证据 | 本计划处理 |
|---|---|---|
| 信源租约与 CAS 完成 | `src/lib/server/scheduler-atomic.ts` | 保留；把保护范围延伸到实际写入事务 |
| 数据库去重 | `items (source_id, external_id)` 冲突处理 | 保留；补齐跨 Telegram 模式的稳定 ID 和媒体唯一性 |
| 微信主备切换、预算、重试、outbox | `workers/wechat-gateway/{server,store,state-machine}.mjs`，`reconciliation-queue.ts` | 保留；补内容新鲜度、窗口完整性和故障演练 |
| OCR/ASR 目标幂等与最多三次尝试 | `extract-targets.ts`、迁移 `0007`—`0009` | 不重建；先解决上游没有真实媒体可供提取的问题 |
| 公共出口 SSRF、DNS pinning、流式限量 | 跟踪分支 `outbound-policy.ts`，文本 4 MiB、媒体 25 MiB | T01 复用；T03 补总期限、错误元数据和内部流量限量 |
| 增量分页、大整数比较 | 跟踪分支 `cursor.ts`、B 站分页、`workers/telethon/test_history.py` | T01 复用；T06 补跨轮续扫、初始范围及模式切换 |
| 全文保存、关键词失败分类、历史打标 | 跟踪分支 `rss-parser.ts`、`keyword.ts`、`scheduler-outcome.ts` | 不再当成全新能力；验证整条入库链实际生效 |
| 重阶段独立节奏、运维诊断、恢复工具 | 跟踪分支 `stage-windows.ts`、`operations-status.mjs`、恢复脚本 | 复用，增加持续证据，不另建运维系统 |

### 仍需提升的重点

1. **版本一致性。** 主线缺少上述已发布修复，直接从主线重建可能回退采集能力；分支也缺少主线更新的 Telegram 输入解析等改动，不能直接全量覆盖。
2. **Feed 完整性。** 两个已检查版本的 `rss-parser.ts` 都有 `items.slice(0, 24)`；微信 `primary.mjs` 也只处理前 24 条。大 Feed 会被本系统额外裁剪，且普通解析器遇到未知 XML 根节点会返回空数组，易误报成功。
3. **Telegram 自恢复。** 两个版本启动连接失败都会把 `client` 设为 `None`，没有重建客户端的后台路径；健康请求失败被折叠为未授权，控制面可能降级到浅层网页窗口。SDK 的自动重连无法修复一个已经丢弃的客户端实例。
4. **媒体链路不闭合。** 两个版本 `save_media()` 都返回空 URL；节点页的 URL 落盘无法凭空下载 Telegram 附件。`media.ts` 仅选择 `remote`，失败改为 `error` 后无自动重试；文章先提交、媒体入队失败时，下一轮命中旧文章后也不补入队。
5. **微信“假健康”。** 主源请求成功时间与文章更新时间混为健康信号；收到旧 Feed 不代表上游同步正常。9 月 30 日记录中就出现过接口恢复但文章仍停在月初。
6. **运行效率与可观测性。** 两个版本仍在每轮读取该信源全部历史文章；需按本批 ID 查询。需要把限流、配置错误、无新内容、有限窗口、积压、需要重新登录分开呈现。
7. **平台覆盖有明确上限。** 抖音/小红书/西瓜目前依赖外部 Feed；YouTube 关键词是新闻索引；B 站接口可受风控。提高重试次数不等于获得完整平台搜索或视频音轨。

### 官方依据

- Telethon 文档明确区分连接超时与请求等待超时，提供有限自动重连、`flood_sleep_threshold` 和按时间正序遍历能力；T05/T06 在现有 SDK 上实现，不另写协议客户端：[TelegramClient](https://docs.telethon.dev/en/stable/modules/client.html)。
- T03/T12 的 `Retry-After`、条件请求与 304 语义遵循 HTTP 规范：[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)。

## 2. 完整任务清单与执行顺序

“P0”指最先处理的数据正确性/恢复风险；“P1”是主要稳定性与效率；“P2”是有需求才开启的能力扩展。所有项当前均为计划状态。

| ID | 优先级 | 交付任务 | 前置 |
|---|---|---|---|
| T01 | P0 | 对齐主线、加固分支、实际部署的可复用基线 | 无 |
| T02 | P0 | 统一服务配置来源并增加采集前置诊断 | T01 |
| T03 | P0 | HTTP 总期限、流式限量、可分类错误与取消 | T01 |
| T04 | P0 | 去掉 Feed 静默截断，验证响应与条目结构 | T03 |
| T05 | P0 | Telethon 连接自恢复、健康状态和 FloodWait 冷却 | T02、T03 |
| T06 | P0 | 连续增量、分页续扫、稳定 ID 和显式回补 | T04、T05 |
| T07 | P1 | 持久退避、按源/上游限流与调度公平性 | T03、T06 |
| T08 | P0 | 入库、媒体入队、游标提交一致性与批量去重 | T06 |
| T09 | P1 | 媒体任务领取、重试、失败恢复与原始地址保留 | T03、T08 |
| T10 | P1 | Telegram 异步附件获取闭环 | T05、T09；要求 Telegram 媒体时执行 |
| T11 | P1 | 微信内容新鲜度、上游停滞与受控回补 | T04、T07 |
| T12 | P1 | RSS 条件请求，减少无变化 Feed 开销 | T03、T04、T08 |
| T13 | P1 | 接入校验、适配器能力声明和真实平台样本 | T02、T04、T07 |
| T14 | P2 | 指定站点的正文补全 | T03、T08、T13；摘要不足时执行 |
| T15 | P2 | 指定动态站点的浏览器采集试点 | T14；仅确有 JS 渲染需求时执行 |
| T16 | P1 | 采集指标、诊断页面与去重告警事件 | T07、T09、T11、T13 |
| T17 | P1 | 离线故障演练、真实连续运行与容量验收 | T01—T13、T16；含已启用可选项 |
| T18 | P1 | 自动备份、恢复演练、可回滚发布与文档闭环 | T17 |

先完成 T01—T09，即可交付明显更可靠的文本采集版本。T10/T11/T12/T13 各自可独立验收；T14/T15 不作为稳定性版本的发布前置。T17/T18 是承诺生产能力前的门槛。

## 3. 文件职责与共同约定

以下路径相对仓库根目录；标注“复用”的文件在已检查跟踪分支中存在，需经 T01 整合后使用。

| 文件 | 职责 |
|---|---|
| `src/lib/server/outbound-policy.ts`（复用）/ `http.ts` | 公共 HTTP 安全出口、总期限、状态与响应头 |
| `collectors/types.ts` / `collectors/index.ts` | 采集输入、输出、覆盖范围和平台适配 |
| `rss-parser.ts` / `rss.ts` | Feed 语义解析与网络条件请求 |
| `telethon.ts` / `workers/telethon/server.py` | 控制面到 Telegram 节点的契约与账号连接生命周期 |
| `cursor.ts`（复用）/ `scheduler.ts` / `scheduler-atomic.ts` | 增量游标、入库事务、租约和计划执行 |
| `stage-windows.ts`（复用）/ `cron.ts` / `api/cron/tick.ts` | 保持重阶段独立频率和总预算 |
| `media.ts` / `media-kind.ts`（复用）/ `storage.ts` | 媒体队列和对象存储；不让二进制下载阻塞文章发现 |
| `workers/wechat-gateway/{primary,server,store,state-machine}.mjs` | 微信主源、内容新鲜度、持久预算与对账 |
| `scripts/operations-status.mjs`（复用） | 只读指标和本地告警事件，禁止调用会触发采集的业务入口 |
| `scripts/collection-load-check.mjs`、`scripts/readiness-offline.mjs`（复用） | 负载与无真实凭据的验证入口 |

代码片段是本任务最小行为契约及关键实现，必须整合进现有调用链，不能作为未被调用的旁路代码。后文新函数在对应任务显式定义；既有测试里的 Vite SSR 加载和 PGLite SQL 包装继续复用。

每个实现任务按“补行为检查 → 运行确认失败 → 最小修改 → 同一检查通过 → 独立提交”执行。已复用实现使检查直接通过时，记录复用证据，不人为制造失败。测试命令默认经 T01 的隔离环境执行。每项提交只包含其 Files 列表中实际修改的文件，不使用 `git add -A`。

## 4. 逐任务实施说明

### T01：确定并整合唯一业务基线

**Files:** 修改 `docs/operations/loom-current-status.md`、`package.json`；新增 `docs/operations/2026-10-02-collection-baseline.md`。代码按下列复用清单逐项整合，部署 `docker-compose.yml` 单独保留。

**Interfaces:** 输入为主线 `7151715`、跟踪引用 `0028a81`、部署镜像标识；输出为固定的集成提交 SHA、迁移清单、测试入口和差异清单，不把镜像标签当成源码证明。

- [ ] 只读记录并比较，若已有运行容器，只读取镜像 ID/标签，不输出环境变量：

```powershell
git status --short
git log -1 --format='%H %cs %s' main
git log -1 --format='%H %cs %s' origin/comet/local-model-settings
git diff --stat main origin/comet/local-model-settings -- src workers scripts migrations package.json
git log --oneline --left-right main...origin/comet/local-model-settings
```

- [ ] 从现有分支复用：`outbound-policy.*`、`cursor.*`、`stage-windows.*`、迁移 `0021_stage_windows.sql`、运行数据库守卫、完整正文保存、关键词分类/全库打标、媒体类型修复、隔离验证与恢复脚本。逐个调用点合并；保留主线 `telegram-handle.ts` 及非法 JSON 处理等较新修复。
- [ ] 修正测试入口：本地分支 `package.json` 引用了 `scheduler-outcome.test.ts`，但本次 `git ls-tree` 没有列出它；核实并接入真实行为测试，不保留失效命令。把已有 `collectors/telegram.test.mjs`、Telegram handle 测试和 Python history 测试纳入相应测试命令。
- [ ] 使用跟踪分支已有 `readiness-offline.mjs` 的 `offlineEnv()` 隔离配置；依赖从锁文件安装。只针对隔离数据库运行迁移和构建。显式 overrides 固定 AUTO_ANALYZE/EXTRACT_AUTO/AGENT_WORKER_ENABLED/AGENT_ASYNC_RESEARCH_ENABLED 为 false，LOOM_RUNTIME_MODE 为 development，LOOM_MODEL_CONFIG 指向测试目录中明确不存在的文件，阻止模型配置自动发现；验证子进程没有真实服务凭据。
- [ ] 运行复用检查：

```text
node --test src/lib/server/collectors/pagination.test.mjs src/lib/server/collectors/telegram.test.mjs
node --experimental-strip-types --test src/lib/server/cursor.test.ts src/lib/server/stage-windows.test.ts src/lib/server/outbound-policy.test.ts
python -m unittest discover -s workers/telethon -p test_history.py
```

- [ ] **验收：** 上述全部成功；清单列明每个能力“代码存在/离线验证/实际镜像验证”三种证据；未核实运行镜像保持“未验证”。独立提交 `chore: reconcile collection implementation baseline`。

### T02：修复配置覆盖并建立接入诊断

**Files:** 修改 `docker-compose.yml`、`env-templates/README.md`、已有最小权限测试 `scripts/service-env-least-privilege.test.mjs`；新增 `scripts/collection-preflight.mjs`、`scripts/collection-preflight.test.mjs`。

**Interfaces:** 导出 `summarizePreflight(env: Record<string,string|undefined>): {code:string;ready:boolean}[]`，只输出存在性/错误码，不输出值。Telegram 必须区分配置缺失与会话连接失败。

- [ ] 增加回归检查：

```js
import assert from 'node:assert/strict';
import { summarizePreflight } from './collection-preflight.mjs';
const result = summarizePreflight({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'SECRET_TEST' });
assert.equal(result.find(x => x.code === 'telegram_credentials').ready, true);
assert.equal(JSON.stringify(result).includes('SECRET_TEST'), false);
```

- [ ] 运行 `node --test scripts/collection-preflight.test.mjs scripts/service-env-least-privilege.test.mjs`。
- [ ] 移除 Compose 中会用空插值覆盖 `env_file` 的重复凭据项，包含 Telegram、微信付费供应商及 xAI；每个值仅保留一个确定来源。保留服务独立 env 文件，不读取秘密进测试。检测数据库、Telegram、网关 allowlist、MinIO 和采集出口的依赖关系，缺失只禁用受影响能力。

```yaml
telethon:
  env_file:
    - F:/loom-backups/env/telethon.env
  environment:
    TELEGRAM_SESSION_PATH: /data/loom.session
    PORT: "8787"
```

- [ ] 使用虚构凭据的临时 Compose 配置确认“env_file 有值、宿主未设置”不会被清空；检查信息不能包含秘密。对实际出口的诊断只发少量无副作用请求，不自动修改宿主代理。
- [ ] **验收：** 重建不会因空插值丢失配置；错误能定位到具体服务/来源；同一检查通过。提交 `fix: preserve per-service collection configuration`。

### T03：统一网络期限、限量和错误元数据

**Files:** 修改 `outbound-policy.ts`、`http.ts`、`telethon.ts`、`collectors/index.ts` 及相关测试；复用 `readCapped()`，不创建第二套 HTTP 客户端。

**Interfaces:** 增加 `CollectionHttpError extends Error`，字段 `code:string`、`status?:number`、`retryAt?:number`；`publicFetch` 可接收 `signal?:AbortSignal`，返回补充 `status:number`、`headers:Record<string,string>`。原有 text/bytes/url/contentType 保持兼容。新增 `parseRetryAfter(value:string|null, nowMs:number):number|null`。

- [ ] 添加到已有出口测试：

```ts
assert.equal(parseRetryAfter('120', 1000), 121000);
assert.equal(parseRetryAfter('not-a-date', 1000), null);
assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:02:00 GMT', 1000), 120000);
```

  再使用本地缓慢响应服务验证：持续滴送数据不能绕过总期限；DNS 等待、重定向、读体共用一个截止时间；超大 chunked 响应取消读取。
- [ ] 运行 `node --experimental-strip-types --test src/lib/server/outbound-policy.test.ts src/lib/server/outbound-policy.integration.test.ts`，保留失败断言。
- [ ] 用总 signal 连接 transport 的现有 `signals.abortSignal`；每跳使用剩余预算，`finally` 清理计时器与 socket。错误保留稳定类别、HTTP status、Retry-After，禁止把包含令牌的完整 URL 放入错误。

```ts
const deadline = AbortSignal.timeout(timeoutMs);
const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
// 将 combined 传入 pinnedTransport 的 signals.abortSignal；读体也受同一 signal 约束。
```

  网络失败不在每一层自动重试，由 T07 调度统一处理。只读公共 GET 的瞬时重试至多一次，且必须计入同一预算；付费网关调用不通用重放。
- [ ] 微信内部 Feed 改为 `readCapped(response.body, 8 * 1024 * 1024)` 后解码，替换“先 response.text() 再检查字符数”；Telethon JSON 使用 4 MiB 上限和运行时形状校验。保留网关禁止重定向；公共抓取逐跳校验，并移除跨源敏感头。
- [ ] **验收：** 慢流、错误 DNS、重定向循环、超体积、429、503、用户取消都有明确终态，子请求不活过任务期限；原 SSRF 测试全通过。提交 `fix: bound collection requests end to end`。

### T04：消除 Feed 静默截断与伪成功

**Files:** 修改 `rss-parser.ts`、`rss.test.ts`、`collectors/types.ts`、`collectors/index.ts`、`workers/wechat-gateway/primary.mjs`、`gateway.test.mjs`。

**Interfaces:** 保留 `parseFeedXml(xml, sourceId, platform): NormalizedItem[]`。正常空 Feed 返回 `[]`；非 Feed、非法 XML、超上限抛稳定错误。`CollectorCoverage` 沿用 T01 的 `complete/window_only/note`，窗口源明确 `complete:false, window_only:true`。

- [ ] 增加行为检查：

```ts
const xml = '<rss><channel>' + Array.from({length: 100}, (_, i) =>
  `<item><guid>${i}</guid><title>article ${i}</title></item>`).join('') + '</channel></rss>';
assert.equal(parseFeedXml(xml, 's', 'rss').length, 100);
assert.throws(() => parseFeedXml('<html><body>verify</body></html>', 's', 'rss'));
assert.deepEqual(parseFeedXml('<rss><channel></channel></rss>', 's', 'rss'), []);
```

- [ ] 运行 `node --experimental-strip-types --test src/lib/server/rss.test.ts` 和 `npm run gateway:test`。
- [ ] 复用已安装 `XMLValidator`；先验证结构，再逐条解析，删除两处固定 24 条截断。网络体积上限外增加最多 1000 条的明确上限：超过抛 `feed_entry_limit`，不能只取前 1000 并报告完整成功。坏条目隔离计数；没有可用条目且有坏条目时判失败。

```ts
if (XMLValidator.validate(xml) !== true) throw new Error('feed_invalid_xml');
if (!rss && !atom && !rdf) throw new Error('feed_unknown_root');
if (items.length > 1000) throw new Error('feed_entry_limit');
```

  ID 保持稳定；guid 不等于可点击 URL，URN 只作为 ID；相对链接以响应最终 URL 为基准解析。音频 enclosure 标为 audio。正文不在解析/入库层二次截断；过大正文给出明确不完整状态。
- [ ] **验收：** 100 条输入保存 100 条；200 HTML 挑战页不会记作无新消息；正常空 Feed 不误报警；微信完整正文仍不被摘要覆盖。提交 `fix: preserve feed entries and reject invalid feeds`。

### T05：Telethon 自恢复与健康状态

**Files:** 修改 `workers/telethon/server.py`、`workers/telethon/test_history.py`、`src/lib/server/telethon.ts`、`collectors/index.ts`、`collectors/telegram.test.mjs`、`docker-compose.yml`。

**Interfaces:** `/health` 新增 `state: 'unconfigured'|'unauthorized'|'connecting'|'ready'|'cooldown'|'unavailable'`、`retry_after_seconds:number`；兼容保留现有字段。客户端不能把 unavailable 解释为 unauthorized。

- [ ] 复用 FakeClient 增加 Python 行为测试：首次连接抛 OSError，后续恢复；同一时刻多个请求只创建一个连接；取消后无遗留任务。给 JS 现有 Telegram 测试增加：

```js
// 使用该文件已有 loadCollector、source 和 fetch double。
globalThis.fetch = async (input) => {
  urls.push(String(input));
  return new Response('{}', {status: 503});
};
await assert.rejects(() => collectSource(source), /unavailable/);
assert.equal(urls.some(url => url.includes('t.me/s')), false);
```

  `urls` 仍由测试的 fetch double 收集，每个测试恢复全局 fetch；不能以空数组掩盖未记录请求。
- [ ] 运行 `python -m unittest discover -s workers/telethon -p test_history.py` 与 `node --test src/lib/server/collectors/telegram.test.mjs`。
- [ ] 在现有生命周期中保留一个后台 reconnect task 和一个锁；连接失败以 5/15/60/300 秒加抖动重试，成功清零，未授权等待人工账号操作。退出时取消并 await task、disconnect，不能在健康检查内发验证码。

```python
async with connection_lock:
    await asyncio.wait_for(candidate.connect(), timeout=10)
    authorized = await asyncio.wait_for(candidate.is_user_authorized(), timeout=5)
```

  使用 SDK 自带有限重试；显式配置 `flood_sleep_threshold=0`，由应用统一冷却。在进入 semaphore 后再次检查 FloodWait，避免排队请求继续轰击；`history` 包括排队在内设置 50 秒 deadline，低于控制面 60 秒。
- [ ] 公共频道读取不自动执行 `JoinChannelRequest`；需要成员资格时报告该要求。只有明确无账号配置/明确未授权且允许网页模式时回退网页，节点不可达不自动回退。
- [ ] **验收：** 模拟断网恢复不用重启容器；429 带冷却时长；无自动登录/加群副作用；原 authorized failure 不回退测试通过。提交 `fix: recover Telegram worker connections safely`。

### T06：连续增量、可续扫与稳定消息身份

**Files:** 修改 `cursor.ts`、`scheduler.ts`、`telethon.ts`、`telegram.ts`、`collectors/{types,index}.ts`、Python history 测试、`collectors/pagination.test.mjs`；新增迁移 `0022_collection_progress.sql` 和 `src/lib/server/collection-progress.test.ts`。

**Interfaces:** `SourceRecord` 增加 `scan_state?: {bootstrap:'latest'|'backfill'; page?:number; boundary?:string}`；`CollectorBatch` 增加 `next_scan_state?:SourceRecord['scan_state']`、`has_more?:boolean`、`next_cursor?:string`。每页完成持久化后才提交这三项；`has_more` 不等于失败。

- [ ] 测试至少 250 条新增内容、80 条页大小，跨轮与中断重放；沿用数字字符串比较，不转 Number：

```ts
assert.equal(compareNumericIds('9007199254740993', '9007199254740992'), 1);
// 在已有分页测试的 fake upstream 中，页 2 失败并恢复后：
assert.deepEqual([...new Set(savedIds)].sort((a,b) => Number(a)-Number(b)),
  Array.from({length:250}, (_,i) => String(i+101)));
```

  此排序仅测试小 ID 101—350；实际代码必须使用 compareNumericIds。fake upstream 与 savedIds 在同一用例内定义并驱动真实 collector/scheduler。
- [ ] 运行上述分页测试与 Python history 测试，确认页上限场景能复现停滞或漏项。
- [ ] Telegram 复用 `reverse=True` 从旧游标向前采集；首次添加默认“最新 80 条”，显式 backfill 才从指定时间/ID 开始，避免新频道从最早历史扫起。返回 `has_more`，最多在一次任务预算内处理有限页，剩余通过持久 scan_state 下轮继续。删除消息产生的 ID 空洞不判为丢失。
- [ ] B 站沿用已有分页，达到页上限保存 `page/boundary`，下轮继续而不是重复第一页；页码可能随新内容漂移，页间保留重叠并按 ID 去重。RSS/网页明确只覆盖当前窗口，不能宣称完整历史回补。
- [ ] 网页 `channel/123` 和 Telethon `123` 对同一 source 统一为消息 ID `123`。旧数据迁移先生成冲突报告，合并时重绑 media_objects、extract_jobs 和所有引用该 item 的业务记录，不能直接删重复项。异常 ID 不用“删除非数字字符”方式猜测。
- [ ] **验收：** 页 2 中断重放无漏项/重复；模式切换不新增同一消息；有限窗口显示覆盖限制；回补可暂停续跑。提交 `fix: make collection progress resumable`。

### T07：持久退避与公平调度

**Files:** 修改 `scheduler-atomic.ts`、`scheduler.ts`、`cron.ts`、`collectors/types.ts`、`stage-windows.ts` 相关调用；新增迁移 `0023_collection_retry.sql`；扩展 `scheduler-atomic.test.ts`、`cron.test.ts`。

**Interfaces:** sources/keywords 增加 `next_attempt_at`、`consecutive_failures`、`last_success_at`、`last_error_code`。错误携带 `retryAt`；claim 增加显式 `manual:boolean=false`，手动执行也不能绕过上游冷却。

- [ ] SQL 行为检查使用现有 PGLite 包装：

```ts
await sql.query("update sources set next_attempt_at=now()+interval '5 minutes' where id=$1", ['s']);
assert.equal(await claimSource(sql, 's', 'new-token'), null);
```

  增加 429、永久配置错误、成功清零以及新旧 worker 并发检查。
- [ ] 运行 `node --experimental-strip-types --test src/lib/server/scheduler-atomic.test.ts src/lib/server/cron.test.ts`。
- [ ] 瞬时网络失败按 1/5/15/60 分钟加不超过 20% 抖动，最高 6 小时；429/FloodWait 至少等待上游指定时长，不能用本地上限缩短服务器长冷却。401/403/配置错误不密集重试，显示可操作原因；修正配置后可以清零。

```sql
and (next_attempt_at is null or next_attempt_at <= now())
```

  此条件加入“挑选到期任务”及“原子 claim”两处。账号级 FloodWait 由 Telegram worker 管理；普通 HTTP 同 host 默认最多 2 并发，总并发不高于现有 9。单副本限制写明；跨实例限流仅在真正扩容时实现。
- [ ] 复用 stage_windows，采集唤醒继续与付费/提取频率分离。按 overdue 时间选择，失败源冷却不占运行槽，关键词和回补各保留有界份额；不要仅增大并发。
- [ ] **验收：** 重启后退避仍生效；失效源不会挤占所有名额；20 次一分钟 tick 不增加付费阶段频率；所有入口一致执行限流。提交 `feat: persist collection retry schedules`。

### T08：入库与游标的事务一致性

**Files:** 修改 `scheduler.ts`、`scheduler-atomic.ts`、`media.ts`、相关测试；复用 `db.ts` 的 `Sql.transaction()`；新增迁移 `0024_media_identity.sql`。

**Interfaces:** `enqueueItemMedia(itemId,urls,mediaType,sql?:Queryable)` 接受事务上下文；新增 `persistCollectedBatch(sql:Sql,source:SourceRecord,claimToken:string,batch:CollectorBatch):Promise<{items_new:number}>`，由现有源任务调用。网络请求不放在 SQL 事务内。

- [ ] 使用 PGLite 在媒体入队处注入失败，验证文章、媒体、游标都未提交：

```ts
await assert.rejects(() => persistCollectedBatch(sql, source, token, collected), /injected/);
assert.equal((await sql.query<{n:number}>('select count(*)::int n from items'))[0].n, 0);
assert.equal((await sql.query<{last_external_id:string}>('select last_external_id from sources'))[0].last_external_id, '100');
```

  测试中用事务 SQL double 仅对 media insert 抛 `Error('injected')`，其余转发给真实隔离库；再测试失效 token 完全无写入。
- [ ] 运行 `node --experimental-strip-types --test src/lib/server/scheduler.test.ts src/lib/server/scheduler-atomic.test.ts`。
- [ ] 每批用一个短事务：先 `SELECT ... FOR UPDATE` 锁 source 并核对 claim_token → upsert items → 幂等入队媒体 → 提交进度和 job 终态。旧 worker 不能在租约失效后继续更新内容。取历史去重记录改为本批 external_id 集合；微信 URL 查找按规范化键做索引，不能每批拉全信源历史。

```sql
select id, external_id, url, extra from items
where source_id=$1 and external_id=any($2::text[]);
```

  `media_objects` 去除已确认重复后增加 `(item_id,source_url)` 唯一约束；保留存储成功行及引用，冲突使用 `ON CONFLICT DO NOTHING`。新旧文章都确保媒体入队，修复历史“文章存在但媒体队列缺失”。跨来源不同文章不按相似标题合并。
- [ ] **验收：** 崩溃点重放无孤儿/漏媒体/游标越过未提交内容；10 万历史记录、80 条新批次不全表拉回应用；PG 与 PGLite 都验证。提交 `fix: commit collected items and progress atomically`。

### T09：媒体队列可靠恢复

**Files:** 修改 `media.ts`、`nodes.ts`、`storage.ts`；新增迁移 `0025_media_retry.sql`、`src/lib/server/media.test.ts`。

**Interfaces:** media_objects 增加 `attempts`、`next_attempt_at`、`claim_token`、`claimed_at`；状态使用 `remote/running/stored/error/dead`。新增 `claimMedia(sql,token,now):Promise<MediaRow|null>`，其中 MediaRow 为既有列加上述字段；完成更新必须匹配 token。

- [ ] 添加同一任务双领取、过期回收、上传成功但 DB 更新失败的检查：

```ts
const claims = await Promise.all([claimMedia(sql,'a',now), claimMedia(sql,'b',now)]);
assert.equal(claims.filter(Boolean).length, 1);
```

- [ ] 运行 `node --experimental-strip-types --test src/lib/server/media.test.ts`。
- [ ] 复用现有原子 claim 模式，瞬时失败 1/5/15 分钟最多三次，超体积/禁止地址/确定不存在进入 dead 并可人工重放。稳定对象键用 media row ID，重试覆盖同一对象，不新增对象副本。源地址保留在 source_url，公共展示地址不充当永久身份。

```sql
update media_objects set status='stored', claim_token='', claimed_at=null, error=''
where id=$1 and claim_token=$2 and status='running' returning id;
```

  同事务更新文章展示 URL，避免两个媒体任务互相覆盖数组；上传成功后数据库失败可重放。维持 25 MiB 上限；按响应 MIME 区分封面与音视频，不把封面送 ASR。对象下载网络与可信 MinIO 读取走不同已知边界。
- [ ] **验收：** 临时 503 能自行恢复，永久错误不无限尝试；历史 error 可受控重新入队；节点页与 cron 不重复领取。提交 `fix: recover failed media ingestion`。

### T10：Telegram 附件的异步获取（媒体范围内执行）

**Files:** 修改 `workers/telethon/server.py`、`test_history.py`、`telethon.ts`、`media.ts`、`collectors/types.ts`；扩展 T09 媒体测试；更新 `workers/telethon/README.md`。

**Interfaces:** 消息 extra 新增 `telegram_media:{channel:string,message_id:string,kind:string,size:number|null}`；内部 `POST /v1/media` 只接受 channel/message_id，返回 `{object_key,content_type,bytes,sha256}`；使用独立服务 Bearer token。复用现有媒体队列，逻辑 source_url 采用 `telegram://channel/message_id`，永远不交给公共 HTTP fetch。

- [ ] 在 Python FakeMessage/FakeClient 中增加附件，用断言证明 history 不下载、后续任务才下载：

```python
self.assertEqual(download_calls, 0)  # history 返回之后
self.assertEqual(result['items'][0]['extra']['telegram_media']['message_id'], '101')
```

  在测试内定义 download_calls 并由 fake download 方法递增；实际调用 history 后检查，不只验证静态字典。
- [ ] 运行 Python history 测试和 `media.test.ts`。
- [ ] history 保留消息类型、稳定媒体定位符和大小，不内联二进制；新增媒体端点按固定 channel/message_id 获取，使用已安装 Telethon 下载和 MinIO SDK，流式写临时文件并在 finally 删除，超 25 MiB 返回 `media_too_large`。媒体槽独立限制为 1，不能堵住历史采集；上传采用稳定键并校验大小/hash。

```python
async with media_gate:
    async with asyncio.timeout(120):
        # 用 Telethon iter_download 分块累计字节，超过上限立即停止。
        # 临时文件交给已有 MinIO SDK；每次退出都清理文件。
        result = await download_media_to_store(channel, message_id)
```

  `download_media_to_store(channel:str,message_id:int)->dict` 在同一 worker 文件实现上述流程；服务鉴权、参数验证在执行之前。照片、视频、音频分别进入 OCR/ASR，禁止把 forwards 写成 likes；转发量放 extra.forwards。
- [ ] **验收：** 文本采集不受 120 秒附件任务影响；图片与音频各一个真实授权样本完成下载/校验/提取；没有媒体配置时准确显示不可用。提交 `feat: ingest Telegram attachments asynchronously`。

### T11：微信内容新鲜度与主备可恢复性

**Files:** 修改 `workers/wechat-gateway/{store,server,state-machine,primary}.mjs`、`state-machine.test.mjs`、`gateway.test.mjs`、`src/lib/server/wechat-gateway-client.ts`、`wechat-meta.ts`。

**Interfaces:** gateway source 状态分开存 `last_primary_ok_at`（请求成功）、`last_primary_content_at`（新 canonical ID 或正文补全）、`latest_published_at`（上游发布时间）。新增 `freshnessState(source,now):'unknown'|'fresh'|'suspected_stale'`；空 Feed 不等于失败或确认停更。

- [ ] 用已有虚拟时间测试写入连续 7 天相同旧 Feed：

```js
assert.equal(freshnessState({
  last_primary_ok_at:'2026-10-02T00:00:00Z',
  last_primary_content_at:'2026-09-01T00:00:00Z',
  expected_update_hours:24
}, new Date('2026-10-02T01:00:00Z')), 'suspected_stale');
```

- [ ] 运行 `npm run gateway:test`，确认旧的只看请求成功逻辑不足。
- [ ] 用新增内容/正文补齐更新内容时间，同内容的重复拉取不刷新它。source 可设 expected_update_hours，默认未设只显示年龄，不推定低频公众号故障；超过期望周期 3 倍标疑似停滞，外部明确 risk_control 才标上游受限。

```js
const stale = source.expected_update_hours > 0 &&
  now.getTime() - Date.parse(source.last_primary_content_at) >
    3 * source.expected_update_hours * 3600000;
```

  沿用 paidDecision、预算账本和日终对账；疑似停滞只生成诊断/核对请求，不自动扩大付费预算。针对已知窗口缺口走显式回补范围，按供应商能力标记历史不可达；不随意删除旧数据。
- [ ] 演练 outbox 入库后 ACK 前重启、SQLite 预算预留后崩溃、正文补齐重放；维持三者既有语义。配置错误/上游停滞/网关不可达保留不同错误码。
- [ ] **验收：** 旧 Feed 的 HTTP 200 不再代表内容新鲜；低频源不误报硬故障；付费调用次数和预算不因健康诊断增加。提交 `feat: distinguish WeChat freshness from availability`。

### T12：RSS 条件请求与 304

**Files:** 修改 `rss.ts`、`http.ts`、`outbound-policy.ts`、`collectors/types.ts`、`scheduler.ts`、`scheduler-atomic.ts`；新增迁移 `0026_feed_validators.sql` 和 `src/lib/server/rss-http.test.ts`。

**Interfaces:** SourceRecord 增加 `feed_etag/feed_last_modified`；CollectorBatch 增加 `not_modified?:boolean`、`feed_validators?:{etag:string;last_modified:string}`。publicFetch 仅在 `allowNotModified:true` 时接受 304，其余调用仍拒绝非 2xx。

- [ ] 模拟第一次 200+ETag，第二次 304，记录实际请求：

```ts
assert.equal(requestHeaders['If-None-Match'], '"v1"');
assert.equal(batch.not_modified, true);
assert.equal(batch.items.length, 0);
assert.equal(xmlParseCalls, 0);
```

  同一测试的 fake transport 记录 requestHeaders、调用真实 rss wrapper 并以解析替身计数；再在入库失败场景确认 ETag 不提交。
- [ ] 运行 `node --experimental-strip-types --test src/lib/server/rss-http.test.ts`。
- [ ] 条件头按 source 持久保存，仅在对应响应条目成功提交的同一事务更新 validators；否则下一次必须重新 200 拉取，不能因 304 永久丢掉未入库响应。

```ts
const headers = {
  ...(source.feed_etag ? {'If-None-Match':source.feed_etag} : {}),
  ...(source.feed_last_modified ? {'If-Modified-Since':source.feed_last_modified} : {}),
};
```

  Feed URL/解析版本变化时清 validators；304 更新扫描成功时间，不更新内容发现时间。未完整处理/条目隔离的批次不缓存为完全消费成功。没有 validators 的上游继续普通抓取。
- [ ] **验收：** 不变内容不用重新解析或写文章；200 入库失败不会被后续 304 掩盖；正常空 200 与 304 区分。提交 `perf: use conditional requests for unchanged feeds`。

### T13：接入校验与平台能力边界

**Files:** 修改 `src/lib/platforms.ts`、`src/lib/server/fns.ts`、`collectors/index.ts`、`src/routes/sources.tsx`、`src/routes/keywords.tsx`、`docs/使用指南.md`；新增 `src/lib/server/source-validation.test.ts`。

**Interfaces:** 导出 `validateSourceInput(input):{ok:true;value:SourceRecord}|{ok:false;code:string}`，输入字段来自现有 addSourceFn，输出的 id 仍由服务器生成。能力表只用静态常量，字段 `history:'paged'|'window'|'none'`、`search:'native'|'index'|'none'`、`media:'reference'|'download'|'none'`。

- [ ] 添加非法 YouTube ID、混有视频 URL 的 B 站输入、缺 Feed 的 xhs、未知 adapter 的检查：

```ts
assert.deepEqual(validateSourceInput({platform:'xhs', handle:'demo',feed_url:''}),
  {ok:false,code:'feed_required'});
```

  同时检查合法旧 source 能读取；新增输入缺必要字段应返回稳定错误，不抛 TypeError。
- [ ] 运行 `node --experimental-strip-types --test src/lib/server/source-validation.test.ts`。
- [ ] 用 zod/现有 Telegram 解析器做运行时验证；YouTube 原生频道 ID 使用 `^UC[A-Za-z0-9_-]{22}$`，支持 Feed URL；B 站只解析明确 mid，不对整条 URL 无差别删非数字字符。未知 adapter 明确拒绝，不回落 RSS。

```ts
const adapter = ADAPTERS[source.adapter];
if (!adapter) throw new Error('unsupported_adapter');
```

  各 adapter 已走同一 Feed 时，不在失败后重复请求相同 URL；微信失败不直接绕过网关走裸 Feed，维持 metadata/预算边界。失败原因保留 primary/fallback 两次分类。
- [ ] 接入页显示所需配置、最近验证时间、覆盖范围和真实可用能力。YouTube 关键词标为新闻索引；TG/xhs/douyin/xigua 不支持原生关键词时明确提示，不返回“搜索成功 0 条”。B 站 412/429 不靠不断换身份或高频重试解决；只接入能验证的授权 API/已有 Feed。
- [ ] **验收：** 每个承诺平台至少一个真实合法 source 样本通过首次、重复和增量验证；无可用上游的平台显示“待配置/未验证”，不能算全平台通过。界面修改需加载 design-ui 指引并验证桌面/移动端。提交 `feat: validate sources and expose collection capabilities`。

### T14：指定站点正文补全（可选）

**触发条件：** T17 的样本报告确认业务所需文章只有摘要，且用户需要完整正文。未触发记为 deferred_by_scope，不采购服务、不新增依赖。

**Files:** 新增 `src/lib/server/article-extract.ts`、`article-extract.test.ts`；修改 `scheduler.ts`、`collectors/types.ts`，按 T08 原子合并全文；若需要独立持久任务，新增 `0027_article_jobs.sql`。

**Interfaces:** `extractArticle(html:string,url:string,selector:string):{body:string;canonicalUrl:string;complete:boolean}`；只对已登记站点和具体选择器生效。HTML parser 优先选已有适用依赖；没有时只增加一个经样本证明必要的解析库，禁止用通用正则模拟 DOM。

- [ ] 为首个明确站点保存脱敏 HTML 样本，检查正文保留而导航/广告不混入：

```ts
const html = '<nav>menu</nav><article><p>完整正文</p></article>';
assert.equal(extractArticle(html,'https://example.org/a','article').body, '完整正文');
assert.equal(extractArticle('<div>请登录</div>','https://example.org/a','article').complete, false);
```

- [ ] 运行 `node --experimental-strip-types --test src/lib/server/article-extract.test.ts`。
- [ ] 正文补全在文章发现后异步进行，用 T03 公共出口和 T07 同站节流，失败不阻塞新文章。读取站点公开规则并尊重访问限制；内容、抓取时间、提取版本、canonical 链接存 extra。不覆盖已确认完整正文和 OCR/ASR 附加文本，不把登录页/挑战页作为正文。

```ts
if (item.extra.body_complete === true) return;
// 抓取 + 指定 DOM 节点提取成功后，复用 mergeExistingItem(...body_complete:true)。
```

- [ ] **验收：** 首站 20 篇代表样本人工对照，正文准确且摘要回退可追踪；未提取的文章仍正常入库。提交 `feat: enrich articles for configured sites`。

### T15：动态页面浏览器试点（可选）

**触发条件：** 指定站点确实依赖 JS，T14 的普通 HTTP 获取不足，且内容可合法访问。不能以本任务承诺抖音/小红书全站抓取。

**Files:** 新增 `workers/browser-collector/server.mjs`、`server.test.mjs`；修改 `docker-compose.yml` 加可选 profile，`collectors/index.ts` 接入一个明确 adapter。Playwright 当前为 devDependency，若正式服务使用，必须在该 worker 的生产镜像显式安装运行依赖与浏览器。

**Interfaces:** worker 只接受 `{source_id,adapter}`，由服务器已登记配置解析 URL，不提供任意 URL 浏览代理；输出现有 CollectorBatch，不另创 schema。

- [ ] 添加鉴权、未登记 adapter、页面超时和挑战页检查：

```js
assert.equal((await request({source_id:'unknown',adapter:'unknown'})).status, 400);
assert.equal(activeContexts, 0); // 超时/成功/失败后均回收
```

  测试通过本地 fixture 页面驱动真实 worker；request 与 activeContexts 在 server.test.mjs 内创建。
- [ ] 运行 `node --test workers/browser-collector/server.test.mjs`。
- [ ] 并发固定 1、单页 30 秒、上下文存活不超过一项任务；`finally` 关闭 context。依赖域名建立明确 allowlist，并对浏览器所有子资源/导航实施网络出口隔离，不能只校验首个 URL；阻断非必要下载，应用资源上限。Cookie/会话仅通过工作区外受控文件注入。

```js
const context = await browser.newContext();
try { return await collectConfiguredPage(context, source); }
finally { await context.close(); }
```

  `collectConfiguredPage(context,source):Promise<CollectorBatch>` 在同文件实现首站明确选择器，等待具体元素并验证正文；挑战页返回 requires_action，停止自动尝试，不加入验证码破解或代理轮换机制。
- [ ] **验收：** 只承诺一个指定站点；72 小时无 context 泄漏、超时可恢复、出口策略有效。不达标撤回 profile，文本采集照常运行。提交 `feat: add optional browser collection pilot`。

### T16：指标、健康与告警闭环

**Files:** 修改 `scripts/operations-status.mjs`、`operations-status.test.mjs`、`src/lib/server/queries.ts`、`src/lib/types.ts`、`src/routes/sources.tsx`、`src/routes/jobs.tsx`、`src/routes/nodes.tsx`；扩展已有 jobs 记录，必要时新增 `0028_collection_observability.sql`。

**Interfaces:** 每次任务记录 adapter、error_code、duration_ms、items_found/new/updated/invalid、bytes、coverage、retry_at；保留 provider/paid_call。freshness 与 availability 独立；每源有 last_success_at、last_content_at。

- [ ] 在已有运维测试中验证“持续请求成功但内容老旧”告警、冷却不计故障风暴、同一事件不重复写：

```js
assert.equal(events.filter(e => e.code === 'content_stale:s1').length, 1);
assert.equal(JSON.stringify(events).includes('Bearer '), false);
```

  events 由连续两次运行实际事件生成逻辑得出，使用临时测试目录，不是手工构造的结果。
- [ ] 运行 `node --test scripts/operations-status.test.mjs`。
- [ ] 复用现有只读 SQL 诊断，新增 oldest_due_age、pending_media_age、各 adapter 错误率、发现延迟分位数、正文完整率；无证据时用 unknown，不展示 100%。事件按 `(source,error_code)` 去重，状态恢复只记一条 resolved。

```sql
select platform, count(*) filter (where last_error_code <> '') as failed,
       count(*) as total from sources where enabled=true group by platform;
```

  上述是源当前状态分布；任务失败率另外以 jobs 时间窗为分母，不混用。页面给出重试时间与操作建议；仅写本地告警事件/既有面板，外发邮件或消息需另有明确授权。
- [ ] **验收：** 能在 5 分钟内区分出口异常、账号失效、限流、Feed 停滞、媒体积压；桌面和 390×844 页面无溢出。提交 `feat: expose actionable collection health`。

### T17：故障演练、完整性与容量验收

**Files:** 复用并修改 `scripts/collection-load-check.mjs`、`scripts/readiness-e2e.mjs`、`scripts/readiness-offline.mjs`；新增 `scripts/collection-reliability-check.mjs`；证据写入 `validation/collection/2026-10-02/`，报告写 `docs/operations/collection-acceptance.md`。

**Interfaces:** 验收 JSON 固定输出 `expected/collected/missing/duplicates`、delay_p50/p95、retry_recovery_seconds、max_rss_bytes、max_queue_age_seconds、paid_calls、evidence_scope；明确 `offline` 或 `live`。

- [ ] 构建 fake HTTP/RSS、Fake Telethon、隔离 PG/MinIO，不继承生产凭据；覆盖 429 Retry-After、503、慢体、坏 XML、重定向到私网、重启、租约竞争、页 2 中断、媒体上传后 DB 失败、ACK 前中断。
- [ ] 验证脚本自身拒绝漏项，不能仅看 HTTP 200 或任务 exit 0：

```js
assert.equal(report.missing, 0);
assert.equal(report.duplicates, 0);
assert.ok(report.collected >= report.expected);
assert.equal(report.paid_calls, 0); // 离线测试绝不能真实付费
```

- [ ] 执行：

```text
node scripts/collection-reliability-check.mjs --offline
node scripts/collection-load-check.mjs
npm test
npm run gateway:test
npm run typecheck
```

  编译命令 `npm run build` 包含 db:migrate，必须通过已复用 offlineEnv 子进程包装启动，生产 DATABASE_URL 不可继承。dev/built 浏览器检查沿用 browser-smoke；页面涉及 T13/T16 时查看桌面/手机截图及控制台。
- [ ] 真实验收先 10—20 个明确允许访问的源，持续 72 小时；通过后扩大至 100+ 源运行 7 天。1000 源先做离线容量评估，不未经测量直接作真实承诺。每源记录平台、采集频率、可访问的参考 ID 集、初始范围及上游窗口，禁止用数据量增加代替召回率。
- [ ] **拟议通过阈值（不是当前成绩）：** 确定性 fixture 的漏项和重复均为 0；真实可访问参考集无未解释漏项；到期调度等待 P95 不超过 120 秒（声明机器与容量）；在上游已可见且不受限时，发现延迟 P95 不超过 source interval + 120 秒；瞬时故障在计划 retry_at 后两个 tick 内开始恢复。
- [ ] **资源/费用门：** 预热后 24 小时进程内存无持续单调增长；RSS 不超过声明容器预算的 70%；积压年龄没有持续发散；付费支出不超过现有硬预算，未知费用不能当零。上游不可用样本独立报告，不能剔除后声称端到端零失败。
- [ ] **验收：** 每项报告绑定 Git SHA、镜像 ID、时间窗口和输入参考集；未运行满 72 小时/7 天保持待验收，不能用离线结果替代。提交 `test: verify collection recovery and completeness`。

### T18：自动备份、可回滚发布与文档

**Files:** 复用 `scripts/postgres-recovery-check.mjs`、`scripts/restore-policy.mjs`；新增 `scripts/collection-backup.mjs`、`scripts/collection-backup.test.mjs`；修改 `docker-compose.yml`、`docs/operations/loom-release-runbook.md`、`loom-current-status.md`、`README.md`、`docs/使用指南.md`。

**Interfaces:** backup manifest 只记录资源名、时间、文件大小/hash、schema version；包含 PG、MinIO、SQLite 一致性备份、Telegram session 的受限加密副本。恢复目标必须是新建隔离资源。

- [ ] 扩展既有 restore policy 测试，覆盖拒绝覆盖既有目标、损坏备份、错误标签和凭据泄漏：

```js
assert.throws(() => assertRestoreTargetIsNew(['loom_existing'], 'loom_existing'),
  /restore_target_exists/);
```

  复用已核对的 `assertRestoreTargetIsNew(existingDatabases, target)`，不要另改生产接口。
- [ ] 运行 `node --test scripts/restore-policy.test.mjs scripts/collection-backup.test.mjs`，然后实际恢复到隔离 PG/MinIO/SQLite，核对有序数据摘要及待执行队列。
- [ ] 拟定每天备份一次、保留 7 个日副本和 4 个周副本；使用 SQLite backup API，不复制运行中的单个 DB 文件冒充一致性备份；媒体与数据库按 manifest 对应。Telethon session 作为登录凭据保护，不进入应用公共下载包。至少一个加密副本保存在不同机器/存储；未具备该条件就明确未完成。
- [ ] 发布按已验证构建源制作固定标签镜像，分别核对 app/scheduler/telethon/gateway，不能只更新 app 就声称 Python 修复上线；停止新任务并等待在途任务完成，运行追加迁移后小流量验证，再恢复调度。

```text
发布清单：Git SHA → app/scheduler image ID → telethon image ID → gateway image ID
          → migration versions → smoke evidence → rollback image IDs
```

  schema 采用向后兼容追加字段；回滚代码保留新字段和数据，不倒滚游标、不删表。生产发布和定时备份实际启用属于后续执行阶段，不由本轮文档自动执行。
- [ ] **验收：** 建议 RPO≤24 小时、RTO≤2 小时，以恢复演练计时为准；重新运行可复现同一版本；README、页面支持范围、源码包与交付状态一致。提交 `ops: ship recoverable collection improvements`。

## 5. 不列为当前必做项

- 不重建已有租约、预算、outbox、提取队列和 Agent 系统。
- 不把普通错误都用多次重试掩盖，不通过无限加并发解决容量问题。
- 不默认上代理池、多账号轮换、验证码破解或通用“反反爬”系统；它们不能解决合法访问范围和上游接口能力限制。
- 不默认承诺全网搜索、历史全量、每个平台的视频下载。浏览器和正文补全均以指定站点样本为入口。
- 不将正文采集计划扩展为向量数据库、多租户、账户系统或付费 AI 重构。

## 6. 自检与执行交接

本计划覆盖：版本一致性、配置、网络边界、完整性、重试、账号恢复、调度、入库一致性、媒体、微信新鲜度、条件请求、平台边界、按需爬虫扩展、监控、容量、备份发布。

本轮证据是源码/分支/历史运维记录审阅，以及官方 HTTP/Telethon 文档核对；没有本次线上压测、在线账号采集或持续运行成绩。尤其不能将主线已知缺陷直接描述为当前生产镜像的缺陷。

执行可选：

1. **按任务委派实施**：每项实现后检查行为证据，再进入下一项；先完成 T01 再分配互不冲突的文件。
2. **当前会话逐项实施**：按同样顺序和验收门推进。

无论哪种方式，第一项都是 T01。稳定性主线优先；T14/T15 没有实际需求就保持不执行。
