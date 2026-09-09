# 2026-09-08 补强复核 — Spec 独立轴

基线：`76b6da1` 及当前未提交补强。只读生产实现；新增隔离 PGlite 检查，未调用供应商或实际项目数据库。

结论：补强并非“只差真实服务验收”。默认 JSON 适配、初步请求重放、skip-locked 领取、日期范围括号等已有修复，但原补强计划 Task 3/5/8/10/11 仍有可离线复现的不满足项。以下严重性指启用对应能力后的业务影响；默认关闭只能限制影响面，不能作为已实现证据。

## 可执行证据

运行：`node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/spec-repro.test.ts`

实际：8 项测试全部失败，退出码 1；都是断言正确行为的回归测试。见同目录 `spec-repro-output.txt`。测试仅使用内存 PGlite 和构造的合法模型结果。

| 用例 | 正确要求 | 当前实际 |
|---|---|---|
| S01 | succeeded 缺 response 应 400 | 200，job 可成功而 run 未成功 |
| S02 | 过期 job 的 complete 不得写业务数据 | 返回 409 前已经写入一条 answer |
| S03 | 重传同一成功 complete 应幂等接受 | 第一次 200，第二次 409 |
| S04 | 同 request_id 不同问题应 request_conflict | 相同材料时返回同一 queued job |
| S05 | 相同问题/身份在领取后仍应进行中 | 返回 request_conflict |
| S06 | 过期 run 不得保存 checkpoint | 返回 ok |
| S07 | 同 checkpoint sequence 不同 payload 应拒绝 | 返回 ok，覆盖 payload |
| S08 | 明确未发送调用的失败释放应更新日汇总 | reservation 改 released，reserved_rmb 仍为 1 |

## 独立 Spec 发现

### SP1 — P1 / wrong：完成消息并非原子、严格、可重放

位置：`src/lib/server/agent-jobs.ts:73`、`:88`、`:102`；`src/lib/server/agent-runs.ts:330`；`src/lib/server/agent-queue.ts:211`。

complete 只在 `status === succeeded && response` 时校验并保存，缺 response 却继续 finishAiJob。正常分支先完成 run/note，再单独结束 job；并没有一个事务同时复核 job/run/token/lease 并保存业务行。S01/S02/S03 复现：成功不变量仍可破坏，租约过期结果也能落业务库，成功回包丢失后的重传被拒。worker.go:162 丢弃 complete HTTP 状态，使后者无人收敛。对应补强 T5、T8、§1.2。

### SP2 — P1 / wrong：异步 request 身份与材料身份混用

位置：`src/lib/server/agent-jobs.ts:26`、`:31`；`src/lib/server/agent-queue.ts:195`；`src/lib/server/analyze.ts:375`、`:411`。

job 只以 `(item_id,material_hash,policy)` 判定冲突；相同材料但问题变化不会拒绝。领取时把 material_hash 写成 run.input_hash，而 ask 使用 mode/question 的 canonical hash，故同一请求在领取后必变为冲突。beginRun 非 won 时还返回刚生成但不存在的 runId。新增 request_id 唯一索引只能阻止第二行，不能取代语义判定；材料变动时会产生未分类 SQL 唯一冲突。S04/S05 已复现。对应补强 T2、T8。

### SP3 — P1 / partial：事务接口存在，提交路径尚未接入

位置：`src/lib/server/agent-runs.ts:283`、`:304`、`:350`、`:363`。

finishAnalyze 仍先在 CTE snapshot 中匹配材料和 run，再仅按 id 更新；sourceName 新比较修复的是串行变更，不能消除实际 PG 锁等待后的旧快照竞争。published_at 属于 materialFingerprint，却没有进入最终复核。finishNote 同样仅通过先前 claimed 查询验证租约。Sql.transaction 在 db.ts 中加入，但 agent-runs/jobs/queue 未调用。主审另跑真实 PG，不在本子审重复。对应补强 T3、T5。

### SP4 — P1 / missing+wrong：checkpoint 恢复未接通，存储 fencing 不足

