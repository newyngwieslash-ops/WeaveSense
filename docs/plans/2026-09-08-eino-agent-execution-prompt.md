# 给实施 Agent 的完整提示词

以下横线后至文件结束可直接复制给实施 agent。这是实施任务，不是再次只做审查或生成计划。

---

请在当前项目继续完成 Eino Agent 集成与补强，执行已有方案、修改代码并验证。不要停在交接报告、修复建议或只跑现有单测。先核对工作区，再按依赖顺序完成全部可离线完成的工作；真实供应商/生产操作按下述授权边界处理。

项目根目录：

`F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace`

当前实际环境为 Windows/PowerShell，Git 元数据在 `.repo`。所有Git命令使用：

`git --git-dir=.repo --work-tree=.`

必须先阅读：

1. 项目 `AGENTS.md`、存在时的 `AGENTS.project.md`，以及 `.agents/skills/ponytail/SKILL.md`。
2. `F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/docs/plans/2026-09-07-eino-agent-architecture.md`
3. `F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/docs/plans/2026-09-07-eino-agent-implementation-plan.md`
4. `F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/docs/plans/2026-09-08-eino-agent-remediation-plan.md`
5. 最新复核：`F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/docs/plans/2026-09-08-eino-agent-followup-review.md`
6. 本次实施清单：`F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/docs/plans/2026-09-08-eino-agent-followup-plan.md`
7. `F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/validation/agent/review-followup-2026-09-08/` 内的工作区指纹、Spec/Go报告、测试源码与输出。

有 executing-plans 技能时读取并使用；按ponyTail修共享调用点，复用已有实现。不因技能中的例行提问停止已获授权的代码修复和隔离验证。

## 当前事实，不能继续沿用旧交接的错误结论

- 最新评审时HEAD为`76b6da1ac8a8d6d6c6a4b30e7f0309c9e18fd8b9`，补强是未提交工作区；此HEAD不能代表未提交代码。检查当前是否又变化，以真实代码为准。
- 旧R01—R09、旧Go两个探针已通过；PG-F01证实SKIP LOCKED双领取修复。保留这些有效修改，不能重置到HEAD重新开发。
- 新PG-F02仍失败：新正文被旧分析标analyzed。
- S01—S08仍失败：complete缺response可成功、租约过期前后半提交、重放失败、请求hash混用、checkpoint过期/同序号覆盖、预算释放未更新日汇总。
- M01/M02仍失败：研究16个sources/32000字符、简报24个sources超过共享契约。
- 新Go探针发现固定流程输出上限写死1800、0模型额度仍调用、Skill预算绕过、307跨origin带Authorization、祖先symlink根外读、checkpoint409被吞、complete500被吞、用量/Stream审计缺失。
- 普通Research/直接Stream的模型次数与输出额度已修；直接Skills根外/末级symlink已修；MCP TokenEnv已接入。请修剩余路径，不重复陈旧结论。
- Store传入Runner并不等于断点恢复：当前缺claim/checkpoint ID/Resume/续租/恢复接线。
- reservations的settled/released/unknown标签不等于成本结算。
- agent-e2e即使指定本地目标也只fetch HTML，不是浏览器验收；检索评测说明字符串不等于实际SQL评测。

## 实施要求

按最新followup-plan的C1—C12执行，下面是不可以省略的不变量：

1. **一个真实完成事务。** 接入已有Sql.transaction，在锁后验证job/run关联、当前claim、实际租约和完整材料指纹，然后一次提交业务行/run/job/相关账本。同步、异步和自动分析共用入口。禁止先保存答案再发现job过期。严格校验schema/run_id/mode；succeeded没有response必须拒绝。相同complete重传返回同一业务id，不重跑模型。
2. **稳定请求身份。** 分开canonical request hash与material hash，首次保存provider/policy/sources/scope/日期。相同request不同问题409，相同意图领取后仍能查询/重放。claim原子创建或关联真实run，非won分支不能编造runId。
3. **公共执行预算。** Generate/Stream/repair/BindTools、Internal/MCP/Skill全部经过同run预算；0额度0请求，实际供应商请求携带policy输出上限。累计所有已知usage，未知null，恢复不能重置预算。修复消息包含原输出、目标schema与错误。
4. **可靠Worker与能力门禁。** complete错误不能吞；可幂等重传结果，不能重跑模型补偿保存失败。服务端按engine/async/worker配置判断能力，关闭后停止新入队/领取；UI真实传异步选择，not_found停止轮询，失败可再提交，历史答案可见引用。
5. **真正checkpoint恢复。** 接入当前Eino版本真实interrupt/checkpoint ID/Store/Resume，传claim generation并验证租约。sequence同值不同payload拒绝；版本错误传播。实现续租与安全回收、剩余预算/已完成调用恢复；未知已发送调用不盲目重放。必须有真实worker进程kill后另一进程恢复的fake模型集成测试。
6. **真实成本账本。** 日预占/job/reservation一个事务；实际usage/费用/价格版本/预算日可查，结算/释放/unknown调整日汇总且幂等。跨日执行重核额度。费用上界与实际模型策略一致，不用常量1元冒充保证。已调用失败不等于免费。
7. **MCP可信证据和凭据边界。** 保留空allowlist零工具，禁止跨origin重定向带凭据，有工具级deadline/尺寸限制和Close生命周期。通过认证内部动作保存run绑定的真实receipt，再把ID给模型；合法外部引用可落库，伪造证据拒绝。不宣称Resources/Prompts/OAuth已支持。
8. **Skills真实根边界。** 验证最终路径及祖先链接/junction，所有读取/发现入口受root约束，传播Walk错误，有界读。只读/按需加载并计入预算；不新增shell、fork或自动执行任意技能脚本。
9. **材料与检索。** 选材阶段同时遵守sources≤12、总字符≤24000及单段上限，正确partial/OCR未完成提示；freshness比较当前fingerprint，保存完整引用元数据。评测走实际SQL候选＋排序＋截断，包括超过候选上限和长文末尾命中，不再用内存小样本代替。
10. **真正验收。** 用当前app＋当前Go＋隔离DB＋fake model/MCP运行浏览器、数据库断言及网络请求计数。完整build包含迁移和资产复制，dev/built桌面/手机均检查。不要把fetch200、固定HTML或预设成功输出叫E2E。

