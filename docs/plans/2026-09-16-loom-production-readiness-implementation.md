# Loom PRD Completion and Production Readiness Implementation Plan

> **当前状态（2026-09-21）以[统一交付状态](../operations/loom-current-status.md)为准。** 本文下方为历史方案或执行快照；其中“未发布、待授权、未修复”只适用于当时，不覆盖后续证据。T21 部分通过、T22 已验证、T23 未完成、T24 已发布但完整回滚验收未闭环；完整 PRD 尚未完成。本次文档修订尚未发布到生产镜像或下载源码包。

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> 其他Agent：使用可用的 `executing-plans` 技能逐任务执行；技能不可用时按本文相同检查点执行，不虚构技能调用。用户已选择另一个Agent实施，本会话只编写计划。

**Goal:** 在保留现有数据、修改和测试证据的前提下，补齐Loom的采集/关键词正确性与部署保护，形成可复现的候选版本，并经独立授权完成所选范围的真实服务与生产验收。

**Architecture:** 保留React/TanStack控制面、PostgreSQL、现有采集适配器、微信网关和Eino worker。先修共享保存/调度/抓取边界，再用隔离服务验证，不重建架构、不引入向量库或多租户。正式业务库与55192假模型测试库分离，真实调用、切换及扩大采集均设独立执行门。

**Tech Stack:** Windows PowerShell；Node.js及项目lockfile；React/TanStack Start；TypeScript；node:test/PGlite/pg；PostgreSQL 16；Go/Eino；Python/Telethon；Docker Compose/MinIO；Playwright。

---

## 0. 路径、基线与授权契约

本文所有 `B/...` 均精确指向业务工作树，`R/...` 均指根目录；这不是两个需要同步源码的项目。

```text
R = F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace
B = F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/.worktrees/local-model-settings
业务分支 = comet/local-model-settings
计划 = R/docs/plans/2026-09-16-loom-production-readiness-implementation.md
执行记录 = R/docs/operations/2026-09-16-production-readiness-execution.md
候选范围 = R/docs/operations/2026-09-16-release-scope.md
每批证据 = B/artifacts/production-readiness/<唯一批次ID>/
```

开始必须读：根/业务树适用的AGENTS.md及AGENTS.project.md（若存在）、`R/.agents/skills/ponytail/SKILL.md`、原始[差距清单](../operations/2026-09-16-prd-gap-and-next-plan.md)、[最新交接](../operations/2026-09-11-handoff.md)、[手测记录](../operations/2026-09-09-manual-test-record.md)、[B/C验收](../operations/2026-09-16-bc-validation.md)、[数据保护](../operations/2026-09-11-persistence-protection.md)、`B/src/routes/prd.tsx`。

基本事实：55192是fake模型手测环境；8182曾用进程内存库，旧数据没有已证实的备份；端口/进程在新会话必须重新核对。A类已通过部分无需重复生成，B01—B12/C01—C04已通过本地范围，C05未完成。最新234项Node与18项PG结果只是当时基线，不能用于新代码的最终宣告。

执行规则：

1. 直接在现有专用业务工作树实施，不从分支HEAD新建一个遗漏未提交修复的工作树；需要隔离副本时只复制明确批准的源码清单，不复制秘密/数据。
2. 保留所有既有修改，不reset/clean/stash、不整树覆盖，不改 `restart.bat`；默认不commit/push/merge。技能“频繁提交”在本项目替换为逐任务diff/哈希/证据检查点，只有用户另行明确允许才提交。
3. 不读取/打印/归档 `config/model.local.json`、私人Key、容器全量环境或会话凭据；只检查配置是否存在与非秘密元数据。测试使用独立假配置。
4. 不重启55192/8182、生产数据库/采集服务，不执行 `docker compose down -v`。隔离资源必须有批次标签、回环端口、唯一目录，只清理本批创建的已核对资源。
5. 普通单元测试/只写临时库的故障测试可直接做。真实供应商、真实抓取、账号登录、付费、生产迁移/切换须到相应门获得具体授权；不因这些门未开放而停止无依赖的离线任务。
6. 开发实现采用最小红→绿检查；文档/库存盘点不造测试。一次“写测试”“运行”“修共享函数”“回归”“记录”各是一小步；长测试和72h/7天观察按启动、检查结果、归档拆开，不伪造短时完成。
7. 搜索优先rg；本机rg损坏时用PowerShell Select-String。Git所有权问题仅用精确目录的单次safe.directory，不改全局配置。

## 1. 交付分级、依赖与范围决策

默认可执行目标是**受控本地/内网、公开资料、单用户候选版本**，并非用户已批准公网部署。先实现通用正确性；真实启用哪些平台由release-scope记录。外部MCP保留现有能力但默认未启用，禁止悄悄扩大原PRD“库内回答”的范围。

| 交付级别 | 条件 | 允许的表述 |
|---|---|---|
| L0 离线候选 | T01—T20适用离线项通过，未获真实授权项明确列出 | 代码/隔离验收完成，等待真实验收 |
| L1 受控试用 | T21对应选定平台/模型通过，T22目标环境与恢复演练通过，指南匹配 | 指定范围可受控使用 |
| L2 指定范围生产 | T23持续运行达到范围门槛、T24发布批准与验证、T25交付 | 明确版本、平台、规模下生产就绪 |

