# Eino Agent 第三轮收敛 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 保留已验证补强，完成原方案尚缺的结果一致性、统一调用预算、可信成本/证据、异步恢复与全链验收，以业务不变量而非特定反例数量判定完成。

**Architecture:** 沿用TS业务/数据库层＋Go Eino执行层。优先使用已存在的Sql.transaction、预算包装、RunBounded、运行账本和队列，避免并行实现多个完成入口或第二套Agent框架。成功、失败、unknown、重放、恢复均共享所有权和支出规则；外部调用放在短数据库事务之外。

**Tech Stack:** 当前锁定的TS/Zod/React/TanStack、pg/PGlite、Go/Eino ADK/eino-ext、Node/Go测试、Playwright与现有构建脚本，不为这轮收敛升级框架。

---

## 1. 与已有方案的关系

本文件是当前可执行总清单，详细契约继续引用[原架构](2026-09-07-eino-agent-architecture.md)、[原20任务](2026-09-07-eino-agent-implementation-plan.md)、[16项补强](2026-09-08-eino-agent-remediation-plan.md)及[C1—C12方案](2026-09-08-eino-agent-followup-plan.md)。新的实测状态以[第三轮报告](2026-09-08-eino-agent-third-review.md)为准；没有取消旧方案任何尚未满足的要求。

本轮仅完成评审和隔离验证，下面实现任务尚未执行。当前工作区补强未提交，不reset、不覆盖、不先push。保留restart.bat现有改动；若构建刷新生成文件，单独检查，不把生成文件变动当人工业务修改。

不重做：R01—R09、S01—S08、M01—M02已过；固定Go输出/0模型额度、MCP重定向、Skills祖先链接/有界读取、单次ACK错误传播已修；PG skip-locked领取已过；完整build在独立PG上应用14迁移已过；built桌面/手机基础页面已过。

这些通过只覆盖列出的边界。正额度耗尽、并发、失败终态、重放身份、使用费用和完整恢复不能从中推断。

## 2. 任务与依赖

优先顺序：**V1 → V2 → V3**（结果/身份/预算）形成公共契约，**V4/V5/V7**在这些边界上补模型、证据和材料，**V6**完成Worker及恢复，**V8/V9**实现真实评测/验收，**V10**做授权后的真实集成与发布门禁。

单条SQL可以用于正确的原子更新；本计划并非要求每条SQL都用显式事务。对当前涉及多行、锁后指纹计算和跨状态重放的业务，已有Sql.transaction是更直接的方案。实现必须通过真实PG竞争证明，而不是把CTE改名为locked即视为加锁。

### Task V1：所有终态共用真实提交与所有权校验

**覆盖：** C1、原Tasks3/8/16，R3-01/02。

**Files:** 修改 `src/lib/server/agent-runs.ts`, `agent-jobs.ts`, `agent-queue.ts`, `analyze.ts`, `nodes.ts`；复用 `src/lib/db.ts` 的transaction；必要新增 `src/lib/server/agent-completion.ts` 和同名测试。

1. 固定PG-F02/PG-T03/PG-T04及TSP04，补成功/failed/unknown三种终态与租约撤销竞争。测试用两个真实PG连接和明确行锁等待，不以随机sleep代替顺序证据。
2. 同一短事务按统一顺序锁job（若有）→run→当前item/source。锁后用数据库实际时间检查claim、关联、状态和lease/run expiry；单条分析重新读取完整字段计算fingerprint，涵盖published_at/source_name/提取状态。不得基于事务等待前的matched快照判断。
3. 验证后一次提交业务行、run、job及必要预算状态；失败/unknown不插成功业务行，也必须在相同所有权校验后一起变更run/job。任何一步失败回滚，不先failRun再拒绝job。
4. 保留业务行run_id唯一约束作为最后防线，但并发相同complete应返回已有结果，不把23505作为可见正常结果。删除重复完成分支，接通同步、异步、自动分析所有调用者。
5. 测试helper升级为真正transaction时保留原断言/竞争场景。验收：旧正文不标新正文analyzed、撤销claim后旧worker零写入、并发相同完成只有一业务行且双方收到幂等结果、失败时run/job一致。

