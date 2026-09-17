# Eino Agent 实现核验与代码评审（2026-09-08）

结论：**有实质实现，但没有完整实现原方案，也尚未达到可启用的验收标准。** Eino 依赖、HTTP 服务、运行账本、三种操作、工具适配、技能目录和队列表确已进入代码；默认 legacy 分析、异步研究结果落库、调用预算、并发领取与材料一致性存在可复现缺陷。不能以“20 个任务对应的提交都存在”或“现有测试通过”认定 P1/P2/P3 完成。

本轮仅评审、隔离验证和编写整改方案；未修改业务实现、未启用生产 Agent、未调用付费模型或真实外部 MCP。新增回归测试中，断言的是**应当成立的正确行为**，当前失败是缺陷证据，不是已经修复。

## 1. 基线、范围与证据等级

- 需求基线：[架构建议与现状分析](2026-09-07-eino-agent-architecture.md)、[完整详细实现方案](2026-09-07-eino-agent-implementation-plan.md)。
- 被评审 HEAD：`76b6da1ac8a8d6d6c6a4b30e7f0309c9e18fd8b9`。
- 比较基线：`d5a67eb95690f7747d4de13c7a1f7f4697444110`，即合并前主分支父提交。
- 差异规模：72 个文件，约 +7450 / -150 行。存在从依赖探针到检索评测的一组实施提交。
- 参考了用户附件中的 Grok 交接说明；该说明自身也承认真实模型/MCP、PostgreSQL 并发、浏览器与 race 验证尚未完成。
- 本项目 Git 目录为 `.repo`。复核命令：`git --git-dir=.repo --work-tree=. diff d5a67eb95690f7747d4de13c7a1f7f4697444110 HEAD`。
- 工作区原有 `restart.bat` 修改不属于本轮评审变更，也未被本轮覆盖。

证据等级：**复现**＝调用实际项目函数或锁定 SDK，观察到违反正确行为；**代码确认**＝调用链中明确缺少实现，但未对该点执行完整运行场景；**待验证**＝需要真实依赖、部署或专项环境。P1 表示应在启用相关能力前修复，P2 表示必须补齐的可靠性/完整性问题；这里没有把所有缺陷笼统称为安全漏洞。

## 2. 实际执行的检查

| 检查 | 结果 | 能证明什么 |
|---|---|---|
| `npm test` | 通过，三个进程批次分别为 25 / 1 / 156 项，共 182 项 | 现有测试通过；不覆盖下列新增反例 |
| `npm run typecheck` | 通过 | TypeScript 静态类型通过 |
| `CGO_ENABLED=0 GOTOOLCHAIN=local go -C workers/agent test ./... -count=1` | 通过 | 锁定 Go/Eino 的现有离线测试通过 |
| `node scripts/agent-e2e.mjs` | 输出 PASS | 仅证明该脚本中的字符串/复制逻辑断言通过，不能证明页面或端到端运行 |
| 新增 TS 回归 R01—R09 | **9 项失败** | legacy、重放、证据、范围、额度、租约、过期运行、响应体超时、材料元数据缺陷 |
| 隔离 PostgreSQL 多连接 PG01—PG02 | **2 项失败** | 同一任务双领取；并发更新正文后旧分析仍提交 |
| Go overlay 两项探针 | **2 项失败** | Research 绕过模型预算/输出限制，Skills backend 缺少根目录边界 |
| 异步 Worker 闭环探针 | 脚本通过，确认预设的错误现象 | 内部取数 403、complete 200、job 成功但 run 未完成、笔记为 0 |
| Go `-race` | 未执行成功，环境编译失败 | 不能宣称通过；事件切片竞态仅列为代码审查发现 |
| 完整 build、dev/built 浏览器、真实模型/MCP、发布回滚 | 本轮未执行 | 不作通过结论 |

