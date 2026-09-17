# Eino Agent 补强后的二次核验

**结论：交接报告准确描述了部分修复和未提交状态，但“补强方案的离线 P1 已修完”不成立。当前仍有不需要真实模型、真实 MCP 或生产环境就能复现的 P1 缺陷。不是仅剩发布验收。**

不能沿用上轮“全部旧反例仍失败”的结论：R01—R09 和上轮两个 Go 探针现在确实通过，PostgreSQL 双领取也已修复。应保留这些有效修复，继续完成原方案的关键不变量。

依据：[原架构](2026-09-07-eino-agent-architecture.md)、[原20项方案](2026-09-07-eino-agent-implementation-plan.md)、[首轮评审](2026-09-08-eino-agent-review.md)、[16项补强方案](2026-09-08-eino-agent-remediation-plan.md)。本文反映再次核验时的工作区，不覆盖首轮历史证据。

## 1. 对另一 agent 交接说法的判断

| 交接说法 | 核验结论 |
|---|---|
| HEAD 是 76b6da1，main，补强未提交 | 确认；补强确有大量工作区修改及未跟踪迁移/测试 |
| ahead 21，behind 0 | 相对**本地缓存的** origin/main 引用确为 21/0；本轮未联网刷新，不能推断远端实时状态 |
| feature/eino-agent 已删除 | 本地 branch 列表中已无该分支 |
| R01—R09 全绿，TS/Go 检查通过 | 本轮复跑确认；现有 npm test 也通过 |
| executeLegacy、日期范围、运行取数 token、Research wrapper 已修 | 确有实现，关键旧反例通过 |
| 成功路径一次写入业务行＋run＋job | **不实**：note/run 与 job 分开更新，没有使用新增 transaction |
| T10 只差进程 kill/resume 验证 | **不实**：缺 claim/checkpoint ID、Resume/续租/恢复接线；存储检查也仍有错误 |
| T11 finish 时 settled/released/unknown | 只有状态标签改变；**不等于金额结算**，日账和真实成本没闭环 |
| T12/T13 已接通鉴权和根目录限制 | 局部修复成立；仍有重定向带 token、祖先 symlink 越界和 MCP 收据无法持久化问题 |
| 配置 AGENT_E2E_TARGET 后就是完整 browser harness | **不实**：仍仅 fetch `/knowledge` 的 HTML，不运行浏览器/点击/提问/刷新 |
| 检索评测注明 SQL 路径 | 仅新增 method 说明字符串，评测仍直接对16条内存材料排序 |
| 默认 legacy、async/auto 关闭 | 代码/示例默认如此；本轮没有核查或修改真实部署中的私密环境值 |
| 下一步先决定提交/push | 建议调整顺序：先完成剩余修复和本地验收；提交不能代替验收，push 仍需明确授权 |

本轮只新增评审文档、可执行探针和日志。未修改被审业务代码、未提交/push、未使用付费模型或业务数据库。临时 PG 容器 `loom-agent-followup-review-20260908` 已删除，原有服务未被停止。工作区原有 restart.bat 修改保持原样。

## 2. 实测结果与复跑入口

工作区基线：[37个补强文件的 SHA-256 清单](../../validation/agent/review-followup-2026-09-08/workspace-snapshot.json)。HEAD 为 `76b6da1ac8a8d6d6c6a4b30e7f0309c9e18fd8b9`；因为代码未提交，HEAD 本身不能唯一代表被评审内容。

| 检查 | 本轮结果 | 解释 |
|---|---|---|
| `npm test` | 通过：25＋1＋165，共191项 | 现有套件有效，但未覆盖本轮新反例 |
| `npm run typecheck` | 通过 | 静态类型通过 |
| `CGO_ENABLED=0 GOTOOLCHAIN=local go -C workers/agent test ./... -count=1` | 通过 | 锁定依赖的现有离线套件通过 |
| 旧 R01—R09 | 9/9通过 | 九个特定旧缺陷行为已修复 |
| 旧 Go ResearchBudget / SkillRoot | 2/2通过 | 普通研究调用计数和直接根外读取已修，不应继续写旧结论 |
| PG-F01 | 通过 | SKIP LOCKED 跳过锁定行；并发领取一个胜者 |
| PG-F02 | **失败** | 新正文仍被旧分析标记 analyzed |
| S01—S08 | **8/8失败** | complete、幂等、checkpoint、预算账本仍有可复现缺陷 |
| M01—M02 | **2/2失败** | 长材料超过 sources/总文本上限 |
| 新 Go 探针 | 七个测试函数执行，缺陷断言失败，含八个场景观测 | 固定流程预算、Skills、重定向、checkpoint 错误、Worker ACK、Stream 审计 |
| `node scripts/agent-e2e.mjs` | PASS | 无目标时为辅助函数测试，不能证明页面链路 |
| build＋dev/built 浏览器、race、真实模型/MCP、进程恢复 | 本轮未完成 | 不作为通过证据；其中恢复还缺实现 |