### Task V2：严格完成信封、重放身份及请求快照

**覆盖：** C2/C3，原Tasks2/3/7/9，TSP01—03。

**Files:** 修改 `src/lib/agent-contract.ts`, `src/lib/server/agent-jobs.ts`, `agent-queue.ts`, `agent-runs.ts`, `analyze.ts`，必要前向迁移及契约测试。

1. 为claim/complete/renew/checkpoint动作建立严格运行时schema；status是明确枚举，run/job/token必须合法。成功response必需，内层run_id/mode与信封/保存run一致，unknown字段策略明确，不靠String/cast默认化非法值。
2. request hash与material hash继续分离；首次保存provider、完整policy、resolved range、sources/scope和稳定意图。claim以事务关联真实run；失败回滚领取。非won分支不得伪造run或丢弃任务身份。
3. 成功时记录规范化完成内容摘要及可验证的完成身份（可用原claim的哈希/现有attempt信息）；重放核对身份、摘要、job/run并返回同一note/analysis ID。不同内容或伪身份409，不因为job已成功就跳过验证。
4. 完成响应丢失与模型结果未知分开：前者只重传同一结果；后者按可信调用事实保留outcome_unknown。用户跨日或材料变更后重放，使用首次请求快照，不重新计算日期/采集结果改变身份。
5. 验收：TSP01—03通过，S03—S05保持通过；相同请求/不同意图、不同provider/scope、内外run_id不一致、非法status、空response、同完成改内容全部有明确测试。

### Task V3：基于真实调用事实的成本准入与结算

**覆盖：** C7、原Task18，R3-03/TSP06。

**Files:** 修改 `agent-queue.ts`, `nodes.ts`, `cron.ts`, V1公共完成入口；新增 `src/lib/server/agent-budget.test.ts` 及后续编号迁移。

1. 增加互为补充的测试：确认未发送可释放；invalid_output/发送后超时不能释放为免费；usage已知结算，usage未知保留预占/unknown。终态failed本身不提供支出证明。
2. 定义可信调用开始/完成收据：在实际发送边界记录尝试身份、policy、model、开始状态、返回usage及是否不确定。来源是受认证执行层，不能只信任完成请求里的error_code或一个可伪造not_sent标签。
3. 同一事务写日预占＋job＋reservation。明细保存模型/价格版本、执行日、费用上界、已知usage/实际费或unknown、唯一结算身份；上界由真实输出/调用限制推导，与V4一致，缺可靠配置则不开放自动付费。
4. 执行跨日重新检查/转移额度；V1终态提交幂等调整明细和reserved/settled日汇总。确定未发送才释放，已知费用按真实用量结算，未知不得归零。用明细与汇总守恒检查防重复结算。
5. PG双连接验证最后额度、重复释放/结算和中途SQL失败；保持0额度零入队。自动筛选复用V7当前材料有效性；完成前保持AUTO_ANALYZE关闭。

### Task V4：预算覆盖实际每次Skill调用及流生命周期

**覆盖：** C4/C6，原Tasks6/11/13/14，R3-04/05。

**Files:** 修改Go `research.go`, `model.go`, `workflow.go`, `tools.go`, `skills.go`及测试。

1. 将本轮TestThirdPositiveSkillBudget加入正式测试，覆盖0、1、N、耗尽后再次调用、Internal＋Skill混合及并行调用。不能只增加if MaxToolCalls==0禁用工具。
2. 在Skill实际执行入口接入同一个tool budget guard；先原子扣减再读取/执行，超额零工具结果。与Internal/MCP共用预算和剩余额度，按实际使用记skill版本，不把available清单当used。
3. 模型实际Generate/Stream/repair累计所有已知usage，失败和重试也记录已发生的事实；未知null。保留已修policy输出wire限制与0模型额度零请求，恢复不得重置计数。
4. Stream包装reader：追踪Recv错误、EOF、取消、Close和最后usage；在终结时记成功/失败及完整持续时间。打开流只能记started，不能把它冒充最终成功。TestThirdStreamLateErrorAudit必须通过。
5. 固定repair带有界原输出＋具体mode schema＋解析错误及证据规则，检查第二次实际请求而不是只预置合法回答。研究repair也补具体schema。验收旧TestFollowup和新TestThird、混合预算及usage累计；有条件跑race。

