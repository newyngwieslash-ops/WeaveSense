# Eino Agent 第三轮核验：补强进展与剩余缺口

**结论：尚未完整实现原方案。此次交接已明确承认整体部分完成，这一点准确；旧反例也确实取得进展。但“完成 SQL 已有可靠围栏”“只释放确定未调用任务”“Skills 预算已修”等局部描述仍超过实际实现。**

本轮用真实 PostgreSQL、多连接并发和新增假服务反例发现：旧 worker 在所有权更新后仍可保存答案，并发 complete 不能可靠幂等；Skill 正额度耗尽后仍可继续执行。它们是实现缺陷，不是等真实供应商凭证才能验证的问题。

## 1. 基线与证据范围

- 需求：[原架构](2026-09-07-eino-agent-architecture.md)、[原20项方案](2026-09-07-eino-agent-implementation-plan.md)。继续使用[16项补强方案](2026-09-08-eino-agent-remediation-plan.md)、[C1—C12完整方案](2026-09-08-eino-agent-followup-plan.md)。
- HEAD仍为 `76b6da1ac8a8d6d6c6a4b30e7f0309c9e18fd8b9`，补强尚未提交。HEAD不是工作区实现的完整身份，见本轮[文件指纹](../../validation/agent/review-third-2026-09-08/workspace-snapshot.json)。
- 本轮未手动修改业务实现、未提交/push、未调用付费模型、未访问生产数据库。构建会生成/刷新构建产物。原有 restart.bat 改动未被本轮编辑。
- 新证据放在 `validation/agent/review-third-2026-09-08/`，保留历次测试和日志，不覆盖旧的失败记录。
- 独立PG容器 `loom-agent-third-review-20260908` 已删除；本轮临时构建预览进程已停止，原开发服务未被停止。

## 2. 交接说法逐项核对

| 说法 | 当前判断 |
|---|---|
| 旧R/S/M反例全部通过 | 确认；已纳入npm test |
| Go正式套件通过 | 确认；初次沙箱临时目录拒绝访问，获准提权后同套件通过，不是代码回归 |
| Go overlay命令可按旧文档复跑 | 不成立：正式文件与旧overlay有7个重名测试函数，当前命令编译失败；正常Go套件不受影响 |
| 完成CTE检查job/run/token/lease | 串行样例成立；并发所有权与重放尚未成立，见PG-T03/04 |
| succeeded缺response被拒、过期job不先写答案 | 特定旧串行反例已修；失败分支仍可先修改run再拒绝job，见TSP04 |
| 仅known-not-sent失败释放额度 | 不成立：任意failed都释放，invalid_output也释放，见TSP06 |
| Skill零额度不加载 | 成立；但额度1时能执行两次并记0，不等于实际调用预算完成 |
| MCP重定向、Skills祖先链接、Worker单次ACK错误已修 | 相关代码/回归支持；但MCP持久收据与Worker结果重传仍未实现 |
| 恢复、成本、SQL检索、完整Agent harness未完成 | 判断准确；这些多数还缺代码，不能仅标“未运行” |
| Windows preview:restart受/proc限制 | 该脚本确有限制，但不是构建产物无法验证；本轮用现有npm run preview完成替代验证 |
| 原构建跳过DATABASE_URL时的迁移证明 | 只能证明构建成功；迁移脚本直接跳过，并不在构建阶段运行PGlite迁移。本轮额外完成真实测试PG迁移 |

## 3. 本轮实际检查

| 检查 | 结果 | 证明范围 |
|---|---|---|
| npm test | 通过，含旧R01—R09、S01—S08、M01—M02 | 现有测试覆盖的行为 |
| npm run typecheck | 通过 | TS类型 |
| CGO_ENABLED=0 Go全量test / go vet | 通过 | 现有正式Go离线测试/静态检查 |
| 新Spec六项 | **6项失败** | 身份、重放、失败提交、checkpoint租约、预算释放 |
| PG-F01 | 通过 | skip-locked领取修复保持有效 |
| PG-F02 | **失败** | 旧材料仍能提交为新正文分析 |
| PG-T03 | **失败** | 同时complete一个200，另一个23505异常，不是幂等重放 |
| PG-T04 | **失败** | 更新claim后旧worker仍200、写note并清空新claim |
| Skill正额度探针 | **失败** | 工具预算1，实际Skill结果2次、ToolCalls=0 |
| Stream后续错误探针 | **失败** | SSE后续解析失败仍留下OK=true事件 |
| 完整npm run build＋独立PG | 通过 | 新建build_review库应用14个迁移，含0014/0015；构建/资产复制通过 |
| 构建产物桌面/移动smoke | 通过 | `/knowledge`可见、无console/page错误、无横向溢出，与已有dev基线无差异 |
| 完整Agent浏览器流/进程恢复/真实模型MCP/race | 本轮未完成 | 页面可见不代表业务全链；race未重新尝试，保留此前环境限制记录 |

