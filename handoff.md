# 2026-09-11 最新交接入口

> **当前状态（2026-09-21）以[统一交付状态](docs/operations/loom-current-status.md)为准。** 本文下方为历史方案或执行快照；其中“未发布、待授权、未修复”只适用于当时，不覆盖后续证据。T21 部分通过、T22 已验证、T23 未完成、T24 已发布但完整回滚验收未闭环；完整 PRD 尚未完成。本次文档修订尚未发布到生产镜像或下载源码包。

请先读 [2026-09-11 Codex接续交接](docs/operations/2026-09-11-handoff.md)。该文件优先于下方历史状态：模型草稿重读、今日简报生成与刷新、五组引用文字核对已经通过；搜索输入返回丢失仍待修，长内容移动测试缺样本，当前PGLite为进程内存库、不支持服务重启保留。本轮未修改业务代码或重跑构建。新会话先处理搜索输入与URL同步（特别区分未按Enter草稿与已提交q），再补隔离测试环境。

可复制的新会话提示词见 [2026-09-11-next-codex-prompt.md](docs/operations/2026-09-11-next-codex-prompt.md)。下方9月9日交接仅供历史追溯，不得据此重做已通过项。

# 2026-09-09 历史交接：本地模型设置与手动验收

本节优先于下方2026-09-01历史交接。旧文件完整备份在 `docs/operations/handoff-before-2026-09-09.md`。目标为本项目上的新Codex会话（code-agent），不是上线批准。本次只生成本地交接文件，不发布、不自动创建会话，也不伪造handoff技能提及的OD导出manifest。

## 当前结论

本地配置文件与模型设置UI已实现，用户真实测试单条分析、同步问答、刷新保留及引用跳转通过。手测仍发现：今日简报异常、详情返回丢筛选、HTML实体未解码、重新读取不重置模型草稿；Telegram媒体提取待定位。这些新发现尚未修复，最近会话主要在指导手测并记录，不能把记录完成当实现完成。下一会话先修复并离线回归，再让用户复测，不要再次只评审。

## 环境、工作区与限制

- 实际Windows/PowerShell，根目录 `F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace`，不是旧说明中的Linux /workspace。
- 当前模型设置源码在 `.worktrees/local-model-settings`，历史分支名 `comet/local-model-settings`，用户实例8182。8080是原实例，8183曾用于built测试，当前存活需重新确认。不要因8182占用就强杀或重复启动。
- 根目录大量未提交业务改动须保留；根Git元数据历史为.repo，必要时用 `git --git-dir=.repo --work-tree=. status --short`；工作树先用正常git检查。创建工作树时复制了155个原有变更文件，依赖node_modules为junction；不得整树覆盖回根目录。
- 不reset/clean、不提交/push、不改restart.bat、不开启生产Eino/async/auto。不代发真实付费模型或生产验证请求。用户手动调用过不等于授权助手无限真实调用。
- 私有配置在工作树 `config/model.local.json`，用户已填Key。禁止读取、打印、归档、截图或提交Key；仅使用脱敏状态。不要新建.env。
- 最后公开配置为 `http://localhost:10100/v1`、`gpt-5.6-luna`、Key已配置。F5后恢复正常，版本短值feba52d44f75；版本可能随重启改变，不硬编码。
- 历史启动为legacy、AUTO_ANALYZE=false、AGENT_ASYNC_RESEARCH_ENABLED=false、AGENT_WORKER_ENABLED=false、无真实DATABASE_URL，使用PGLite。若需启动，先检查已有服务，再用工作树 `npm run dev -- --host 127.0.0.1 --port 8182`；不绕过环境包装器。
- 用户要求助手直接维护测试文档，逐项区分代码、离线、真实状态。UI截图不证明零调用、账单、外部数据库或重启持久化。

## 必读资料（相对根目录）

1. `docs/operations/2026-09-09-manual-test-record.md`：MAN01—MAN30、OBS01及全部截图索引。后面的补充更新前面的待测状态，以最新条目为准。
2. `.worktrees/local-model-settings/docs/operations/local-model-settings.md`：MS01—MS12、私有配置及测试步骤。
3. `docs/operations/2026-09-08-eino-agent-manual-test-guide.md`：完整业务手测指南。
4. `docs/plans/2026-09-08-eino-agent-third-review.md`、`docs/plans/2026-09-08-eino-agent-completion-plan-v3.md`：第三轮基准与V1—V10；实际third-review文件名没有反斜线。
5. `validation/agent/review-third-2026-09-08/`；`validation/agent/implementation-v3-2026-09-08/acceptance.md`、`verification-summary.json`、`workspace-final.json`：竞争与实施证据。
6. 工作树 `docs/comet/changes/local-model-settings/` 及 `.comet/runtime/native/changes/local-model-settings/`。

