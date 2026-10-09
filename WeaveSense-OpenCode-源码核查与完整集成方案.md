# WeaveSense × OpenCode：源码核查与完整集成方案

**日期：2026-10-07**  
**性质：基于上传源码的静态分析、有限契约测试及工程设计；不是已经完成的 OpenCode 集成。**

## 0. 阅读方法、证据范围与交付边界

本方案实际读取并解压了上传的 `WeaveSense.rar`。归档内共解出 619 个普通文件；分析以外层 `WeaveSense/` 源码为准，不以项目名字推测功能，也不把 `public/zhishi-loom-source.zip` 内可能不同的历史版本混作当前源码。

归档 SHA-256：

```text
60a0c66234f33eac48b1b1ea22e2a8e2ea0e2476e8d2224a5fa430116bc6e2cf
```

包内 Git HEAD 记录为 `24d899023db08c8ea2e739b9c77a150743cc8bf6`，提交时间记录为 `2026-10-06 22:33:22 +0800`。HEAD 仅为定位信息；本次不宣称解压工作树与这个提交完全一致，具体以归档字节和文件哈希为准。

本方案使用三类来源：

| 标签 | 含义 | 不能由此推出的结论 |
|---|---|---|
| S01–S32 | 上传源码中的具体路径、行号和摘录，见同包《WeaveSense-源码证据摘录.md》 | 不自动证明你的实际部署已启用或成功运行 |
| M01 | 上传的《MiniMax-Design-技术架构与复现分析报告-v2.md》，按章节引用 | 不代表本次取得 MiniMax 源码或重新验证其安装包 |
| O01–O05 | 本次查询的 OpenCode 官方文档，见末尾来源表 | 不代表 OpenCode 二进制已安装、联调或通过所有兼容测试 |

**已完成**：关键执行路径的源码审阅、生产 Skill/MCP 实现定位、引擎与默认部署核查、原始 Go 契约测试的独立复跑、方案样例的 TypeScript 类型检查和 JSON Schema 校验。

**未完成**：完整应用构建、Go 完整模块测试、真实模型/MCP 调用、用户线上环境检查、OpenCode 运行验证、端到端质量与性能对照。没有修改原项目业务代码，也没有提交付费生成请求。

## 1. 决策结论

**可以集成，但应作为可选的独立 Agent Runtime，而不是替换现有业务控制层。仅为了继续安装 Skill 或接入 MCP，没有必须引入 OpenCode 的理由。**

源码已经具备：Eino 研究 Agent、运行时 Skill 加载、MCP Streamable HTTP 客户端、内部证据检索工具、检查点恢复、任务租约、运行幂等、调用回执与原子完成。需要补足的是更通用的长任务协作、受控工作区、产物版本与独立质量审核，而不是从零补上“工具调用”。[S02、S05–S13、S20]

建议分成两条路径：

- 现有单条分析、日常简报、库内问答：保留 legacy/Eino，先验证现有功能是否满足需求。
- 经授权的复杂专题研究、阶段化报告、可编辑产物和人工审批：增加 OpenCode Sidecar 试点，并由 WeaveSense 保持证据、权限、成本和发布的最终决定权。

OpenCode 带来的是可复用运行时能力的工程收益候选，不是“接入后模型必然更聪明”的保证。同模型、同材料、同任务条件下的效果和成本要通过对照评测决定。[设计判断]

## 2. 源码当前究竟是什么

### 2.1 应用与 Agent 已经分层

`package.json` 声明 React、TanStack React Start、TypeScript、pg/PGlite 等依赖；`src/lib/db.ts` 根据配置选择 PostgreSQL 或 PGlite。独立的 Go 服务在 `workers/agent/`，不是 Electron 内部 Agent。[S01、S02、S26]

`workers/agent/go.mod:3–9` 明确声明：

```text
go 1.24.1
github.com/cloudwego/eino v0.9.19
github.com/cloudwego/eino-ext/components/model/openai v0.1.13
github.com/cloudwego/eino-ext/components/tool/mcp v0.0.9
github.com/mark3labs/mcp-go v0.43.0
```

当前适合保留的调用边界是：

```text
React/TanStack UI
  → TypeScript 服务函数与行业业务层
  → legacy 或 Go/Eino 执行路径
  → 模型、内部语料工具、受控 MCP
  → 引用校验与原子完成
  → analyses / knowledge_notes 等业务数据
```

这不是 MiniMax 的桌面画布架构。应借鉴协议和职责分离，而不是新增 Electron、NestJS、SQLite 后重写现有应用。[S01–S05、S26；M01 §3–4]

### 2.2 Eino 是真实实现，不只是依赖声明

`workflow.go:44–45` 将 `research` 分派至 `runResearch()`；`research.go:71–86` 实际创建 `adk.NewChatModelAgent()` 与 `adk.NewRunner()`，配置工具、Skill Middleware、预算模型和 CheckPointStore。`research.go:89–110` 有恢复调用。[S04、S05]

单条分析和简报主要走结构化模型输出流程；研究是有界工具循环。研究普通逻辑轮次设为 6，durable 分支为了处理 Eino 回放扩大迭代计数，但实际模型/工具调用仍受预算控制。没有证据支持把它描述成当前已有一整套独立 Producer/Reviewer/Controller 多角色系统。[S04、S05]

### 2.3 生产 Skill 已经有加载、限制和版本记录

当前生产目录里明确存在三个包：

| Skill | 原始文件 | 已声明职责 |
|---|---|---|
| industry-analysis | `workers/agent/skills/industry-analysis/SKILL.md` | 单条行业材料结构抽取 |
| briefing-writing | `workers/agent/skills/briefing-writing/SKILL.md` | 时间范围内简报 |
| cross-source-check | `workers/agent/skills/cross-source-check/SKILL.md` | 跨源一致、冲突和缺证分析 |

`skills.go` 不只是读取一个提示词字符串：有受限文件系统读取、路径解析、只读写接口、包哈希、文件数上限、重复名字拒绝、禁止 Skill 自行覆盖 context/agent/model，并有 `read_skill_resource` 工具。[S06、S30–S32]