依赖顺序：T01→T02→T03/T04；T05→T06；T07→T08→T09；T10与T11可顺序接续；T12依赖T05/T10；T13→T14；T15/T16→T17；所有改动→T18/T19/T20；T21—T25按外部输入逐门推进。默认一个Agent顺序执行，本文不是自动启动多Agent的授权。

W映射：W01=T01/T20；W02=T02/T03/T22；W03=T04—T06；W04=T07；W05=T08；W06=T09/T10；W07=T11；W08=T12；W09=T21；W10=T13/T23；W11=T14/T21；W12=T15；W13=T16；W14=T17/T23；W15=T18/T19/T20/T24；W16=T25。

## 2. 通用测试与证据约定

以下命令在B运行，先以Task 1准备的独立环境执行，不能继承真实DATABASE_URL/模型配置。使用仓库已有Node版本与依赖，不无理由升级。

```powershell
Set-Location 'F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/.worktrees/local-model-settings'
node --version
npm run typecheck
```

Node定向命令格式：`node --experimental-strip-types --test <精确.test.ts路径>`；mjs不需要strip-types。新增TypeScript测试不得直接导入带未解析 `@/` alias 的生产模块造成假失败；复用现有依赖注入/纯模块测试方式，或在已有Vite集成harness中执行真实服务函数。语法错误、缺依赖、别名错误不是业务红测试证据。

每项日志记录：Task ID、源码哈希、命令、隔离资源、开始/结束时间、退出码、pass/fail/skip、预期/实际、输出路径、尚缺什么。浏览器检查保存桌面与390×844截图并实际查看，记录console/pageerror；HTTP200不算渲染通过。所有费用、正文和地址证据按最低必要程度脱敏。

进度状态固定为 `not_started / implementing / offline_pass / awaiting_authorization / real_pass / blocked / deferred_by_scope`。单纯没有授权是awaiting_authorization，不是整份计划完成；后续无依赖离线项继续。

### Task 1: 固定基线、范围与隔离运行入口（W01）

**Files:** Read `B/package.json`, `B/AGENTS.md`, `B/docker-compose.yml`（只检查模板，不展开秘密）；Create `R/docs/operations/2026-09-16-release-scope.md`、`R/docs/operations/2026-09-16-production-readiness-execution.md`；必要时Create `B/scripts/readiness-offline.mjs`及`.test.mjs`。

1. 只读核对当前分支、HEAD、脏文件路径、迁移文件名、既有服务端口；不要读取私有配置内容。根Git使用`.repo`，业务树用正常git。
2. 将本计划T01—T25写为进度表；范围表列平台/适配器/计划规模/频率/真实证据/是否首版，尚无用户选择标proposed，不能自行宣称已批准。
3. 建立本批唯一artifact目录；复用现有harness运行隔离依赖。若需统一命令包装，子进程环境只继承PATH、SystemRoot、TEMP等运行必需项，显式设假模型路径、AUTO=false、async/worker按该用例、无真实DATABASE_URL；不要按“删除几个已知Key”处理未知秘密。
4. 如新增包装器，测试父环境含虚构DATABASE_URL/Key时子进程不可见，显式测试DSN才可见；不输出值。运行 `node --test scripts/readiness-offline.test.mjs`，预期通过。
5. 保存基线manifest；不提交。基线文档足够就不新增包装器。

### Task 2: 正式运行缺数据库时拒绝启动（W02）

**Files:** Modify `B/src/lib/db.ts`、`B/package.json`、`B/Dockerfile`及`B/docker-compose.yml`中运行标志（按调用链最小修改）；Create `B/scripts/runtime-policy.mjs`、`B/scripts/runtime-policy.test.mjs`；Read `B/scripts/with-app-env.mjs`、`B/scripts/migrate.mjs`。

1. 写纯策略测试，覆盖dev空库允许、正式空/空白DSN拒绝、正式PG允许、非法模式拒绝。使用显式 `LOOM_RUNTIME_MODE=production`，不要只靠NODE_ENV：built隔离预览也可能无外部库。
2. 运行 `node --test scripts/runtime-policy.test.mjs`，确认是预期策略缺失导致失败。
3. 最小策略函数完整参考：

```js
export function assertRuntimeDatabase(env) {
  const mode = env.LOOM_RUNTIME_MODE ?? 'development';
  if (!['development', 'test', 'production'].includes(mode)) {
    throw new Error('invalid_runtime_mode');
  }
  if (mode === 'production' && !String(env.DATABASE_URL ?? '').trim()) {
    throw new Error('production_database_required');
  }
}
```

4. 在首次运行期打开数据库前调用，并使正式容器入口在服务监听前执行同一策略；build不得因此连接正式库或强制正式模式。显式测试模式只用于隔离测试，不作为生产默认。
5. 运行测试及typecheck；隔离正式启动缺库应非0退出且零建库，开发模式仍可预览；记录测试命令，不读取真实DSN。

### Task 3: PG备份与恢复副本工具（W02）

**Files:** Read `B/scripts/pglite-recovery-check.mjs`, `B/scripts/pglite-backup-http-check.mjs`, `B/src/lib/server/pglite-backup.ts`；Create `B/scripts/postgres-recovery-check.mjs`、`R/docs/operations/loom-backup-restore-runbook.md`。