### Task V5：MCP持久证据与Skills只读拓展契约

**覆盖：** C5/C6，原Tasks12/13。

**Files:** 修改Go `mcp.go`, `skills.go`, `tools.go`；TS `agent-data.ts`及V1完成校验/契约；相关fake MCP测试。

1. 保留已修真实MCP客户端的重定向拒绝和超时；补资源Close生命周期、响应解码前字节/block上限，不只在完全解码后截文本。
2. 为受控MCP适配器提供认证receipt写入动作，绑定service/run/当前token/claim、允许server/tool、结果序号、材料hash及来源元数据。成功持久化后才把证据ID返回模型。
3. ID绑定run/call/result，不用重启可碰撞的全局序号。保存title/允许URL/片段/时间；无法获得来源URL时如实显示服务来源，不制造链接。最终引用仅从服务器收据核验，不能直接信任response.evidence。
4. fake协议服务执行真实initialize/list/call/auth/receipt/complete链，合法外部引用能保存并在历史结果呈现，跨run/伪quote拒绝。Skills合法读继续通过，同时验证junction/盘符/按需资源和V4预算。
5. 保持最小拓展面：明确支持Tools＋已验证transport＋只读Skill包。Resources/Prompts/OAuth、任意脚本执行不在首版已完成声明中，不因“拓展”另造运行框架。

### Task V6：Worker可靠完成确认与真正恢复

**覆盖：** C3/C8，原Task19，R3-05/TSP05。

**Files:** 修改Go `worker.go`, `research.go`；TS `agent-jobs.ts`, `agent-checkpoints.ts`, `agent-queue.ts`；恢复相关迁移与测试。

1. 不止让RunWorkerOnce返回错误；运行循环必须处理并记录错误，保留计算结果到明确ACK。瞬时失败重传同一complete，409旧claim终止，非法结果保留可诊断终态；不能为保存失败重新调用模型。
2. 按锁定Eino版本接通checkpoint ID、claim、实际interrupt/Store.Set/Resume，记录schema/runtime/policy/model/skills、已完成调用和剩余预算。仅传Store不算恢复。
3. checkpoint写入使用V1事务所有权语义，锁后同时验证job lease、run expiry和generation；seq同值同payload幂等，不同payload拒绝。并发seq竞争也验证，不能先SELECT后无保护upsert。
4. 实现续租、失败取消、过期任务安全回收和新generation令牌轮换，续租不突破run总deadline。恢复只继续安全剩余步骤；已发送但无法确定结果的外部调用不能自动重放。
5. 进程级fake测试：checkpoint后kill进程，另一个worker恢复，已完成模型调用计数不增加；complete已提交但回包丢失后重传只得一个业务结果；旧worker取数/写checkpoint/complete全部被拒。

### Task V7：当前材料新鲜度、覆盖和前端结果一致

**覆盖：** C3/C9，原Tasks4/9/10/14/18。

**Files:** 修改 `agent-context.ts`, `agent-data.ts`, `analyze.ts`, `agent-queue.ts`, `fns.ts`, `src/routes/knowledge.tsx`及材料/页面测试。

1. 保留sources≤12、总24000的修复；选择策略必须对应实际模式：固定简报没有get_item工具，不用“工具会取尾部”解释被截尾事实。明确partial，评测决定头/尾/命中窗口分配，不能隐瞒覆盖范围。
2. get_analysis比较当前fingerprint，单条提交包含完整指纹；自动分析不把任何旧succeeded当当前有效。OCR未完成/应提取但尚未建job、analyzed正文变化、来源/发布时间变更均覆盖。
3. 收据保存完整内部/外部来源元数据和区间；非零offset尾段不能标full。动态引用/历史笔记不要用itemId标题/rss占位。
4. 服务端有效async能力包含engine/开关/worker完整配置；关闭时显式async报不可用，停止新领取。前端提供真实异步选择并传参数；not_found/无权/终态停止轮询，失败允许新问题，刷新恢复任务身份。
5. 验收材料尾部/OCR/freshness和UI真实交互，R/M保持绿；基础页面smoke不能替代异步提交/引用/错误恢复检查。