但当前没有从已查代码中确认完整的安装注册中心、依赖锁解析、管理员审批、签名信任链、跨运行时绑定和版本回滚管理。因此应在已有加载器之上增设治理层，而不是宣称“尚无 Skill”。

### 2.4 MCP 也已真正接入

`mcp.go:57–63` 明确只接受 `streamable_http`。后续会读取环境变量凭据、启动和初始化 MCP Client、按 `allowed_tools` 过滤、规范化名称、限制响应大小，并把工具调用开始和完成事实写入应用服务。[S07]

`agent-data.ts:60–83` 另有应用侧工具白名单和回执验证；返回的证据身份由可信业务服务建立，不是模型自行生成。[S09]

现阶段不能说已支持本地 stdio Server 生命周期、任意脚本执行或所有 MCP 多模态结果。示例 `mcp.example.json` 中服务为 `enabled:false`，Compose 的 `AGENT_MCP_CONFIG` 默认空；实际连接了什么服务没有部署证据。[S03、S08]

### 2.5 任务安全与可恢复性已有基础

以下能力应保留：

| 能力 | 当前源码位置 | 集成原则 |
|---|---|---|
| 请求幂等、输入和素材 hash | `agent-runs.ts:101–180` | 新 Runtime 仍须遵守 |
| 数据库租约认领 | `agent-queue.ts:136–163` | 增加 Runtime 过滤，不重建无约束队列 |
| Checkpoint 恢复 | `agent-jobs.ts:23–45`、`worker.go` | Eino 私有状态仍由 Eino 解释 |
| 模型调用预算和调用前事实 | `model.go:62–97` | OpenCode 不能绕过 |
| 精确引用校验 | `agent-context.ts:293–304` | 引用来自登记材料且 quote 为原文子串 |
| 原子完成与业务写入 | `agent-completion.ts:25–70` | 始终由应用决定是否发布 |

注意：精确子串校验能拒绝不存在的证据 ID 和伪造引文，不能单独证明结论推理正确、引文没有断章取义或多个来源相互独立。新增语义审核的价值应在这里验证，而非重复写一遍已经存在的字符串校验器。[S10–S13、S16、S20]

### 2.6 上传默认配置不是“已启用 Eino”

`docker-compose.yml:154` 将 Go Agent 放在可选 `agent` profile；226–237 行是：

```text
AI_ENGINE 默认 legacy
AGENT_WORKER_ENABLED 默认 false
AGENT_ASYNC_RESEARCH_ENABLED 默认 false
VITE_AUTH_ENABLED 固定为 "false"
```

这说明源码中的 Eino 路径存在，但按这份 Compose 默认启动不等于启用了它。是否覆盖环境变量、是否存在前置访问控制、是否线上已启动，应另用实际运行配置确认，不能由归档推断。[S03]

## 3. 接 OpenCode 前应先解决的具体问题

### 3.1 超时链存在实际不一致

`analyze.ts:85–98` 将 native 单次模型超时设为 120 秒，并在注释中称与 Agent 路径一致；但 `agent-client.ts:8` 默认 45 秒，Go `config.go` 的 ExecuteTimeout 为 40 秒，`server.go:93–99` 将实际 deadline 取策略 deadline 与该上限的较早值。异步研究入队虽声明约 120 秒 deadline，也不代表 Go 单次执行可持续 120 秒。[S14、S15、S17、S18、S12]

整改：分别定义排队寿命、单次模型超时、Runtime 执行期限、业务任务期限和人审等待期限；不要只改一个注释或环境变量。扩长任务也必须有租约、预算与取消能力。

### 3.2 固定 Skill 读取错误被忽略

`workflow.go:54` 为 `skillBody, _ := loadFixedSkill(...)`，读取失败可静默退化为无 Skill 提示词。应根据 Skill 必需/可选属性返回结构化错误或明确降级事件，并补测试。此处是静态代码问题定位，不宣称已经观察到你的实际生产失败。[S04]

### 3.3 新 Runtime 不只是替换一个 URL

以下位置已写死 legacy/eino 或 Eino 专属逻辑：

- `agent-client.ts:10–25,40–45` 与 `analyze.ts:41–44`：引擎类型限制。
- `analyze.ts:392–403`：只有 Eino 被允许异步研究。
- `agent-queue.ts:136–161`：认领筛选按业务 kind，不按 runtime。
- `agent-jobs.ts:34–35,51–63`：恢复版本及新认领 provider 固定为 Eino。
- `migrations/0011_ai_runs.sql:5`：数据库 CHECK 限制 provider。
- `fns.ts:446`：全局异步能力关闭会取消尚未认领的研究任务。

如果直接让 OpenCode 作业进入现在的研究队列，旧 Go Worker 可能先领到它，然后走 `unsupported_saved_provider`。必须同时改认领、恢复、能力展示和数据库合同，而不能只设置 `AI_ENGINE=opencode`。[S12–S15、S21、S22]

### 3.4 库内问答不能悄悄变成全网研究

`analyze.ts:387–390` 在无语料种子时返回 `insufficient_evidence`；异步任务 snapshot 为 `scope:corpus`。OpenCode 加入后仍应保持这个产品承诺。外部研究必须新增明确的任务范围、工具授权、证据导入和 UI 标记，不能自动联网填满“材料不足”。[S15]

### 3.5 无登录配置要求更谨慎的执行边界

本包默认关闭登录。已查的研究业务函数定义没有在这些定义上挂认证中间件，知识笔记查询也未显示主体/工作区隔离条件。这不是对所有外部网关的安全结论，但足以说明不能直接追加面向不可信请求的任意 shell、文件系统和网络工具。[S03、S21]

P0 应保持受信任、隔离访问；共享/公网多用户部署需身份、角色、数据行授权与审计配套，不能把“打开登录开关”当成完整多租户改造。

## 4. 三种方案比较