1. 以现harness创建独立PG并执行现迁移，写入材料、引用、分析、note及pending任务；固定验证ID，记录表行数与排序摘要。
2. 使用PG16的pg_dump/pg_restore，凭据通过受限环境/临时passfile传入，不放CLI参数/日志；先写失败场景：拒绝覆盖已有恢复目标、损坏备份拒绝、目标资源标签不符拒绝。
3. 导出到非public/non-git目录，SHA256/版本/迁移清单写manifest；恢复到另一个新库；摘要比较使用同一快照时点，避免运行中计数与稍后dump不一致。
4. 在恢复副本启动独立应用读取指定历史note及引用，重启该副本进程再读；源测试库始终保留。
5. 运行 `node scripts/postgres-recovery-check.mjs`，脚本默认只创建自己的隔离资源；期望一致且0退出，失败不自动删除现场。脚本不得默认接受生产库地址。
6. Runbook补网关SQLite一致性备份、MinIO对象清单/校验及Telethon会话秘密备份流程；不要把运行中SQLite主文件单独复制当完整备份。真实业务备份/宿主重启留到T22。

### Task 4: 部署配置与打包边界（W03）

**Files:** Modify `B/docker-compose.yml`, `B/Dockerfile`, `B/env.example`, `B/scripts/pack-source.mjs`；Create `B/scripts/deployment-policy.test.mjs`；Read `B/.dockerignore`, `B/.gitignore`。

1. 用临时目录和虚构配置测试源码包/构建上下文不得带config/model.local.json、.env、会话、SQLite、artifacts和数据库目录；防止正向只打包tracked文件却漏必要源码。使用现打包脚本接口，不复制项目秘密。
2. 配置门测试：正式PG/MinIO无默认弱凭证、内部服务无公开宿主端口；app/管理端口默认回环，远程入口由后续部署清单明确。
3. 改模板使用必填变量，不生成真实值。既有卷修改密码需SQL/服务内更新方案，不能以更改环境变量声称已轮换；计划不执行轮换。
4. 匿名媒体桶仅允许明确的公开资料模式；生产非公开资料配置应拒绝匿名初始化，不新增账户体系。不要宣称简单关闭匿名桶后现有公开URL仍可用。
5. 镜像固定到经验证版本/摘要，具体值由实现时读取已用镜像并验证，不猜测。运行 `node --test scripts/deployment-policy.test.mjs`；Compose语法检查用全是假值的独立环境，输出不包含秘密。

### Task 5: 外部下载的安全/大小边界（W03）

**Files:** Modify `B/src/lib/server/http.ts`；按复用情况Create `B/src/lib/server/outbound-policy.ts`、`B/src/lib/server/outbound-policy.test.ts`；Read `B/src/lib/server/model-config.ts`与Go MCP已有网络校验。

1. 列出所有外部URL下载调用者及内部服务调用者，逐项确定public-fetch或明确内部服务；禁止把统一“禁止私网”套到本机模型、MinIO和网关。
2. 先写测试：非法协议/用户名密码、localhost/IP回环、RFC1918/link-local/metadata、IPv6/mappedIPv4、混合DNS答案、公开域重定向私网、过多重定向、超时、chunked超限及取消reader。
3. public-fetch限定HTTP(S)、解析与连接用同一验证结果，每次重定向重验；DNS检查后再普通fetch有重绑定时间差，不能当修复。优先复用已安装实现；否则用Node http/https.request的lookup将连接钉到校验地址，TLS仍校验原域名。自动代理/环境代理须纳入测试。
4. 流式计数而非只信Content-Length；建议文本4MiB/媒体25MiB为首版上限，作为代码常量和文档契约，不自动扩容；达到上限明确拒绝并关闭连接。
5. `node --experimental-strip-types --test src/lib/server/outbound-policy.test.ts` 通过。fixture以注入resolver/transport测试，生产不能新增“所有私网允许”测试后门。实际Node传输另用隔离集成验证连接目标。

### Task 6: 将下载策略接入全部真实调用者（W03）

**Files:** Modify `B/src/lib/server/rss.ts`, `B/src/lib/server/telegram.ts`, `B/src/lib/server/collectors/index.ts`, `B/src/lib/server/collectors/keyword.ts`, `B/src/lib/server/media.ts`, `B/src/lib/server/extract.ts`；Test `B/src/lib/server/rss.test.ts`及新增 `B/src/lib/server/download-integration.test.ts`。

1. 对每个caller写一个故障边界，至少覆盖RSS重定向、媒体超限、OCR远程URL、关键词请求；保持模型/MCP/网关私有网络走各自受控策略。
2. 逐个替换散落fetch，保留原有Accept/UA/响应错误语义；响应体只读取一次。已有受保护内部地址不能跟随重定向泄露Bearer。
3. 搜索剩余 `fetch(`/`arrayBuffer`/`redirect: follow`，在审计表记录每处为何安全或未接入；不只修用户可见的一条路径。
4. 运行精确新测试、rss/collectors旧测试、typecheck；预期所有下载caller通过且内部假服务仍能调用。源码扫描不是唯一通过证据。

### Task 7: 历史关键词完整、并发安全的打标（W04）

**Files:** Modify `B/src/lib/server/scheduler.ts:145`、`B/src/lib/server/scheduler-atomic.ts`；Test `B/src/lib/server/scheduler.test.ts`；Read `B/src/lib/keyword.ts`。行号仅定位，修改前按函数名重新核对。

