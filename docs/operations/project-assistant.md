# 织识助手（Project Assistant）运维指南

> 对应实现计划：`docs/plans/2026-10-08-opencode-project-assistant.md`（Task 17）。
> 逐项测试步骤见 `docs/testing/project-assistant-step-by-step.md`。

## 1. 功能开关

| 环境变量 | 默认 | 含义 |
| --- | --- | --- |
| `AGENT_ASSISTANT_ENABLED` | `false` | 助手总开关：关闭时 capabilities 明确返回 `assistant_disabled`，新轮次无法入队 |
| `AGENT_ASSISTANT_ACTIONS_ENABLED` | `false` | 动作开关：关闭时助手只读；已批准动作仍由 reconcile 收敛结算 |
| `AGENT_ASSISTANT_DAILY_LIMIT` / `AGENT_ASSISTANT_DAILY_BUDGET_RMB` | `20` / `20` | 助手子限额；仍受统一全局预算日锁约束 |
| `AGENT_ASSISTANT_MAX_MODEL_CALLS` / `AGENT_ASSISTANT_MAX_TOOL_CALLS` | `6` / `8` | 单轮模型/工具次数上限 |
| `ASSISTANT_WORKER_TOKEN` | 空 | Worker 领取助手任务的独立服务令牌（与 `OPENCODE_WORKER_TOKEN` 分离） |

两个助手开关默认关闭；关闭时旧研究/分析路径行为完全不变。**回退顺序**：先关
`AGENT_ASSISTANT_ACTIONS_ENABLED` 阻止新批准，再关 `AGENT_ASSISTANT_ENABLED`
阻止新轮次；运行中 run 按既有撤 grant/stop 流程收敛，未执行动作取消，未知结果保留。

## 2. 部署顺序

1. 暂停新增研究/助手任务并等待收敛；备份数据库。
2. 隔离环境验证 0026/0027 迁移与旧数据兼容；部署期间禁止旧 Worker 领取 assistant 类型（0027 的触发器保证未链接轮次的 assistant job 无法插入）。
3. 更新宿主、Bridge、Worker、runtime 镜像及 `project-assistant` 批准 Skill，助手开关保持关闭；验证旧研究链路。
4. 在实际部署主机重做 profile 工具隔离、模型代理与网络隔离测试（本机 Docker Desktop 证据不能替代目标主机）。
5. 打开 `AGENT_ASSISTANT_ENABLED` 做只读试运行；再开 `AGENT_ASSISTANT_ACTIONS_ENABLED`。
6. 宿主仅 loopback 绑定；记录批准 HEAD、镜像内容 ID、profile/digest、启用人与时间。

## 3. 旧 Worker 兼容性

**直接退回不认识 `job_kind` 的旧二进制并不天然安全**：旧代码按 `item_id` 前缀
判别，assistant 行（`assistant:<turn_id>`）会被误判为分析任务。回退必须先 drain
助手工作，或使用保持新 schema 兼容但关闭功能的版本。0027 的
`ai_jobs_opencode_research_check`/`assistant_job_turn_binding` 触发器在数据库层
阻止不合法的 assistant 行，因此旧二进制最多忽略它们，不会领取执行。

## 4. 健康与可用性

- `GET /api/assistant/capabilities` 返回当前能力与不可用原因：
  `assistant_disabled` / `model_config_missing` / `research_governance_unconfigured`。
  该端点只读配置，不调用模型、不探测运行时、不 seed。
- Worker/Bridge 的无模型 health 检查沿用现有 `/health` 契约；capabilities 区分
  “配置齐全”与“最近端到端验收通过”（后者见测试指南 Q01）。
- reconcile 循环在两次模型运行之间与空闲轮询中运行：预览过期、子研究终态、
  到期 run 收敛均无需浏览器访问；助手开关关闭时 reconcile 与既有预算结算继续。

## 5. 边界与限制（如实告知）

- 首期能力只对可信本机单操作员开放；助手门禁不补全整个产品的公网安全。
- 外部采集没有供应商幂等协议：可证明“一次发送或结果待核实”，不能承诺
  跨崩溃 exactly-once。
- 模型设置档案与 `AGENT_MODEL_*` 固定环境配置存在差异；助手使用后者并如实展示。
- 会话归档不是数据删除；保留/删除策略需独立实现，UI 不承诺“彻底删除”。

## 6. 分阶段试运行（交付流程）

按顺序执行，每阶段有明确验收与回退开关；前一段未通过不进入下一段。

| 阶段 | 开放范围 | 通过标准 | 回退 |
| --- | --- | --- | --- |
| 0 | 全部关闭 | 旧研究/分析链路回归全绿；`capabilities` 返回 `assistant_disabled` | 无需 |
| 1 | `AGENT_ASSISTANT_ENABLED=true`（只读） | 面板可开；快照/事件轮询正常；读历史 0 模型调用（A01/A07/A08） | 关回 `false` |
| 2 | + `AGENT_ASSISTANT_ACTIONS_ENABLED=true` | 关键词/信源预览→确认→真实写入→回执→缓存刷新（A09/A10/A11） | 先关本开关（阻止新批准），已批动作由 reconcile 收敛 |
| 3 | 单次采集动作 | 稳定 jobs ID；断线重连只查不重采（A12/A13） | 同上 |
| 4 | 研究子任务 | 子任务经既有 Reviewer 发布；取消只作用于本轮归属（A15/A16/A17） | 关总开关并 drain |

每阶段记录：日期、操作者、HEAD、镜像 ID、profile/digest、观察结果。真实付费质量
试运行（Q01）在所有阶段通过后单独执行，不以假模型结果替代。

## 7. 交付清单（第一版实现）

- 迁移：`migrations/0026_assistant_sessions.sql`、`migrations/0027_assistant_runtime.sql`
- 服务端：`src/lib/server/assistant-{access,store,context,tools,jobs,actions,action-preview,action-dispatch,research,reconcile,events,capabilities,turn-status,action-receipt}.ts` + `project-actions.ts`
- 合同：`src/lib/assistant-contract.ts`、`assistant-state.ts`、`assistant-client.ts`、`assistant-effects.ts`
- 路由：`/api/assistant/*`（capabilities/conversations/messages/events/turns/actions）与 `/api/internal/assistant-actions`
- UI：`src/components/assistant/*`（provider/launcher/panel/composer/message/action-card）
- Go：runtime assistant profile + `project-assistant` Skill、Bridge profile 工具面、Worker 双队列执行
- 文档：本指南、测试指南、验收 harness `validation/agent/assistant/e2e.mjs`