| 方案 | 改动与收益 | Skill/MCP 扩展 | 代价与风险 | 结论 |
|---|---|---|---|---|
| A：继续增强原生 Eino | 延续既有证据、回执和恢复体系；增设角色/步骤/产物 | 现有加载器加中立 Registry/Broker 即可 | 复杂协作需要自行开发 | 当前窄范围分析问答的优先基线 |
| B：OpenCode 独立 Sidecar | 复用独立会话与任务执行能力；按业务场景渐进接入 | 两运行时共享平台扩展合同 | 增加进程治理、协议适配、成本代理和测试 | 有复杂任务需求时推荐试点 |
| C：深嵌/Fork 或替换核心 | 可深改内部行为 | 容易绑定某一实现 | 回执、预算、租约、DB 和恢复迁移风险大 | 当前源码没有显示足够理由支持 |

先完成 A 的基线核查再做 B 对照，不以 C 作为默认终点。B 没有达到质量/成本验收就保留关闭，不必为技术栈统一强行上线。[基于第 2–3 节的设计判断]

## 5. 目标架构与责任归属

```text
现有 React / TanStack 研究页面
               │ 研究任务、阶段进度、审批与版本差异
               ▼
WeaveSense TypeScript 业务控制层（保留）
  ├─ 身份 / scope / 策略 / 配额 / 数据授权
  ├─ Task Controller + 租约队列 + Outbox/Event Journal
  ├─ Extension Registry + 固定版本锁
  ├─ Artifact / Review / Publication Service
  └─ Runtime Router
          ├─ LegacyAdapter → 现有 legacy 路径
          ├─ EinoAdapter   → 现有 Go Agent
          └─ OpenCodeAdapter → 受限任务沙箱中的 OpenCode Server
                                   │
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
              受控 MCP Bridge/Broker       模型调用预算网关
               ├─ corpus.search/read        ├─ 每次调用准入
               ├─ 受控外部资料工具          ├─ 凭据代理/限额
               └─ 草稿/产物工具             └─ 调用回执与结算
                     │                           │
                     └─────────► WeaveSense SQL ◄─┘
                                      │
                            原子发布 knowledge_notes
```

这里的 Gateway 是现有 TS 应用承担的可信业务边界，不要求新建一套 NestJS。OpenCode 是执行器，不能直接改 analyses/knowledge_notes、宣告自己的引文有效、签发审核通过或决定退款。[设计；保留 S09–S13 的边界]

职责划分：

| 组件 | 可以决定 | 不可以决定 |
|---|---|---|
| Runtime | 怎样组织模型上下文、选择已授权工具、形成候选草稿 | 用户身份、证据真实性、最终发布和账务 |
| MCP Broker | 是否准许某次工具调用、输入输出合同、运行事实 | 让任意 Skill 自授权 |
| Registry | 哪些包被安装、启用、固定版本和授予什么能力 | 因包声明“可信”而自动信任 |
| Validator | 精确引用、版本、结构、数值等确定性规则 | 冒充领域语义判断 |
| Reviewer | 针对固定来源和草稿提出可定位的审核问题 | 修改被审内容、写最终业务表、调用付费工具 |
| Controller | 依据确定性结果/审核/用户决定推进或回修 | 相信 Producer 自报成功就直接发布 |

## 6. OpenCode 接入形态、版本与适配器

### 6.1 使用独立 Server，不嵌入终端 UI 或 Fork 内核

官方 Server 文档提供 headless `opencode serve`、HTTP/OpenAPI、会话创建、异步提交、取消和 SSE；SDK 文档提供连接已有 Server 的客户端方式。因此推荐通过版本锁定的服务协议接入，而非解析终端输出。[O01、O02]

第一次接入必须锁定并记录：发行版版本号、二进制/镜像 digest、SDK 版本、OpenAPI 摘要、配置编译器版本。没有实际运行验证前，不在本方案编造一个“当前最新且已兼容”的版本号。

官方普通文档与 `/v2/docs/mcp-servers` 展示了不同的 MCP 配置形状；例如 v2 强调 `mcp.servers` 和 `disabled`。因此禁止把不同代文档片段拼进同一个配置文件。先用实际二进制导出的合同测试，再生成对应配置。[O05]

### 6.2 每个活跃试点任务一个隔离运行单元

初期一个受限容器/沙箱承载一个任务的 OpenCode 进程，独立工作区、配置目录和 HOME。完成后停进程，持久化必要的任务状态；同一任务恢复只能绑定其原有状态和兼容版本。建议初始并发 1，验证后再增加，不能直接认定一个全局常驻进程可安全隔离所有任务。

Runtime Supervisor 负责准备沙箱、健康检查、进程退出、清理和日志。业务应用不获得任意 Docker Socket 或随意启动容器的权限；Supervisor 只接受固定镜像、配额和挂载模板。

### 6.3 应用自有的接口合同

完整类型见 `examples/runtime-adapter.ts`。主要接口是：

```ts
interface AgentRuntimeAdapter {
  capabilities(): RuntimeCapabilities;
  health(signal: AbortSignal): Promise<Result<Health>>;
  prepare(run: FrozenRun, signal: AbortSignal): Promise<Result<RuntimeHandle>>;
  submit(run: FrozenRun, handle: RuntimeHandle, signal: AbortSignal): Promise<Result<Accepted>>;
  observe(handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<ObservedRuntimeEvent>;
  reconcile(handle: RuntimeHandle, signal: AbortSignal): Promise<Result<ReconciliationSnapshot>>;
  cancel(handle: RuntimeHandle, reason: string, signal: AbortSignal): Promise<Result<CancelRequested>>;
  dispose(handle: RuntimeHandle, signal: AbortSignal): Promise<Result<Stopped>>;
}
```

上述是领域接口示意，不是 OpenCode SDK 的原生方法名。现有 Eino `/v1/execute` 由 EinoAdapter 维护兼容，OpenCodeAdapter 单独映射当前厂商 API。同步 Runtime 可以声明不支持可观察事件；Controller 不得凭空伪造它的细粒度执行过程。

prepare 先创建并持久化运行绑定；submit 使用应用生成的 dispatch_id。提交结果不明必须 `dispatch_unknown → reconcile`，不可自动再次提交同一提示词。AbortSignal 仅能取消本地请求的场景，必须另调用 Runtime 取消并核实结果，不能把断开 HTTP 当作远端已停止。

### 6.4 事件和错误模型

应用持久事件至少含 `event_id/run_id/seq/dedup_key/type/runtime_instance_id/instance_epoch`。seq 由应用事务分配；上游 SSE 是观察渠道，不直接充当可恢复账本。