1. 在真实PGlite建items表，插入450条匹配资料（前200已标记）、50条不匹配；调用实际SQL helper，期望后250条补齐，再运行新增0。另写两个并发关键词不丢标签测试。
2. 运行 `node --experimental-strip-types --test src/lib/server/scheduler.test.ts`，旧实现应未能覆盖余下条目；不要用返回假数组替代数据库断言。
3. 将最小集合更新放已有scheduler-atomic.ts，scheduler负责获取sql与参数。建议SQL形状如下（参数化，实际lower语义需中英文/特殊字符用例验证）：

```sql
update items
set matched_keywords = coalesce(matched_keywords, '[]'::jsonb) || jsonb_build_array($1::text)
where strpos(lower(coalesce(title, '') || E'\n' || coalesce(body, '') || E'\n' || coalesce(author, '')), lower($1::text)) > 0
  and not exists (
    select 1 from jsonb_array_elements_text(coalesce(matched_keywords, '[]'::jsonb)) as kw(value)
    where lower(kw.value) = lower($1::text)
  )
returning id;
```

4. 不先读JSON再在JS覆盖整列；`%`、`_`视为字面字符。加平台范围参数（空=全部），并追踪新资料自动匹配和手动回填全部caller，避免本地过滤仍跨平台。
5. 测试空/非法短语在调用边界拒绝，大小写不重复、中文、`%_`、平台过滤。PGlite通过后在隔离PG验证两个更新竞争与实际索引/耗时；若集合更新在目标体量超预算再做主键游标批处理，不预建队列。
6. 文档记录覆盖上限/计时；任何超时保留旧标签、可重试，不返回“全库完成”。

### Task 8: 关键词结果契约与真实状态（W05）

**Files:** Modify `B/src/lib/server/collectors/keyword.ts`, `B/src/lib/server/collectors/types.ts`, `B/src/lib/server/scheduler.ts`, `B/src/lib/keyword.ts`, `B/src/routes/keywords.tsx`, `B/src/routes/jobs.tsx`；Create `B/src/lib/server/collectors/keyword.test.ts`；必要时Modify `B/src/lib/server/scheduler-atomic.ts`, `B/src/lib/types.ts`, `B/src/lib/server/queries.ts`。

1. 新增结果类型，复用jobs.error/attempts承载安全摘要，先不新增状态枚举/迁移：

```ts
export type KeywordAttempt = {
  source: 'google_news_zh' | 'google_news_en' | 'hacker_news' | 'youtube_news' | 'bilibili_search';
  status: 'ok' | 'error';
  count: number;
  error_code?: 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' | 'network_error';
};
export type KeywordBatch = { items: NormalizedItem[]; attempts: KeywordAttempt[] };
```

2. 写fixture测试：全部成功零条、全失败、本地模式零外部调用、一成功一失败、HTTP429、不合法JSON；注入fetch或用既有集成runner，禁止网络回退。
3. collectKeyword取消吞错为空数组，返回attempts；scheduler依结果落库：无外部来源=正常本地；全部失败=error（仍可保留本地标签）；部分失败=ok并显示“部分来源失败”；成功空=正常无命中。不把本地有结果抵消全部外部失败。
4. UI已有“公众号信源/local”应真的只匹配本地，取消它触发Google News的隐式行为；YouTube标“新闻索引检索”，不是全站。其他local平台也执行T07范围过滤。
5. 运行 `node --experimental-strip-types --test src/lib/server/collectors/keyword.test.ts src/lib/server/scheduler.test.ts`、typecheck；harness验证任务页三种状态及关键词页提示，手机无溢出。

### Task 9: 后台短周期调度与原生产阶段解耦（W06）

**Files:** Modify `B/scripts/cron-loop.mjs`, `B/scripts/cron-loop.test.mjs`, `B/src/routes/api/cron/tick.ts`, `B/src/lib/server/cron.ts`, `B/src/lib/server/cron.test.ts`, `B/docker-compose.yml`, `B/env.example`。

1. 注入时钟测试5/10/30分钟源在浏览器关闭时到期可被选取，循环不重叠，未处理任务继续到期。不要真的sleep10分钟。
2. 先追踪cron完整阶段和上海半小时提取/对账窗口。生产候选建议调度唤醒60秒、source本身间隔不变；**不能仅把默认30分钟改1分钟，导致落盘/OCR/付费对账频率翻30倍**。
3. 对重阶段设置独立持久时间窗准入/租约，复用已有数据库租约/周期机制；如果没有可复用的全局周期状态，新增下一序号迁移（当前最大0020，执行时重新检查），保存window_key/stage/claim/terminal。频率变化不改变微信60分钟源约定。
4. 测试同窗多tick、服务重启、多实例竞争只准入一次重阶段；阶段失败按已定义重试规则，不通过内存时间戳假装持久排重。采集工作量长于唤醒间隔时报告延迟，不能承诺硬实时。
5. 运行 `node --test scripts/cron-loop.test.mjs` 与 `node --experimental-strip-types --test src/lib/server/cron.test.ts`，新增迁移需隔离PG升级/再跑验证。建议候选小规模due-to-start P95≤120秒，T17测不到则明确降级范围，不修改门槛掩盖。

