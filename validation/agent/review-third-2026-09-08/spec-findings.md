# 第三轮独立 Spec 审查（2026-09-08）

依据 `docs/plans/2026-09-08-eino-agent-followup-plan.md` 的 C1/C2/C7/C8 与 §2 不变量；对象为当前工作区。读取了当前 `acceptance-after-remediation.md`。本轮没有业务修改、真实付费调用或实际项目库访问。

## 对交接表述的判断

当前交接已明确总体为 partial，并承认没有公共事务、真实 Resume、费用结算和完整集成。这些应被认可，不应将“已承认未完成”表述成“宣称整体完成”。旧 S01—S08 修复具有价值。

但有三个局部陈述仍超出实现：

1. `acceptance-after-remediation.md:26` 的 “strict async complete schema”：外层 params/status 仍强制转换，未校验 response.run_id 与完成信封一致；完成重放未校验内容或 claim。
2. `:28` 的 “failed known-not-sent work releases”：代码不是仅释放可证明未发送，而是所有 failed 均释放，invalid_output 同样释放。
3. `:36` 的 “fenced SQL CTE”：CTE 名为 locked_job/locked_run，但只是无 FOR UPDATE 的普通查询；实际等待后是否仍拥有权未在更新谓词重新检查。原子一条 SQL 不等于并发所有权 fencing 已实现。真实 PG 由主审独立验证。

## 本轮可执行检查

`node --experimental-strip-types --test validation/agent/review-third-2026-09-08/spec-repro.test.ts`

六项正确行为断言均失败，退出码 1。日志 `spec-repro-output.txt`。使用内存 PGlite、真实生产 handler 与构造的执行响应；没有调用模型。TSP06 模拟 invalid_output 的终态，该终态通常发生于已发送模型调用后，验证的是账本释放规则而非真实供应商计价。

| ID | 当前复现 | 预期 |
|---|---|---|
| TSP01 | 已完成任务换成不同内容，仍 replay 200 | 冲突 409，原结果不应被误认同内容重放 |
| TSP02 | 已完成任务携带伪 claim，仍 replay 200 | 旧完成身份验证失败 |
| TSP03 | 内层 response.run_id 是另一个合法 UUID，仍提交 200 | 400，无业务写入 |
| TSP04 | job lease 已过期，failed complete 回 409 但 run 已改 failed | 拒绝旧 worker，不改变 run |
| TSP05 | job lease 已过期，checkpoint 仍保存 ok | stale |
| TSP06 | failed/invalid_output 使日预占金额从 1 变 0 | 未证明无支出，保留预占或结算/unknown |

## 发现与规格对应

### TS3-1 — P1：成功身份与重放内容未绑定

`src/lib/server/agent-jobs.ts:88–91`（定位点 88、91）。parseExecuteResponse 仅验证结构，随后没有判断 parsed.value.run_id===runId。已有成功 job 的 replay 分支仅匹配 jobId/runId 即 200，绕过 claim、引用与完成内容比较，也不返回此前业务 note_id。TSP01–03 复现。对应 C1.1/C1.4、§2.3/2.4。修复需在首次成功保存规范化完成摘要及可验证完成身份；重放要求相同摘要和身份，返回同一业务结果；内部 run_id 必须吻合。

### TS3-2 — P1：失败完成仍为分离写入

`src/lib/server/agent-jobs.ts:81–86`（定位点 84）。failRun 在 finishAiJob 之前执行且不检查 job 关联/租约。TSP04 表明已过期 job 的 worker 仍改变有效 run，之后 job 保持 running 而 handler 返回 409；不是仅成功路径需要原子性。任意非法 status 的 cast 也不能代替运行时 schema 校验。对应 C1.2/C1.3、C2.5。终态成功、失败、未知均需共享事务/同一所有权校验顺序。

### TS3-3 — P1：已耗费调用失败会重新释放全部可用预算

`src/lib/server/agent-queue.ts:237–243`（定位点 237、242）。所有 failed 映射 released，未检查 errorCode、调用开始收据或实际 usage；S08 仅覆盖 not_sent，所以该绿测试不能证明释放决策正确。TSP06 复现 invalid_output 也释放。自动调度在模型多次返回无效结果时能够用释放出的额度继续接纳任务，削弱每日支出上限。对应 C7、§2.8。应基于可信调用状态区分确定未发送/已知用量/未知支出；未知不可释放。

### TS3-4 — P1（恢复启用门禁）：checkpoint 仅校验 run 寿命，未绑定 job lease

`src/lib/server/agent-checkpoints.ts:29–45`（定位点 33、45）。新增 run.expires_at 和同 sequence payload 的串行守卫有作用，但没有当前 job 关联/lease；读取 run、读取 checkpoint 和 upsert 三段仍不原子，相同 sequence payload 守卫可能被并发绕过。TSP05 复现 job lease 已过期但 run 尚在寿命内仍可写。版本参数未在 upsert 更新或完整绑定。对应 C8、§2.9。交接明确尚无真正恢复，不应将其说成隐瞒；应在恢复开放前补真实 fencing 与并发测试。

### TS3-5 — P1：同步与新增异步 CTE 仍依赖先前查询状态

`src/lib/server/agent-runs.ts:286/304/350/363` 与 `src/lib/server/agent-jobs.ts:98/101/106/111`。同步仍为旧 claimed/matched CTE；异步新 locked_* CTE 没有行锁。若两完成消息或材料更新与提交竞争，等待后更新仅依赖先前选出的 id。没有调用 Sql.transaction，也没有完整 published_at 指纹复核。此处为静态确认，PG 并发结果由主审另测，避免将 PGlite 串行通过宣称为真实 PG race 已排除。对应 C1.2/3/5/6。

## 下一实施批次

优先完成 C1 的共享事务及严格身份/重放，其次 C7 可信支出状态，最后 C8 所有权 fencing；上述六项纳入正式回归，并保留旧 R/S/M/Go 测试。每个任务以完整不变量为目标，不能只把当前六条输入改绿。继续保留默认功能关闭和未验收范围；本子审不建议为测试结果先做提交或生产启用。