OpenCode 事件缺失时通过消息/会话状态和可信模型/MCP 回执对账。不能承诺还原上游未持久保存的每个临时事件，更不能仅靠“最后一条文本说完成”发布结果。[设计，基于 O01 的流接口而不扩张其保证]

错误须包含 code、phase、outcome 和 retry 分类：`not_sent/known/unknown`；`never/safe_read/reconcile_first`。失联后未知的模型计费或工具副作用不可归零，不可盲重试。

## 7. 一次研究任务的端到端流程

1. **接收与冻结**：服务端解析身份、scope、材料范围和模型 profile。保持既有 request_id 幂等；冻结 material_hash、policy_digest、extension_lock_digest 与 runtime。
2. **准入**：检查额度、必需 Skill/MCP 和运行版本；生成可信数据与模型访问 grant。超预算或缺必需扩展时，尚未调用模型就失败。
3. **入队与认领**：持久化 runtime_provider；仅匹配的 Worker 可认领。旧 Eino Worker 只能认领 Eino 作业，恢复扫描同样必须按 runtime 隔离。
4. **准备运行**：Supervisor 物化只读输入快照、扩展快照和受限可写 output；建立应用 run_id 与 Runtime session_id 绑定；探活后提交。
5. **工具与模型调用**：都经可信 Broker/预算网关。记录 started，再提交外部调用，再记录明确完成或 unknown。
6. **草稿收集**：Runtime 交付严格结构化结果/产物引用；应用读取实际字节、计算哈希、限制体积和文件类型。模型说“已保存”不等于文件存在。
7. **验证与审核**：现有引用校验先运行；复杂任务再进入独立语义审核。草稿可展示，但尚不能成为已发布答案。
8. **原子发布**：核对材料和草稿版本仍等于审核版本，核对有效 claim，调用应用完成事务写知识笔记、状态、预算结算与 outbox。
9. **清理与恢复**：停止不需要的进程，保留审计与必要恢复材料。重启先对账，不把新生成当作通用恢复手段。

初期保留 `research + scope:corpus`；外部研究经新增 scope 和审批后逐步启用。独立网页内容由业务网关登记证据，不由 OpenCode 任意赋予可信级别。

## 8. Skill：中立扩展包、安装与持续扩容

### 8.1 平台拥有扩展合同，运行时只消费快照

建议中立目录：

```text
extensions/
  skills/cross-source-check/1.0.0/
    extension.json
    SKILL.md
    references/
  workflows/
  validators/
  reviewers/
  mcp/
```

目录为新增设计。`1.0.0` 是拟议封装版本，不是声称原项目已经发布了该版本。现有三份生产 Skill 可以首先登记，原文与原哈希留档；不批量导入开发工具目录。

包格式至少包括 id、version、kind、entry、文件列表及各自 SHA-256、精确依赖、目标运行时、能力需求、请求权限和测试。完整示例与 Schema 见 `examples/extension-manifest.schema.json`、`cross-source-check.extension.example.json`。

Schema 校验只是第一层；安装器还须验证路径穿越、绝对路径、重复文件、大小、symlink、文件哈希、依赖闭环、信任策略、许可证与实际加载兼容性。包声称兼容某 Runtime 不等于已经通过测试。

### 8.2 将 Skill 与具体工具名解耦

中立能力名采用 `corpus.search`、`corpus.read`、`artifact.read` 等。Eino 与 OpenCode 对应实际工具名字可能不同，由配置编译器明确绑定。原 `cross-source-check` 里写有 `search_items/get_item`，因此迁移不能只复制文件后假定所有工具名自动匹配。[S32]

首选提供稳定别名包装；需要渲染提示词时，对模板和渲染产物各记录 digest。模型最后使用的上下文版本必须可追溯，禁止隐式字符串替换后仍记录原始包 hash。

### 8.3 不把所有扩展都伪装成一个 SKILL.md

| 类型 | 执行归属 | 原则 |
|---|---|---|
| Prompt / Reference Skill | 各 Runtime 兼容加载器 | 只表达说明与资料，不自带无限权限 |
| Tool/Script 扩展 | MCP Broker 或受限工具执行器 | 脚本执行独立审查、隔离和计费 |
| Workflow | WeaveSense Controller | 状态转换和失败策略由程序定义 |
| Validator | 应用验证服务/受限独立进程 | 确定性返回，不由创作者自填 |
| Reviewer Profile | 独立审阅调用 | 只读材料，输出 ReviewReport |

Skill 名为 reviewer 并不会自动形成独立审核边界；加载 prompt 也不应自动执行其中的 shell 命令。

### 8.4 发现、信任、版本和回滚

安装流程为“收包 → 隔离扫描 → 文件与依赖校验 → 人工/策略审批 → 契约测试 → 登记 immutable package → 启用”。初期仅允许平台维护者安装受控包，不必先开发公开插件市场。

全局安装表示组织可选择，不表示所有工作区自动获得所有权限。项目/工作区级选择必须符合全局策略；有效权限取用户授权、租户/工作区策略、任务授权与扩展需求的交集。包声明不能扩大权限。

同名冲突默认拒绝或要求明确命名空间；禁止不透明的“后加载覆盖前加载”。依赖必须锁为确定版本和包摘要；不存在的依赖阻止新任务启动。

普通升级和热加载只影响新任务。进行中的任务使用只读快照，不随目录变更；禁用后不得再启新任务。安全撤销则允许立即停止相关活跃工具授权，同时保留证据，不能把已经加载的危险版本静默替换成另一个版本继续执行。

Registry 同时生成 Eino filesystem 快照和 OpenCode 专属快照。Eino 现有包哈希与平台中立包 digest 可以不同，必须分别保存，不能将两种算法的结果混作同一字段。

### 8.5 避免加载开发环境 Skill

OpenCode 官方文档列出了 `.agents/skills` 等自动发现目录。[O03] 该上传项目包含开发工具目录，所以不能把 OpenCode 的 cwd 直接指向整个源码根并继承开发者 HOME。任务沙箱只物化审批后的业务 Skill 与数据快照；配置来源审计必须确认没有多加载开发工具或全局插件。