此前技能：ponytail、comet/comet-native、design-ui。本次读取 `C:/Users/Administrator/.agents/skills/handoff/SKILL.md`，按用户要求落地本地文件；无OD运行上下文，不作远程导出。

## 已有实现与历史验证

工作树主要文件：`src/lib/server/model-config.ts`（私有JSON校验、脱敏状态、版本冲突/锁/原子保存保留Key、models检测、本机访问约束）；`src/routes/api/model-settings.ts`；`src/routes/model-settings.tsx`；`src/components/app-shell.tsx`；`src/lib/server/analyze.ts`（分析/问答/简报共用配置快照）。复用现有入口，没有另建Agent框架。

初始化与保护：`scripts/with-app-env.mjs`、`scripts/model-setup.mjs`、`config/model.example.json`、`.gitignore`、`.dockerignore`、`vite.config.ts`、`scripts/pack-source.mjs`。测试：`src/lib/server/model-config.test.ts`、`src/lib/server/analyze.test.ts`、`scripts/model-settings-ui.mjs`。

历史报告通过（本交接轮未重跑）：配置3 tests、npm test 229 tests、typecheck、build、dev/built UI与smoke桌面及手机。截图在工作树screenshots/model-settings-*。早期Eino报告含隔离PG18及Go tests/vet/race，以implementation-v3原证据核对准确命令。

本轮读取Comet状态为verify/await-user，state_version=14，旧候选 a1346fe1-ae21-4b1c-854c-32a842c704ea，历史7项passed。新缺陷出现后不能把旧pass当完整验收；状态只通过CLI更新，不手改Runtime YAML/JSON。用户尚未明确同意Archive，不自动归档，不干扰其他Comet任务。

## 新缺陷与完整回归要求

| 编号 | 事实 | 接续修复要求 |
| --- | --- | --- |
| MAN10 | 今日简报保存“未提供具体问题”，没有汇总材料 | 追踪briefing公共入口、任务提示及输出校验；有材料应直接汇总，无材料明确反馈，异常输出不得冒充成功保存；覆盖失败与预算一致性。不能仅针对固定错误文本补丁。 |
| MAN30 | 修改模型草稿后测试连接禁用正常，重新读取无效；F5恢复原模型及相同版本 | 检查查询与本地表单同步，尤其服务端值没变时；显式重读重置URL与模型草稿，读取失败不能假成功，不保存不调用模型。代码根因尚未定位。 |
| MAN01/MAN15 | 8080和8182详情“返回内容”丢关键词与平台 | 修公共导航，覆盖搜索/关键词/平台/非默认形态、浏览器后退、详情刷新、新标签、直接打开详情的默认返回，不硬编码固态电池。 |
| MAN02/MAN28/MAN29 | 微信正文混CSS、重复标题来源、段落压平；RSS/Telegram字符实体原样显示 | 修公共提取/清洗，覆盖命名、十进制、十六进制实体和安全边界、普通文本及段落；明确旧数据展示/修复策略，不无授权批量破坏历史数据。 |
| MAN28/MAN29待定位 | 应用durov/547出现大幅模糊钞票图，原消息截图仅表情/文字/链接/引用卡片；应用未保留链接和引用卡片 | 检查媒体是否误取emoji/预览资源，不能把假设当根因。核对media_type=text与image对象语义及内容完整性。 |

样本：`wc-late-001`为宁德时代短片段，非已验证完整原文；Telegram `durov/547`，原页t.me/durov/547。原页$和!正常，应用显示&#036;和&#33;。941k与945K浏览量时间不同，不直接判缺陷。

## 手测结果摘要

- 分析/同步问答生成、刷新保留、知识库展示、引用跳转通过；问答明确材料缺少具体客户，没有补造，来源片段可见。简报未通过。
- 搜索命中/空结果/清空、平台与形态交集通过；返回筛选失败。
- 关键词空白/空格/单字/两字/纯分隔符、混合分隔与去重预览通过；未提交测试词，不能据此判定调度或服务端写入通过。
- 信源RSS必填提示、取消未新增（用户确认）、重开重置、Telegram↔RSS字段切换通过；未用有效地址新增测试信源。
- 任务从空列表变为Durov任务：9月9日16:04、ok、发现20/新增20、manual、尝试telegram_web，Provider横线；具体操作者未知，不能证明Telethon在线或20条均保真。durov/547与时间对应但内容有上述缺陷。
- 公众号提示wechat_gateway_unconfigured；Telethon缺TELEGRAM_WORKER_URL、MinIO缺MINIO_ENDPOINT、OCR/ASR需XAI_API_KEY。文本模型配置不等于这些能力已配置。数据库卡片“在线”同时说明预览PGLite，不能据此认定外部PG在线。
- 真实费用、调用次数、重复扫描去重、重试、服务重启持久化、公众号及媒体链路待验收。
- 截图原位置为 `C:/Users/ADMINI~1/AppData/Local/Temp/`，文件名在手测记录；尚未全部归档，临时文件可能清理。可核对存在后复制到validation，不能包含Key。

