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