## 验证入口与测试纪律

先跑本次新增反例确认基线，再修代码，不得修改断言以接受当前错误行为：

```powershell
node --experimental-strip-types --test validation/agent/review-2026-09-08/repro.test.ts
node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/spec-repro.test.ts
node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/material-repro.test.ts

$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
go -C workers/agent test -overlay ../../validation/agent/review-followup-2026-09-08/go-overlay.json ./internal/agent -run TestFollowup -v -count=1

# 只在独立新建PG容器实际端口配置REVIEW_PG_PORT后执行
node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/postgres-repro.test.ts

npm test
npm run typecheck
go -C workers/agent test ./... -count=1
go -C workers/agent vet ./...
```

Go overlay映射是绝对路径，若工作区不同要重新生成，或把同语义测试迁入正式包测试。业务接口改为transaction后，测试helper可升级为真正事务；必须保留原场景/断言。旧PG01等待两个连接阻塞不适合SKIP LOCKED，应使用新PG-F01验证“跳过锁定行＋解锁后一个胜者”，不是恢复旧调度以制造失败。

还必须做：

- 全部新增回归纳入正式测试命令，失败不能通过跳过/删除覆盖来消除；历史失败日志保留，另写修复后证据。
- 真实PG多连接提交竞争、预算最后额度、checkpoint/lease竞争；PGlite通过不能替代PG。
- 旧库迁移/重复应用/失败回滚。0014/0015是否已应用不明时，使用新的前向迁移，不直接重写历史。
- 隔离配置下完整`npm run build`；不以直接vite build替代。读取项目现有startup/smoke脚本，使用当前实际路径和有效参数执行dev/built浏览器与截图检查。
- 支持CGO的平台执行`go test -race`。环境阻塞要记录具体错误与未证明能力；继续所有不依赖该条件的工作，不能因此放弃其他任务。
- 用假供应商做Worker进程中断/恢复、complete响应丢失与重传，记录模型调用计数证明没有重复计费步骤。

## 已授权与未授权范围

已授权：按方案编辑业务代码和测试；创建/清理专用测试文件、隔离数据库/假服务；本地构建、迁移隔离库、浏览器和故障验证；更新真实验收记录。对这些常规可逆工作不要反复索要确认。若工具本身触发权限审核，按工具机制请求所需最小权限，不绕过。

未授权：git reset/clean覆盖现有改动、`git init`、`git add .`、修改用户restart.bat、改真实数据库/私密环境、创建.env、提交或push、部署生产、实际收费模型/MCP调用、打开AUTO_ANALYZE或生产Eino/async开关。需要真实收费验证时，在其他离线工作完成后给出具体服务、最小调用数量和预算方案再请求授权；不能拿不到key作为停止离线修复的理由。

不新增第二个Agent框架，不重写采集/账号/提取，不把无关Comet交接任务带进这次。长任务/自动分析属于原计划范围，本次要求完成，不可用YAGNI直接删掉后宣称实现。

## 最终交付

1. 实际完成的代码、迁移和正式回归测试。
2. 更新 `validation/agent/acceptance-after-remediation.md` 和 `docs/operations/agent-service.md`，明确passed/failed/not_run及证据链接；修正旧报告的过度完成声明，保留历史审查文件。
3. C1—C12、原20任务、补强16任务逐项状态和证据。代码存在但没有有效调用者只能算部分；单测通过只能证明其覆盖范围。
4. 命令/退出码/PG竞争结果/浏览器截图/进程恢复记录，以及当前HEAD和未提交文件清单。保留默认开关，明确未提交、未push、真实集成是否待验证。
5. 如果仍有未完成项，精确列实现缺口或验证阻塞及下一步，不得继续写“离线P1已全部完成”“只剩真实服务测试”，除非相应全部门禁确实通过。

现在开始核对工作区并实施。不要只回复计划，也不要先建议提交当前补强diff来结束任务。