## 继续检查与Eino长期要求

在工作树执行适合变更的 `npm run test:model-settings`、`node --experimental-strip-types --test src/lib/server/analyze.test.ts`、`npm test`、`npm run typecheck`、`npm run build`。build含db:migrate，必须先确认当前终端DATABASE_URL为空或指向明确隔离库，不能迁移生产。用 `npm run preview -- --host 127.0.0.1 --port 8183` 验证built并做桌面/手机渲染检查；保留用户8182。

`scripts/model-settings-ui.mjs`会修改配置，只能指向其假网关8190及 `artifacts/model-settings-qa/model.local.json`，严禁用用户真实配置跑脚本。按既有脚本与日志准备隔离服务，不以Windows缺/proc或无生产数据库授权跳过隔离PG/built验收。

V1—V10、旧C1—C12和原20任务未作废。保留已通过R/S/M/TestFollowup；核对PG-T04旧claim、PG-T03并发complete、PG-F02旧材料与TSP01—06的当前代码及证据，不从初始缺陷盲目重做，也不能跳过回归。V1必须覆盖成功/失败/unknown；Skills正额度每次调用扣减；invalid_output不能证明免费释放预算。正式TestFollowup已存在，禁用重名旧overlay；第三轮overlay仅独立新探针，迁正式测试同步入口。

最终报告仍逐项给V1—V10及原20任务代码/离线/真实状态、命令、竞争证据、截图、待验证。MAN01—30是手测编号，不等同原20任务。

## 建议新会话行动顺序

1. 读本节及手测记录，核对Git/工作树/8182服务，不读取Key。
2. 在已有模型工作树修MAN30、MAN10、MAN15及公共清洗/媒体问题，按依赖调整，不只做评审。
3. 增加正式业务回归，完成隔离离线、类型、构建、dev/built桌面手机检查，保留旧通过项。
4. 更新文档为代码已修/离线通过/真实待复测，保留原失败证据；再给用户简短复测步骤。
5. 接续完整指南剩余功能与Eino计划，不擅自真实付费或生产验证。

---

# 2026-09-01 历史交接（仅供追溯，以下状态不代表当前环境）

- 生成时间：2026-09-01 20:03:44 +08:00（Asia/Shanghai）
- 项目根目录：`F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace`
- 微信专项工作树：`F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace\.worktrees\wechat-collection`
- 主分支：`main`
- 微信专项分支：`feature/wechat-collection`
- 两个分支当前基线：`7fe23b1 test: add WeChat scale acceptance report`
- 本文性质：会话交接与后续开发清单，不是上线批准或真实 pilot 验收报告

## 1. 一句话结论

织识 Loom 的控制面、增量采集、关键词、内容库、任务账本、知识层，以及微信公众号网关、主源优先、付费兜底状态机、预算、定时器、CSV 批量接入、健康展示和验收报告工具均已完成代码与确定性 QA；但微信公众号真实 Feed 仍为空，真实 72 小时 pilot、100+ 账号 7 天规模验证和长期服务器迁移均未开始，因此当前状态是“工程实现基本完成，真实数据与生产门槛尚未通过”。

## 2. 必须区分的三个环境

| 环境 | 地址/目录 | 用途 | 当前状态 |
| --- | --- | --- | --- |
| 微信 fixture QA | `http://127.0.0.1:8180` | 虚构 Atom、故障切换、CSV 和 UI 验收 | 已完成多轮手测；不得导入真实号 |
| Loom 生产模式 | `http://127.0.0.1:8080` | 真实 Feed、PostgreSQL、网关和常驻调度 | 尚未开始真实号验证 |
| WeWe RSS 旁路服务 | `http://127.0.0.1:4000` | 将批准的公众号转换为真实 Feed | 容器运行中；`/feeds` 当前为 `[]` |

WeWe 位于独立目录 `C:\Users\Administrator\wewe-rss`，数据在其 `data` 目录。它是旁路 Feed 服务，不应并入 Loom 仓库。

重要网络边界：WeWe 容器在独立 Docker 网络中。Loom 的 `wechat-gateway` 容器不能把 Feed URL 中的 `127.0.0.1:4000` 当成 Windows 主机；真实导入前必须实测以下方案之一：

1. Docker Desktop 下使用 `http://host.docker.internal:4000/...`，并把 `host.docker.internal` 加入 `WECHAT_PRIMARY_ALLOWED_HOSTS`；或
2. 把 WeWe 容器显式接入 Loom Compose 网络，使用稳定容器 DNS 名，并把该主机名加入白名单。

不能在未从 `wechat-gateway` 容器实际取到 Atom 的情况下，仅凭宿主机浏览器能打开就判定主源可用。

## 3. 当前 Git 与工作区状态