## 9. MCP：保留现有证据合同，增加统一 Broker

### 9.1 首期桥接内部语料接口

新增 `workers/mcp-broker/`，向 Runtime 暴露受控工具，内部复用 `agent-data.ts` 的业务能力。Broker 自己持有应用服务凭据；Runtime 仅获得绑定单个 run/task/scope 的短期 grant。请求体中由模型传来的 run_id 不作为身份凭证。

工具能力映射建议：

| 中立能力 | 原有基础 | 新增要求 |
|---|---|---|
| corpus.search | `search_items` | 当前任务范围与数据授权 |
| corpus.read | `get_item` | 限长、来源版本和 evidence_id |
| corpus.analysis.read | `get_analysis` | 保留陈旧标识，不能当最新事实 |
| artifact.draft.write | 新增 | 仅草稿目录、限类型和体积，不能发布 |
| artifact.read | 新增 | 按 artifact_id+revision 读取 |
| external.retrieve | 另行授权 | 受控域名、凭据、证据导入与出处标记 |

首期不用任意外部工具就能验证 OpenCode 接入：只开放前两项，使用相同语料完成现有问答合同。

### 9.2 两类传输分步实现

保留现有 Streamable HTTP 路径作为 Eino 兼容基线。统一 Broker 可作为两个 Runtime 的 HTTP 工具入口；后续由 Broker 管理审查过的 stdio Server，不要求每个 Runtime 都实现一套相同的进程管理器。[设计，S07 已确认当前只支持 HTTP]

stdio 管理须固定可执行文件/镜像摘要和 argv，禁止用户直接提供 shell 字符串；清理子进程树，区分协议 stdout 与诊断 stderr；限制 cwd、HOME、环境变量、网络、内存、CPU 与输出。动态依赖安装不能发生在模型工具调用路径中。

### 9.3 每次调用合同

调用前检查 grant、租约、server/version/tool、JSON Schema、审批、预算和幂等键。可信服务记录 tool_call_id 与 started 事实后再发送请求；响应做 Schema、长度、类型、来源范围和安全渲染检查。

当前客户端与应用各有一份 allowlist。过渡期可由单一 Registry 生成这两份配置并测试一致性，不能删除其中一层后误认为已经“统一权限”。[S07、S09]

读取超时可依据策略重试；有写入、付费或未知副作用的工具，必须查询原任务或使用真正受服务支持的幂等机制。通用 JSON-RPC 请求 ID 不能被当成所有外部服务的业务幂等键。

### 9.4 身份、健康与内容边界

远程 HTTP Server 做出站域名/IP/DNS/重定向审查；localhost、内网地址和云元数据默认禁止，明确批准的内部服务单独配置。现有 MCP HTTP transport 未显示复用其他采集器的 outbound-policy，因此需要显式接入并测试，不可视为已经继承。[S07]

必需 Server 故障阻止任务启动；可选 Server 故障返回结构化降级事实。健康检查分进程就绪、协议初始化、工具清单兼容和实际受控探测，不能只因进程存在就返回全部能力可用。

超长文本先保存原始内容并产出版本化受限引用；不能截断后声称“完整阅读”。图片、文件等结果经资产导入器校验并登记，不继续沿用当前“扁平化文本即完整 MCP 能力”的假设。

日志记录 trace/run/call/server/version、延迟、结果摘要与错误类别；剥离 Token、个人资料和不必要正文。缓存按工作区授权、工具版本、输入 hash 和材料修订隔离，不能跨授权复用敏感结果。

## 10. 模型预算、安全与秘密管理

### 10.1 预算必须覆盖 OpenCode 内部的所有实际模型请求

现有 Go budgetModel 会在真实 Generate 之前登记调用并执行预算检查。[S20] 仅在 OpenCode 会话结束后读取总 usage，无法等价替代这个边界。

新增模型预算网关：先校验每次模型请求的 run grant、价格版本、可用额度、上下文/输出上限并登记 started；再转发并记录 supplier request ID、usage 与明确结果。模型重试、子 Agent、摘要/压缩和辅助调用只要经过供应商都必须被计入。Runtime 不获得可绕过网关的供应商主密钥或另一条登录配置。

网关不能证明每个内部请求都经过它时，P2 不得扩大到付费复杂任务。允许的 provider 协议从单个经过测试的模型 profile 起步，不能未经测试声称兼容所有供应商接口。未知 usage 记为未知并保留保守预留，不推定零费用。

### 10.2 系统隔离与权限审批

OpenCode 官方普通版文档中，多数权限默认 allow。[O04] 集成配置应改为默认拒绝，只开放本任务需要的 Skill/工具；这只是应用层授权，还要有 OS/容器隔离。

沙箱不可读真实项目仓库、生产数据库配置、媒体采集登录态、宿主 HOME 或 `.env`。工作区只读输入与批准扩展分开挂载；可写路径局限于临时产物区。默认无 shell、无外部文件访问、无任意浏览器/网络工具。

审批对象必须绑定精确操作、规范化参数 hash、工具与版本、目标资源、金额/配额、期限和申请身份；审批前后任一字段变化都要重新授权。网页、Skill 或模型文字中的“用户已批准”无效。

如果以后开放代码执行或本地处理，使用独立沙箱工具，不把整个 OpenCode 容器提升为宿主控制器。供应链管理保留来源、签名验证、依赖锁、许可证和撤销记录；包内自报签名状态不可信。

### 10.3 提示注入和 UI 输出

采集正文、网页、MCP 描述和第三方 Skill 都可能含指令型文本。策略上区分可信系统规则与不可信资料；服务端权限拒绝应独立于模型是否识别注入。

审核输出与普通回答走不同 Schema/通道。UI 不从任意 assistant 文本中解释可写指令。报告中借鉴的“只读工具但文本仍可能触发写入”风险不应在 WeaveSense 重现。[M01 §10–13]

## 11. Producer / Validator / Reviewer / Controller 闭环

M01 §11 将四种职责明确作为建议新增架构；不能表述为 MiniMax 已经完整实现、WeaveSense 只需复制一个模块。对本项目迁移的是职责与版本合同，不是镜头秒数、站位或视频生成规则。

