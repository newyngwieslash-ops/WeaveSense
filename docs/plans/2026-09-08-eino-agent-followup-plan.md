# Eino Agent 剩余闭环 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 保留已经通过回归的补强，修复二次核验发现的实际缺口，完成原方案中尚未实现或未验收的同步/异步、预算、证据、MCP/Skills、恢复和部署链路。

**Architecture:** TS 仍负责权限、快照、请求/任务账本及唯一结果提交；Go Eino 负责真实受限的执行。把现有 Sql.transaction、budgetModel、RunBounded 和 receipt 机制接入所有实际调用者，不再增加并行框架。每个任务先固定正确业务不变量，再修共享入口，最后验证故障、并发及跨语言行为。

**Tech Stack:** 现有 TypeScript/Zod/React/TanStack、pg/PGlite、Go/Eino ADK/eino-ext、Node test/Go test、现有浏览器工具和 Docker Compose；保持锁定依赖，除非有明确不兼容证据，不升级或新增框架。

---

## 1. 使用方式与完成边界

这是对[原20项方案](2026-09-07-eino-agent-implementation-plan.md)和[16项补强方案](2026-09-08-eino-agent-remediation-plan.md)的**剩余工作清单**。它不会把未满足的旧要求作废；沿用旧方案完整契约、测试要求和上限。本轮实测依据见[二次评审](2026-09-08-eino-agent-followup-review.md)。

当前工作区有未提交有效修复，不执行 reset/checkout 覆盖。HEAD 76b6da1 只是原合并点；实施前读取[工作区指纹](../../validation/agent/review-followup-2026-09-08/workspace-snapshot.json)，检查是否有后续变更，再决定测试基线。所有步骤在当前 Windows 实际环境执行，Linux路径只是部署约定，不应因不存在 `/workspace` 就跳过可在本机进行的应用验证。

不重新实现已修项：legacy JSON适配、R01—R09、正常Research/Stream计数、直接Skills根外检查、内部工具事件锁、TokenEnv header、PG skip-locked领取、RunBounded、客户端body超时。继续保留这些回归。

交付分两级：

- **离线功能完成**：下面 C1—C11 的代码、假服务、真实PG、完整build及浏览器/故障验收通过。无法执行的race或平台特定检查单列，不能称完全验收。
- **真实集成可启用**：C12 在明确授权和额度下验证实际模型、已配置MCP、部署、回滚。缺授权时不作付费调用，完成其他独立工作后交付准确的待验证项。关闭开关是部署状态，不是能力实现证明。

默认保持 legacy、async=false、auto=false；不要提交/push、改用户restart.bat或真实环境、创建.env、启用自动付费调度。本计划请求的是实现与本地验收；提交与发布由明确授权单独控制。

## 2. 不变量与接口约定

1. request_id 唯一标识稳定用户意图；request_hash 与 material_hash 分开。相同意图重放，不同意图409；服务器生成的首次日期/范围与快照不能在重试中重新计算。
2. claim 只返回数据库真实存在且与job关联的run；非won分支必须显式处理。运行令牌仅当前generation有效，令牌原文不持久化或写日志。
3. `job=succeeded` ⇒ run=succeeded＋response_json＋业务行存在。缺response、伪造run_id/模式、过期lease或旧claim不得写任何成功业务行。
4. 完成调用应幂等：结果已提交但响应丢失后，只重传complete，不重跑模型。相同完成身份/内容返回同一业务id，不同内容拒绝。
5. 单条分析提交前，在事务锁后复核完整当前材料；简报/研究保留历史快照语义。日期、来源名、正文、标题等影响fingerprint的字段必须一致。
6. Generate/Stream/repair/BindTools实例、Skill/Internal/MCP使用同一次运行预算；0额度表示0调用，失败/恢复不能凭空重置额度。
7. receipt必须由已认证执行/数据边界保存到指定run，模型自报evidence无权直接扩展可信集合。收据数量、总字节、片段及元数据都受限。
8. 预占、job和reservation要么全成功要么全失败；完成/释放/unknown与对应运行状态一致且可幂等对账。未知usage保留未知，不记录0。
9. checkpoint绑定run/job/claim generation、版本、序号、剩余预算与已完成调用。只有安全恢复点能继续；不确定已发送调用不盲目重复。

建议的最小完成接口（项目自有接口，不是假定SDK API）：

```typescript
type CompletionInput = {
  runId: string;
  jobId?: string;
  claimToken: string;
  response: unknown;
};
// 解析、授权、材料/receipt校验、业务/run/job/账本提交均在该共享入口收敛。
// 完整类型以现有ExecuteResponse和业务结果联合为准，不添加无需求的插件接口。
```