### 3.1 主目录 `main`

已有用户改动，接手时不得覆盖或清理：

- `restart.bat`：已修改。
- `0901手动测试文档.md`：未跟踪，记录本轮手动 QA。
- `极致了api成本测算.md`：未跟踪，记录付费 API 成本模型。
- `docs/comet/changes/project-handoff-20260901/`：本次交接的 Comet Native 工件。
- `handoff.md`：本文件。

### 3.2 `feature/wechat-collection` 工作树

未提交改动：

- `docker-compose.yml`：增加可配置的 App/MinIO 宿主端口，避免 QA 与生产端口冲突。
- `package.json`：把详情页路由回归测试加入 `pnpm test`。
- `src/routeTree.gen.ts`：详情页从 `/inbox` 列表子路由改为独立 `/inbox/$itemId` 路由。
- 删除 `src/routes/inbox.$itemId.tsx`，新增 `src/routes/inbox_.$itemId.tsx`。
- 新增 `scripts/inbox-detail-route.test.mjs`。
- 新增 `start-wechat.ps1`：QA/production 启动入口，密钥只放进进程环境。

这些改动对应已手测通过的“内容详情页不再被列表页遮蔽”和 QA/生产并存启动能力。接手者应先验证并提交，不能重置或重写成另一套实现。

## 4. 已完成的工程能力

### 4.1 整体 Loom

- PostgreSQL/PGLite 数据层、MinIO 媒体对象、任务账本和迁移链已存在。
- 信源、关键词、内容、知识库、任务、节点、管道、指南、规格页面均已实现。
- 信源与关键词按游标/时间到期增量扫描，已有去重与失败隔离。
- RSS 与公开新闻源可实采；Telegram 支持 Telethon，未登录时可回退公开网页。
- 内容详情、手动 OCR/ASR、手动 LLM 分析、简报和库内问答已实现。
- Docker Compose 已包含 App、PostgreSQL、MinIO、Telethon、微信网关和常驻 scheduler。

### 4.2 微信公众号专项

- 微信文章稳定 ID：优先 `__biz + mid + idx`，其次规范化 URL，再次账号/标题/日期指纹。
- 微信 Atom 解析保留完整正文；正文输入上限 2 MiB，超限时保留必须字段。
- 独立 `wechat-gateway`、SQLite 状态、鉴权 Feed 与健康接口。
- 主 Feed 优先、连续失败/超时/每日对账触发付费兜底的状态机。
- 极致了客户端、URL/时间/响应边界、错误清洗、预算预留与账本。
- 每日金额和调用次数硬上限、80% 预警基础、付费 outbox/重扫队列。
- Bearer 保护的服务器 cron、单副本 scheduler、并发与单轮时间预算。
- CSV 精确表头校验、RFC 4180 解析、预览、重复识别、选择性确认与逐行失败隔离。
- 单批 500 行通过；1000 行接受；1001 行拒绝。
- 信源页展示 Primary 最近成功、连续失败、付费检查和当日付费汇总。
- 任务页展示 Provider、尝试顺序、发现数、新增数和错误。
- 验收报告工具与真实试运行手册已完成。

## 5. 已完成的 QA，但不能当成真实 pilot

| 项目 | 结果 |
| --- | --- |
| CSV 预览 | 有效 2、重复 1、错误 1 |
| 选择性导入 | 创建 1、跳过 0、失败 0 |
| 定时/手动扫描 | 首次发现 2、新增 2；再次发现 2、新增 0 |
| 长正文 | 8,000 字以上正文可持续滚动，标题、来源、时间和原文链接正常 |
| 原文链接 | 目标以 `https://mp.weixin.qq.com/s?` 开头 |
| 批量上限 | 500、1000、1001 行边界均符合设计 |
| 暂停/启用 | 状态和按钮行为符合预期 |
| 主源故障 | 第一次连续失败 1；第二次连续失败 2并降级 |
| 付费保护 | QA 全程 `今日付费 0 次 · ¥0.00` |
| 主源恢复 | `QA主账号`、`微信测试源` 恢复 `ok/正常/连续失败 0` |
| fixture 报告 | 9 项指标 PASS，`overall: true` |

已知 fixture 限制：封面媒体显示过 `image · error / remote`。这不能证明生产封面提取失败，也不能算封面覆盖率通过；必须用真实 Feed 测量。

## 6. 自动化与质量门现状