```text
冻结来源版本/范围/扩展锁
 → Producer 产出草稿
 → Validator（结构、精确引用、版本、覆盖与数值）
 → Reviewer（独立读取来源与草稿，评价推理/信源/冲突）
 → Controller
     ├─ 可机械修复：回 Producer，重新验证
     ├─ 需扩大范围或改变假设：请求用户决策
     └─ 通过：发布当前固定版本
```

适配 WeaveSense 的检查矩阵：

| 检查项 | 确定性部分 | 语义部分 |
|---|---|---|
| 引用 | evidence_id 存在、quote 为原文精确子串 | 引文是否真正支撑该结论 |
| 范围 | 时间、材料版本、授权 scope | 是否把范围外信息包装为范围内事实 |
| 完整性 | 读取/截断标志、必要字段、source 映射 | 是否因材料片面而过度归纳 |
| 独立信源 | 标识、出处、转载链可记录事实 | 多条转载是否被误当独立佐证 |
| 数字与日期 | 可结构化的原值匹配、计算重算 | 口径和时间逻辑是否混淆 |
| 冲突 | 矛盾材料是否可定位 | 是否掩盖差异或把猜测写成事实 |
| 发布 | review 输入/草稿/policy hash 完全匹配 | 不以高分抵消硬失败 |

Reviewer 只能读已固定来源与产物并提交严格 ReviewReport。默认不开放发布工具或预算外模型调用。Producer 不能给自己签发最终 pass。

报告必须绑定 `review_id/artifact_id/revision/input_digest/artifact_digest/policy_digest/extension_lock_digest`，包含每项 pass/fail/not_checked、阻断问题、具体定位、证据和修复建议。未检查不能算通过。

Controller 可先设最多两轮自动修订；这是拟议策略，不是源项目已有参数。复验必须运行失败项与受影响检查。上游材料或用户修改草稿后，旧审核自动失效；事务发布时再次核对版本，避免审核 A、落库 B。

## 12. 数据模型与恢复：扩展已有表，而非另建一套真相

### 12.1 复用与新增

复用 `ai_runs`、`ai_jobs`、`agent_checkpoints`、`ai_model_calls`、现有预算表和材料版本机制。[S10–S13、S22–S25]

新增表名为建议，实施时按项目约定调整：

| 表/实体 | 最低字段或关键约束 |
|---|---|
| ai_runtime_bindings | run_id 唯一、runtime_provider、版本/digest、session_id、instance_id/epoch、工作区位置摘要 |
| ai_run_events + outbox | run_id+seq 唯一、dedup_key 唯一、事件类型、脱敏 payload、交付状态 |
| extension_packages/installations | 包 id/version/digest、来源、审批、启停、安装 scope |
| extension_run_locks | task/run 与不可变包集合、tool bindings、配置生成器 digest |
| ai_tasks / ai_task_stages | 逻辑任务、阶段、依赖、当前草稿、回修次数、执行尝试关联 |
| ai_artifacts / ai_artifact_revisions | 稳定 artifact_id、revision、内容 hash、文件引用、来源依赖；revision 不可覆盖 |
| ai_reviews | 绑定输入与草稿版本、规则版本、校验/审核输出 |
| ai_approvals | 精确动作 hash、主体、有效期、单次消费状态 |

工作区的初期含义是执行隔离范围，不能仅新增 workspace_id 字段便宣称完成多租户。若共享同一知识库，应在产品界面明确；后续多用户化必须真正改查询授权和隔离测试。

### 12.2 迁移策略

当前迁移序列到 `0021_stage_windows.sql`。从 `0022` 起新增迁移，不改已经应用的 `0011` 等历史文件。

先扩展 provider CHECK，再增加 ai_jobs 的 runtime_provider 字段。回填只依据可以验证的既有 payload/任务类型映射；未知或冲突记录输出报告并中止或隔离处理，不能盲目把全部旧任务改为 opencode/eino。

过渡期所有认领入口和过期恢复扫描都须使用同一 provider 判定函数，包括旧字段兼容规则；未分类任务不得被任意 Worker 抢走。Schema v1 Eino Execute 合同保持原样，新增 v2 外层编排合同来承载 task/runtime/extension lock。

### 12.3 不混同不同身份和不同完成概念

`request_id` 是幂等请求，`task_id` 是长期业务任务，`run_id` 是一次有界执行尝试，`runtime_session_id` 是某厂商会话。一个逻辑任务可以包含 Producer/Reviewer 多次执行，但不是所有 stage succeeded 都立即写 knowledge_notes。

P2 沿用一研究 run 对应一次原子笔记发布。P4 引入阶段任务后，由受控最终 publication run 完成发布；中间执行完成只能登记阶段事实，不能触发旧“完成即答案已发布”的 UI 语义。对外 v2 API 明确区分 task_status、stage_status 和 publication_status。

等待用户期间不无限续租一个 Worker。Controller 可保存草稿和阶段状态，停 Runtime，释放槽位；审批后用同一 task_id 下的新运行尝试继续，重新取得授权/预算并核对输入版本。人审 TTL 与执行 deadline 分开管理。

### 12.4 故障恢复

业务完成事务、模型调用回执和 MCP 工具回执优先于模型会话文字。旧 claim 或旧 instance_epoch 不能写入新 run。重复事件可以出现，内部数据库用唯一键和幂等事务处理；不宣称远端服务 exactly-once。

Eino checkpoint 不能给 OpenCode 读取。OpenCode 私有状态只在完全匹配并已验证兼容的 Runtime 版本中恢复；否则从平台保留的阶段产物启动新的、已授权尝试，明确记录差异。存在不明付费/副作用时先核实，不自动重做。

## 13. 文件级实施位置