### Task 10: Telegram/B站分页与安全游标（W06）

**Files:** Modify `B/workers/telethon/server.py`, `B/src/lib/server/telethon.ts`, `B/src/lib/server/collectors/index.ts`, `B/src/lib/server/collectors/types.ts`, `B/src/lib/server/scheduler.ts`；Test `B/src/lib/server/scheduler.test.ts`；Create `B/workers/telethon/test_history.py`, `B/src/lib/server/collectors/pagination.test.ts`。

1. 用fake Telethon client模拟旧cursor=100、新消息101…350、limit80；现取最新80后推进最大ID会漏中段。单独测试Message归一化/失败，导入server不能自动登录。
2. 对既有cursor，按最老未见消息开始升序取有界页（验证SDK reverse/min_id语义）；初次cursor=0保留“从最近窗口开始”并标记起点，不默认拉全历史。完成该页持久化后才推进到该页安全最大ID。
3. B站分页拉至旧边界或明确页数/时间上限；截断未达到旧边界时不能推进最终高水位而丢中段。优先保存有限页续读位置在现source元数据（若不存在再最小迁移），避免每次从最新页无限重扫。
4. 扩CollectorBatch为可选coverage/continuation信息；RSS/网页有限窗口明确 `window_only`，不伪称完整补采。数字ID比较用BigInt或安全字符串算法，不用超过安全范围的Number。
5. 测试页二失败、页内入库失败、lease丢失、重新执行、FloodWait、多页无重复；collector失败不能导致付费或网页回退绕过明确暂停。
6. `python -m unittest discover -s workers/telethon -p 'test_history.py'`、`node --experimental-strip-types --test src/lib/server/collectors/pagination.test.ts src/lib/server/scheduler.test.ts`。Python依赖缺失用专用venv/已有镜像，不读取登录会话。真实Telegram留T21。

### Task 11: 全文保存与历史修复预览（W07）

**Files:** Modify `B/src/lib/server/scheduler.ts`, `B/src/lib/server/scheduler-atomic.ts`；Test `B/src/lib/server/scheduler.test.ts`, `B/src/lib/server/rss.test.ts`；Create `B/scripts/content-repair-preview.mjs`；Read `B/src/lib/server/rss-parser.ts`, `B/src/lib/server/agent-context.ts`。

1. 准备12,500字符RSS和关键词材料，尾部唯一断言串 `TAIL-READINESS-12500`；通过解析、两条入库入口、读取详情/检索核对，旧实现应在入库断言失败。
2. 删除非微信8,000字符静默截断，保持T05传输大小上限与现模型上下文预算；超内容上限明确拒绝/标partial，不能无标记丢尾部。新增/mergeExistingItem两个路径都要检查。
3. 重复相同external_id不增加条目；真实正文变化按现材料revision机制失效旧缓存且保留历史分析，不绕过Agent已完成的指纹检查。
4. preview脚本默认只读：输出受影响ID、原因、旧/拟新摘要，不输出全文。不能由截断文本“补造”尾部；需重抓的标 `requires_authorized_refetch`。
5. 若实现apply模式，只允许明确资源标签的恢复副本、输入固定预览manifest并校验旧摘要、事务更新；真实库apply不在本任务执行。
6. 运行scheduler/rss/agent-context定向测试；用既有long-content-ui/material-generation脚本接口做隔离浏览器验证。不再到55192生成重复Battery问答。

### Task 12: 媒体类型、提取输入与幂等（W08）

**Files:** Modify `B/src/lib/server/media.ts`, `B/src/lib/server/extract.ts`, `B/src/lib/server/collectors/index.ts`；Test `B/src/lib/server/extract-targets.test.ts`；Create `B/src/lib/server/media.test.ts`, `B/src/lib/server/extract-input.test.ts`；Read `B/src/lib/server/storage.ts`。

1. fixture包含video条目只有JPEG封面、真正音频/视频文件、空文本图片、超限图片、坏MIME及远程404。断言封面不能当音轨送STT。
2. 按目标文件类型选择OCR/STT，保留条目形态与媒体目标类型区别；已有guessKind把mediaType=video覆盖扩展名需对应测试。
3. `extract.ts`当前对超长图片bytes.subarray会截断二进制；改为明确 `media_too_large` 拒绝（零模型调用），不新增图像处理库悄悄有损压缩。
4. 接入T05流式上限；验证落盘对象可读取和hash一致、外链失效时读取已落盘对象；公共URL用部署地址而不是客户端不可达loopback。
5. 运行 `node --experimental-strip-types --test src/lib/server/media.test.ts src/lib/server/extract-input.test.ts src/lib/server/extract-targets.test.ts`；现每目标终态/最多重试策略不得退化，刷新0调用。真实OCR/STT只准备清单，留T21。

### Task 13: 微信费用保守预留与诊断（W10）

**Files:** Modify `B/workers/wechat-gateway/dajiala.mjs`, `B/workers/wechat-gateway/store.mjs`, `B/workers/wechat-gateway/server.mjs`；Test `B/workers/wechat-gateway/dajiala.test.mjs`, `B/workers/wechat-gateway/gateway.test.mjs`, `B/workers/wechat-gateway/state-machine.test.mjs`；Modify `B/env.example`与操作文档。