在 `feature/wechat-collection` 工作树于 2026-09-01 实际执行：

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm test` | 通过 | 109 项通过，0 失败；另含 26 项报告 CLI/指标测试和 collector 测试 |
| `pnpm typecheck` | 通过 | `tsc --noEmit` 无错误 |
| `pnpm build` | 失败 | `scripts/with-app-env.mjs` 在 Windows 使用 `spawn("vite")`，虽存在 `node_modules/.bin/vite.cmd`，仍报 `spawn vite ENOENT` |
| `pnpm lint` | 失败 | 421 个问题；大部分来自 `.agents` 等工具/技能脚本，但项目源码也有少量真实规则错误 |

构建失败是明确的 Windows 命令解析兼容问题，不应通过绕过 `with-app-env.mjs` 或直接运行 Vite 来规避。修复后必须保留 `.grok/app-env.json` 注入语义，并在 Windows 与 Docker/Linux 各验证一次。

lint 需要先限定产品源码与工具生成目录边界，再修复产品内真实错误；不能简单把整个仓库全部忽略，也不能为了绿灯删除安全检查。

## 7. 对标整体 PRD（FR-01～FR-09）

| PRD | 当前状态 | 尚缺的生产证据/开发 |
| --- | --- | --- |
| FR-01 信源接入 | 基本实现 | 微信、B站、YouTube、抖音、小红书、西瓜的真实来源和规模稳定性未全部验证 |
| FR-02 增量扫描 | 已实现并自动测试 | 需真实 72 小时/7 天证明两小时发现率、重启恢复和无重复突增 |
| FR-03 关键词雷达 | 已实现 | 各平台搜索后端、限流、风控和 100–1000 规模生产验证不足 |
| FR-04 关键词打标 | 已实现 | 需在真实长期库验证召回、误标与性能 |
| FR-05 内容库 | 已实现 | 详情页路由修复尚未提交；真实微信正文/封面覆盖率待测 |
| FR-06 任务账本 | 已实现并完成微信 QA | 真实供应商、24 小时告警、预算账单的持续证据待补 |
| FR-07 LLM 分析 | 已实现为用户触发 | 真实密钥、成本、错误恢复和隐私边界需生产验证 |
| FR-08 简报/问答 | 已实现 | 需用真实长期库验证引用准确性和无材料时的失败行为 |
| FR-09 管道可视化 | UI 已实现 | Telethon、MinIO、微信网关、scheduler 的生产节点状态需长期验证 |

整体 PRD 中明确“已实现”的控制面不等于所有平台已经生产可用。受风控平台目前仍以适配器和可替换 Feed 为主。

## 8. 对标微信公众号专项 PRD

| 专项要求 | 工程状态 | 实测状态 |
| --- | --- | --- |
| 稳定 ID 与跨 Provider 去重 | 已实现、自动测试通过 | fixture 通过；真实短链/长链仍需抽样 |
| 主 Feed 网关与鉴权 Atom | 已实现 | fixture 通过；WeWe 真实 Feed 尚为空 |
| 完整正文与 2 MiB 上限 | 已实现 | 长正文 fixture 通过；真实正文覆盖率未知 |
| 极致了客户端与付费状态机 | 已实现、自动测试通过 | 未使用真实试用凭证调用 |
| 每日预算/调用次数硬上限 | 已实现、自动测试通过 | 未与真实账单对账 |
| 服务器定时入口与 Compose scheduler | 已实现 | QA 通过；长期运行未验证 |
| CSV 预览/导入/500+ 行 | 已实现 | 手工边界测试通过 |
| 健康、Provider、尝试顺序 | 已实现 | QA 故障/恢复通过；24 小时真实告警未验证 |
| 10–20 号 72 小时 pilot | 工具和手册已具备 | 未开始 |
| 100+ 号 7 天验证 | 报告工具已具备 | 未开始 |
| 固定公网出口服务器迁移 | 有设计和手册 | 未开始 |

## 9. 完整剩余任务清单

### P0：在任何真实 pilot 前完成

#### P0-1 收口并保护现有工作树改动

- 依赖：无。
- 操作：审阅 `feature/wechat-collection` 的未提交路由修复、端口覆盖、测试和 `start-wechat.ps1`；不要重置。
- 验证：`pnpm test`、`pnpm typecheck` 通过；详情页 `/inbox/<id>` 直接打开和从列表进入均正常；QA 8180 与生产 8080 可并存。
- 完成标准：改动形成一个范围清晰的提交，提交前用户已有文件不被夹带或覆盖。

#### P0-2 修复 Windows 构建入口并恢复生产构建门

- 依赖：P0-1 的改动已理解，避免并行改同一脚本/包配置。
- 操作：让 `scripts/with-app-env.mjs` 在 Windows 正确启动本地 `.cmd`，同时保留 Linux/Docker 行为、信号转发和环境注入；补一个最小回归检查。
- 验证：Windows `pnpm build`、`pnpm typecheck`、相关测试通过；Docker/Linux 构建也通过；不得改成直接调用 `vite` 绕过 wrapper。
- 完成标准：生产 bundle 成功生成且数据库迁移、PGLite 资产复制步骤完成。

#### P0-3 整理可执行的 lint 门

- 依赖：P0-2。
- 操作：明确 ESLint 应检查的产品源码、脚本和 worker；排除第三方/生成的技能包和构建产物；修复产品源码中真实错误。
- 验证：标准 lint 命令返回 0，且没有用全仓忽略掩盖 `src/`、`scripts/`、`workers/` 的问题。
- 完成标准：测试、类型、构建、lint 四个门均可重复通过。

#### P0-4 完成 WeWe 人工登录和 2–5 个批准号接入

- 依赖：用户完成微信读书扫码；业务/内容/合规批准 2–5 个公开公众号。
- 操作：为稳妥起见，在真号接入前轮换 WeWe `AUTH_CODE`；不要在聊天、日志或仓库输出值。添加 2–5 个批准号，记录显示名、原始 `gh_...`、一篇可打开原文。
- 验证：WeWe `/feeds` 不再为空；每个 Atom 能返回真实标题、发布时间、公众号名、原文链接和正文。
- 完成标准：获得 2–5 条可审计的真实 Feed 映射，不从极致了搜索结果擅自挑号。

#### P0-5 打通 WeWe 到 `wechat-gateway` 的 Docker 网络

- 依赖：P0-4 至少有一个 Feed。
- 操作：在 `host.docker.internal` 与共享 Docker 网络方案中选择最小稳定方案；设置只含 hostname 的 `WECHAT_PRIMARY_ALLOWED_HOSTS`。
- 验证：从 `wechat-gateway` 容器内部请求 Feed 成功；非法主机仍被拒绝；Feed URL 不含账号密码。
- 完成标准：Loom 网关能稳定取到真实 Atom，宿主机 `127.0.0.1` 成功不能替代此检查。

#### P0-6 完成 2–5 号纯主源真实冒烟

- 依赖：P0-1～P0-5。
- 操作：使用生产栈 8080，不加 `-EnablePaidFallback`；CSV 使用精确表头，`wechat_id` 为 `gh_...`，`primary_feed_url` 为经 P0-5 验证的地址。
- 验证：导入、手动扫描、定时扫描成功；任务显示 `Provider primary`；当日付费 0；内容不是 fixture 文本；标题、来源、发布时间、原文链接、长正文均正确。
- 完成标准：2–5 个号至少完成一轮发现与一轮增量无重复扫描，失败可定位且不污染 8180 QA 数据。

#### P0-7 验证真实封面和正文；只在证据失败时修代码

- 依赖：P0-6。
- 操作：抽查不同文章形态；记录正文是否完整、封面是否 HTTPS、媒体对象是否成功。
- 验证：先形成真实覆盖样本；若失败，定位 WeWe Atom、网关归一化、RSS 解析或 MinIO 媒体阶段中的真实根因。
- 完成标准：不根据 fixture 的 `image · error` 预先改代码；任何修复带最小回归测试。

### P1：10–20 号、72 小时真实 pilot

#### P1-1 准备批准清单、参考集和供应商试用输入

- 依赖：P0 全部通过。
- 操作：获得 10–20 个批准号、极致了试用凭证、人工复核人和采购/迁移批准人；创建真实 `validation/wechat-reference.csv`，不能复制 fixture。
- 验证：参考集表头、时间、原文链接和 `provider_known` 符合 runbook；凭证只由秘密管理器/进程环境注入。
- 完成标准：试运行手册中的开始条件全部满足并有人签字负责。

#### P1-2 实测极致了付费兜底

- 依赖：P1-1；先备份网关 SQLite 与主 PostgreSQL。
- 操作：在受控预算下启用真实凭证，验证账号定位、当天发文、历史列表、详情、短链规范化、错误码和账单。
- 验证：主源正常时不调用付费；连续失败/每日对账才调用；调用数、金额、Provider 和尝试顺序一致；无凭证泄漏。
- 完成标准：真实 API 行为与工程状态机一致，预算硬上限可观察且不可突破。

#### P1-3 连续运行 72 小时并保存每日证据

- 依赖：P1-2。
- 操作：每天维护人工结果与供应商结果并集；生成三个 24 小时报告和一个 72 小时聚合报告；保存镜像摘要、非秘密配置、人工记录、供应商导出和账单摘要。
- 验证：必须字段 ≥99%；两小时发现 ≥95%；供应商已知缺失为 0；重复率 <0.1%；正文 ≥80%；HTTPS 封面 ≥90%；24 小时故障全部告警；预算不超限。
- 完成标准：四份真实报告退出码均为 0，证据目录完整，fixture 报告不能替代。

#### P1-4 作出供应商继续/停止决定

- 依赖：P1-3。
- 操作：按专项 PRD 的明确规则判断；只有必须字段 <99% 或供应商已知文章对账后仍缺失，才停止极致了并改测清博。
- 验证：结论引用真实报告与人工证据，不凭价格或单次印象决定。
- 完成标准：采购/迁移批准人记录“继续”“改测清博”或“拒绝扩容”。

### P2：100+ 账号、7 天和生产迁移

#### P2-1 扩至 100+ 个批准号并运行 7 天

- 依赖：P1 全部门通过。
- 操作：批量导入、分批扫描、监控限流、并发、两小时容量、付费预算与数据库增长。
- 验证：每天报告和 7 天聚合报告通过；100+ 号未因 `TICK_LIMIT`、单轮预算或上游限流长期饥饿。
- 完成标准：7 天聚合指标全部达到专项 PRD 门槛。

#### P2-2 完成重启、备份、恢复与重复率验证

- 依赖：P2-1 运行期间。
- 操作：分别重启 `wechat-gateway`、scheduler、App；每次先做 PostgreSQL `pg_dump` 与 SQLite 卷快照，记录前后计数和镜像摘要。
- 验证：状态、队列、预算、文章和游标不回退；没有 duplicate spike；回滚演练不只恢复单侧数据库。
- 完成标准：三类重启证据与一次可读备份/恢复验证齐全。

#### P2-3 迁移到固定公网出口的长期 Docker 服务器

- 依赖：P2-1、P2-2 全部通过并获批准。
- 操作：迁移原有 Compose 服务、持久卷、秘密注入与监控；不在迁移时临时替换采集实现。
- 验证：固定出口、健康检查、备份、日志保留、预算和告警均可运行；迁移后重跑受影响报告。
- 完成标准：长期服务器运行一周无门槛失败，才标记生产可用。

### P3：整体 PRD 的其它生产化缺口

#### P3-1 Telegram 生产规模验证

- 依赖：合法 `api_id/api_hash`、Telethon 人工登录和批准频道。
- 操作：验证 100–1000 频道 GetHistory、FloodWait、游标、重启和会话卷。
- 完成标准：任务无长期饥饿，增量不重复，凭证和会话不进入仓库。

#### P3-2 B站、YouTube、抖音、小红书、西瓜适配器逐平台验收

- 依赖：每个平台合法来源、许可结论和稳定 collector/Feed。
- 操作：每个平台分别定义必须字段、限流、失败、重试、媒体覆盖和规模目标；不要把“有 UI 入口”视为实采完成。
- 完成标准：每个平台有真实样本、自动回归、运行手册和生产结论。

#### P3-3 MinIO、OCR/ASR、LLM 与知识层生产验证

- 依赖：对象存储和批准的模型密钥。
- 操作：验证媒体落盘、四类提取目标、失败重试、成本上限、手动分析、简报和只引用库内材料。
- 完成标准：无静默失败、无页面加载自动扣费、无跨源隐私泄漏，成本可追踪。

#### P3-4 更新 PRD、指南、README 与源码包

- 依赖：当前微信专项代码合并且真实阶段结论明确。
- 操作：同步 `/prd`、`docs/使用指南.md`、README 和下载源码包；明确“适配器”“QA 已过”“真实 pilot 已过”“生产已过”的差异。
- 完成标准：文档不再把尚未完成的真实验收描述成已上线，也不保留过时的直接 WeWe 接入说明。

## 10. 推荐的接手执行顺序

1. 在微信专项工作树检查 `git status`，保护未提交改动。
2. 完成 P0-1：验证并提交详情页路由、端口覆盖、启动脚本。
3. 完成 P0-2、P0-3：恢复 Windows/Linux 构建与可用 lint 门。
4. 等用户完成 WeWe 扫码和提供批准号；在等待期间不要自行搜索或添加公众号。
5. 有真实 Feed 后做 P0-5 网络验证，再做 P0-6 纯主源冒烟。
6. 只有 P0 全绿，才准备极致了凭证和 72 小时 pilot。

## 11. 新 Cursor/Codex 会话完整提示词

将下方整段原样提交给新的 Cursor 或 Codex 会话：

```text
你将接手“织识 Loom”项目的继续开发。请先读证据和规则，再改代码；不要从聊天记忆猜状态。