新的 PG 用例没有直接照跑旧 PG01：旧用例等待两个连接阻塞，与正确的 SKIP LOCKED 行为不兼容，而且未加载新增迁移。新的 PG-F01 先验证锁定行被跳过，再在解锁后验证两个连接只有一个胜者；PG-F02 保留旧材料竞争语义。修改测试调度是适配正确算法，未降低业务断言。

```powershell
# 已修旧反例
node --experimental-strip-types --test validation/agent/review-2026-09-08/repro.test.ts

# 新业务与材料边界，当前应失败；修复后应全通过
node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/spec-repro.test.ts
node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/material-repro.test.ts

# 新 Go 探针，当前应失败；overlay 换工作区须重建绝对路径
$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
go -C workers/agent test -overlay ../../validation/agent/review-followup-2026-09-08/go-overlay.json ./internal/agent -run TestFollowup -v -count=1

# 仅连接新建的独立测试 PG，脚本固定 review 数据库/测试凭据
# 设置 REVIEW_PG_PORT 为该容器实际端口后执行，禁止指向业务数据库
node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/postgres-repro.test.ts
```

详细证据：[业务探针与输出](../../validation/agent/review-followup-2026-09-08/spec-repro-output.txt)、[PG输出](../../validation/agent/review-followup-2026-09-08/postgres-repro-output.txt)、[材料输出](../../validation/agent/review-followup-2026-09-08/material-repro-output.txt)、[Go实验说明与输出](../../validation/agent/review-followup-2026-09-08/go-results.md)。所有 fake 服务只使用合成凭据；没有泄露实际凭据的测试。

## 3. 主审确认的核心剩余问题

### F01 · P1 · Sql.transaction 存在，但关键路径没有使用【PG-F02 / S01—S03】