### Task V8：走生产候选路径的SQL检索评测

**覆盖：** C10，原Task20。

**Files:** 修改 `scripts/agent-retrieval-eval.mjs`, `validation/agent/retrieval-cases.json`，新增版本化评测输出。

1. 旧16条小样本结果保留为历史，新增超过实际候选SQL上限、长文末尾、范围边界、重复/无关/无答案语料，标注相关条目及证据区间。
2. 评测调用实际数据库候选查询、rank和V7选材；旧/新策略使用相同候选/字符预算。新增method字符串或另一份复制函数不能证明生产路径。
3. 输出候选recall、最终证据覆盖、无答案误取、截断比例、大小和耗时，包含语料hash/commit/工作区hash。检索质量和模型答案质量分开，不以一个recall替代全部结论。
4. 提前固定范围越界零容忍、关键场景不退化阈值；达不到保留失败，不临时改标签。向量库/索引只有实证需要才加入。
5. 真实SQL评测产物和回归进入正常命令；状态应写“评测路径未实现”直到代码接通，不能仅写“未运行”。

### Task V9：真实Agent harness、迁移和跨平台验收

**覆盖：** C11、原Task16。

**Files:** 重写 `scripts/agent-e2e.mjs`，新增最小 `scripts/agent-integration-harness.mjs`；更新package测试入口、验收记录，保留历史review测试。

1. 当前正式TestFollowup已与旧overlay重名：正式用 `go -C workers/agent test ./internal/agent -run TestFollowup -count=1`；新第三轮probe使用独立名字。更新可复跑说明，不回改旧日志。新测试迁入正式后再移除对旧overlay的执行依赖。
2. harness拥有独立PG、fake模型/MCP、当前Go、当前应用和浏览器；只清理其创建的资源，记录PID/端口/容器身份。对话测试由fake供应商响应，不调用真实付费服务。
3. 浏览器执行同步/异步提问、工具/技能、动态引用、历史结果、刷新、失败重提、预算拒绝；同时断言数据库与网络调用数。加入V6进程kill/重启、complete丢响应与重传，不只检查静态HTML。
4. 完整正常测试＋TS类型＋Go test/vet；PG-F01/F02/T03/T04及新的checkpoint/预算竞争必须过。旧库含run_id=null旧结果的升级、重复迁移、失败回滚单列；本轮只证明新库迁移，不能替代旧库升级。
5. 每次业务代码变更后重新完整build并smoke对应产物。Windows可使用现有npm run preview绑定独立端口，或最小改造preview脚本记录/停止自身PID；不杀未知端口所有者，不因/proc缺失就停止验证。dev/built桌面/手机检查延用本轮方法，但新增Agent行为流。
6. race在支持64位CGO环境执行（可用隔离Linux工具链）；受权限/下载阻断按工具流程请求最小批准，准确记录。缺平台条件不妨碍其他离线实现继续完成。

### Task V10：真实集成与发布回滚门禁

**覆盖：** C12、原Tasks15/17。

**Files:** `docker-compose.yml`, Go main/config、`workers/agent/Dockerfile`, `docs/operations/agent-service.md`, `validation/agent/acceptance-after-remediation.md`；仅启动方式变化时更新startup.sh。