项目根目录：
F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace

微信公众号专项工作树：
F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace\.worktrees\wechat-collection

第一步必须完整阅读：
1. F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace\AGENTS.md
2. F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace\handoff.md
3. F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace\docs\superpowers\specs\2026-08-28-wechat-public-account-collection-design.md
4. F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace\docs\operations\wechat-pilot-runbook.md
5. 微信专项工作树内三份 2026-08-28 微信 implementation plan、README、start-wechat.ps1 和当前 git diff。

当前基线：main 与 feature/wechat-collection 都指向 7fe23b1。微信专项工作树有未提交改动，包含详情页独立路由修复、回归测试、QA/生产端口覆盖和 start-wechat.ps1。不得 reset、checkout 丢弃、覆盖或重写用户改动；先逐文件审阅并保护。

已验证：
- pnpm test：109 项通过，0 失败。
- pnpm typecheck：通过。
- fixture CSV、批量上限、定时扫描、去重、故障降级、恢复、长正文和原文链接已手工 QA。
- fixture 离线报告 9 项 PASS；它不是真实 pilot。

当前阻塞/风险：
- pnpm build 在 Windows 报 spawn vite ENOENT；node_modules/.bin/vite.cmd 实际存在。根因指向 scripts/with-app-env.mjs 直接 spawn("vite") 的 Windows 命令解析。必须修 wrapper 的跨平台行为，不能绕过它直接启动 Vite。
- pnpm lint 当前失败；大量错误来自 .agents 等工具脚本，也有少量产品源码错误。需要建立合理 lint 边界并修真实错误，不能全仓忽略。
- WeWe RSS 独立运行在 C:\Users\Administrator\wewe-rss，端口 4000，但 /feeds 当前为空；用户尚未完成微信读书扫码并添加批准号。
- WeWe 与 Loom 在不同 Docker 网络。真实 Feed 不能在 gateway 容器里使用 127.0.0.1:4000；需验证 host.docker.internal 或共享网络方案。
- 真实 72 小时 pilot、100+ 账号 7 天验证、付费供应商真实调用和长期服务器迁移均未完成。