PostgreSQL 验证使用本轮独立创建的 `postgres:16-alpine` 容器 `loom-agent-review-20260908`，独立数据库与测试 schema，未使用应用现有数据库。测试通过明确的行锁等待排列执行顺序，而不是凭随机压测推断竞态。验证后该临时容器已删除，原有服务未被停止。

证据文件及复跑方法：

- [TS 回归源码](../../validation/agent/review-2026-09-08/repro.test.ts)、[实际输出](../../validation/agent/review-2026-09-08/repro-output.txt)。命令：`node --experimental-strip-types --test validation/agent/review-2026-09-08/repro.test.ts`。
- [PostgreSQL 回归源码](../../validation/agent/review-2026-09-08/postgres-race.test.ts)、[实际输出](../../validation/agent/review-2026-09-08/postgres-race-output.txt)。准备独立 PG，按脚本的测试专用连接配置设置 `REVIEW_PG_PORT` 后执行 `node --experimental-strip-types --test validation/agent/review-2026-09-08/postgres-race.test.ts`。禁止把它指向业务数据库。
- [异步 Worker 探针](../../validation/agent/review-spec-worker.mjs)。命令：`node --experimental-strip-types validation/agent/review-spec-worker.mjs`；它断言错误现象已经出现，修复时应改成正常业务行为测试。
- [Go 探针](../../validation/agent/review-standards-probe_test.go)、[overlay 映射](../../validation/agent/review-standards-overlay.json)、[审查说明](../../validation/agent/review-standards-results.md)、[实际输出](../../validation/agent/review-2026-09-08/go-probe-output.txt)。overlay 使用本机绝对路径，换工作区需重新生成映射。

Go 探针命令（PowerShell；模型请求仅发向测试进程的 httptest）：

```powershell
$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
go -C workers/agent test -overlay ../../validation/agent/review-standards-overlay.json ./internal/agent -run 'TestReviewStandardsResearchBudget|TestReviewStandardsSkillRoot' -v -count=1
```

## 3. 原方案 20 项任务逐项核验

“部分”包括实现代码存在但关键要求未满足；“待验收”不等于失败，也不等于完成。

| 原任务 | 当前状态 | 已实现 | 未满足 / 关联发现 |
|---|---|---|---|
| 1 依赖、模型适配基线 | 离线部分完成 | Go 模块锁定、兼容性探针、现有测试可编译 | 真实供应商能力仍待 Task 17 验收 |
| 2 双端契约 | 部分 | TS/Go 类型、结构校验、fixtures | legacy 包装不匹配；跨语言脚本未覆盖真实双端收发与全部 missing/null 边界，A01 |
| 3 运行账本与幂等 | 部分 | 唯一请求、状态表、claim token | 过期悬挂、重放依赖当前材料、提交 fencing，A04/A05 |
| 4 材料与引用 | 部分 | 摘要截取、快照、基础引用校验 | 新工具证据不能完成闭环、材料上限/指纹遗漏，A03/A04/A09 |
| 5 Go HTTP 服务 | 部分 | 认证、HTTP 限流/请求校验 | Worker 直调绕开统一入口；完整响应体 deadline，B05 |
| 6 固定分析流程 | 部分 | Eino 模型适配、结构校验/修复流程 | 默认 legacy 回归、输出 token 限额未下传、修复重复计数，A01/B01/B02 |
| 7 客户端与引擎切换 | 部分 | 配置开关、HTTP 客户端 | UI 异步固定选 Eino，回滚不覆盖全部入口；响应体超时，A02/B05 |
| 8 三种操作与原子保存 | 不满足核心验收 | 同步分支存在运行与业务写入 | async 丢弃结果，pg stale 写入复现，A02/A04 |
| 9 页面兼容与重试 | 部分 | 状态展示、轮询、局部引用展示 | 默认异步无能力门禁、刷新丢 job、失败无法重提，A02 |
| 10 内部检索 API | 部分 | 服务令牌、运行令牌、参数化查询 | get_item/get_analysis 越出范围，OR/AND 优先级错误，A06 |
| 11 Tools/研究循环 | 部分 | Eino ADK Agent、内部工具 | 模型调用不受公共预算保护，证据缺口/提示冲突，A03/B01/B02 |
| 12 MCP | 部分 | transport、名单、名称校验 | TokenEnv 未生效、证据标识重复且无法被模型可靠引用，B03 |
| 13 Skills | 部分 | 只读工具与技能包 | root/symlink 边界未成立，技能调用预算及实际使用版本不完整，B04 |
| 14 事件与错误收敛 | 部分 | runtime 结构、部分日志/UI | research usage 缺失、模型调用记 0、并行事件写入、未收敛过期状态，B01/B06/A05 |
| 15 部署与启动契约 | 配置存在，待验收 | Docker/Compose/操作说明 | 必须以修复后的代码重做健康/就绪、worker 开关及启动验收 |
| 16 统一回归与浏览器 | **未完成** | 既有单测与类型检查通过 | agent-e2e 非 E2E，真实 pg 新用例失败，dev/built 未验，A10 |
| 17 真实集成、发布、回滚 | **未完成** | 文档与预定步骤 | 无真实模型/MCP、完整回滚验收；不能宣称已发布可用 |
| 18 自动分析调度 | 部分，不应启用 | ai_jobs、预算表、调度函数 | 首次额度检查漏掉、无真实结算、状态/材料筛选不完整，A07 |
| 19 长任务与恢复 | **骨架，未闭环** | checkpoint 表/API/httpStore | Runner 未使用 Store、无续租/恢复闭环、异步结果未保存，A02/A08 |
| 20 检索质量升级 | 部分 | 排序函数、小样本脚本 | 评测未走实际候选 SQL、长正文/截断和真实质量未验，A09/A10 |