1. 重现日累计1.92、下一次预留0.08而实际0.14场景；分别测试网络错误/started未知/完整结算、并发最后额度、跨日。使用fake，不查供应商真实账户。
2. 估计价格不能作为硬上限。为付费模式要求明确、经来源验证的列表/详情上界；配置缺失/失效则付费准入拒绝，主Feed路径仍可用。不要把0.14硬编码为永久真价。
3. 所有未知结算保留保守预留并标明unknown；实际超上界记录overrun并阻断后续付费准入，不能撤销已发生扣费。跟踪原请求日，不因跨午夜释放旧账。
4. SQLite升级走现openStore迁移风格，旧库字段保留；禁止用把所有历史unknown改0的方式通过测试。
5. 将technical_error细分为安全代码 timeout/network/rate_limited/provider_5xx/invalid_response，禁止保存原始响应/Key。
6. `npm run gateway:test` 通过，记录分段计数；真实账单/风控恢复仍awaiting_authorization。旧日期回归保持已修，不回改生产七天窗。

### Task 14: C05准备与模型配置来源核对（W11）

**Files:** Read/按发现最小Modify `B/src/lib/server/model-config.ts`, `B/src/lib/server/agent-client.ts`, `B/src/lib/server/agent-budget.ts`, `B/workers/agent/internal/agent/`下配置/模型实现；Create `R/docs/operations/loom-real-service-acceptance.md`；复用 `B/scripts/agent-integration-harness.mjs`。

1. 画一张实际配置来源表：legacy模型设置、本地Go环境、OCR/STT、MCP各自来源和是否热加载；只写变量名/保存状态，不能读取用户Key验证。
2. 若UI让人误以为一次设置控制全部引擎，先补精确文案/非秘密状态，不自动同步或搬运Key。找不到缺陷就不修改实现。
3. 真实验收表固定操作ID、模型/工具版本、最大请求数、费用上限、材料、结果、run/job、usage/账单口径及停止条件。所有额度填“待用户指定”，不自填授权金额。
4. 离线测试usage完整/缺失、工具后最终回答、unknown费用、截止取消、不跨引擎自动fallback，复用B/C已有脚本；只有配置相关代码变化才重跑相应Go/Node检查。
5. C05不能此时标real_pass；到T21批准后执行。

### Task 15: 引用契约与检索评测（W12）

**Files:** Modify `B/src/routes/prd.tsx`, `B/src/routes/knowledge.tsx`, `B/src/routes/guide.tsx`（必要文案）；Read/按实测Modify `B/src/lib/server/agent-retrieval.ts`, `B/src/lib/server/agent-context.ts`, `B/src/lib/server/agent-data.ts`；Test对应`.test.ts`；Modify `B/scripts/agent-retrieval-eval.mjs`及其现有fixture引用文件（先定位不另造平行评测）。

1. 固定契约：普通库内问答只引用库内证据；显式启用工具研究可含标识明确的服务来源；没有真实工具收据不得伪造外部来源。
2. 检查现页面是否已区分，已有能力直接保留。测试刷新后来源类别、证据文本与内部文章链接不混淆。
3. 读取c11失败案例及期望材料，先复现0.5，再用最小词法/排序修复尝试；不得删案例、降低阈值或插入按测试问题硬编码。
4. 评测增加真实业务脱敏样本清单（缺用户材料先用明确fixture），覆盖数字冲突、日期、尾部、无答案、平台范围。fixture通过不等于真实领域通过。
5. `npm run agent:retrieval` 必须使用隔离PG，先读脚本所需环境接口；范围泄漏0、无答案误取0、关键尾部召回保持原门槛，其他召回如实报告。无明显收益不新增向量库。

### Task 16: 阶段日志、只读状态与告警闭环（W13）

**Files:** Modify `B/scripts/cron-loop.mjs`, `B/scripts/cron-loop.test.mjs`, `B/src/routes/api/cron/tick.ts`；Create `B/scripts/operations-status.mjs`、`B/scripts/operations-status.test.mjs`；Read `B/src/lib/server/agent-jobs.ts`, `B/src/lib/server/agent-budget.ts`。

1. 用fake响应测试采集/媒体/提取/对账/队列各自失败可区分；网络status0只写错误类别，不含URL查询/token。
2. 保留现summary字段，增加 `stages`、`duration_ms`、`deferred`、`error_code`；调用日志不能把HTTP200等于全成功。
3. status脚本以只读事务查询最近成功、最老队列、unknown保留和备份manifest年龄；不调用会ensureSeeded/tick的业务入口，不输出正文或秘密。
4. 本地告警先输出结构化文件/非0退出；真实通知渠道尚未指定时不发送消息给任何人。新增通知适配仅在用户选定渠道后做，fake端验证触发/去重/恢复。
5. `node --test scripts/cron-loop.test.mjs scripts/operations-status.test.mjs`；隔离故障时生成对应告警事件，恢复后一次解除；把备份不存在与备份过旧分开。

### Task 17: 100/1000源离线容量评测（W14）

**Files:** Create `B/scripts/collection-load-check.mjs`；复用现PG/fixture服务/cron接口；Create `R/docs/operations/loom-capacity-report.md`。