你的首个开发目标（按顺序完成，不扩大范围）：
1. 在微信专项工作树检查并验证现有未提交改动。
2. 运行 pnpm test、pnpm typecheck，复现 pnpm build。
3. 用最小跨平台改动修复 scripts/with-app-env.mjs 的 Windows spawn 问题，保留 app-env 注入、信号转发和 Linux/Docker 语义；补一个最小回归测试。
4. 让 pnpm build 在 Windows 成功，再验证 Docker/Linux 构建。
5. 建立可执行的 lint 范围，修产品源码的真实 lint 错误。
6. 在所有质量门通过后，整理并提交当前工作树改动；不要夹带主目录的手测、成本或其它用户文件，除非用户明确要求。

安全与产品边界：
- 8180 是 wechat-fixture QA 栈，绝不导入真实公众号。
- 真实测试使用 8080 生产栈，第一轮不要加 -EnablePaidFallback。
- 不得从极致了搜索结果自行选择公众号；等待用户提供 2–5 个已批准公开号并完成 WeWe 扫码。
- 不得读取、打印、粘贴、提交或记录 AUTH_CODE、DAJIALA_KEY、DAJIALA_VERIFYCODE、Cookie、二维码、验证码、微信读书会话、CRON_SECRET、WECHAT_GATEWAY_TOKEN。
- 如工具输出可能暴露密钥，使用字段化/脱敏查询，不要输出完整容器环境。
- CSV 精确表头：name,wechat_id,sample_url,primary_feed_url,interval_minutes,priority。
- wechat_id 必须是原始 gh_...，不是公开微信号别名。
- primary_feed_url 必须是从 wechat-gateway 容器可访问的真实 Atom；浏览器能打开不等于 Docker 内可达。
- WeWe 保持旁路服务，不并入 Loom 仓库。
- 主源成功时付费调用必须为 0；只有用户批准后才能启用极致了。