事务步骤固定为：锁job（若存在）→锁run→锁相关item/source→用数据库当前时间复核lease→读取最新材料/收据→比较完整指纹→写业务行/run/job/结算。所有调用者同一锁顺序；租约检查不能用等待前的旧SELECT结果。外部模型调用始终在事务外，避免长时间占锁。

## 3. 任务依赖

`C1 → C2 → C3 → C8 → C11 → C12` 为结果/任务主线；`C4 → C5/C6 → C11` 为执行与拓展主线；`C2+C4 → C7 → C11` 为成本主线；`C9 → C10 → C11` 为材料/检索主线。共享契约先顺序完成，再考虑互不重叠的工作；不让多个agent同时发明完成接口。

### Task C1：把事务真正接入结果保存

**对应：** F01；原补强T3/T5/T8。**Files:** 修改 `src/lib/db.ts`, `src/lib/server/agent-runs.ts`, `agent-jobs.ts`, `agent-queue.ts`, `analyze.ts`, `nodes.ts`；必要时新增 `src/lib/server/agent-completion.ts` 和其测试，禁止多处复制完成逻辑。

1. 运行 S01/S02/S03、PG-F02，确认当前错误；为成功complete缺response、跨job/run、错误schema/mode、租约等待过期、部分SQL失败分别补测试。
2. 将业务入口依赖改为真正支持transaction的有限接口，复用已有pg/PGlite实现。取消任何“缺transaction时直接执行callback”伪事务降级；测试fake也必须提供真实事务语义。
3. 实现共享完成事务：校验消息完整性，锁后检查当前claim/关联/lease，对单条重新计算包括published_at/source_name的完整材料fingerprint，再保存业务行＋run＋job。数据写入中途失败全部回滚。
4. 支持完成重放：记录/比较规范化完成摘要或复用已保存response，相同结果返回同一id；不能随机生成新noteId后把重复消息判失败。
5. 同步analyze/briefing/research、async complete、自动分析完成都调用共享入口；禁止节点层先保存run再单独finishAiJob。
6. 验证 S01—S03、PG-F02 全绿，PG-F01仍一胜者；在PG两个真实连接上测试同run双完成、complete与取消/过期竞争。正式测试helpers可增加transaction，但不得降低原行为断言。

### Task C2：修请求身份、快照和领取

**对应：** F02；原补强T2/T8。**Files:** 修改 `agent-queue.ts`, `agent-jobs.ts`, `agent-runs.ts`, `analyze.ts`, `src/lib/agent-contract.ts`及相关测试；必要新增前向迁移。

1. 先固定S04/S05，补跨日期briefing、相同request切provider、同request不同scope、claim后重试、领取创建run失败。
2. 排队时保存canonical request hash、provider/mode/policy、首次resolved range、sources/material hash和可审计身份。不能用material hash代替input hash。
3. 按request_id读取已有job/run并比较稳定请求；相同材料不同问题必须409。唯一索引冲突要转换为明确冲突或重放，不让SQL异常泄漏到UI。
4. claim在C1事务机制中关联真实run并签发data token；处理won/replay/in_progress/conflict全部分支，不能非won时返回新随机runId。失败回滚领取，不留running孤儿job。
5. 明确过期running的含义：已发送调用且无结果→outcome_unknown；只有确认未发送才可安全重排。不要把全部过期无差别timed_out然后鼓励新付费请求。
6. 命令：`node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/spec-repro.test.ts`，S04/S05应绿；调用计数证明同意图无额外模型请求。

### Task C3：让 Worker 完成确认可靠、页面能力一致

**对应：** F04/F08；原补强T8/T9/T16。**Files:** 修改 `workers/agent/internal/agent/worker.go`, `worker_test.go`, `src/lib/server/fns.ts`, `src/routes/knowledge.tsx`, `src/lib/server/agent-jobs.ts`。

1. 保留Worker complete500反例，增加成功提交后网络丢响应、409旧claim、400非法输出、任务URL不存在/无权访问用例。
2. Worker检查postJobs错误和HTTP状态，区分可重传完成与终态拒绝；结果保留到收到明确ACK或记录不可确认状态。重传沿用相同response/id，不重跑execute。
3. 统一有效能力为 engine=eino＋async开关＋worker配置完整，服务端执行此判断。显式async请求不可用返回capability_unavailable；关闭开关停止新入队/新领取，在途run按已保存策略收敛。
4. UI同步保持默认，开放时提供明确异步入口或显式选择，并真实传async字段；不能只显示开放文案。URL job恢复保留，not_found/无权访问/终态停止轮询；网络错误有界退避并保留任务链接。
5. 历史笔记和异步结果显示持久化引用/coverage，失败可再次提问。requestId按用户新意图更新，网络重试保留原意图。
6. Go Worker探针和C11浏览器检查验证：一个请求一个答案，complete重传不多模型调用，错误job不永久锁按钮。