1. 固定seed生成100/1000源，每源两轮各新增10条、20关键词；不触网、不调用模型。先跑100，再1000，数据库各自隔离。
2. 两轮完整执行后应各得到每源20条且重复0；再重放一轮新增0。加入慢源、429、超时和批次截止，失败不能饿死正常源。
3. 记录P50/P95 due-to-start和运行时间、最老等待、内存峰值、DB量、失败/延迟数。T09建议P95≤120秒只适用于选定小规模候选，1000不达标则收窄承诺并记录瓶颈。
4. `node scripts/collection-load-check.mjs --sources 100`，通过后 `--sources 1000`；脚本创建标签资源，测试后仅清理自身资源，失败证据保留。
5. 真实持续时长由T23补，不将快跑fixture变成72h/7天证据。

### Task 18: 汇总自动门禁与新迁移验证（W15）

**Files:** Modify `B/package.json`（新增测试纳入聚合命令）；复用 `B/validation/agent/implementation-v3-2026-09-08/postgres.test.ts`与`migration.test.ts`，新增迁移的回归写同目录合适文件；Update执行记录。

1. 新增测试都进入一个可重复命令，避免只在手工列表存在。保留原测试不降低断言；别将历史测试总数当固定期望。
2. 在独立子进程环境运行下列检查，每个检查独立日志且读取退出码：

```text
npm test
npm run test:manual-fixes
npm run gateway:test
npm run typecheck
npm run lint
go -C workers/agent test ./... -count=1
go -C workers/agent vet ./...
npm run agent:pg
npm run agent:retrieval
```

3. `agent:pg/retrieval`按各自脚本现有环境接口连接新PG，记录0 skip；在Linux隔离容器运行Go race（复用09-16证据所用命令/依赖缓存，勿挂用户秘密）。
4. 迁移需空库→全量、0020旧基线→新增、重复执行幂等、失败中止、现有业务数据保留；不得修改历史0014/0015等已发布迁移以修新需求。
5. 存量lint等失败先区分基线/新增，修影响候选发布者；不能只写“历史问题不管”然后称门禁全绿。迁移失败保留目标，勿碰正式库。

### Task 19: 候选构建与dev/built端到端（W15）

**Files:** 复用 `B/scripts/agent-e2e.mjs`, `B/scripts/agent-integration-harness.mjs`, `B/scripts/browser-smoke.mjs`及已有专项UI脚本；Create/按需扩展 `B/scripts/readiness-ui.mjs`。

1. 用隔离环境、空DATABASE_URL执行 `npm run build`，确认db:migrate明确跳过；T02正式模式不应用于编译进程。build后改源码必须重新build。
2. 读harness当前CLI，再运行 `npm run agent:e2e` 默认离线场景；其worker二进制必须每轮独立，不覆盖55192占用文件。
3. 扩隔离UI只覆盖本次新增交互：关键词partial/error、全文尾部、提取拒绝、来源标记；既有搜索/模型设置/断网专项按相关源码影响重跑，不要求用户重复。
4. dev与built都检查桌面、手机可见正文、按钮、无横向溢出及console/pageerror；用脚本--help/源码确认当前参数，不猜不存在的CLI。
5. PNG及JSON落本批artifact，实际查看；运行差异与默认分享图提示分别记录，不能用截图文件存在当已查看。

### Task 20: 离线候选完成审计与真实门清单（W01/W15）

**Files:** Update release-scope、execution；Create `R/docs/operations/loom-release-candidate.md`、`R/docs/operations/loom-authorization-checklist.md`。

1. 核对T01—T19每项状态、代码diff、测试/未测、是否需要新迁移。无变化的已通过专项不重复测试，明确复用依据。
2. 发布manifest仅含源码/构建标识、迁移、公共配置变量名、证据路径、限制，不含Key/账单账户标识。保留所有原始失败尝试。
3. 生成下面每道门的具体待批准操作，必须包含唯一环境/目标、调用次数/金额、时窗、停止条件和回滚资源；缺字段就不执行真实操作。
4. 完成后可称L0，不称生产就绪；继续T25指南草稿与所有可离线事项，不以缺真实授权结束未完成离线工作。

### Task 21: 真实服务最小验收（W08/W09/W11；Gate A）

**Files:** Update `R/docs/operations/loom-real-service-acceptance.md`、release-scope、execution；证据保存受限的非公开目录，报告只引用脱敏结果。

**前置门：** 用户明确平台/源列表、模型/MCP/OCR服务、允许样本、最大调用数与金额、时间窗；秘密由用户/受控运行环境注入，Agent不读取Key内容。旧手测或旧五号试点不是本门授权。

1. 仅对批准的一个平台/服务先运行最小样本，记录首次、重复、实际新增、内容字段和错误；先完成单源再扩已批准列表。
2. 模型三操作分别核对已有材料、引用、usage；工具链必须有真实工具调用/版本/最终回答证据，未触发工具记未测，不强造PASS。
3. OCR/ASR只对批准的小文件一次执行，结果落库后复读证明无再次调用；不下载任意视频制造测试样本。
4. 对照实际供应商用量/用户提供脱敏账单，未知则保留unknown，不释放成0；不能为测超预算而真的超支。
5. 到达任一上限/风险/窗口截止立即停止该服务；报告real_pass、失败或未测。其他离线工作继续，不自动提高预算。

### Task 22: 业务数据迁移与恢复验收（W02；Gate B）