```text
src/lib/server/
  analyze.ts                    # 修改：分任务 runtime 路由，保留旧语义
  agent-client.ts               # 保留/封装：Eino 协议实现
  agent-queue.ts                 # 修改：provider 过滤与入队锁定
  agent-jobs.ts                  # 修改：provider dispatch、独立恢复分支
  agent-completion.ts            # 增强：发布时版本与审核门禁
  agent-data.ts                  # 复用：证据与运行权限
  fns.ts                        # 修改：按 runtime 的能力/取消/任务显示
  agent-runtime/                # 新增
    contract.ts
    router.ts
    legacy-adapter.ts
    eino-adapter.ts
    opencode-adapter.ts
    supervisor-client.ts
    event-journal.ts
    reconcile.ts
  agent-extensions/             # 新增
    manifest.ts
    registry.ts
    lockfile.ts
    installer.ts
    policy.ts
    compile-eino.ts
    compile-opencode.ts
  agent-review/                 # 新增
    validator.ts
    reviewer.ts
    controller.ts
    report-schema.ts
  agent-artifacts/              # 新增
    store.ts
    revisions.ts
    publish.ts

workers/
  agent/                        # 保留 Go/Eino；适配冻结的 Skill 快照
  opencode-supervisor/          # 新增：受限生命周期管理
  mcp-broker/                   # 新增：语料桥/Server 管理
  model-gateway/                # 新增：每次模型请求准入与回执

src/routes/knowledge.tsx        # 修改：阶段、审核、取消、产物版本
migrations/0022_*.sql           # 新增：运行时兼容与绑定
migrations/0023_*.sql           # 新增：扩展锁、事件、产物、审核等
validation/agent/opencode/     # 新增：协议、故障、安全、效果对照
extensions/                    # 新增：平台中立扩展包
```

目录与新增文件是实施建议，不是声称它们已存在。不要顺带重写采集、调度、微信/Telegram 网关或与本任务无关的业务。

## 14. 分阶段实施与验收

### P0：源码基线与现有 Eino 能力验收

改动：统一超时配置；处理固定 Skill 加载错误；补真实能力探测；核对部署开关、模型与 MCP 双白名单。建立受信任访问边界，不直接开放危险工具。

验证：按 go.mod 使用 Go 1.24.1 或兼容工具链；安装项目锁文件依赖后运行原测试；分别验证 legacy、Eino 同步和异步研究；验证“无语料返回材料不足”、引用和幂等未退化。

通过门槛：现有路径有可复现测试结果与部署记录。回滚：仅撤回该阶段配置/小修补，不动现有表和数据。此阶段不依赖 OpenCode。

### P1：运行时抽象和队列兼容

修改：`analyze.ts`、`agent-client.ts`、`agent-queue.ts`、`agent-jobs.ts`、`fns.ts`、`agent-runs.ts`、新迁移与 RuntimeAdapter。增加 runtime_provider 认领隔离，建立版本锁和运行绑定。

通过门槛：新增适配器可以用 fake Runtime 跑完原合同；旧 Eino 不会误领 opencode；旧任务恢复不被更改；关闭新功能不取消另一 Runtime 队列。

回滚：新增开关关闭新任务路由；保持添加型表结构；已认领任务由匹配版本 drain/reconcile，不能直接改 provider 重投。

### P2：只读 OpenCode 最小集成

新增 Supervisor、OpenCodeAdapter、内部语料 MCP Bridge、模型预算网关。仅研究任务开关选用；不开放 shell、任意浏览器或外部 MCP；使用现有生产 Skill 的受控快照。

通过门槛：同一请求不重复提交；相同语料得到符合现有 Schema 的候选输出；数据和模型每次调用均有可信回执；未授权工具与网关绕行被实际拒绝；崩溃后不会重复发布/收费式重试。

回滚：停止新 OpenCode 入队，保留 Eino/legacy；对旧运行先对账。OpenCode 不可用不自动把已发送任务改给 Eino 再调用一次。

### P3：中立扩展注册与 MCP 扩容

新增包 Schema、Registry、安装审批、签名/来源策略、版本锁、配置编译器。将三份原 Skill 登记为受控包；增加一个经过审批的 MCP 测试 Server，并测试一次 stdio 沙箱。

通过门槛：新增合格 Skill/MCP 不需要修改 Agent 核心业务文件；两 Runtime 可使用同一能力绑定；同名冲突、越权、错误依赖/哈希被拒；回滚只影响新任务；活跃任务版本固定。

回滚：禁用新包版本，使用前一批准锁集；安全撤销主动失效相关令牌。

### P4：阶段产物、独立审核与人工审批

新增 Artifact/Revision、ReviewReport、Controller、task/stage 状态及 UI。复用确定性引用校验，增加语义审核和修订闭环；发布继续走应用事务。

通过门槛：审核通过后修改来源/草稿会阻止发布；Producer 不能自己放行；Reviewer 无写权限；暂停等待用户不长期占用 Worker；阶段完成与最终发布在 UI 中可区分。

回滚：新复杂任务关闭；保留已写草稿与审阅记录只读；现有一次性问答仍可运行，不删除审计材料。

### P5：对照评测、灰度与运维

使用相同素材集、模型 profile 和问题分别评测 Eino 与 OpenCode；记录额外的 Skill 加载、工具描述和子调用开销。再单独比较扩展后的复杂任务能力，不将不同输入条件混作运行时提升。

灰度从单任务/低并发开始；质量、预算、防越权或重复执行任一硬门槛失败则停止扩大。升级必须经过相同合同和故障测试，不使用浮动 latest 镜像。

## 15. 验收矩阵

| 分类 | 必测场景 | 通过条件 |
|---|---|---|
| 既有回归 | legacy/Eino 单条、简报、研究 | 原结果合同、预算与引用行为不退化 |
| 协议 | 真实固定版本 Server/SDK、非法结构 | 适配器明确报协议错误，无任意文本兜底发布 |
| 任务路由 | 两 Worker 同时认领 | provider 隔离、单一有效 claim |
| 输入幂等 | 同 request_id 同/不同输入 | 返回原任务或冲突，不重复启动 |
| 引用 | 伪造 evidence_id、改写 quote | 确定性拒绝 |
| 范围 | corpus 无材料、试图联网补答 | 维持材料不足或显式新增授权流程 |
| 模型预算 | 子 Agent/重试/摘要调用 | 全部过网关、达到上限即拒绝 |
| 成本不明 | 转发后连接中断 | 标记 unknown，不记录为零费用 |
| MCP 权限 | 另一个 run 的 token、未授权工具 | 服务端拒绝并有审计 |
| MCP 故障 | stdio 卡死、超大结果、重定向 | 限时清理/拒绝；不阻塞整个进程池 |
| 运行时崩溃 | 模型 started 后 kill | 对账，不盲重放有副作用步骤 |
| 事件 | 重复、乱序、SSE 断线 | DB 幂等；可从权威事实重建业务状态 |
| 版本 | 中途修改 Skill/源材料/草稿 | 快照不变或审核失效，拒绝错版发布 |
| 审核 | Reviewer 返回普通文本/自称批准 | Schema 拒绝；无直接写路径 |
| 租约 | 旧 Worker 迟到完成 | stale，不能覆盖新任务结果 |
| 沙箱 | 读 HOME/.env/生产目录或任意网络 | OS 与 Broker 双层阻止 |
| 数据库 | PostgreSQL/PGlite 迁移与事务 | 两受支持模式分别验证，不凭单后端通过外推 |
| 升级 | 协议/配置变化、旧 state 恢复 | 不混版本；失败可禁用/回滚 |
| 扩容 | 安装新 Skill/MCP 后运行 | 不改核心 Agent 即可使用已批准能力 |