位置：`workers/agent/internal/agent/research.go:59`、`:61`；`workers/agent/internal/agent/worker.go:25`、`:44`；`src/lib/server/agent-checkpoints.ts:30`、`:40`。

Runner 虽传入 Store，但构造没有 claimToken，实际 Set 携带空 token；只有 Query，没有 Resume、续租或 expired-job reclaim。Store.Get 将 HTTP >=400 且 err=nil 转为 nil,false,nil，版本错误会被伪装未找到。TS 保存未检查 expires_at/job lease；先读后写留 TOCTOU；相等 sequence 可用不同 payload 覆盖；schemaVersion 不校验，runtime/model/policy/skills 版本未完整绑定。S06/S07 已复现。所以不仅“kill/resume 未验”，还缺实现。对应补强 T10。

### SP5 — P1 / partial：金额账本仅增加状态标签

位置：`src/lib/server/agent-queue.ts:105`、`:110`、`:119`、`:232`、`:248`；`migrations/0015_agent_budget_reservations.sql:1`；`src/lib/server/nodes.ts:128`。

预算预占、job、reservation 三次独立写入，失败可孤立预占/任务；finish 只改 reservation.status，不记录实际 usage/费用或更新日 settled/reserved 汇总。failed 不区分模型已调用还是未发送就标 released。仍以可配置常量 1 RMB 估最坏费用，无价格/模型上界证明；跨日执行不转移额度。S08 复现日汇总不释放。自动分析也在 analyzeItemWith 成功后单独 finishJob，未共享 claim 或请求身份。对应补强 T11。

### SP6 — P2 / partial：开关执行含义与契约不一致

位置：`src/lib/server/fns.ts:426`、`:459`；`src/lib/server/agent-jobs.ts:20`。

async 请求在开关关闭时被转换成同步执行，而不是 capability_unavailable；capabilities 仅返回 bool，不包含 engine/worker 完整配置综合判定。claim endpoint 不校验 async/engine 开关，关闭门禁不会停止已有排队任务的新领取。对应补强 §1.1、T1/T9/T16。

### SP7 — P2 / partial：材料与证据策略仍有缺口

位置：`src/lib/server/agent-data.ts:147`（stale 仅看是否有 hash）；`src/lib/server/agent-queue.ts:87`（任何 succeeded analysis 当有效）、`:98`（只扫 ingested/extracted）；`src/lib/server/analyze.ts:449`、`:460`。

get_analysis 不与当前材料 fingerprint 比较；自动分析筛选可漏掉正文变化的 analyzed 项。内部工具收据可合入同步引用了，但动态内部引用被输出成 itemId 标题/rss 平台，外部 MCP 收据没有可信写入 action；Go 返回 evidence 并不会自动成为 TS 收据。因此完整来源呈现/MCP 最终可保存仍未完成。对应原方案任务 10/12/18，补强 T4/T11/T12。

## 给后续实施者的最小修复路线

1. 固定 S01–S08 为正确行为测试，保留旧 R01–R09 与主审 PG 测试；不能通过改成错误即 PASS 来验收。
2. 修共享事务完成函数：锁当前 run/job/item，锁后以 clock_timestamp 复核租约，比较完整版本，业务+run+job+预算一次提交；严格消息 schema；重复 complete 返回同一业务对象。
3. 分开 canonical request hash 与 material hash；排队时持久化完整 request/provider/policy/sources/scope；claim 原子关联 run；任何非 won 分支不得编造 runId。
4. 真正接入 checkpoint claim token、版本、interrupt/resume、续租与安全回收；相同 seq 相同 payload 才幂等。无安全恢复点的已发送调用进入 outcome_unknown。
5. 预算 reservation 与准入一次事务，依据实际模型上界和版本价格，跨执行日复核；结算/释放/unknown 与业务完成原子且幂等。
6. 修门禁、动态引用元数据和材料 freshness，再跑真实 dev/built 浏览器与进程故障 harness；关闭默认能力持续保留到各自验收通过。