**Files:** Update `R/docs/operations/loom-backup-restore-runbook.md`和execution；复用T03工具。

**前置门：** 唯一源库、目标库/卷、可读取的业务数据范围、备份位置、停写窗口、恢复时限和最终切换批准。没有真实源数据就只记录新业务库初始化，不声称迁移旧8182。

1. 先只读识别业务库与测试库，记录库指纹/表数/迁移，不打印连接秘密。
2. 用户允许后停止新写入入口/相关调度，处理running任务，再做一致备份；不是停数据库来尝试找回内存。
3. 先恢复新副本并核对行数/摘要/引用/媒体；失败保持源库不变。
4. 最终增量与切换方式写成具体方案供用户确认后执行；随后仅重启批准的应用实例验证持久性。
5. 宿主重启由用户安排，Agent不能自行重启电脑。按真正重启记录恢复时间/丢失窗口；验证通过后才能记录RPO/RTO达标。

### Task 23: 长期试运行与扩大范围（W10/W14；Gate C）

**Files:** Read `R/docs/operations/wechat-pilot-runbook.md`；Update capacity-report、execution；复用 `B/scripts/wechat-validation-report.mjs`及参考CSV格式。

**前置门：** 平台/账号清单、窗口、预算、独立参考集维护人、通知渠道、到期停止动作均明确。自动化提醒不等于停止采集服务；未经用户明确要求不要创建自动化或发送通知。

1. 微信10—20号连续72小时；每天维护真实参考CSV、日报和快照，窗口结束后按手册时限归档，不能日后用health补历史。
2. 达标并重新获批后做100+号7天，期间按批准计划分别重启gateway/scheduler/app并核对去重与数据。
3. 按现手册门槛处理字段有效率、缺失、费用、持续故障；失败修根因并重新定义有效观察窗，不把暂停时间拼成连续通过。
4. PRD1000规模若未真实验证，范围表仍限于实际达标规模；不因1000假源压测通过扩大真实声明。

### Task 24: 正式发布与受控回滚（W15；Gate D）

**Files:** Create `R/docs/operations/loom-release-runbook.md`，Update release-candidate/execution；仅本门可操作批准目标的发布配置。

1. 前置T18/T19候选版本、T21适用服务、T22备份、T23适用规模证据全部通过；确定唯一目标与版本。
2. 在生产副本演练迁移和旧应用兼容性；只追加迁移不保证旧版本兼容，须实际测试。若不可逆，回滚方案必须包含恢复备份及新写入损失处置。
3. 展示最终操作清单：停止哪个调度、处理哪些队列、部署哪个镜像、迁移哪个库、检查哪些业务结果、失败如何退回；最后申请切换确认。
4. 获批后按清单执行，小样本验证并对账；不顺手恢复未批准平台或AUTO。
5. 失败按批准方案回退，记录实际影响，不改证据；成功只宣布范围表中的能力与规模。

### Task 25: 完整使用指南、运营手册和最终交接（W16）

**Files:** Modify `R/docs/使用指南.md`, `B/src/routes/guide.tsx`, `B/src/routes/prd.tsx`, `B/README.md`；Create `R/docs/operations/loom-user-quickstart.md`、`R/docs/operations/loom-release-handoff.md`。业务树同名文档若不存在，不自动整树复制，只按打包契约补必要文件。

1. 在L0阶段先写候选草稿，显著标记fake/未授权项；L1/L2后换为实际已验证的入口、版本与支持矩阵，不提前写生产就绪。
2. 指南按用户动作覆盖：启动与停止、重启留存、模型配置与作用范围、源/CSV、关键词频率、采集状态、筛选与原文、OCR/ASR、分析、简报、库内/工具问答、异步恢复、费用、备份、故障、升级。
3. 操作步骤每项有预期界面、成功证据和失败时处理；真实资料示例只能来自获批材料，Battery fake数字明确仅测试。
4. 助手用隔离候选环境走一次文档路径；用户最终只验收实际研究价值和业务引用，不再重复A05/A14/A18等旧按钮测试。
5. 最终交接列完成/未完成/范围排除、代码文件、命令与计数、证据、数据位置、授权记录、运行资源、回滚及下一任务；全部通过才标L2，缺一门就准确交付当前级别。

## 3. 执行记录模板

```markdown
### Txx — 名称
- 状态：implementing / offline_pass / awaiting_authorization / real_pass
- 代码基线与本项文件：
- 缺陷复现（期望/实际）：
- 最小实现：
- 验证命令/退出码/数量：
- 浏览器截图与实际查看：
- 资源/费用：仅本机假服务 / 经Gate编号授权
- 已知限制与未完成项：
- 证据目录：
- 下一独立任务：
```

## 4. 禁止的完成捷径

- 不将这份计划当真实调用/发布授权；不将源码中的示例凭证当用户批准的凭据。
- 不改旧测试预期、跳过失败或删检索难例来制造PASS；不把编译错误当业务红测试。
- 不让用户重复已通过手测代替后台证据；不在55192污染历史生成。
- 不把主页面200、节点health、F5、导入1000源等同于业务完整、持久化或容量达标。
- 不因没有外部服务而停做剩余离线任务；也不把未授权门静默移出整体完成条件。
- 不新增无关架构；外部授权前的产出必须已经具体可审查，而不是只有“需要Key/批准”。