1. 区分liveness/readiness，缺必要配置要明确不可用；健康检查零付费调用。agent宕机时采集/浏览继续，服务token/模型key不进浏览器/日志，Skills目录只读。
2. 在明确授权的实际服务和额度内做最小模型/MCP验证：三模式、tool calling、结构/usage/output limit、认证/名单/外部引用。无凭证或额度授权时完成其余任务，真实项保留待验证，不擅自付费。
3. legacy→eino→legacy全入口回滚，已有job按保存provider/policy结束或明确取消，不切引擎重跑；历史结果仍能读。AUTO_ANALYZE与async逐项独立开放，不能一次切全开。
4. 0014/0015是否已应用不明时用前向迁移，不改历史DDL破坏既有库。验收记录区分代码完成、离线验证、真实可用；提交/push/部署仍按明确授权，不用提交数量判完成。

## 3. 原20任务映射与放行要求

| 原任务 | 当前最短剩余工作 |
|---|---|
| 1 依赖基线 | 保持锁定及通过的编译测试，实际供应商由V10验证 |
| 2 双端契约 | V2严格信封/响应一致与跨语言边界 |
| 3 幂等账本 | V1/V2当前所有权、并发重放和未知状态 |
| 4 材料快照 | V1/V7完整指纹、覆盖与版本 |
| 5 Go执行服务 | 保持RunBounded，V4/V9验证全入口 |
| 6 模型固定流程 | V4格式修复输入、usage累计 |
| 7 引擎切换/客户端 | V2/V7/V10全入口能力与回滚 |
| 8 三操作保存 | V1统一所有终态提交与PG竞争 |
| 9 页面 | V7/V9异步选择/恢复/错误/引用 |
| 10 内部工具 | V7范围/freshness/完整收据 |
| 11 研究循环 | V4模型＋所有工具真正预算 |
| 12 MCP | V5可信持久收据、资源/尺寸约束 |
| 13 Skills | 保留根边界修复，V4/V5实际调用与版本 |
| 14 事件/错误 | V4/V6真实生命周期/累计用量/ACK |
| 15 部署 | 本轮新库build/built页面已过，V10启动/配置/容错 |
| 16 统一验收 | V9完整Agent harness/旧库迁移/真实PG/race |
| 17 真实集成回滚 | V10，授权后执行 |
| 18 自动分析 | V3/V7完整可信账本/就绪/材料一致性 |
| 19 长任务恢复 | V6实际Resume/续租/进程故障验收 |
| 20 检索升级 | V8实际SQL链与质量证据 |

不能再以“所有目前列出的反例变绿”提前结束V1—V9。每项验收覆盖成功、失败、未知、重放、耗尽和并发中适用的场景；缺实际调用者的接口仍属未实现。未来真实收费验证可以待授权，现有离线缺口不应被混入同一阻塞理由。

## 4. 可交给实施Agent的补充指令

在已有[完整执行提示词](2026-09-08-eino-agent-execution-prompt.md)前加入以下内容，避免沿用旧任务完成声明：

```text
继续实施，不是再次只做评审。最新状态以 docs/plans/2026-09-08-eino-agent-third-review.md 为准，按 docs/plans/2026-09-08-eino-agent-completion-plan-v3.md 的V1—V10执行。旧C1—C12要求未作废。

保留已通过的R/S/M/TestFollowup，不reset工作区。优先修PG-T04旧claim仍成功、PG-T03并发complete异常、PG-F02旧材料提交，以及第三轮TSP01—06；V1必须覆盖成功/失败/unknown全部终态。Skills必须在正额度每次调用扣减，不能只拦0。invalid_output不能作为免费释放预算的证明。

新证据位于 validation/agent/review-third-2026-09-08/。正式TestFollowup已存在，不要再使用重名的旧overlay命令；第三轮overlay仅用于独立新探针，正式迁入时同步更新测试入口。

当前已证明Windows可通过npm run preview在独立端口验证built，不以/proc缺失或没有生产数据库授权跳过隔离PG/本地验收。真实付费/生产验证待明确授权，其他可离线实现必须完成后再交付。

每项以完整业务不变量验收，不能只修一组输入值变绿。最终逐项报告V1—V10及原20任务的代码/离线/真实状态，列出命令、竞争证据、截图和仍待验证内容。不要提交/push或改restart.bat，不开启生产Eino/async/auto。保持已有业务改动，修公共入口，不新建第二套Agent框架。
```