[agent-runs.ts:283](../../src/lib/server/agent-runs.ts#L283) 仍用 claimed/matched 旧快照 CTE，最后 items 更新只按 id；新增 sourceName 比较没有修复竞争。真实 PG 复现：`result=ok, body=new body, pipeline_status=analyzed`。published_at 等指纹字段也没有完整复核。

[agent-jobs.ts:73](../../src/lib/server/agent-jobs.ts#L73) 只有 succeeded 且存在 response 才校验；缺 response 仍可把 job 标成功。正常响应先保存 note/run，再更新 job。S02 中 job 已过期，接口最终409，但**此前已写入答案**；S03 同一成功 complete 再传得到409，无法处理成功回包丢失。

必须在一个真实事务内校验当前 job/run/claim/lease/材料并保存业务行、run、job及相关预算状态。仅声明 transaction、增加索引或在最后一步报错不足以保证原子性。

### F02 · P1 · 异步请求身份与材料身份混用【S04 / S05】

[agent-queue.ts:195](../../src/lib/server/agent-queue.ts#L195) 排队仍按材料相关键处理冲突；[agent-jobs.ts:26](../../src/lib/server/agent-jobs.ts#L26) 将 material_hash 当 inputHash。相同 request_id 换问题但材料不变会错误复用 job；相同问题在 job 领取后又被判 request_conflict。非 won 分支还可能返回未实际创建的随机 runId。

需要分开稳定请求哈希和材料哈希，保存首次完整 provider/policy/sources/scope，claim 时原子关联真实 run，重放不能依赖当前材料或重新计算身份。

### F03 · P1 · 预算只在部分调用路径生效【新Go探针】

[model.go:104](../../workers/agent/internal/agent/model.go#L104) 固定流程/修复把输出额度写死1800；要求12，wire仍1800。[workflow.go:40](../../workers/agent/internal/agent/workflow.go#L40) 把0次模型额度改为1，实际发出请求。Skills仍绕开工具预算，0次工具额度也加载成功并记录0次。

要明确区分：普通 Research 和直接 Stream 的调用次数/输出上限已修。剩余错误是固定流程、修复、技能及统计没有统一覆盖。Research usage仍不累计，Stream成功没有审计事件；固定流程修复后只记最后一次usage。

### F04 · P1 · checkpoint 不是“只差实测”，Worker 也会吞提交失败【S06/S07、新Go探针】

[research.go:59](../../workers/agent/internal/agent/research.go#L59) 传了 Store，却没有当前 claim token、启用 checkpoint 的ID或实际 Resume；不存在续租、过期任务恢复与预算恢复链。HTTP409/version_mismatch 在 Store.Get 中变成未找到且 err=nil。TS允许过期run保存、相同sequence不同payload覆盖。

[worker.go:162](../../workers/agent/internal/agent/worker.go#L162) 完成接口返回500仍让 RunWorkerOnce 返回nil。处理结果提交丢失必须幂等重传完成消息；不能用重新调用模型来补偿。

### F05 · P1 · 成本账本尚未结算【S08】

[agent-queue.ts:105](../../src/lib/server/agent-queue.ts#L105) 预占、入队、reservation分成三次写入；[232行](../../src/lib/server/agent-queue.ts#L232) finish只改reservation.status。[0015迁移](../../migrations/0015_agent_budget_reservations.sql) 也没有实际usage/费用字段。

S08 中 reservation=released，但日reserved_count/reserved_rmb不下降。成功的settled也不记录实际费用，未知与已发送失败语义不完整。仍用常量1元估上限、没有执行日额度转移、自动分析有效性不比较当前材料指纹。0额度拒绝已经修好，不能据此宣称自动计费闭环完成。

### F06 · P1 · MCP/Skills 边界与可信证据仍不完整【新Go探针＋代码确认】

TokenEnv和每次调用ID确已接入，但MCP默认307重定向会向另一个origin转发Authorization（探针只用本地合成token）。证据仅写Go内存，没有认证后的TS收据写入口，因此最终服务器收据校验仍无法接受外部引用。连接关闭、工具级超时、解码前响应尺寸限制也需补齐。

Skills直接根外和末级symlink已拦住，但只Lstat最终文件；祖先目录symlink仍能指向根外。探针实读到外部sentinel。此结论限于文件backend边界，不声称当前名称型skill工具已经允许模型任意指定系统路径。

### F07 · P1/P2 · 大材料和数据新鲜度不满足共享契约【M01/M02＋代码确认】

[agent-context.ts:214](../../src/lib/server/agent-context.ts#L214) 8条长材料生成16个sources、32000字符，超过12个sources/24000总字符；12条长材料简报生成24个sources。公共契约会拒绝这些正常规模的输入。应在选材时统一分配source与文本预算，不是发送后报格式错。

[agent-data.ts:147](../../src/lib/server/agent-data.ts#L147) stale仍只判断旧hash存在；非零offset尾段仍可能标full。可信收据缺完整标题/URL/platform，动态内部引用回传降为itemId/rss占位，MCP引用缺持久收据。

### F08 · P2 · 页面、能力门禁和验收脚本仍有缺口【代码确认】

knowledge页面读取asyncEnabled并显示“长任务已开放”，但提交不再传async，普通用户仍无法从该按钮进入异步研究。URL job恢复基础已加，failed允许再提交也已修；然而not_found不停止轮询、可一直禁用按钮，历史笔记不呈现完整引用。

关闭async时fns会把显式异步请求转为同步执行，claim又没有停止新领取的能力门禁。应将UI选择、服务端能力、配置完整性和领取行为一致处理。

`agent-e2e.mjs`没有浏览器；`agent-retrieval-eval.mjs`只是新增method描述，评测仍绕过真实SQL候选/截断。补强验收文档中“unless AGENT_E2E_TARGET...”的描述应改掉：设置目标也不会使fetch变成browser harness。

## 4. 逐项进度，避免把骨架认作完成

| 补强任务 | 当前判定 | 尚需完成 |
|---|---|---|
| T1 默认兼容 | 特定旧缺陷修复，整体部分 | 异步能力门禁、错误语义完整一致 |
| T2 幂等/过期 | 部分 | F02，未知执行与timed_out区分 |
| T3 事务/领取 | 领取通过，事务未接业务 | F01，真实PG提交、锁后租约检查 |
| T4 材料/范围/收据 | 部分 | F07，收据元数据/上限/freshness |
| T5 统一完成 | 未闭环 | F01，一个共享完成事务 |
| T6 统一预算 | 部分 | F03，固定/repair/skill/usage |
| T7 边界/事件 | 边界已改善，部分 | Stream/失败事件、usage累积 |
| T8 异步结果 | 正常样例通过，未闭环 | F01/F02/F04，严格且幂等完成 |
| T9 页面 | 部分 | 真正选择异步、not_found、历史引用 |
| T10 checkpoint | 接了Store但不可恢复 | F04，实现＋进程级验收都缺 |
| T11 成本账本 | 部分 | F05，不能只改标签 |
| T12 MCP | 部分 | F06，鉴权重定向与可信持久收据 |
| T13 Skills | 部分 | F03/F06，祖先链接和预算 |
| T14 检索评测 | 未完成要求 | 实际候选SQL/长文/截断评价 |
| T15 全面离线验收 | 未完成 | 新缺陷全绿、PG、browser、完整build、race |
| T16 发布/真实验收 | 未完成 | 真实集成/回滚/能力开放证据 |

原20项方案的当前结论：Task1依赖离线验证通过；Tasks2—14仍各有契约、状态、材料、预算或拓展闭环缺口；Task15部署配置存在但未完成集成验收；Tasks16—17没有满足完整验收；Task18账本/调度部分；Task19恢复未实现闭环；Task20只完成小样本排序实验。不能给出“原20项已完整实现”的结论。

## Standards

以下为独立审查者原序结果，保留严重性，不与Spec合并排序。路径前缀为 workers/agent/internal/agent/。

1. **P1｜复现** model.go:104、workflow.go:40：固定输出1800，0模型额度仍请求。违反补强T6。
2. **P1｜复现** skills.go:159：Skill额度0仍加载并记0。违反T6/T13。
3. **P2｜复现/静态** model.go:52、research.go:114：Stream无事件、研究usage未累计；Stream次数及输出额度已生效。违反T6/T7。
4. **P1｜复现** mcp.go:72：307跨origin仍转发Authorization。违反T12.2。
5. **P1｜静态** mcp.go:154：MCP证据仅存内存，无可信持久收据，连接关闭与工具级超时未齐。违反T12。
6. **P1｜复现** skills.go:45：祖先目录symlink仍可根外读；直接根外和末级检查已修。违反T13。
7. **P1｜静态/复现** research.go:59、worker.go:37：无checkpoint ID/claim/Resume，409被吞成未找到。违反T10。
8. **P1｜复现** worker.go:162：complete500仍返回nil。违反T8/T10。

完整独立报告：[Go Standards](../../validation/agent/review-followup-2026-09-08/go-results.md)。

## Spec

1. **P1** agent-jobs.ts:73/88/102：缺response成功、租约过期仍先落答案、complete重放失败。
2. **P1** agent-jobs.ts:26/31：材料hash当请求hash，领取后同请求冲突、换问题误复用。
3. **P1** agent-runs.ts:283/304：事务未接入、旧CTE及不完整fingerprint。
4. **P1** research.go:59、agent-checkpoints.ts:30/40：Store缺claim、无Resume/续租/回收，过期和同seq不同payload可写。
5. **P1** agent-queue.ts:105/232：预占/入队/明细非原子，状态标签不等于结算。
6. **P2** fns.ts:426：关闭async转换同步、claim仍领取，门禁不一致。
7. **P2** agent-data.ts:147：freshness只看hash存在，动态来源与MCP收据不完整。

完整独立报告：[Spec](../../validation/agent/review-followup-2026-09-08/spec-findings.md)。

Standards共8项，最严重为P1预算/凭据/执行边界问题；Spec共7项，最严重为P1结果保存与任务一致性问题。

## 5. 后续交付物

按[剩余实施方案](2026-09-08-eino-agent-followup-plan.md)完成现有实现，不重起框架。把[可直接交给实施agent的提示词](2026-09-08-eino-agent-execution-prompt.md)全文交给另一个agent；提示词包含本次明确反例、文件范围、禁止弱化测试规则、验收命令及未授权的发布/付费边界。