### Task C4：完成固定流程、修复、Skill和用量预算

**对应：** F03；原补强T6/T7。**Files:** 修改Go `model.go`, `workflow.go`, `research.go`, `tools.go`, `skills.go`和现有相关测试。

1. 新Go固定输出/zero budget/SkillBudget/StreamWire探针作为必过回归；保留普通Research和Stream已正确的wire限制。
2. generateOnce接收同一run预算和实际policy输出上限，删除1800常量与0→1保底；repair只扣一次，BindTools派生实例保持同一budget，不创建重置的计数器。
3. Skill实际tool执行接入统一tool guard；把读取字节和进入上下文的内容限制纳入运行策略。Internal/MCP/Skill并发预占共享且有锁，禁止结果返回后才判超额。
4. 在真正供应商边界确认自动重试行为；每次网络尝试要么禁用隐式重试，要么纳入额度。usage累计包括repair/已执行失败的已知用量，未知保持null。
5. Stream成功、出错、取消、未读完都关闭reader并记录有界事件；当前Research禁用stream可保留，但包装接口声明支持的能力要有测试。
6. 格式修复给有界原输出＋具体mode schema＋验证错误及现有证据约束；fake检查第二次请求内容，不再只预设第二个回答正确。
7. `go -C workers/agent test ./internal/agent -count=1`及新overlay对应用例全绿；wire断言0额度零请求、12输出上限实际为12、usage是累计值。

### Task C5：完成 MCP 安全调用和可信收据

**对应：** F06；原补强T12。**Files:** 修改Go `mcp.go`, `mcp_test.go`, `config.go`, `tools.go`；TS `agent-data.ts`, `agent-jobs.ts`/共享完成入口、契约测试。

1. 保留TokenEnv header和每次ID已修部分，先固定307/308跨origin合成token转发反例（不同协议/主机/端口均算origin变化）。
2. 在实际MCP客户端注入禁止跨origin重定向的HTTP client，限制连接/单工具deadline、返回bytes/blocks及解码前尺寸。按run明确Close所有权；不要只在收完响应后截4000字。
3. 增加严格的认证receipt写入动作，验证服务身份＋当前run token/claim＋服务器/工具allowlist＋来源类型＋大小/序号；只能由受控适配器建立可信收据。先保存成功，再把evidence_id返回模型。
4. 收据ID绑定run/call/result，不用跨进程重启会碰撞的裸全局序号；保存来源标题/允许URL/内容hash/区间/时间。外部内容不是新指令或权限。
5. 最终response引用只从服务器收据集合验证，不直接合并模型/Go自报evidence。合法MCP引用可落库并在历史笔记打开；伪造ID/quote/跨run收据拒绝。
6. fake Streamable HTTP服务走实际协议做初始化/list/call/auth/timeout/证据全链测试。明确首版支持Tools和验证过的transport，Resources/Prompts/OAuth仍属未来范围，不冒充已支持。

### Task C6：修 Skills 祖先链接与读取边界

**对应：** F06；原补强T13。**Files:** 修改Go `skills.go`, `skills_test.go`；复用C4预算包装。

1. 保留直接根外/末级symlink已过检查；把AncestorSymlink探针纳入正式测试，补root本身链接、嵌套链接、Windows junction/不同盘符、合法相对resource和超大文件。
2. 真实读取入口解析root与目标最终路径，检查实际归属或拒绝路径链中的链接；不能只做字符串前缀或仅Lstat最后一级。GlobInfo传入path也必须验证，Walk拒绝错误必须传播。
3. 使用MAX+1有界读替代ReadFile后判大；只读部署目录作为运行约束，不新增shell/fork/脚本执行。
4. 可用技能元数据与实际used skill版本分开记录，按需加载资源也经过同一边界和预算。unsupported明确失败，不能返回空成功。
5. 运行 `go -C workers/agent test ./internal/agent -run Skill -count=1`及ancestor探针，合法技能仍可用，根外文件不得进入输出。平台特定skip在对应平台补验。

### Task C7：把 reservation 标签补成真实成本账本