构建与页面新增证据：[build日志](../../validation/agent/review-third-2026-09-08/build-output.txt)、[built smoke日志](../../validation/agent/review-third-2026-09-08/built-smoke-output.txt)、[built verdict](../../screenshots/agent-third-built.json)。已有dev桌面/移动截图本轮均已视觉检查，是空知识库/同步问答页面，不能证明提问成功或工具调用。

本轮使用独立测试库运行完整build，不需要生产DB授权；通过 `npm run preview -- --host 127.0.0.1 --port 58791` 启动本轮产物，再用原smoke脚本和已有dev verdict对比。临时端口属于本轮核验，不改变项目正式启动约定。

## 4. 核心缺陷与触发条件

### R3-01 · P1 · 单条SQL仍没有可靠的并发所有权验证【真实PG】

[agent-jobs.ts:98](../../src/lib/server/agent-jobs.ts#L98) 的 locked_job/locked_run只是普通查询名称，没有FOR UPDATE；后续更新只依赖先前选出的id。

- **PG-T04**：另一个连接先开始把job claim改为new-owner，本次complete读取旧快照；等待后新claim提交，但旧complete仍返回200，写入note并清空claim。这是所有权围栏失效。
- **PG-T03**：两个相同complete同时阻塞在run更新，释放后一个成功、另一个抛 `23505 knowledge_notes_run_unique`。唯一约束阻止了第二条笔记，**不能说产生两条笔记**；但调用者没有收到约定的幂等结果。
- **PG-F02**：[agent-runs.ts:283](../../src/lib/server/agent-runs.ts#L283) 同步材料CTE仍允许新正文被旧分析标analyzed。

SQL原子性只说明单条语句成功或失败时其写入整体提交/回滚；不能据此推断等待锁后业务谓词仍有效。修复目标是共享完整提交不变量，而不是形式上强制所有SQL都套同一个名字的函数。现有Sql.transaction适合在锁后重读并复核当前状态。

### R3-02 · P1 · 完成信封、响应和重放内容没有绑定【TSP01—04】

[agent-jobs.ts:88](../../src/lib/server/agent-jobs.ts#L88) 只解析response结构，不核对内层run_id与信封runId一致。已成功job的重放分支只比jobId/runId，换完成内容或伪claim也200；不返回原noteId。

失败分支先failRun再finishAiJob。job已过期时，接口409但run已被旧worker改为failed，状态不一致。成功/失败/unknown都必须执行相同的当前所有权校验，不能只修成功分支。

### R3-03 · P1 · 释放费用缺少可信“未发送”依据【TSP06】

[agent-queue.ts:237](../../src/lib/server/agent-queue.ts#L237) 把所有failed映射released，再释放日预占；没有检查模型调用开始收据、usage或支出是否未知。invalid_output通常发生于已调用模型之后，探针模拟该状态也释放全部预占。

新增S08证明“确定未发送可以释放”，并未证明“只有确定未发送才释放”。反复无效模型输出可能腾出额度继续接单，削弱实际日支出限制。真实费用、跨日处理、原子预占/结算仍按交接所述未完成。

### R3-04 · P1 · Skills只拦初始零额度，没有逐次扣减【新Go探针】

[research.go:34](../../workers/agent/internal/agent/research.go#L34) 通过MaxToolCalls>0决定是否加载middleware。设置额度1，模型连续请求两次Skill，实际收到2个工具结果，最终ok=true、ToolCalls=0；已知供应商usage仍为nil。

必须把Skill实际执行接入统一工具预算，与Internal/MCP共享原子预占，不能用“隐藏零额度工具”代替正额度耗尽检查。固定工作流输出上限/0模型额度的旧缺陷已修，不再重复指控。

### R3-05 · P1/P2 · Worker ACK、checkpoint和审计只修了一层

- Worker单次函数现在返回complete非2xx错误，但[worker.go:113](../../workers/agent/internal/agent/worker.go#L113) 实际循环丢弃错误，无保留计算结果/重传完成消息。瞬时失败仍可能丢弃答案。
- checkpoint拒绝过期run和串行相同seq不同payload已修；但未检查job当前lease，TSP05复现job过期、run未过期时仍保存。读取run/checkpoint和upsert分离，并发fencing不足。实际Resume/claim/checkpointID/续租仍未实现。
- [model.go:57](../../workers/agent/internal/agent/model.go#L57) 在Stream打开时就记录OK，未跟踪后续Recv/取消/结束；后续SSE解析失败仍记成功。当前研究禁用stream，这属于声明支持的包装能力缺口。研究usage和repair累计usage仍缺；固定格式修复缺必要原输出/目标schema。

### R3-06 · P1/P2 · 已承认的剩余功能必须继续实现

MCP可信持久收据、连接关闭/解码前上限，完整成本账本、Eino恢复、真实SQL检索评测、异步UI入口/不存在任务停止轮询、历史引用/freshness/OCR仍未闭环。不能因旧反例全绿把它们从原任务范围移除。

材料cap修复现在使用头部截断，M01/M02通过；但简报固定流程没有工具，注释“尾部由get_item表示”不能说明简报能主动补取尾部。后续评测要覆盖尾部事实，并明确选择策略/partial，而不为了cap通过暗示全文或尾部已经被分析。

## 5. 可复跑证据与测试纪律

```powershell
node --experimental-strip-types --test validation/agent/review-third-2026-09-08/spec-repro.test.ts

# REVIEW_PG_PORT只指向本次新建的独立测试库；容器已清理，复跑需重新创建
node --experimental-strip-types --test validation/agent/review-third-2026-09-08/postgres-repro.test.ts

$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
go -C workers/agent test -overlay ../../validation/agent/review-third-2026-09-08/go-overlay.json ./internal/agent -run TestThird -v -count=1

# 上轮探针迁入正式文件后，应直接运行正式测试，避免旧overlay的重名定义
go -C workers/agent test ./internal/agent -run TestFollowup -count=1
```

新证据：[Spec报告](../../validation/agent/review-third-2026-09-08/spec-findings.md)、[Spec输出](../../validation/agent/review-third-2026-09-08/spec-repro-output.txt)、[PG输出](../../validation/agent/review-third-2026-09-08/postgres-output.txt)、[Go报告](../../validation/agent/review-third-2026-09-08/go-results.md)。新测试断言正确行为，当前失败就是需修复证据，不得改为接受当前错误。

## Standards

独立审查按前轮原顺序保留已修/未修，不与Spec合并排序：

1. 固定额度已修；workflow.go:74的修复输入仍缺原输出/具体schema，P2。
2. research.go:34只拦0，正额度1执行Skill两次、记0，P1复现。
3. model.go:57后续SSE错误仍记OK；research.go:119已知usage丢失，P2复现。
4. MCP实际客户端重定向拒绝与8秒超时已修。
5. mcp.go:157可信持久收据/连接Close未实现，P1静态。
6. Skills祖先链接/有界读取已修；沙箱path_escape不能报成代码回归。
7. research.go:64真实checkpoint/Resume/续租未实现；409传播已修，剩余P1。
8. worker.go:165单次返回错误已修，113行循环丢弃且无重传，剩余P1。

另有C11可复跑性问题：旧overlay与正式7个函数重名；更新运行说明，不回改历史证据。Standards主序列仍有6项未闭环（4项P1、2项P2），最严重为正额度预算等运行边界；另有1项P2测试入口问题。

## Spec

1. P1：成功身份、response.run_id和重放内容未绑定，TSP01—03。
2. P1：失败完成仍分离写入，过期job拒绝前run已变failed，TSP04。
3. P1：已调用失败也释放所有日预占，TSP06。
4. P1：checkpoint只检查run寿命，未绑定job lease，TSP05。
5. P1：同步与新异步CTE仍依赖旧快照状态，主审PG实证补足。

Spec共5组未闭环问题，最严重为结果提交/所有权一致性。交接已承认整体partial，不能描述为它声称原方案全部完成。

## 6. 完成判定

原20项方案仍未整体完成。依赖适配、HTTP执行、基本流程和多项局部边界具有真实基础；运行原子性、统一预算、可信证据、队列恢复、成本治理、评测与Agent端到端仍需补齐。

本轮将“完整PG构建迁移”和“构建产物页面渲染”从待验证变为已验证；不把这两项进展扩大为Agent业务成功。下一步执行[第三轮收敛实施方案](2026-09-08-eino-agent-completion-plan-v3.md)，围绕完整业务不变量关闭任务，避免反复只修已列出的特定输入值。