领域缺陷集需人工标注：错误引文、断章取义、转载冒充独立信源、时间范围混淆、材料截断后假装完整、忽略冲突、缺证却高置信度结论。指标包括漏报、误报、定位正确率、修订后新错误，而不是只看回答长度或模型自评分。

## 16. 性能、成本和容量治理

当前源代码存在并发、输入/输出、调用轮数与执行超时限制，不能引入新 Runtime 后忽略这些边界。[S05、S16–S20、S28]

建议试点先保持小并发和少量启用扩展；完整正文按需加载，避免将所有 Skill 与工具 Schema 一次塞入上下文。固定材料版本可缓存检索和确定性校验；跨 run 缓存必须再次校验权限，禁止缓存授权决定或审批。

具体 CPU/内存、进程数和完成时延要压测后配置，本方案没有性能实测，因而不给保证性数字。可配置上限至少包括活跃沙箱、排队数、每任务时长、模型调用数、工具调用数、上下文/输出大小、自动修订次数、每用户/工作区费用与当天额度。

监测：排队长度、等待时长、运行 p50/p95、心跳失联、checkpoint 恢复率、调用 unknown 比例、工具超时、Schema 拒绝、审核阻断、发布成功率，以及每份被接受报告的实际成本。

背压必须在任务准入和工具/模型网关生效；不能仅通过“模型少调用几次”的提示词控制。取消时及时撤销 run grant，防止 Runtime 未退出仍继续消费。

## 17. 当前已执行验证记录

### 17.1 原始 Go 合同测试

以下命令在解压源码上成功运行，未修改 contract.go/contract_test.go：

```bash
GOTOOLCHAIN=local GOPROXY=off GO111MODULE=off go test -v \
  workers/agent/internal/agent/contract.go \
  workers/agent/internal/agent/contract_test.go
```

3 个测试函数通过：TestContractValidFixtures、TestContractInvalidFixtures、TestContractAnalysisRejectsStringTopics。前两个分别遍历 3 个合法 fixture 与 12 个非法 fixture。它们验证合同，不证明运行时、网络、数据库或模型能力。

### 17.2 没有通过或没有运行的项目验证

完整 `go test ./...` 被环境 Go 1.23.2 低于项目 go 1.24.1 要求阻止。TypeScript agent-context 测试被 Zod 等依赖缺失阻止。一次独立目录依赖安装超时，没有形成成功构建。日志在 `verification/`。

本次并未启动 OpenCode 或 Eino 模型链，也没有把上传包内的历史验证日志计为本次通过。

### 17.3 方案自身样例检查

新增设计文件 `runtime-adapter.ts` 通过独立 `tsc --noEmit --strict --target ES2022 --lib ES2022,DOM`；JSON Schema 和示例通过 Draft 2020-12 结构校验。它们只是类型/格式有效，不是 Adapter 的工作实现。

## 18. 实施交接约束

给执行开发的 Agent/工程师的要求：

1. 开始前重新核对上传归档或工作区文件哈希；若文件变化，重新定位源码行，不按旧报告盲改。
2. 先建立 P0 基线；不得以“现有无 Skill/MCP”为前提重写。保留旧开关默认行为。
3. 按 P0–P5 分开提交；每次提交附改动文件、测试命令、真实结果和回滚动作。
4. 任何外部实际调用、权限扩大或新付费模型接入都须符合用户已授权范围；不自动安装来源不明插件。
5. 不改旧迁移、不直接写业务表、不把 Runtime 文本当完成证据、不在失败后静默换引擎重试。
6. OpenCode 的具体版本、配置与 SDK 方法须以选定二进制和合同测试为准；本包不给未经验证的厂商配置当成可直接运行成品。
7. 确保每个新 Skill/MCP 都可通过 Registry 注册、锁定、测试、禁用与回滚；平台业务代码不依赖某个 Runtime 的私有会话结构。

## 19. 外部来源与报告引用

M01：用户上传《MiniMax-Design-技术架构与复现分析报告-v2.md》，重点 §3–4 组件边界、§8–13 审核边界、§14 异步任务、§16 验收。原报告中的“建议新增”保持为设计建议，本次未重新验证 MiniMax 安装产物。

以下仅用于核验公开的 OpenCode 集成与配置能力，查阅日期为 2026-10-07：

| 编号 | 官方页面 | 用途 |
|---|---|---|
| O01 | https://opencode.ai/docs/server/ | Server、会话、取消、事件、认证和 OpenAPI |
| O02 | https://opencode.ai/docs/sdk/ | 客户端/服务端连接模式 |
| O03 | https://opencode.ai/docs/skills/ | SKILL.md 发现、命名与配置目录 |
| O04 | https://opencode.ai/docs/permissions/ | 权限默认行为与工具授权 |
| O05 | https://opencode.ai/v2/docs/mcp-servers | v2 的配置结构差异与适配风险 |

**最终建议：先核实并用好已存在的 Eino；把 OpenCode 作为复杂任务的可选执行器，用同一套 Skill/MCP 注册、证据、预算、版本和发布合同管理。不要把增加一个 Runtime 变成拆掉已经实现的业务可靠性。**