实现方式遵循 ponytail：先追真实调用链和根因，复用现有实现，最小 diff，不加新依赖，不做未请求重构；每个非平凡修复留下一个能失败的最小检查。

完成首个目标后，请报告：
- 修改文件和根因；
- 实际运行的 test/typecheck/build/lint 结果；
- 当前 git status；
- 是否已经具备进入 2–5 个真实号纯主源冒烟的条件；
- 若仍阻塞，只说明最小阻塞和需要用户完成的人工动作，不要擅自扩展到付费或真实账号。
```

## 12. 接手者的停止条件

出现以下任一情况应停止当前动作并请求用户，而不是猜测：

- 需要微信读书扫码、公众号批准、极致了凭证或采购决定。
- 需要启用付费、修改每日预算或接触真实密钥。
- 需要删除/重置现有改动、清空数据库或恢复持久卷。
- 真实 Feed 返回的账号与批准清单不一致。
- 构建修复需要改变 app-env 的产品语义，而不只是跨平台启动兼容。
- 72 小时或 7 天报告任一门失败，需要决定修复、停止采购或拒绝迁移。

## 13. 关键文档索引

- 整体 PRD：`src/routes/prd.tsx`
- 微信专项 PRD：`docs/superpowers/specs/2026-08-28-wechat-public-account-collection-design.md`
- 试运行手册：`docs/operations/wechat-pilot-runbook.md`
- 三份实施计划：`docs/superpowers/plans/2026-08-28-wechat-*-implementation-plan.md`
- 使用指南：`docs/使用指南.md`
- 手工 QA：`0901手动测试文档.md`
- 极致了成本：`极致了api成本测算.md`
- 微信专项启动：`.worktrees/wechat-collection/start-wechat.ps1`
- WeWe 旁路目录：`C:\Users\Administrator\wewe-rss`