## 4. 主审业务复核明细（A 编号）

### A01 · P1 · 默认 legacy 单条分析不能接受其自己要求的输出【复现 R01】

[analyze.ts:125](../../src/lib/server/analyze.ts#L125) 中 `executeLegacy` 向模型要求平铺的 `summary/topics/entities/insights/tags`；约第 138 行把这些字段直接铺进 `result`。共享契约却要求 `result.analysis`。按提示精确返回的有效 JSON 被拒绝为 `invalid_output`，提示出现 `Unrecognized keys`。默认配置仍为 legacy，因此这不是仅影响新引擎的边角问题。

修复方向：保留旧模型提示/既有结果语义，在唯一适配边界规范化为共享契约；为旧式返回增加真实 analyzeItemWith 回归，不只测手造新契约。

### A02 · P1 · 研究页面强制进入未闭环的异步 Eino 路径【代码确认＋Worker 探针】

[knowledge.tsx:35](../../src/routes/knowledge.tsx#L35) 始终传 `async: true`；[agent-jobs.ts:19](../../src/lib/server/agent-jobs.ts#L19) 固定创建 `provider: eino`。因此 legacy 默认与回滚配置没有覆盖研究页面。领取响应缺少材料快照和运行取数令牌，Worker 首次内部取数被 403 拒绝。

[agent-jobs.ts:61](../../src/lib/server/agent-jobs.ts#L61) 的 complete 仅修改 job，忽略 Worker 提交的 `response`，没有校验/保存研究笔记或结束 ai_run。探针结果：`completionStatus=200, job=succeeded, run=running, response_json=null, noteCount=0`。这证明即使模型返回成功，用户仍得不到持久化答案。

页面还只把 jobId 放在组件 state，刷新后丢失；失败状态不清理当前任务，按钮持续禁用，轮询缺少合理停止策略。先恢复有能力门禁的同步默认，再接通异步完整生命周期。

### A03 · P1 · 研究工具获得的新证据不能通过最终引用校验【复现 R03】

[analyze.ts:346](../../src/lib/server/analyze.ts#L346) 最终校验只使用最初 `selected.sources`，不把运行期间通过 `agent-data` 保存的可信证据收据纳入；有效的新证据返回 `invalid_citation`。Go evidenceBag 仅识别顶层 `evidence_id`，不识别 `search_items.items[]`；外部引用也未完整传回前端。

必须用 run 内服务器保存的收据构造最终允许引用集合，不能直接信任模型返回的 `executed.evidence`。同时统一种子与工具片段 ID：现有 `item:id:index` 与 `item:id:start` 的语义不一致，存在标识碰撞空间。有效新增材料应能引用，伪造 ID、篡改 quote 和跨运行收据必须拒绝。

### A04 · P1 · PostgreSQL 原子性与材料一致性没有成立【复现 PG01 / PG02 / R09】

[agent-queue.ts:151](../../src/lib/server/agent-queue.ts#L151) 的领取更新，外层条件只有子查询选出的 id，未通过行锁或条件更新确保 queued 状态仍有效。两个真实 PG 连接竞争，**同一 job 返回两次不同 claim token**；双领取已经造成重复执行/计费风险，即使最终 token 可挡掉一个写入也不够。

[agent-runs.ts:255](../../src/lib/server/agent-runs.ts#L255) 先以 CTE 快照匹配材料，最后更新 items 只按 id。测试在分析提交阻塞时并发提交新正文，结果仍为 `ok`，`body=new body` 而 `pipeline_status=analyzed`：旧结论被当成新正文分析。指纹包含的 `source_name/published_at` 也没有全部进入完成比较，R09 单独证实 source_name 更新未阻止保存。

必须在真实事务/正确条件更新中锁定并复核当前 run、claim、租约和材料版本；不能仅再加一个普通 SELECT 或把同一套 CTE 换个名字。

### A05 · P1 · 幂等重放与过期状态处理缺失【复现 R02 / R07 / R06】

`analyzeItemWith` 先读取当前正文再查询历史请求；已成功的相同请求，在正文被清空后不能重放成功结果。briefing 的新请求哈希依赖每次重算的“今天”，跨日相同请求可能误冲突。

[agent-runs.ts:152](../../src/lib/server/agent-runs.ts#L152) 将过期 running 仍返回 `in_progress`；failRun 又要求未过期，未找到可靠的超时收敛入口。[agent-queue.ts:200](../../src/lib/server/agent-queue.ts#L200) 完成条件没有 `lease_until > now()`，过期 worker 仍能提交。异常出口还可能把运行留在 running。

应先按稳定请求标识处理重放/冲突，保存首次归一化输入；区分已知未执行失败与调用结果未知，不能因租约过期就默认重新计费执行。

### A06 · P1 · 内部工具没有在所有动作执行同一数据范围【复现 R04＋代码确认】

[agent-data.ts:100](../../src/lib/server/agent-data.ts#L100) `get_item` 只按 id 查询，未约束保存的运行时间范围；Jan 1—2 的运行能读取 Sept 7 的条目。[约 120 行](../../src/lib/server/agent-data.ts#L120) `get_analysis` 同样漏范围，且 stale 只检查旧 hash 是否存在，没有与当前材料比较。

搜索条件拼成 `term1 OR term2 AND range`，SQL 优先级使前项绕过范围。当前参数化查询没有发现 SQL 注入；问题是授权范围语义，而不是字符串注入。范围必须从已保存的 run 取出，并在每种数据动作的查询中生效，调用参数只能进一步缩小它。

### A07 · P1 · 自动分析的日额度约束与结算不完整【复现 R05＋代码确认】

[agent-queue.ts:123](../../src/lib/server/agent-queue.ts#L123) 首次预算行 INSERT 没有限额条件，只有冲突 UPDATE 检查：每日次数/金额均为 0 时，仍入队 1 条并预占 1 元。预占与入队分成查询，缺少事务关系；未找到 `settled_*` 的实际结算流程。固定 worstCost=1 不能替代按供应商价格、输入/输出和最大调用次数计算的上界。

自动筛选还需验证未创建提取任务、旧分析对应旧指纹、源名称映射、跨日排队等场景。在预算账本闭环前保持自动开关关闭。

### A08 · P1 · checkpoint 表和接口尚不构成可恢复 Agent【代码确认】

[research.go:58](../../workers/agent/internal/agent/research.go#L58) 创建 Runner 未配置 CheckPointStore；[worker.go:23](../../workers/agent/internal/agent/worker.go#L23) 的 httpStore 只定义没有接入，无可靠 Resume、续租和过期任务恢复流程。checkpoint 保存对 claim 的检查和写入分开，序号不保证递增，部分未写入情况仍可返回成功，schemaVersion 兼容判定不完整。

因此只能认定“恢复基础表/API 存在”。不应对外宣称长任务断点恢复已经实现。需要实际进程中断、替代 worker 恢复、旧 token 拒绝、版本不兼容拒绝及副作用不重放的验收。

### A09 · P2 · 材料覆盖和检索改善仅部分满足设计【代码确认】

候选种子可达 8 条 × 2 段＝16 个 sources，而契约上限 12；按每条 4000 字符选材又可能超出原方案总量 24000 的约束。输入 `materialIncomplete` 没有在单条分析主入口完整传入，不能稳定体现 OCR 未完成。get_item 从非零偏移读到短尾部时的 coverage 可能被标 full。

现有离线评测只有 16 条小材料、22 个问题；比较的是脚本内全量小集合排序，未走实际 SQL 候选截断、长正文和生产材料选择。分数可以说明小样本函数表现，不能证明实际检索链已经达到 Task 20 要求。

### A10 · P1（验收门禁）· 标为 e2e 的脚本没有执行端到端验证【代码确认】

[scripts/agent-e2e.mjs](../../scripts/agent-e2e.mjs) 复制辅助逻辑并断言手造字符串，`rendered` 是固定链接文本；没有启动/访问应用、没有浏览器，也没有调用真实业务函数。AGENT_E2E_TARGET 只做主机名检查。故其 PASS 与“研究页面可完成”“刷新可恢复”“引用可打开”没有证据关系。

必须替换为应用路由＋真实数据库＋fake 模型服务的浏览器检查，并完成 dev/built 双环境、旧库升级与 PG 多连接门禁。真实供应商验收单列，不用假模型通过替代。

## 5. 主审运行边界复核明细（B 编号）

### B01 · P1 · ADK 研究绕过模型预算和 usage 统计【Go 探针复现】

[research.go:49](../../workers/agent/internal/agent/research.go#L49) 把原始 ChatModel 直接传给 ADK；它不经过固定流程的预算扣减入口。设置 `max_model_calls=1` 时，假供应商实际收到 **2 次 HTTP 请求**，响应仍 `ok=true`，记录 `ModelCalls=0`，即使供应商提供 usage，research 的 InputTokens/OutputTokens 仍为空。

[model.go:23](../../workers/agent/internal/agent/model.go#L23) 配置未把 `max_output_tokens_per_call` 传给模型；探针检查实际 JSON 既无 max_tokens 也无 max_completion_tokens。必须使用一个受预算保护的模型适配边界覆盖 Generate/Stream/工具绑定后实例及修复调用，统计实际请求，限制实际线上参数。

### B02 · P2 · 修复缺少必要输入、重复扣预算，研究提示与工具设计冲突【代码确认】

研究 repair 先 `takeModel`，随后 `generateOnce` 再扣一次，同一修复调用消耗两次额度，可能错误拒绝合法修复。workflow.go:74 和 research.go:85 的修复消息只有解析错误，没有原输出和目标 schema；预设第二次返回合法答案的测试掩盖了真实修复缺少上下文的问题。研究提示又复用基础提示中的 “Do not call tools”，同时要求 ADK 用工具。将权限/次数硬限制置于运行时；按 mode 生成一致提示，修复传递有界原输出、目标结构和校验错误，且只经一次公共模型入口。

### B03 · P1 · MCP 鉴权与外部证据没有实现闭环【代码确认】

[mcp.go:26](../../workers/agent/internal/agent/mcp.go#L26) 声明 TokenEnv 但未实际读取/注入客户端；配置看似支持鉴权，调用却不会按预期携带凭据。每次运行创建连接，未建立明确关闭生命周期；未配置明确的重定向凭据策略。

证据 ID 固定为 `mcp:` 加工具名，同工具不同调用发生碰撞；返回模型的文本没有完整注入可引用证据 ID，source URL 和最终外部引用存储也不完整。保留当前 transport/空白名单=零工具设计，补齐鉴权、唯一收据、尺寸限制、生命周期和持久化；不额外声称 Resources/Prompts/OAuth 已实现。

### B04 · P1 · Skills backend 的 root 边界失效【探针复现＋代码确认】

[skills.go:24](../../workers/agent/internal/agent/skills.go#L24) Read 未使用配置 root，只做路径清洗和 `..` 检查；直接传根目录外的绝对路径可以读到测试 sentinel。GlobInfo 用 os.Stat 跟随 SKILL.md 符号链接，skillVersions 忽略 Walk 返回的拒绝错误。

这证明 backend 边界不成立，**不等于已经证明模型通过当前 skill 工具可任意选择系统路径**；当前名称发现机制有额外限制。修复应在真实读取入口验证解析后的路径属于 root，拒绝越界 symlink，并为引用资源做同样检查；不依赖日志扫描替代访问校验。技能工具也必须计入总工具预算，版本记录应区分可用与实际使用。

### B05 · P2 · 客户端 deadline/字节限制未覆盖响应体；Worker 绕过 HTTP 执行边界【复现 R08＋代码确认】

[agent-client.ts:71](../../src/lib/server/agent-client.ts#L71) 在收到响应头后清理超时，再 `arrayBuffer()` 读完整响应才检查大小。10ms 超时、80ms 延迟响应体仍正常返回；大响应先整体分配内存。应保持 abort 到解码/校验结束，并流式累计字节，超限立即取消。

Worker 直接调用 execute，不经过 HTTP handler 的并发槽位和整体 deadline 控制；应抽取/复用最小执行边界供两种入口共同调用。HTTP 和队列分别设置看似相同的数字不能形成服务级共享限制。

### B06 · P1 · 并行事件写入缺少同步，运行可观测性不完整【代码确认，race 未验】

[tools.go:134](../../workers/agent/internal/agent/tools.go#L134) 多个工具向共享 events 切片 append 无同步；Eino 工具节点可并行执行。当前平台 race 编译失败，不能写成“已检测到数据竞争”，但应把并行工具 race 用例纳入支持环境验证。

模型请求、工具/skill/MCP、修复与最终保存事件尚未统一形成有界运行记录；研究成本数据不完整，失败/结果未知路径也未收敛到可审计状态。不要记录未提供 usage 为 0，也不要用工具步骤数代替模型调用次数。

## 6. 应保留的实现与建议交付顺序

保留 TS 业务层＋Go Eino 执行层分工、已有契约与表、模型适配、显式 engine 选择、参数化数据接口、MCP 空名单语义和只读 Skills 方向。这些是可用基础，问题在关键调用链未贯通和运行约束未落到真正执行入口，不需要再增加一个 Agent 框架或重写采集模块。

先修复默认/同步操作和 PG 数据一致性，再统一预算与证据，之后接通异步结果和恢复；自动分析应等成本账本闭环后开启。部署与真实验收完成前，文档应将 P1/P2/P3 改为“部分实现/待验收”，不能继续使用“全部完成”。

完整的文件级整改步骤、依赖顺序、回归命令及放行标准见：[Eino Agent 补强实施方案](2026-09-08-eino-agent-remediation-plan.md)。

以下保留两位独立审查者的原序结论，未将两个审查轴合并排序。前面的 A/B 编号是主审结合运行验证展开的整改引用编号。

## Standards

1. **[P1] 模型预算未执行。** research.go:49 直接传 cm，绕过计数；model.go:23 未设置输出 token 上限。离线实测限 1 次却发送 2 次 HTTP、返回成功且 model_calls=0，供应商 usage 丢失。Skill Tool 同样绕过计数。违反原方案第 292—300 行“包括修复及技能加载、每次供应商请求适配层计数”。
2. **[P1] 并行工具事件存在数据竞争风险。** tools.go:134 对共享 events 无锁 append，Eino 并行调用可能丢事件或损坏切片。违反原方案第 843、934 行并发安全和审计要求。race 探针本机编译失败，当前是静态发现。
3. **[P1] MCP 鉴权和证据闭环不完整。** mcp.go:67 未读取 TokenEnv；140—143 行同工具每次使用相同 evidence ID、不解析来源 URL，也未把 ID 返回模型。违反原方案第 345、875 行。
4. **[P1] Skills 目录边界未成立。** skills.go:24—29 不使用 root；第 57 行跟随 SKILL.md symlink；第 77 行丢弃 Walk 拒绝错误。底层根外读取已复现，不等于模型可任意选路径。违反原方案第 367 行。
5. **[P2] 格式修复缺少必要输入。** workflow.go:74—78、research.go:85—87 只有错误，无原输出与目标 schema；后者重复扣额度。违反原方案第 698 行“结构错误与必要输出”。
6. **[P2] 研究指令冲突。** research.go:48 复用 workflow.go:135 的 Do not call tools，又要求检索工具。违反原架构 §4.2 研究工具循环设计。

启发式意见：countedModel 只有定义，没有实现或调用，属于可能的过早抽象；优先把它接到真实预算边界。此意见不是额外硬性违规。

## Spec

1. **[P1／错误] 异步成功结果丢失。** agent-jobs.ts:61 忽略 response，只更新 job，不保存答案、引用、usage 或结束 ai_runs。违反原方案第 1118 行保存事件和完成结果。
2. **[P1／错误] 异步研究不能读取内部材料。** agent-jobs.ts:19 未生成运行令牌；worker.go:133 不传令牌或初始材料；agent-data.ts:45 拒绝。违反原方案第 1118、1190 行认证契约。
3. **[P1／错误] 原问答与回滚被异步入口替换。** knowledge.tsx:35 无条件 async，agent-jobs.ts:20 固定 Eino；失败后不清 jobId、刷新丢 id。违反原方案第 1056、1122、1126 行回滚、有界轮询及验收后开放入口。
4. **[P1／缺失] 断点恢复没有接线。** worker.go:23 的 httpStore 未实例化，research.go:58 未配置 CheckPointStore；无续租、Resume、过期任务处理。违反原方案第 1120、1126 行。
5. **[P1／错误] 完成围栏不检查租约。** agent-queue.ts:215 只查 token/status；agent-checkpoints.ts:29 同样漏租约且检查/写入非原子，不保证递增序号。违反原方案第 1110、1122 行。
6. **[P1／部分] 金额预算没有结算闭环。** agent-queue.ts:128 首次 INSERT 不受上限限制；nodes.ts 的完成路径只结束 job，无 settled_* 更新，未关联预算日/价格版本。违反原方案第 1074、1084 行。
7. **[P2／部分] 评测不能证明生产检索效果。** agent-retrieval-eval.mjs:43 对 16 条内存材料排序，绕过 SQL 最近 40 候选和材料截断，缺实际长文、耗时/token/引用准确性验证。违反原方案第 1145、1157 行。

独立评审统计：Standards 共 6 项，最严重为 P1 模型预算绕过等运行边界问题；Spec 共 7 项，最严重为 P1 异步结果丢失等业务闭环问题。