**对应：** F05；原补强T11。**Files:** 修改 `agent-queue.ts`, `nodes.ts`, `cron.ts`, 共享完成入口；新增前向迁移与 `src/lib/server/agent-budget.test.ts`。

1. 运行S08，补最后额度双连接竞争、预占后job写失败、reservation写失败、重复settle/release、模型已调用后失败、跨日排队与价格版本切换。
2. 预占日汇总、job、reservation在一个事务里建立，首次与已有日行走同一检查。reservation保存job/request、执行日、model/price version、费用上界、已知usage、实际费用或unknown、结算身份。
3. 费用上界由配置价格和实际输入/输出/调用次数限额推导，必须与C4真实wire一致；无法可靠估计则拒绝自动付费模式，不能用默认1元承诺封顶。
4. 执行前处理跨日转移及额度复核；成功按已知usage结算并调整reserved/settled日汇总；确定未发送才释放；结果/usage未知保留unknown及必要预占。模型已调用失败不等于免费。
5. 与C1完成事务联合提交相关账本状态，重复完成不重复记账。自动筛选复用C9材料指纹与提取就绪判断，不把任意旧成功分析当当前有效。
6. S08与PG并发额度用例通过，核对明细/日汇总守恒。AUTO_ANALYZE仍关闭到真实额度配置与C12放行完成。

### Task C8：真正实现 checkpoint、中断与恢复

**对应：** F04；原补强T10。**Files:** 修改Go `research.go`, `worker.go`；TS `agent-checkpoints.ts`, `agent-jobs.ts`, `agent-queue.ts`；必要前向迁移。

1. 先补当前S06/S07/CheckpointHTTPError，建立锁定Eino版本的interrupt→Store.Set→Resume小型编译/运行探针，读取真实SDK签名后接线。
2. 传真实run/job/claim/checkpoint ID；保存schema/runtime/policy/model/skills版本、sequence、执行过的调用记录和预算余额。同seq同payload可幂等，同seq不同payload拒绝。
3. 在事务锁后验证run、job lease和claim generation，过期不可写。409/version_mismatch必须传播，不能当作不存在从头执行。
4. 实现健康执行续租、失败取消、过期job安全回收；续租受run总deadline限制。新generation轮换token，旧worker的取数/保存/complete均拒绝。
5. 恢复只继续已知安全的剩余步骤，保留累计成本/调用预算；中断点包含未确认外部调用时进入outcome_unknown，不盲目重跑。
6. C11 harness启动独立worker进程，checkpoint后kill，再启动另一worker实际Resume；断言已完成模型步骤不会再请求，最终只有一个业务结果。该测试未过不得写“只差真实供应商”。

### Task C9：修全局材料上限、freshness和引用元数据

**对应：** F07；原补强T4。**Files:** 修改 `agent-context.ts`, `agent-data.ts`, `analyze.ts`, `agent-queue.ts`, `agent-runs.ts`及相关测试。

1. M01/M02先固定8条5000字/12条5000字；补中英文emoji、全文末尾命中、OCR未完成、来源/发布时间改变和非零offset尾段。
2. 在选择阶段先分配全局source数量与24000字符预算，头尾分片都占source数，保持≤12。明确取舍和partial，不能为满足schema悄悄宣称全文已覆盖。
3. 统一mapItem/materialFingerprint/evidenceId；比较当前材料与分析时指纹判断stale。自动分析源名join、analyzed正文更新、未创建提取job等情形沿同一规则处理。
4. 收据保存title/url/platform/source_name、版本及区间，动态引用正确映射，禁止itemId标题/rss占位。get_item只有覆盖从0到全文末尾才可标full；缺材料/未完成OCR明确提示。
5. M01/M02与旧R03/R04/R09通过；双端实际收发最大合法材料和超限材料，正确接受或在计费前拒绝。

### Task C10：实际检索评测，不靠说明字符串证明链路

**对应：** F08；原补强T14。**Files:** 修改 `scripts/agent-retrieval-eval.mjs`, `validation/agent/retrieval-cases.json`；新建有版本的评测结果文件。

1. 保留原小样本结果，停止覆盖旧日期结果作为新证据。新增超过SQL候选上限、长正文末尾、重复/无关/无答案/时间边界等标注数据。
2. 使用隔离PG/PGlite，调用实际候选SQL、rank与C9材料函数；baseline/新策略在相同候选/字符/片段预算比较，不复制业务排序函数。
3. 输出候选recall、最终片段覆盖、无答案误取、截断比例、返回字节与耗时，记录语料hash及参数；模型答案质量单列，离线排序不能替代真实答案评价。
4. 预先明确零范围越界、关键场景不退化的阈值，失败保留，不为提升数字修改标签。只有实证需要时再增加索引/向量能力。
5. `node scripts/agent-retrieval-eval.mjs`实际走数据库链路并产出新结果；把“SQL path covered by tests”的字符串替代为真实实测配置。

### Task C11：形成真正的全链验收门禁

**对应：** 原Task16；补强T15。**Files:** 重写 `scripts/agent-e2e.mjs`，新增 `scripts/agent-integration-harness.mjs`，更新package测试入口及验收记录；保留review历史日志。

1. 把新增探针行为迁入正常测试入口。辅助测试可以保留，但名称不得继续误导为完整E2E。Query-only测试helper可升级为真实事务helper；严禁改成断言错误现象、跳过失败分支或更改期望让红变绿。
2. harness起隔离DB、fake model/MCP、当前Go和当前应用，浏览器走真实路由/按钮：同步/异步、刷新、job不存在、失败重提、内部/MCP引用、历史笔记、预算拒绝、worker重启。不要调用业务生产库或重启用户服务。
3. 用页面内容＋数据库不变量＋fake请求计数联合验收；fetch HTML、HTTP200、硬编码rendered、预设第二次合法输出均不足。
4. PG真实多连接跑PG-F01/02、C1事务竞争、C7最后额度、C8checkpoint/lease；PGlite兼容测试同语义。旧库升级含run_id=null旧结果，验证迁移不丢数据、重跑不重复、失败回滚。
5. 完整 `npm test`、`npm run typecheck`、`go -C workers/agent test ./... -count=1`、`go -C workers/agent vet ./...`；支持CGO的环境跑race。完整 `npm run build` 在隔离数据库执行，必须包含migrate和资产复制，不以vite build替代。
6. 按项目现有启动契约跑dev/browser-smoke，视觉检查桌面/手机截图；built启动后对比dev baseline，再跑真实agent浏览器流。读取现有脚本确定实际参数，Windows路径按当前环境解析，不照抄不存在的Linux路径。
7. 更新 `validation/agent/acceptance-after-remediation.md`：commit＋工作区hash、具体命令/退出码/截图/数据库、passed/failed/not_run。清理仅本次创建的容器/临时资源，记录清理结果。

### Task C12：真实集成、启动、回滚与发布门禁

**对应：** 原Tasks15/17；补强T16。**Files:** 当前 `docker-compose.yml`, `workers/agent/Dockerfile`, Go main/config、`docs/operations/agent-service.md`；启动改变才同步更新startup.sh。

1. 区分liveness/readiness，缺必要凭证/endpoint/worker配置时功能不可用且错误可理解，健康检查不消耗模型额度。agent不可用时采集/浏览仍工作。
2. 只有明确授权和可用额度后执行最小真实模型smoke，验证三模式、tool calling、structured output/usage/max output；真实MCP只验证明确配置的只读工具。未授权不执行，准确列待验证。
3. legacy→eino→legacy完整演练，覆盖所有新入口、已有job和历史结果；禁止切引擎后隐式重跑在途请求。自动分析只有预算与账本验收后单独开放。
4. 旧数据库只做兼容前向迁移；0014/0015是否已应用不明时不得直接重写历史迁移，新增后续编号。不要为了回滚删除用户运行数据。
5. 修正文档“离线P1已完成”“配置目标即browser harness”等不准确说法。若真实集成仍待验证，最终交付明确为代码/离线验收完成，不宣称生产完成。

## 4. 交付验收矩阵

| 门禁 | 最少证据 |
|---|---|
| 旧修复未回归 | R01—R09、旧Go两探针、PG-F01通过 |
| 完成与身份 | S01—S05＋PG-F02、真实事务回滚/竞争/重放通过 |
| 成本与恢复 | S06—S08＋账本并发/进程kill-resume及未知调用处理通过 |
| 执行与拓展 | 新Go所有正确行为断言通过，MCP可信receipt/ancestor symlink/0额度/wire limits |
| 材料与检索 | M01/M02、freshness/coverage、真实SQL检索评测 |
| 应用验收 | 全部正常测试、类型/Go vet/race、完整build、dev/built真实浏览器 |
| 真实可用 | 明确模型/MCP/预算配置的实际smoke、健康启动和回滚记录 |

完成报告逐项列出 C1—C12、原20任务和上一版16补强任务的状态与证据。某项有代码但无有效调用者＝部分实现；只有fake通过＝离线验证；跳过＝未运行。不得用提交数量、代码行数或默认关闭开关替代功能完成。
