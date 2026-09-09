# Loom Eino Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在保留现有采集、媒体处理与数据层的基础上，实现可回滚的 Eino 分析服务，并交付内部检索工具、MCP 工具接入及受控 Agent Skills。

**Architecture:** TypeScript 业务层负责材料、执行授权、幂等和原子保存，Go 服务负责 Eino 模型与 Agent 执行。固定分析流程与研究问答分开，Go 通过受控内部 HTTP API 查询业务数据，不直接连接数据库。P1/P2 采用有界同步运行，自动任务和长任务恢复单列为 P3。

**Tech Stack:** 现有 React 19、TanStack Start/Query、TypeScript、Zod 4、pg/PGlite、Node test runner；新增 Go、Eino/ADK、eino-ext OpenAI 协议模型适配器、eino-ext MCP 工具适配器；部署复用 Docker Compose。

---

## 0. 执行说明与范围

- 日期：2026-09-07。状态：实现计划，未执行。对应调研：[架构建议](2026-09-07-eino-agent-architecture.md)。
- 当前用户授权的是方案落盘；本文中的代码、迁移、安装及发布命令都是后续实施步骤，不表示已经执行。
- 工作方式：@ponytail + @writing-plans；实施时使用 @executing-plans。上面的 superpowers 名称来自 writing-plans 模板；若当前环境没有该命名空间，读取已安装的同名 executing-plans 技能，不虚构工具或安装未经请求的插件。
- 仅文档在当前项目落盘，未为写两份文档创建 worktree。开始实施时建立独立分支/工作树；先核对实际 Git 结构，不能直接执行 git init。
- 本次检查到 Git 元数据为 `.repo`，工作树为项目根；`restart.bat` 有用户已有修改。使用 `git --git-dir=.repo --work-tree=. status --short` 检查，保留该修改。
- 下文文件路径相对项目根，Go 命令通过 `go -C workers/agent ...` 运行。Linux QA 环境项目根为 `/workspace`；当前主机是 Windows，不混用路径。
- P1/P2 全部完成才称为“Eino + MCP + Skills 已集成”。只有协议假服务通过时，称为“离线集成已验证”；真实模型和真实 MCP 未测时必须列出未验证项。
- 任务的每个 Step 是一个可独立检查的小动作。代码块给出固定契约、关键算法及测试起点；完整业务实现按测试清单补齐。Eino 具体 API 以 Task 1 锁定版本编译结果为准，不将 main 分支示例当已验证的生产代码。

### 0.1 交付边界

| 纳入 P1/P2 | 延后，满足触发条件再实施 |
| --- | --- |
| 三个现有页面入口兼容 | 自动处理整个历史语料 |
| 单条结构化分析、材料简报、研究问答 | 开放注册、多租户、私有用户连接器 |
| 配置模型地址与名称，首个模型供应商兼容性验证 | 同时集成所有模型供应商 |
| 内部只读数据 Tools | 任意 SQL、任意 URL 抓取、文件系统写入与 shell |
| 一个可配置的远程 MCP 工具集成路径 | MCP Resources/Prompts/OAuth 全协议产品化 |
| 项目自有只读 inline Skills | 插件市场、自动安装第三方依赖、fork 技能与多 Agent |
| 运行记录、证据、执行限制、显式回滚 | Redis/Kafka/向量数据库/通用编排平台 |

## 1. 当前基线与复用清单

| 现有文件/符号 | 当前行为 | 后续处理 |
| --- | --- | --- |
| `src/lib/server/analyze.ts:chat` | xAI 单次调用，固定模型、45 秒超时 | 保留 legacy 分支，移除宽松伪成功；新增 Eino 分支 |
| 同文件 `analyzeItem/generateBriefing/askKnowledge` | 读材料、模型生成、直接保存 | 保留导出签名，内部接入规范化请求与统一保存 |
| `src/lib/server/fns.ts:analyzeItemFn/briefingFn/askFn` | POST ServerFn；validator 主要是类型透传 | 增加真正运行时校验，兼容旧调用参数 |
| `src/routes/inbox.$itemId.tsx` | 按钮触发分析、OCR | 保留功能，添加重试请求 ID 和结果覆盖范围提示 |
| `src/routes/knowledge.tsx` | 提问、简报、笔记列表 | 显示已核对引用、不充分回答及运行错误 |
| `src/lib/server/scheduler.ts` | 采集与去重 | P1/P2 不改 |
| `src/lib/server/extract-targets.ts` | 提取领取、claim_token、防重复追加 | 不重写；分析侧记录材料指纹与提取状态，避免过期结果 |
| `src/lib/server/nodes.ts`、`src/routes/api/cron/tick.ts` | 媒体与提取生产调度 | P1/P2 不接自动分析 |
| `src/lib/db.ts:Sql/getSql` | pg 与 PGlite 统一接口 | 复用；不为了 Go 增加数据库网络出口 |
| `migrations/0010_wechat_job_provider.sql` | 当前最新业务迁移 | 新迁移暂定 0011，实施前再次核对编号 |
| `src/lib/server/queries.ts`、`src/lib/types.ts` | 现有 UI 映射与类型 | 仅增加可选运行元信息，不破坏旧数据 |
| `docker-compose.yml`、`env.example` | 多服务部署与变量模板 | 添加内部 agent 服务和变量说明 |

注意：SQL 抽象每次 query 不保证占用同一数据库连接，不能用分散的 `BEGIN`、`INSERT`、`COMMIT` 假装事务。优先采用单条数据修改 CTE；如确需事务，先复用/核实真实连接作用域，而非在所有调用点打补丁。

## 2. 固定的业务行为

### 2.1 分析、简报与研究模式

| mode | 材料选择 | 执行形式 | 输出 |
| --- | --- | --- | --- |
| `analyze_item` | 指定条目及已追加 OCR/ASR 内容 | 程序选材 → ChatModel → 校验；最多 1 次格式修复 | 兼容 AnalysisRow 的五字段，附覆盖范围和证据 |
| `briefing` | 默认上海时区当天；显式日期范围；最多 12 条，优先已有有效分析 | 固定生成流程；不用 Agent 搜索整个互联网 | 标题、正文、引用、材料不足说明 |
| `research` | 用户问题和服务端限定范围；Agent 通过工具查找 | Eino ChatModelAgent，默认只读内部工具，可配置 MCP | answer、citations、insufficient_evidence |

简报日期由应用层生成，采用 `[from,to)` UTC 边界表示上海自然日；没有当天材料则直接返回“该时间范围暂无材料”，不把上周新闻标成今日简报。需要最近若干条时显式选择 rolling 范围。

问答不再在零匹配时偷偷替换成最近 8 条。P1 返回材料不足，P2 可通过查询改写和分次检索补材料。一次 research 是一次独立任务，P2 不承诺持续对话记忆。

### 2.2 选材和截断

1. 原文统一 CRLF 为 LF；引用匹配使用统一后的精确子串。不悄悄做 Unicode 归一化或空白压缩。
2. 长度单位统一为 Unicode code point：TS 使用 `Array.from(text)`，Go 使用 rune；不继续混用 JS UTF-16 slice 与 Go 字节索引。
3. 单条材料首版上限 12,000 code points；超过时取前 6,000、后 6,000，作为两个独立片段返回，不拼成假连续原文。
4. 单次固定任务总材料上限 24,000 code points；简报逐条分配额度；工具返回最多 4,000 code points，总计最多 24,000。
5. `coverage=partial` 和具体片段区间必须传给模型与 UI；不得把片段摘要称为全文分析。P3 的全文分块另设预算。
6. OCR/ASR 未结束或失败时允许用户手动分析现有文字，但明确 `media_incomplete`。自动分析若未来启用，应有更严格就绪条件；`pipeline_status='extracted'` 并不代表所有媒体都提取成功。
7. 复用 analyses 前检查其关联运行的材料指纹与当前材料一致；旧记录没有指纹时只能作为历史参考，不能充当最新事实。

## 3. 接口与数据契约 v1

### 3.1 浏览器到 TypeScript

保留已有三个 ServerFn。新增可选 `request_id`（UUID）；浏览器每次明确的新操作生成一次，网络重试重用它。旧客户端未传时服务端生成，仍能工作，但无法保障跨请求重试幂等。

```ts
import { z } from "zod";

export const analyzeInput = z.object({
  id: z.string().trim().min(1).max(128),
  request_id: z.uuid().optional(),
}).strict();

export const askInput = z.object({
  question: z.string().trim().refine(v => {
    const length = Array.from(v).length;
    return length >= 2 && length <= 400;
  }),
  request_id: z.uuid().optional(),
}).strict();

export const briefingInput = z.object({
  request_id: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.from === undefined) !== (v.to === undefined) ||
      (v.from !== undefined && v.to !== undefined && Date.parse(v.from) >= Date.parse(v.to))) {
    ctx.addIssue({ code: "custom", message: "invalid_date_range" });
  }
});
```

空参数 briefingFn 仍合法，适配为 `{}`。日期跨度另在选材层限制为最多 31 天。所有 `.validator` 调用 `.parse()`；浏览器不得指定 provider、系统提示词、工具白名单或凭证。

### 3.2 TypeScript 到 Go

- `POST /v1/execute`：同步有界运行，返回 JSON；最大请求体 512 KiB、响应体 256 KiB。
- `Authorization: Bearer <AGENT_SERVICE_TOKEN>`：独立服务凭证，不复用 CRON_SECRET 或网关 token。
- 请求 ID 与 `run_id` 由业务层生成。Go 不生成数据库主键、不决定落库。
- `GET /healthz`：只返回存活状态；`GET /readyz` 检查配置与技能装载，不请求付费模型。

请求示例是服务间契约，所有超时、模型与策略值来自服务端配置：

```json
{
  "schema_version": 1,
  "run_id": "6cb9226b-bf73-4e87-8d4a-1b121e24ab46",
  "mode": "analyze_item",
  "input": {
    "question": "",
    "sources": [{
      "evidence_id": "item:item-1:0",
      "item_id": "item-1",
      "title": "示例条目",
      "platform": "rss",
      "source_name": "示例信源",
      "url": "https://example.com/article",
      "published_at": "2026-09-07T01:00:00Z",
      "text": "用于测试的示例原文。",
      "start": 0,
      "end": 10,
      "coverage": "full"
    }],
    "range": null
  },
  "policy": {
    "version": "loom-agent-v1",
    "deadline_at": "2026-09-07T02:00:40Z",
    "max_model_calls": 2,
    "max_tool_calls": 0,
    "max_output_tokens_per_call": 1200
  }
}
```

示例文字区间在契约 fixture 中按 code points 计算，不能手填后与实际文本不一致。`input` 按 mode 检查：analyze_item 必须同一 item 的非空片段；briefing 必须有效 range；research 必须非空 question，sources 可以为空。

P2 在请求中增加 `data_access_token`，只供 Go 调用内部数据 API；它不进入模型上下文、不写入日志或 request_json。数据 URL 固定来自 Go 环境配置，不允许通过请求或模型任意指定。

响应结构：

```ts
export type EvidenceCitation = {
  evidence_id: string;
  quote: string;
};

export type AgentResult = {
  analysis?: { summary: string; topics: string[]; entities: string[];
    insights: string; tags: string[] };
  title?: string;
  content?: string;
  citations: EvidenceCitation[];
  insufficient_evidence: boolean;
  coverage: "full" | "partial";
  warnings: string[];
};

export type ExecuteResponse =
  | { schema_version: 1; run_id: string; ok: true; result: AgentResult;
      runtime: { model: string; prompt_version: string;
        skill_versions: Record<string, string>; input_tokens: number | null;
        output_tokens: number | null; model_calls: number; tool_calls: number;
        events: Array<{ type: string; name: string; duration_ms: number; ok: boolean }> };
      evidence: Array<{ evidence_id: string; item_id: string | null;
        title: string; url: string; text: string; origin: "internal" | "mcp" }> }
  | { schema_version: 1; run_id: string; ok: false;
      error: { code: string; message: string; retryable: boolean;
        outcome_unknown: boolean } };
```

实现时用严格 Zod discriminatedUnion 和 Go Decode + DisallowUnknownFields 校验两端；上面的 TS 类型不是运行时校验替代品。按 mode 校验结果：单条必须有 analysis，其他必须有 content，禁止跨模式多余字段；数组最多 12 项，每项最多 80 code points，summary/insights 最多 1,200，content 最多 12,000，引用最多 20 条、quote 最多 500。

runtime 与 evidence 来自可信执行代码捕获，不能让模型生成后原样充当执行证据。任何额外 JSON 值、尾随内容、空结果、错误类型必须拒绝；不使用“第一个左括号到最后一个右括号”抢救非法响应。

### 3.3 P2 内部数据 API

创建 `src/routes/api/internal/agent-data.ts`，统一 POST 三种 action：

| action | 参数 | 最大返回 |
| --- | --- | --- |
| `search_items` | `query` 2–200 字符、`limit` 1–8，可选合法时间范围/平台 | 标题、来源、匹配片段、evidence_id，不返回全库 |
| `get_item` | `item_id`、可选片段起点 | 4,000 code points 的一个连续片段与区间 |
| `get_analysis` | `item_id` | 最新有效结构化分析、来源运行 ID、stale 标记 |

认证使用独立 `AGENT_DATA_TOKEN` + `X-Agent-Run-Token`；后者由应用产生随机值，仅将 hash 存入 ai_runs。请求携带 run_id，应用验证该运行仍 running、未超时、run token 匹配，再执行固定 SQL；运行的 source/time/platform 范围从已保存请求读取，不能被工具参数扩大。internal action 的 schema 和字段白名单固定，禁止传 SQL。

内部检索第一版使用参数化 ILIKE：Agent 可给出关键词，不对中文使用英文分词假设。单次搜索对 title/body/author 做明确匹配；按发布时间及 id 稳定排序；转义 `%`、`_`、反斜杠，防止把检索词变成通配符。此实现对大语料可能全表扫描，标记 `ponytail:` 性能上限，只有检索评测证明需要才加中文索引或向量召回。

### 3.4 引用与来源闭环

1. 初始材料及内部工具输出由 TS 分配 evidence_id，并将精简证据收据追加到本次运行的 events_json；并发追加使用 SQL jsonb 追加与字节/条目上限，不能读改写覆盖。
2. MCP 证据由 Go 工具包装器记录，标记 server/tool/受控返回 URL 与实际片段；模型只引用 evidence_id，不能自己创造外部引用。
3. 成功保存前，TS 检查每个内部 ID 属于本次读取材料；外部 ID 属于受认证 Go 运行返回的 MCP 证据账本。quote 必须是该证据 text 的精确子串。
4. 引用标题、平台、URL 由证据账本填充，不采信模型拼写。外部 URL 仅接受 http/https，无凭证字段；展示为文本/链接，不注入 HTML。
5. 给现有 AskResult 的 citations 保留内部 `{id,title,platform}` 格式；新增可选 external_citations 和 evidence 字段承载外部引用，不能伪造一个 items 主键。
6. knowledge_notes.item_ids 只存真实内部 item ID。模型答复未实际引用的检索结果不自动塞进引用列表。
7. 结构与子串验证只能证明引用存在；人工评测仍检查结论是否受证据支持、原始信源是否独立。

## 4. 运行状态、持久化和幂等

### 4.1 首版迁移草案

新增 `migrations/0011_ai_runs.sql`，执行前确认编号没有被其他工作占用。只追加表与可空关联，不改历史迁移、不回填旧结果的虚构运行信息。

```sql
create table if not exists ai_runs (
  id text primary key,
  request_id text not null unique,
  mode text not null check (mode in ('analyze_item','briefing','research')),
  provider text not null check (provider in ('legacy','eino')),
  input_hash text not null,
  material_hash text not null,
  policy_version text not null,
  request_json jsonb not null,
  status text not null check (status in ('running','succeeded','failed','timed_out','cancelled')),
  claim_token text not null,
  data_token_hash text not null default '',
  expires_at timestamptz not null,
  response_json jsonb,
  events_json jsonb not null default '[]'::jsonb,
  model text not null default '',
  prompt_version text not null default '',
  skill_versions jsonb not null default '{}'::jsonb,
  input_tokens bigint,
  output_tokens bigint,
  model_calls integer not null default 0,
  tool_calls integer not null default 0,
  error_code text not null default '',
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists ai_runs_status_expiry_idx on ai_runs(status, expires_at);
alter table analyses add column if not exists run_id text references ai_runs(id);
alter table knowledge_notes add column if not exists run_id text references ai_runs(id);
create unique index if not exists analyses_run_unique on analyses(run_id) where run_id is not null;
create unique index if not exists knowledge_notes_run_unique on knowledge_notes(run_id) where run_id is not null;
```

request_json 只包含规范化业务参数、材料快照/片段、范围、服务端策略与指纹输入，排除 API key、Bearer token、data_access_token。结果与业务行在一个语句中保存。默认运行记录保留 30 天的材料和事件，保留轻量运行元信息及结果关联；清理用量和引用证据前明确保留策略，不直接级联删除业务结果。

### 4.2 幂等规则

- `request_id` 表示一次用户操作；`input_hash` 是规范化业务请求的 SHA-256，不包含当前数据库快照或 provider 开关。重复请求先查询已有记录，不能重新选材再决定是否同一操作。默认“今日”的实际 UTC 范围在首次运行中冻结；不把重试时的新日期加入 input_hash，避免跨午夜重试被误判成新输入。
- 同 ID、同 input_hash、已成功：返回已保存 response_json，不调用模型。
- 同 ID、同 input_hash、running：返回 `run_in_progress`，不新建模型请求。
- 同 ID、不同 input_hash：返回 `request_conflict`，不能借同一个 ID 修改材料或问题。
- 同 ID、已失败或超时：返回原失败状态；明确“重新分析”才生成新 request_id。不得隐式重试可能已经收费的请求。
- 先通过唯一索引 `INSERT ... ON CONFLICT DO NOTHING RETURNING id` 抢到一次执行权，只有胜者调用 Go。
- claim_token 是本次执行的随机 fencing 值；完成写入必须匹配 id、running、claim_token 和未过期条件。旧请求迟到结果不能覆盖终态。
- 超时后是 `timed_out`，不重新领取。同步模式没有恢复保证；P3 才增加持久队列/断点。

### 4.3 原子保存规则

单条分析用一个数据修改 CTE：匹配 running + claim_token → 检查当前条目材料指纹 → 更新 ai_runs 为 succeeded 并存最终响应 → 插入 analyses → 更新 items.pipeline_status。任何插入或校验失败应让整条语句回滚或返回零行，不产生“运行成功但结果不存在”。

材料指纹不要求数据库安装 hash 扩展：TS 对固定顺序字段计算 SHA-256；提交时以快照中的原 title/body/source 元信息与当前行作参数化比较。匹配条件必须覆盖实际参与模型输入的字段；发生 OCR 追加、正文更新或条目删除时返回 `input_changed`，不把旧材料结果标成当前已分析。

简报/问答保存 ai_runs + knowledge_notes 同样使用单语句 CTE；它们是明确时间点的材料快照，允许材料后来变动，记录快照与生成时间即可。已保存结果重复提交只返回原结果，不再创建新笔记。

故障顺序：先模型运行，再结构及引用校验，再原子保存。成功落库后 HTTP 响应丢失，重试可返回相同结果。模型已经成功但落库前进程崩溃，首版不能恢复输出，也不能承诺“恰好收费一次”；报告不确定状态，由用户明确重试。

## 5. 超时、预算、失败与服务安全

### 5.1 首版执行限制

| 项目 | 固定分析/简报 | 研究问答 |
| --- | --- | --- |
| Go 总执行时间 | 最多 40 秒 | 最多 40 秒 |
| TS 调用超时 | 45 秒 | 45 秒 |
| 运行过期 | 接受请求后 60 秒 | 接受请求后 60 秒 |
| 模型请求次数，含修复 | 最多 2 | 最多 6 |
| 单次模型超时 | 不超过剩余 deadline，且上限 30 秒 | 同左 |
| 工具总调用次数 | 0 | 最多 4，含技能加载 |
| 单次工具超时 | 不适用 | 8 秒，且不超过剩余 deadline |
| 单次输出 token | 1,200；简报可设 1,800 | 1,800 |
| Go 同时运行数 | 全服务默认 2 | 与固定任务共享 |
| 超限行为 | 返回明确错误，不返回半成品成功 | 返回 budget_exceeded；不得无限循环 |

服务拒绝比本地上限更高的请求策略，或取两者较小值；不能信任任意 deadline。单条格式修复也占用模型次数和总 deadline。Eino MaxIterations 只是第二道防线，实际每次供应商请求（包括框架重试）都由适配层计数；关闭不可见的自动重试与 failover。

40 秒是首版同步产品上限，不是 Eino 性能保证。若真实研究任务频繁超时，先实施 P3 长任务，不能只把 ServerFn 超时调到数分钟。上线前核实目标部署的请求时限能覆盖本方案。

token usage 只有供应商确实返回时才记录；未知写 null。首版限制请求数、输出额度、输入体积和并发，不宣称已实现每日人民币硬预算。需要金额硬限制时，P3 增加有价格版本的最坏成本预留及并发原子扣减，未知用量不能按 0 结算。

### 5.2 错误分类

| code | 行为 |
| --- | --- |
| `invalid_request` / `request_conflict` | 4xx，不调用模型 |
| `agent_unconfigured` / `agent_unavailable` / `capacity_exceeded` | 明确显示配置、不可达或繁忙；不自动回退 legacy |
| `run_in_progress` | 保留同 request_id；提示稍后重新查询/重试同操作 |
| `model_rejected` | 供应商 4xx；脱敏，不回显 key/原始响应 |
| `model_timeout` / `outcome_unknown` | 禁止自动再次调用，标记执行结果不确定 |
| `invalid_output` / `invalid_citation` | 不写业务结果；最多一次受预算约束的格式修复 |
| `input_changed` | 单条原文已变化，不将结果标为当前分析 |
| `tool_denied` / `tool_unavailable` | 可作为受控工具错误反馈 Agent；仍计入工具次数 |
| `budget_exceeded` | 中止运行，不标成功 |
| `persist_failed` | 保留原始业务数据，提示结果未保存 |

Agent 内部错误对应 HTTP 状态与前端返回由 TS 统一映射；前端已有 `{ok:false,error}` 仍可展示，另加 `error_code/run_id` 可选字段。

### 5.3 权限与部署边界

- 第一版沿用无登录共享语料模式，只适用于受控部署。上线公开访问前，用既有部署访问控制限制 AI 入口；内部 token 只认证服务，不能代替最终用户权限和速率限制。
- 浏览器绝不持有两个服务 token 或模型 key。Go 不暴露宿主机端口，内部 API 默认拒绝空 token，认证前不读数据库。
- TypeScript 与 Go 的服务 URL 均由运维配置，不接受浏览器或模型传入 URL。内部请求不跟随重定向，HTTPS 外部部署，Compose 可使用明确内部 HTTP 地址。
- 不新增任意 URL 抓取工具。MCP URL 采用静态信任配置和主机白名单，不向陌生重定向转发凭证；生产禁止不受控的回环/云元数据地址。
- 当前工作区的开发者 .agents/skills 和 app-data 连接器不自动授予运行时 Agent；访问用户真实连接器时再阅读项目 app-data 规范并实现对应认证。
- 不记录原始系统推理内容；运行事件只记录工具名、步骤、耗时、结构化错误、用量和允许保存的证据片段。

## 6. MCP 与 Skills 配置

### 6.1 MCP 最小配置

创建 `workers/agent/config/mcp.example.json`，实际凭证通过环境注入。示例默认禁用，不能把示例地址当已接通服务。

```json
{
  "servers": [{
    "id": "research",
    "enabled": false,
    "url": "https://mcp.example.com/mcp",
    "transport": "streamable_http",
    "token_env": "RESEARCH_MCP_TOKEN",
    "allowed_tools": ["search"],
    "required": false
  }]
}
```

只支持一个已验证的远程 transport 起步，优先 Streamable HTTP；Task 1 检查锁定 MCP 客户端支持，不能拿旧 SSE 示例冒充 HTTP transport。工具命名 `mcp_<server>_<tool>`，名字冲突、过长、非允许字符时启动报错；允许列表为空表示不暴露任何工具，不能直接利用上游“空列表=全部”的默认行为。

启动时连接、Initialize、GetTools 后本地再过滤。少量工具固定注册；数量增长且测得上下文问题后再加 ToolSearch。可选服务失败时内部研究仍可用，结果 warnings 标记缺失能力；任务显式要求某服务则失败，不能静默伪装成功。重连仅在工具调用/健康维护阶段有界进行，不自动重放结果不确定的调用。

MCP 返回的数据是不可信材料，包装器限字节与结构、过滤不支持的二进制资源，并捕获来源收据。首个生产服务优先只读。由模型提出“安装新的 MCP 服务”不构成配置变更授权。

### 6.2 Skills 目录

```text
workers/agent/skills/
  industry-analysis/SKILL.md
  cross-source-check/SKILL.md
  briefing-writing/SKILL.md
```

先通过 Eino 官方 skill backend + middleware 读取只读技能目录，不暴露通用文件系统或 shell 给 Agent。每个技能最多 32 KiB，name 唯一；拒绝符号链接逃逸、越界路径、fork/model/agent 覆盖字段和指向目录外的参考资料。运行时技能目录与版本打包入镜像，更新通过发布完成，首版不热更新。

技能版本采用该技能允许文件内容及相对路径的稳定排序 SHA-256，写入 ai_runs；不要依赖模型声称使用了哪个版本。发现元信息与实际加载事件由代码记录。

可直接采用的业务技能起点：

```markdown
---
name: cross-source-check
description: 比较多个媒体条目对同一行业事件的描述，找出一致、冲突与缺失证据。
---

使用 search_items 查找候选条目，再用 get_item 阅读支持结论的具体片段。
区分原始发布与转载；多个转载不算多个独立信源。
按“已知事实、存在分歧、尚缺证据”组织回答。
每个关键事实使用运行时提供的 evidence_id，并摘录支持它的原文。
材料没有给出的数字、日期与来源不要补写。
没有足够材料时明确说明不足。
```

固定分析和简报在程序端明确选择对应技能正文作为版本化指令，不依靠 Agent 概率触发；研究 Agent 才使用按需加载。新增第三方技能先审阅依赖和工具映射；仅含说明的技能可直接适配，需要脚本的技能必须先补沙箱设计和审核。

## 7. 文件布局与新增配置

```text
workers/agent/
  go.mod
  go.sum
  Dockerfile
  cmd/agent/main.go
  internal/agent/config.go
  internal/agent/contract.go
  internal/agent/server.go
  internal/agent/model.go
  internal/agent/workflow.go
  internal/agent/research.go
  internal/agent/tools.go
  internal/agent/mcp.go
  internal/agent/skills.go
  internal/agent/*_test.go
  config/mcp.example.json
  skills/{industry-analysis,cross-source-check,briefing-writing}/SKILL.md
src/lib/agent-contract.ts
src/lib/server/agent-client.ts
src/lib/server/agent-context.ts
src/lib/server/agent-runs.ts
src/lib/server/agent-data.ts
src/lib/server/agent-*.test.ts
src/routes/api/internal/agent-data.ts
migrations/0011_ai_runs.sql
scripts/agent-contract-check.mjs
scripts/agent-e2e.mjs
validation/agent/contracts/*.json
docs/operations/agent-service.md
```

先按 Task 新建真正需要的文件，不一次性生成空目录和空接口。Go 内部用一个业务 package，职责用少数文件划分，不做 controller/service/repository 三层样板。

| 变量 | 所在服务 | 默认/约束 |
| --- | --- | --- |
| `AI_ENGINE` | app | `legacy`；只接受 legacy/eino |
| `AGENT_SERVICE_URL` | app | 空；eino 模式必须配置 |
| `AGENT_SERVICE_TOKEN` | app + agent | 空；显式非空，服务间独立随机密钥 |
| `AGENT_DATA_URL` | agent | 空；P2 必填，固定内部 API URL |
| `AGENT_DATA_TOKEN` | app + agent | 空；与执行 token 分离 |
| `AGENT_MODEL_BASE_URL` | agent | 显式配置；不信任模型返回的 URL |
| `AGENT_MODEL_NAME` | agent | 显式配置；模型是否可用由兼容性验收确认 |
| `AGENT_MODEL_API_KEY` | agent | 服务端秘密；可由部署系统映射已有 XAI_API_KEY |
| `AGENT_MAX_CONCURRENT_RUNS` | agent | 2，有界整数，单实例上限 |
| `AGENT_MCP_CONFIG` | agent | 空表示无 MCP，非空读取固定配置文件 |
| `AGENT_SKILLS_DIR` | agent | 镜像内只读 skills 目录 |

不暴露全部内部常量为环境变量；本文预算先作为服务端常量，由需要校准的测量结果推动配置化。旧 XAI_API_KEY 仍供 legacy/OCR/ASR，不删除。P3 的 AUTO_ANALYZE、队列设置在该阶段才增加。

## 8. 分阶段执行总览

| 阶段 | 任务 | 依赖 | 阶段验收 |
| --- | --- | --- | --- |
| P0 | 1–2 | 当前代码与官方 API | 版本矩阵与双端契约可编译/验证 |
| P1 | 3–9 | P0 | 三个入口可切 Eino，合法结果原子保存，失败与回滚明确 |
| P2 | 10–14 | P1 | 内部工具 + MCP + Skills + 可追溯研究问答 |
| 发布 | 15–17 | P1/P2 | 双模式、双数据库、dev/build、预算与回滚检查完成 |
| P3 可选 | 18–20 | 测量或用户需求 | 自动任务、持久长任务、检索改进按需分别验收 |

以下提交建议均只暂存任务明确列出的文件。普通 worktree 中使用 git；当前特殊根目录若直接操作，使用 `git --git-dir=.repo --work-tree=.`。不要 `git add .`。

### Task 1：确认依赖、模型适配和实施基线（P0）

**Files:**
- Create: `workers/agent/go.mod`、`workers/agent/go.sum`
- Create: `workers/agent/internal/agent/compatibility_test.go`
- Create: `docs/operations/agent-service.md`
- Read: `package.json`、`docker-compose.yml`、`src/lib/server/analyze.ts`、本计划第 9 节官方来源

**Step 1 — 记录版本与工作区。**

运行 `node --version`、`go version`、`git --git-dir=.repo --work-tree=. status --short`，在操作文档记录工具版本和实际部署方式。Node 保持项目支持版本，Go 选择仍受支持且满足全部子模块要求的版本；不能从 eino 根 go.mod 的最低版本推导全部扩展所需版本。

**Step 2 — 选择并锁定兼容依赖。**

创建 Go 模块 `loom.local/agent`。用以下只读命令查版本，再将选中的明确 tag 写入 go.mod；不提交 `@latest` 安装脚本，不假设 eino-ext 子模块同版本号：

```sh
go list -m -versions github.com/cloudwego/eino
go list -m -versions github.com/cloudwego/eino-ext/components/model/openai
go list -m -versions github.com/cloudwego/eino-ext/components/tool/mcp
go list -m -versions github.com/cloudwego/eino-ext/adk/backend/local
```

版本表必须列：Go、Eino、OpenAI adapter、MCP adapter、MCP client、Skill filesystem backend、模型名/API 地址（不写 key）。main 分支仅用于查能力，实际锁定发布版；如果所需能力仅在未发布提交中，应单独记录 commit 和原因。

**Step 3 — 编写最小编译探针。**

`compatibility_test.go` 分别实例化 ChatModel、无工具 ChatModelAgent、Skill Middleware 和本地协议测试 MCP client。使用 `httptest.Server` 作为模型/MCP 假服务，只测试协议，不调用真实模型。验证工具调用响应可再次回传模型；不能仅测试“构造成功”。

测试名固定为 `TestModelRoundTrip`、`TestToolCallRoundTrip`、`TestSkillLoad`、`TestMCPTransport`。模型回复由测试服务脚本控制，测试替身不能进入应用运行时 fallback。

**Step 4 — 运行探针并记录结果。**

```sh
go -C workers/agent mod tidy
go -C workers/agent test ./internal/agent -run 'Test(ModelRoundTrip|ToolCallRoundTrip|SkillLoad|MCPTransport)$' -count=1
go -C workers/agent list -m all
```

预期全部 PASS，并记录最终版本矩阵。第一次缺 API/接口不兼容属于真实失败，修正版本或适配后再继续。生产模型的 tool calling、JSON mode、usage 返回在 Task 17 专项验证，不能由 fake 通过推断可用。

**Step 5 — 提交。**

仅提交上述四个文件，建议 `chore: pin Eino runtime compatibility baseline`。网络受环境限制时按环境审批规则处理，不绕过。

### Task 2：锁定双端契约和跨语言样例（P0）

**Files:**
- Create: `src/lib/agent-contract.ts`、`src/lib/server/agent-contract.test.ts`
- Create: `workers/agent/internal/agent/contract.go`、`workers/agent/internal/agent/contract_test.go`
- Create: `validation/agent/contracts/analyze-valid.json`、`briefing-valid.json`、`research-valid.json`、`invalid-cases.json`
- Create: `scripts/agent-contract-check.mjs`

**Step 1 — 写失败样例。**

覆盖未知 mode、多余字段、错误数组类型、超长文本、空证据、跨模式输出、引用缺 ID、嵌套对象超限、emoji/code point 计数、尾随第二个 JSON 对象。字段边界测试采用第 3 节实际限制。

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { analysisSchema } from "../agent-contract.ts";

test("analysis output rejects string topics", () => {
  const result = analysisSchema.safeParse({ summary: "摘要", topics: "主题",
    entities: [], insights: "洞察", tags: [] });
  assert.equal(result.success, false);
});
```

**Step 2 — 确认失败。**

运行 `node --experimental-strip-types --test src/lib/server/agent-contract.test.ts`，预期导出不存在或校验未生效时 FAIL。

**Step 3 — 实现 schema 与 Go struct。**

Zod 使用 strict 对象和 discriminatedUnion；Go decoder 使用 DisallowUnknownFields，解码后必须读到 EOF。普通 struct 无法区分缺失与零值的字段使用指针或显式 required 校验。两端字符上限都按 code point 校验；source.end-start 必须等于片段长度。

analysisSchema 的最小可复用定义：

```ts
import { z } from "zod";
const text = (max: number) => z.string().refine(v => Array.from(v).length <= max);
const labels = z.array(text(80).refine(v => v.trim().length > 0)).max(12);
export const analysisSchema = z.object({
  summary: text(1200).refine(v => v.trim().length > 0),
  topics: labels,
  entities: labels,
  insights: text(1200),
  tags: labels,
}).strict();
```

**Step 4 — 双端验证同一组 fixtures。**

```sh
node --experimental-strip-types --test src/lib/server/agent-contract.test.ts
go -C workers/agent test ./internal/agent -run TestContract -count=1
node scripts/agent-contract-check.mjs
```

check 脚本只执行两端验证并比较接受/拒绝清单，任何差异退出 1，不另写第三套 schema。预期全部 PASS。

**Step 5 — 提交。**

仅提交本任务文件，建议 `feat: define versioned agent execution contract`。

### Task 3：增加运行账本和幂等领取（P1）

**Files:**
- Create: `migrations/0011_ai_runs.sql`
- Create: `src/lib/server/agent-runs.ts`、`src/lib/server/agent-runs.test.ts`
- Modify: `package.json`（将新增测试接入 npm test）
- Read: `src/lib/server/extract-targets.test.ts`、`src/lib/server/scheduler-atomic.ts`

**Step 1 — 写数据级失败测试。**

沿用现有 PGlite 测试模式，加载 0002 与 0011。写出：相同 request_id 并发创建只返回一个胜者；不同 input_hash 冲突；成功请求可重放；过期领取不可完成；错误 claim_token 不得改状态。

**Step 2 — 确认失败。**

运行 `node --experimental-strip-types --test src/lib/server/agent-runs.test.ts`，预期未实现迁移或领取函数时 FAIL。

**Step 3 — 实现最小持久逻辑。**

采用第 4 节完整迁移；agent-runs.ts 接受现有 `Sql` 形状和明确参数，不创建 Repository 接口。提供 `beginRun`、`finishRun`、`failRun`、`getRun` 四个具体函数。使用标准库 randomUUID/createHash；input_hash 使用固定顺序的 JSON 字段，不能直接散列任意键顺序对象。

领取 SQL 起点：

```sql
insert into ai_runs (id, request_id, mode, provider, input_hash, material_hash,
  policy_version, request_json, status, claim_token, expires_at)
values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'running',$9,$10)
on conflict (request_id) do nothing
returning id;
```

无返回行时读取已有记录并应用第 4.2 节规则。不得把同 ID 请求冲突当“再次执行”。

**Step 4 — 验证与接入测试命令。**

运行本任务测试，预期 PASS；PGlite 并发连接模型不等于生产 pg 并发，多连接 pg 的相同用例在 Task 16 必须运行。新增 npm test 文件名时保留全部现有测试。

**Step 5 — 提交。**

建议 `feat: persist idempotent AI runs`。

### Task 4：材料选择、快照和引用验证（P1）

**Files:**
- Create: `src/lib/server/agent-context.ts`、`src/lib/server/agent-context.test.ts`
- Read: `src/lib/server/analyze.ts`、`src/lib/server/queries.ts`、`src/lib/server/extract-targets.ts`

**Step 1 — 写实际问题对应的失败测试。**

用前半段正文与末尾 OCR 片段的长条目验证不会只剩开头；验证 partial 区间、emoji 边界、零材料、上海午夜、31 天上限、过期分析、引用不存在/quote 不在文本中，以及传入多条但只引用一条时只保存一条引用。

**Step 2 — 运行本文件测试，确认 FAIL。**

`node --experimental-strip-types --test src/lib/server/agent-context.test.ts`。

**Step 3 — 实现三种材料构建和证据验证。**

只在一个文件中提供模式对应的具体函数，复用 mapItem。代码级分段函数起点：

```ts
export function selectTextSegments(body: string, cap = 12000) {
  const chars = Array.from(body.replace(/\r\n/g, "\n"));
  if (chars.length <= cap) return [{ start: 0, end: chars.length, text: chars.join("") }];
  const head = Math.floor(cap / 2);
  const tail = cap - head;
  return [
    { start: 0, end: head, text: chars.slice(0, head).join("") },
    { start: chars.length - tail, end: chars.length, text: chars.slice(-tail).join("") },
  ];
}
```

cap 只由程序常量传入，若作为公共参数则校验为正整数。选材返回快照、material_hash、coverage、warnings。引用验证函数输入为规范化结果和可信 evidence Map，禁止跨 run 查询任意 ID 补证据。

**Step 4 — 再次运行并确认 PASS。**

检查 selected 字数与预算、quote 与标准化原文精确匹配。零材料应不进入模型调用路径。

**Step 5 — 提交。**

建议 `feat: build bounded evidence context for analysis`。

### Task 5：Go HTTP 执行服务与配置（P1）

**Files:**
- Create: `workers/agent/cmd/agent/main.go`
- Create: `workers/agent/internal/agent/config.go`、`server.go`、`server_test.go`
- Modify: `workers/agent/internal/agent/contract.go`

**Step 1 — 写 HTTP 行为测试。**

覆盖空 token、错误 token、超大 body、畸形 JSON、过期 deadline、超过并发上限、健康检查不触发模型、请求取消传播。测试服务器注入一个函数型 execute 回调，不为了假服务引入通用 Agent 工厂。

**Step 2 — 运行并确认 FAIL。**

`go -C workers/agent test ./internal/agent -run TestHTTP -count=1`。

**Step 3 — 用 Go 标准库实现服务。**

使用 net/http、context.WithDeadline、http.MaxBytesReader、crypto/subtle、带缓冲 channel 实现单实例并发 2。执行请求配置 ReadHeaderTimeout、总 WriteTimeout 和 Shutdown；readyz 只做本地配置检查。token 比较拒绝空值与长度不匹配，禁止日志输出 Authorization。

鉴权函数起点：

```go
func authorized(header, token string) bool {
    if token == "" || !strings.HasPrefix(header, "Bearer ") { return false }
    got := []byte(strings.TrimPrefix(header, "Bearer "))
    want := []byte(token)
    return len(got) == len(want) && subtle.ConstantTimeCompare(got, want) == 1
}
```

在 handlers 中绑定一个已构建的执行函数；满载返回明确 429/503 分类，不悄悄排无界队列。服务启动失败返回非零，不能自动切假模型。

**Step 4 — 验证。**

运行 HTTP 测试与 `go -C workers/agent test -race ./...`，预期 PASS。若主机 race toolchain 不可用，将 race 检查放在受支持 Linux 构建环境，记录实际运行环境。

**Step 5 — 提交。**

建议 `feat: add bounded internal agent HTTP service`。

### Task 6：模型适配与固定分析流程（P1）

**Files:**
- Create: `workers/agent/internal/agent/model.go`、`workflow.go`、`workflow_test.go`
- Modify: `workers/agent/cmd/agent/main.go`、`internal/agent/server.go`

**Step 1 — 写脚本化供应商响应测试。**

覆盖合法 JSON、非法 JSON 后一次修复、连续非法、401、429、超时、空内容、缺 usage、返回模型名与配置一致性、两次修复不允许、材料包含恶意指令但没有工具可调用。

**Step 2 — 确认 FAIL。**

`go -C workers/agent test ./internal/agent -run TestWorkflow -count=1`。

**Step 3 — 实现模型调用与固定分支。**

复用 Task 1 的 Eino ChatModel 适配，model/base URL/key 来自服务配置，显式设置 request deadline。使用 `analyze_item`/`briefing` 的固定消息构造与结构校验；research 在 P1 先用已选材料单次回答，不伪称有工具循环。供应商支持 structured output 时可启用，但业务校验始终保留。

每次真正 HTTP 模型请求前扣本次调用额度；修复提示只包含结构错误与必要输出，不追加全部不可信供应商错误页。总预算不足则直接失败。禁用未计数的 SDK/ADK retry 和 failover。没有 usage 返回时写 null，不推算为 0。

**Step 4 — 验证。**

运行测试并统计 httptest 收到的请求数量；合法场景 1 次，格式修复场景最多 2 次，401/超时不隐式重放。输出存在 coverage 与输入一致性；不能由模型把 partial 改成 full。

**Step 5 — 提交。**

建议 `feat: run deterministic analysis through Eino models`。

### Task 7：TypeScript 调用客户端与显式引擎切换（P1）

**Files:**
- Create: `src/lib/server/agent-client.ts`、`src/lib/server/agent-client.test.ts`
- Modify: `src/lib/server/config.ts`、`src/lib/server/analyze.ts`

**Step 1 — 写失败测试。**

注入 fetch，测试 engine=legacy 不请求 agent URL、eino 缺配置明确失败、错误 run_id 拒绝、超大响应/HTML 错误页拒绝、连接超时不调用 legacy、未知 engine 启动/请求失败。

**Step 2 — 运行并确认 FAIL。**

`node --experimental-strip-types --test src/lib/server/agent-client.test.ts`。

**Step 3 — 实现一个具体 HTTP 客户端。**

使用原生 fetch、redirect:error、AbortSignal.timeout 和第 3 节 schema。限制响应字节数后再 JSON.parse；Content-Type 与 JSON 都检查。函数接受显式配置与 fetchImpl 默认值便于测试，不建立“多供应商插件接口”。

AI_ENGINE 在运行创建时冻结进 provider；重复 run 不受后续开关变化影响。保留当前 legacy 函数作为可选分支；它同样进入新结果校验和运行保存，不能保留非法 JSON 伪成功。不添加失败自动回退逻辑。

**Step 4 — 确认 PASS。**

测量 fake fetch 调用计数，任何 Eino 超时/错误路径 legacy 调用数都为 0。验证服务 token 不出现在返回错误中。

**Step 5 — 提交。**

建议 `feat: route AI requests through explicit engine selection`。

### Task 8：接通三种业务操作并原子保存（P1）

**Files:**
- Modify: `src/lib/server/analyze.ts`、`fns.ts`、`agent-runs.ts`
- Create: `src/lib/server/analyze.test.ts`
- Modify: `src/lib/types.ts`、`src/lib/server/queries.ts`（可选 run_id 与结果元信息）

**Step 1 — 写端到端业务测试。**

组合 PGlite 与 fake execute，验证：相同操作一次模型调用一次结果；非法输出零业务行；保存失败不改 items 状态；已成功响应丢失后再次请求返回同 ID；分析过程中原文/OCR 改动拒绝旧提交；简报只有指定范围；问答材料不足不产生编造引用。

**Step 2 — 运行并确认 FAIL。**

`node --experimental-strip-types --test src/lib/server/analyze.test.ts`。

**Step 3 — 将真实业务串成单一路径。**

顺序固定：校验输入 → 查幂等记录 → 选材 → 创建运行 → 执行选定 engine → 校验结果及引用 → 原子保存 → 返回旧接口兼容形状。数据库条件冲突返回结构化错误，异常捕获不吞掉 persist_failed。

为 node 原生测试，将真正需要测试的逻辑以具体函数参数传入 Sql/execute；不要让测试必须通过 Vite 别名或启动整个页面。已有分析导出作为薄入口仍使用 getSql，不为一个实现创建接口层。

briefingFn 兼容无参数调用；askFn/analyzeItemFn 应用 Task 2 schema。新增 fields 为可选；历史行 run_id=null 可正常 map 和渲染。

getItemFn 与 listKnowledgeFn 需通过可空 run_id 关联读取 coverage、warnings 和已保存 evidence，否则刷新后这些信息会丢失。只选择 UI 需要的 response_json 字段；不得把 request_json、claim_token 或 data_token_hash 发给浏览器。旧记录缺少运行元信息时显示“历史结果，覆盖范围未记录”，不能补写 full。

**Step 4 — 验证。**

运行 Task 3/4/7/8 的定向测试，确认全 PASS；检查新增 SQL 没有分散 BEGIN/COMMIT。调用原前端参数形状仍能完成流程。

**Step 5 — 提交。**

建议 `feat: persist validated AI results atomically`。

### Task 9：页面最小兼容、请求重试与结果提示（P1）

**Files:**
- Modify: `src/routes/inbox.$itemId.tsx`、`src/routes/knowledge.tsx`
- Create: `scripts/agent-e2e.mjs`
- Read before UI edits: `.grok/skills/design-ui/SKILL.md`

**Step 1 — 写浏览器行为验收。**

脚本在隔离测试服务上覆盖：双击按钮不会创建第二次操作、同操作网络重试使用相同 UUID、新的明确分析生成新 UUID、legacy 旧记录可渲染、partial/material不足有文字说明、外部引用不会跳转成内部 item 页。

**Step 2 — 在当前未实现页面运行，确认新增行为 FAIL。**

命令 `node scripts/agent-e2e.mjs`，脚本必须强制要求测试专用目标与配置，默认不能向实际账户发送付费请求。

**Step 3 — 最小 UI 修改。**

继续使用现有 TanStack Query mutation、Button、toast；操作开始生成 request_id，失败保留到用户明确发起新操作。保留已展示结果，失败不能清空上一次成功记录。新增 coverage/warnings/错误分类与核对后引用展示；不创建运行控制台新页面。

前端状态文本区分“生成失败”“结果未保存”“任务仍在执行”；数据不足显示正常说明，不伪装模型错误。不要在挂载、刷新或 React 重试时自动发起付费分析。

**Step 4 — 复测。**

`node scripts/agent-e2e.mjs` 返回 PASS，截图写入项目 screenshots。完整桌面/手机、dev/built 检查在 Task 16 统一执行。

**Step 5 — 提交。**

建议 `feat: expose analysis coverage and safe retry feedback`。

### Task 10：受控内部检索 API（P2）

**Files:**
- Create: `src/lib/server/agent-data.ts`、`src/lib/server/agent-data.test.ts`
- Create: `src/routes/api/internal/agent-data.ts`
- Modify: `src/lib/server/agent-runs.ts`、`src/lib/server/config.ts`

**Step 1 — 写权限与证据失败测试。**

覆盖缺服务 token、空 token、错 run token、非 running/过期 run、跨范围 item、任意 SQL action、超大 query、ILIKE 转义、body 内容限额、并发证据追加不丢失。应用无登录也必须验证服务与运行范围。

**Step 2 — 运行并确认 FAIL。**

`node --experimental-strip-types --test src/lib/server/agent-data.test.ts`。

**Step 3 — 实现三种固定 action。**

路由只做 HTTP 解析和调用业务函数。随机 run token 使用 `randomBytes(32)`，数据库只存 hash。复用已有 timingSafeEqual 模式但不能复用凭证本身。认证通过后才读取材料；参数过滤条件与已保存范围取交集。

每次成功返回的材料写入该 run 的证据账本，证据 ID 不由模型提供。追加条数与字节总量做原子条件限制，最多 32 条；超过返回 budget_exceeded，不默默截断已引用证据。

**Step 4 — 确认 PASS。**

调用计数证明未认证请求没有数据库材料查询；并发请求不会覆盖证据数组。测试 SQL 通配符搜索不会扩大范围。

**Step 5 — 提交。**

建议 `feat: expose scoped read tools for active agent runs`。

### Task 11：内部 Tools 与研究 Agent 循环（P2）

**Files:**
- Create: `workers/agent/internal/agent/tools.go`、`research.go`、`research_test.go`
- Modify: `workers/agent/internal/agent/workflow.go`、`model.go`、`contract.go`

**Step 1 — 写可重现的 Agent 场景。**

fake 模型固定三步：先调用 search_items，再 get_item，最后输出带引用答案；假数据服务记录 run token 和范围。另测零结果、工具越权、连续工具循环、并行 tool calls 超总额度、格式修复耗尽次数。

**Step 2 — 运行并确认 FAIL。**

`go -C workers/agent test ./internal/agent -run TestResearch -count=1`。

**Step 3 — 用 Eino ADK 实现实际循环。**

将三个工具注册为 Eino BaseTool，使用锁定版本的 ChatModelAgent + Runner。工具封装调用固定 AGENT_DATA_URL，凭证由执行上下文附加，不在 tool schema 中出现。所有计数使用并发安全计数器，工具并行时不能各自看到“还有一个额度”而同时放行。

输出必须经过统一结果 validator。工具返回作为 tool message，引用证据 ID 和 coverage 与材料一起进入上下文。不为模型开放保存数据库或重跑采集工具。

**Step 4 — 确认 PASS。**

证明实际经过模型→工具→模型循环而非硬编码脚本；测试工具次数最多 4、模型调用最多 6、40 秒上下文取消后所有工具退出。

**Step 5 — 提交。**

建议 `feat: add bounded research agent with corpus tools`。

### Task 12：MCP 工具适配与外部证据（P2）

**Files:**
- Create: `workers/agent/internal/agent/mcp.go`、`mcp_test.go`
- Create: `workers/agent/config/mcp.example.json`
- Modify: `workers/agent/internal/agent/config.go`、`research.go`、`contract.go`
- Modify: `src/lib/server/agent-context.ts`、`src/lib/types.ts`

**Step 1 — 编写 MCP 协议失败用例。**

测试服务提供 search/read/write 三种工具。允许 search 时 Agent 只能看到 search；空 allowed_tools 时工具数必须为 0；还要覆盖命名冲突、Initialize 失败、凭证重定向、超大结果、伪造外部 URL、可选服务断开、必需服务不可达。

**Step 2 — 运行并确认 FAIL。**

`go -C workers/agent test ./internal/agent -run TestMCP -count=1`。

**Step 3 — 复用官方适配器并包装边界。**

由锁定版本 MCP client 建连接并初始化，再调用 `eino-ext/components/tool/mcp.GetTools`。allowed_tools 非空且明确匹配后才注册；适配器默认空列表会拉取全部的行为不得泄露到应用。工具输出包装器负责限量与证据收据，不另造 MCP 协议实现。

第一版只接受文本工具结果。来源 URL 按已验证工具返回 schema 解析，不从模型最终答案反向“识别出处”。外部 evidence 返回值由工具运行记录生成，TS 校验 run_id 与引用存在性。

**Step 4 — 复测并记录覆盖范围。**

全部测试 PASS；操作文档明确“Tools + 已验证 transport”，不声称 Resources/Prompts/OAuth 已支持。真实服务配置在 Task 17 按实际可用凭证验证。

**Step 5 — 提交。**

建议 `feat: integrate allowlisted MCP research tools`。

### Task 13：只读 Skills 和业务技能包（P2）

**Files:**
- Create: `workers/agent/internal/agent/skills.go`、`skills_test.go`
- Create: `workers/agent/skills/industry-analysis/SKILL.md`
- Create: `workers/agent/skills/cross-source-check/SKILL.md`
- Create: `workers/agent/skills/briefing-writing/SKILL.md`
- Modify: `workers/agent/internal/agent/research.go`、`workflow.go`

**Step 1 — 写技能行为失败测试。**

覆盖元信息发现不加载全文、显式触发只读取指定技能、重复 name、目录逃逸、超大文件、不支持 fork/model 覆盖、版本 hash 随内容变化、没有 shell 工具。测试路径使用 Go t.TempDir，不向用户全局 skills 目录写入。

**Step 2 — 运行并确认 FAIL。**

`go -C workers/agent test ./internal/agent -run TestSkills -count=1`。

**Step 3 — 使用现成 Skill Middleware。**

先校验打包目录，再交给官方 filesystem skill backend；目录挂载只读。固定任务选择固定业务技能，研究 Agent 注册 skill middleware。业务技能只引用已实现工具；内容包含事实/推断区分、独立信源识别、引用约束和材料不足处理。

固定任务加载技能无需模型调用，研究中的 skill 工具调用计入总工具额度。加载事件记录由代码产生；哈希按相对文件名稳定排序与原始字节计算，两个 OS 相同包内容必须相同版本。

**Step 4 — 复测。**

全部 PASS，并用真实读取的三份技能确认没有依赖未实现的工具、shell 或账户。测试替身只验证触发过程，不保证真实模型每次都选择同一技能；核心业务校验不依赖选择结果。

**Step 5 — 提交。**

建议 `feat: load versioned read-only analysis skills`。

### Task 14：运行事件、引用呈现与错误收敛（P2）

**Files:**
- Modify: `workers/agent/internal/agent/model.go`、`research.go`、`tools.go`、`mcp.go`、`skills.go`
- Modify: `src/lib/server/agent-runs.ts`、`agent-context.ts`、`analyze.ts`
- Modify: `src/routes/knowledge.tsx`、`src/routes/inbox.$itemId.tsx`
- Modify: `src/lib/server/analyze.test.ts`、`scripts/agent-e2e.mjs`

**Step 1 — 写贯穿链路的失败测试。**

内部检索→技能→外部 MCP→答案；检查每条引用归属当前运行，旧/伪造引用拒绝。断网、超时、非法输出、数据库失败均只有一个明确终态；错误不泄露 token、完整供应商响应或私有推理。

**Step 2 — 执行相应测试，确认新增断言 FAIL。**

运行 `node --experimental-strip-types --test src/lib/server/analyze.test.ts` 和 `node scripts/agent-e2e.mjs`。

**Step 3 — 收敛统一事件与结果。**

运行记录仅存白名单事件字段；事件最大 64 条，字节总量有界。失败事件可记到 ai_runs；模型 usage 缺失保留 null。将 evidence 来源与调用耗时映射到可选 UI 元信息，页面只展示对用户有用的来源、范围、结果和失败原因，不渲染内部凭证/完整系统提示。

最终追加 runtime 事件时保留内部数据 API 已写入的证据收据，不用 Go 返回数组覆盖整个 events_json。receipt 与 runtime 事件使用不同 type；64 条总上限包含最多 32 条证据收据，达到限制时返回明确预算错误。

**Step 4 — 验证。**

同一材料结果通过刷新可再次看到；外部引用链接有效且不会被当成内部条目；失败后之前成功分析仍可见；全局搜索日志测试数据中的密钥哨兵应为零匹配。

**Step 5 — 提交。**

建议 `feat: record auditable agent outcomes and evidence`。

### Task 15：部署接入与启动契约（发布）

**Files:**
- Create: `workers/agent/Dockerfile`
- Modify: `docker-compose.yml`、`env.example`、`README.md`
- Modify if startup actually changes: `startup.sh`、`restart.bat`
- Modify: `docs/operations/agent-service.md`

**Step 1 — 记录两种部署验收条件。**

Compose 中 agent 没有 ports 映射，app→agent 与 agent→app 地址都可达；不形成双向 healthy 依赖。TypeScript 在 agent 不可用时仍能启动和展示已采集内容；Go 不读取数据库凭证。

Vercel 路径只部署 TypeScript 应用，Go 必须由独立受支持服务运行，AGENT_DATA_URL 指向已配置安全入口。不得在 ServerFn 里启动 Go 进程或未等待的后台任务。

**Step 2 — 实现最小镜像与 Compose 接线。**

使用 Task 1 锁定 Go 版本的多阶段构建，复制 go.mod/go.sum 后下载依赖，构建 agent 二进制，运行层非 root、只读技能/配置目录。健康检查使用二进制提供的 `healthcheck` 子命令或镜像内明确存在的工具，不假设 distroless 有 curl。

Compose 新增 agent 服务使用独立 build context `./workers/agent`，内部端口建议 8791。app 默认 AI_ENGINE=legacy，只有显式 eino 时连接服务。agent 不依赖 app 的 readyz 完成启动；收到 research 请求时检查数据服务连接。

不创建 .env；env.example 只写变量说明与非秘密示例。若 startup.sh 引入本地 Go 服务，保持幂等、非阻塞、npm run dev 契约，并让 Go 缺失只影响 Eino 模式。restart.bat 已有用户改动，先重新读 diff；没有必要就不改。

**Step 3 — 做配置级检查。**

`docker compose config --quiet` 预期退出 0；不要把包含真实展开密钥的完整 compose config 输出贴进日志。`docker compose build agent` 预期成功。检查 agent 服务没有宿主端口和敏感卷挂载。

**Step 4 — 验证启动与故障。**

在隔离测试部署启动 agent/app；healthz 正常，无模型请求。停止 agent 后现有收件箱仍可用；Eino 操作返回 unavailable，不自动收费重试。恢复 agent 后新操作可执行。测试启动不运行真实采集 scheduler。

**Step 5 — 提交。**

建议 `build: deploy Eino as an internal agent service`。

### Task 16：统一回归、迁移与浏览器验收（发布）

**Files:**
- Modify: `package.json`（完成全部新增测试接线）
- Modify: `scripts/agent-e2e.mjs`、`docs/operations/agent-service.md`
- Create: `validation/agent/acceptance-2026-09-07.md`

**Step 1 — 准备隔离测试配置。**

LLM、MCP 使用协议测试服务；业务数据库用新建测试库或 PGlite，禁用采集 scheduler。构建脚本会执行 db:migrate，因此不得让验收构建意外指向真实生产数据库。测试服务不得出现在生产 fallback 中。

PGlite 与 PostgreSQL 分别运行 Task 3/8 的相同语义用例，PostgreSQL 并发用至少两个真实连接。旧数据已有 analyses/knowledge_notes、run_id=null 的升级必须验证。迁移重新运行不报错，0011 不修改原有字段值。

**Step 2 — 执行后端与协议检查。**

```sh
npm test
node scripts/agent-contract-check.mjs
go -C workers/agent test ./... -count=1
go -C workers/agent vet ./...
go -C workers/agent test -race ./...
node scripts/agent-e2e.mjs
```

预期全部退出 0；记录运行环境和覆盖的 engine/database 组合。race 测试在支持的 Go 环境执行。不能只跑 fake 模型构造测试就认定 Agent 集成完成。

**Step 3 — 并行执行构建和类型检查。**

源码稳定后，在独立终端运行 `npm run build` 与 `npm run typecheck`；不要把失败后的构建输出继续用于验收。预期两个命令均退出 0。

**Step 4 — 检查 dev 与 production 实际渲染。**

Linux `/workspace` QA 环境按现有脚本运行：

```sh
sh /workspace/startup.sh
node scripts/browser-smoke.mjs http://127.0.0.1:8080/knowledge /workspace/screenshots/agent-dev.png
npm run preview:restart
node scripts/browser-smoke.mjs http://127.0.0.1:8081/knowledge /workspace/screenshots/agent-built.png --baseline /workspace/screenshots/agent-dev.json
```

dev verdict 要求桌面与 390×844 移动端都正常、无页面/控制台错误、无水平溢出；批量查看两张 dev 截图。built verdict 不得出现 module MIME 错误或相对 dev 的异常差异；有差异时再读 built 截图。详情页用脚本创建的有效条目 ID 再跑同样检查。

当前 Windows 环境不能直接通过修改安全限制把 `/workspace` 脚本硬跑成任意路径。使用现有 Linux QA 容器挂载项目，或先为 browser guard 增加有范围校验的跨平台支持与测试；选择最少影响当前项目的可用方式，并在验收记录说明。

**Step 5 — 归档证据并提交。**

acceptance 文档记录测试命令、结果、截图位置、版本矩阵、未验证事项。建议 `test: verify Eino integration across engines and deployments`。只有实际通过才打勾，不预填 PASS。

### Task 17：真实集成验证、发布与回滚演练（发布）

**Files:**
- Modify: `docs/operations/agent-service.md`
- Modify: `validation/agent/acceptance-2026-09-07.md`
- No production code change unless a real defect is found

**Step 1 — 确认真实验证条件。**

读取 `.grok/skills/xai-api/SKILL.md`（使用 xAI 时）及实际供应商官方文档。检查受支持模型和账户可用权限，记录 model/baseURL/能力矩阵，不回显 key。真实测试需要当前会话/既有部署授权；仅有本计划不等于授权无限付费测试。

首轮真实模型验证最多 4 个业务任务，遵守单次上限：单条分析、简报、内部研究、MCP+Skill 研究各 1 次。使用无敏感测试材料与只读 MCP 工具；不能双路影子执行所有真实用户请求。

**Step 2 — 执行四种实际场景。**

验证真实供应商接收 schema/tool 参数、返回 usage 或明确缺失、支持工具结果反馈。检查费用/用量记录与实际调用数量，验证第三方 MCP 的协议、鉴权和返回 schema。

未提供可用 MCP 地址/凭证时，保留集成禁用状态，记录“真实服务待配置”。内部 Tools+Skills 可独立使用，但不宣称真实外部 MCP 验收完成。

**Step 3 — 切换与故障演练。**

在测试部署显式设置 AI_ENGINE=eino，运行新任务；然后设置 legacy，再运行新的 request_id。已成功 run 的重复请求始终返回原结果，不因为开关变化重新运行。

模拟 Go 离线、模型限流、工具无响应。确认既有采集和 OCR/ASR 正常，失败的 Eino 请求没有自动触发 legacy。实际发布按当前用户授权与环境审批规则执行。

**Step 4 — 文档化回滚。**

回滚只修改新任务的 AI_ENGINE=legacy；保留 ai_runs 表和已生成结果，不执行 down migration。Go 服务确认无在途任务后可停止。未决 Eino 运行维持原状态，按过期规则收敛；不能切换后立即重放全部未决请求。

**Step 5 — 完成发布记录。**

填写实际依赖版本、模型能力、MCP 服务、技能 hash、验收和回滚证据。建议 `docs: record agent rollout and rollback verification`。交付结论分别列“已完成代码/离线验证/真实验证/生产启用”，不混为一个完成状态。

### Task 18：自动分析调度（P3，显式需求后）

**启动条件：** 用户要求采集后自动分析，并确定日任务上限及付费预算；不随 P2 默认启用。

**Files:**
- Create: `migrations/0012_ai_jobs.sql`（届时重核编号）
- Create: `src/lib/server/agent-queue.ts`、`agent-queue.test.ts`
- Modify: `src/lib/server/config.ts`、`src/lib/server/nodes.ts`、`src/routes/api/cron/tick.ts`
- Modify: `docs/operations/agent-service.md`、`env.example`

**Step 1 — 写任务身份与预算测试。**

同一 `(item_id,material_hash,policy_version)` 只能排一个任务；OCR 未就绪、关键媒体失败、空正文、有效分析已存在时不排。两个 scheduler 同时运行仍只领取一次；并发预算不能透支；付费结果不确定不自动重试。

**Step 2 — 运行并确认 FAIL。**

`node --experimental-strip-types --test src/lib/server/agent-queue.test.ts`。

**Step 3 — 实现队列和独立开关。**

新增 AUTO_ANALYZE=false、每日任务数量与明确币种/价格版本预算。ai_jobs 保存 item_id、material_hash、policy_version、status、run_id、attempts、next_attempt_at、lease_until、claim_token；唯一约束为任务身份三元组。队列领取采用现有 SQL lease/fencing 思路，但 job 类型与 extract_jobs 分开。

预算使用 SQL 行锁/原子条件更新预留最坏成本，实际完成后结算；tokenizer 不能给保守上界时先只提供供应商账户硬限额 + 调用量上限，不能把估算宣传为金额硬限额。未知用量保留预留额度，待人工或供应商账单对账，不按 0 释放。

调度只为入库且就绪材料创建作业；不在采集结果循环内直接 await 大量模型调用。失败重试仅针对明确未发起供应商请求的阶段；模型超时转 outcome_unknown 等待处置。

**Step 4 — 验证。**

队列测试 PASS，回归 `npm test`；确认 AUTO_ANALYZE=false 时模型请求数为 0，EXTRACT_AUTO 开关不影响新开关。生产启用前单独验收每日上限。

**Step 5 — 提交。**

建议 `feat: schedule budgeted automatic item analysis`。

### Task 19：长任务、断点与恢复（P3，测得同步上限不足后）

**启动条件：** 真实研究任务需要超过 40 秒，或明确需要刷新页面后继续运行、断点恢复。此时才改变执行协议，不用临时增大 HTTP 超时替代持久任务。

**Files:**
- Create: `workers/agent/internal/agent/worker.go`、`worker_test.go`
- Create: `src/routes/api/internal/agent-jobs.ts`
- Create: `src/lib/server/agent-checkpoints.ts`、`agent-checkpoints.test.ts`
- Create: `migrations/0013_agent_checkpoints.sql`（届时重核编号）
- Modify: `src/lib/server/agent-queue.ts`、`src/lib/server/fns.ts`
- Modify: `src/routes/knowledge.tsx`、`docker-compose.yml`

**Step 1 — 写恢复语义测试。**

在领取后、工具完成后、最终保存前分别杀 worker。只有拥有有效 claim_token 的 worker 能保存；旧 worker 恢复后不得提交。模型请求在途崩溃与工具已执行结果不确定必须区别处理，不能承诺外部副作用 exactly once。

**Step 2 — 确认 FAIL。**

`go -C workers/agent test ./internal/agent -run TestWorker -count=1`；`node --experimental-strip-types --test src/lib/server/agent-checkpoints.test.ts`。

**Step 3 — 引入持久协议。**

app 接受任务后返回 job/run ID；常驻 Go worker 通过受认证内部 jobs API 领取、续租、保存事件和完成结果。job 的 queued/running 状态与 ai_runs 的执行尝试分开；一次重试创建新的 attempt/run 并保留关联，不覆盖旧尝试。

使用 Eino Runner 的 CheckPointStore 扩展，后端通过内部 API 存 opaque checkpoint 字节及 schema/runtime version、run/claim/sequence。只接受可信服务写入，设体积上限和存储访问控制；恢复时校验 Eino、模型、技能、工具版本兼容。不要序列化包含长期凭证的配置；运行密钥恢复时重新注入。

执行器以 lease fencing 保护完成写入。非幂等外部工具需工具自身幂等键或人工确认；首版只读工具也可能收费，结果不确定仍需避免自动重复。浏览器先用 TanStack Query 有界轮询状态；只有确有实时显示需求才加 SSE 和序号回放。

**Step 4 — 验证。**

故障注入测试 PASS；重启后领取与恢复不依赖原 HTTP 请求存活；版本不匹配时拒绝恢复并给出明确错误。Docker 多 worker 与服务重启检查后再开放长任务入口。

**Step 5 — 提交。**

建议 `feat: persist and resume long-running research jobs`。

### Task 20：检索质量与全文处理升级（P3，评测驱动）

**启动条件：** 真实评测发现关键词检索召回不足或 partial 分析不能满足需求；独立于是否启用长任务，不提前安装向量数据库。

**Files:**
- Create: `validation/agent/retrieval-cases.json`
- Create: `scripts/agent-retrieval-eval.mjs`
- Modify: `src/lib/server/agent-data.ts`、`agent-context.ts`
- Modify: `workers/agent/internal/agent/workflow.go`
- Add migration only if selected retrieval method requires an index/table

**Step 1 — 建立测量集。**

使用至少 20 个有人工标注预期材料的实际领域问题，包含同义词、中文短语、跨源事件、无答案与长文后半段关键事实。记录当前 recall@8、错误引用、延迟与 token，不能用 LLM 自评取代人工证据标注。

**Step 2 — 运行当前基线。**

`node scripts/agent-retrieval-eval.mjs` 输出 JSON 指标与逐例结果。预期暴露具体失败案例，不为追求通过修改标签。

**Step 3 — 只实现改善失败样例的最小方案。**

先试查询关键词拆分/改写、字段加权、时间过滤；中文全文索引、pgvector/embedding 只有在评测证实值得时加入，并保持 PGlite 模式能力说明。全文摘要可增加程序分段→各段结构化摘要→聚合，保留段落证据 ID 和独立预算；不能把拼接摘要当原文 quote。

**Step 4 — 对比评测。**

同一测量集比较召回、引用准确性、时延和成本；无答案问题不能因新召回而编造。新增索引在真实 pg 上验证查询计划，不能仅凭 PGlite 速度推断生产表现。

**Step 5 — 提交。**

建议 `feat: improve evidence retrieval from measured failures`，在操作文档写明新依赖与收益。

## 9. 官方依据与版本核验

查询日期：2026-09-07。以下链接用于核对能力，不作为“已安装版本”的证据。版本锁定结果必须由 Task 1 写入操作文档；供应商兼容性由 Task 17 写入验收记录。

| 依据 | 本方案使用范围 |
| --- | --- |
| [Eino ADK 概览](https://www.cloudwego.io/docs/eino/core_modules/eino_adk/agent_preview/) | ChatModelAgent、Workflow、Runner 的职责 |
| [ChatModelAgent](https://www.cloudwego.io/docs/eino/core_modules/eino_adk/agent_implementation/chat_model/) | 工具循环、迭代限制、middleware 扩展 |
| [OpenAI adapter 源码](https://github.com/cloudwego/eino-ext/blob/main/components/model/openai/chatmodel.go) | BaseURL、模型配置与调用接口；不据此宣称 xAI 全能力已验证 |
| [MCP adapter 源码](https://github.com/cloudwego/eino-ext/blob/main/components/tool/mcp/mcp.go) | 初始化后的客户端接入、GetTools 与工具过滤 |
| [Skill Middleware](https://www.cloudwego.io/docs/eino/core_modules/eino_adk/eino_adk_chatmodelagentmiddleware/middleware_skill/) | 发现/按需读取技能，业务限制另由项目实施 |
| [Eino FAQ](https://www.cloudwego.io/docs/eino/faq/) | Skill 指令不能代替强制工具与业务规则 |
| [Runner 与扩展](https://www.cloudwego.io/docs/eino/core_modules/eino_adk/agent_extension/) | P3 使用持久 CheckPointStore，非首版默认实现 |
| [Eino go.mod](https://github.com/cloudwego/eino/blob/main/go.mod) | 核对依赖；扩展模块各自的最低 Go 要求仍需独立检查 |

本计划中的限额、SQL 表、服务职责和实施顺序是针对 Loom 的设计决策，不是 Eino 官方默认值。

## 10. 验收矩阵与完成定义

| 场景 | 必须成立 | 检查位置 |
| --- | --- | --- |
| 同一按钮请求重复发送 | 最多一个运行胜者、一个业务结果；不重复模型请求 | Task 3/8/16 |
| 模型返回非 JSON/假引用 | 不写 analyses/notes、不标 analyzed | Task 2/6/8 |
| OCR 在分析过程中追加 | 单条旧快照不能作为当前成功结果提交 | Task 4/8 |
| 无搜索结果 | 明确材料不足，不偷偷使用无关最新内容 | Task 4/11 |
| 文本超上限 | 保留区间与 partial 标识，不能声称全文覆盖 | Task 4/9 |
| 上海零点/简报无材料 | 时间范围正确，无材料零模型调用 | Task 4/8 |
| 内部 API 未认证/运行越权 | 拒绝数据返回；不能由参数扩大范围 | Task 10 |
| MCP 空白名单 | 0 个可用外部工具 | Task 12 |
| MCP 返回恶意指令 | 材料不改变服务权限、预算与工具集合 | Task 11/12/17 |
| Skill 依赖 shell/fork | 首版拒绝不支持内容，不执行任意命令 | Task 13 |
| Go 宕机/模型超时 | 可见错误，现有采集可用，无隐式 legacy 二次请求 | Task 7/15/17 |
| usage 缺失 | 保留 null，不记录 0 或虚构金额 | Task 6/14 |
| 并发工具/模型调用 | 所有调用共享同一运行预算 | Task 5/11 |
| 切回 legacy | 新任务走 legacy，旧结果/运行保留 | Task 17 |
| PGlite 与 PostgreSQL | 迁移和原子保存语义一致，pg 有多连接竞态测试 | Task 16 |
| 桌面/移动 dev/build | 页面可见，无未捕获异常和资源 MIME 错误 | Task 16 |

P1 完成：Tasks 1–9 + 对应部署测试通过，三个原入口保持可用。

P2 完成：Tasks 10–14 + Tasks 15–17 验收通过，实际工具循环、允许的 MCP 工具和三个运行时技能形成闭环。真实服务尚未提供时必须标明未验证状态，不能把离线测试结果写成生产完成。

P3 的每个 Task 独立决策与验收，不因“后续可扩展”就提前创建其表、worker 或依赖。

## 11. 实施交接

推荐首先执行 Task 1，完成依赖和协议编译探针，再按顺序进入 P1。共同契约未完成前保持顺序实施。

后续实施可以留在当前任务逐项完成；也可以在用户明确选择后，交由独立任务或按不重叠职责分配子代理。无论方式如何，每个 Task 都需先检查相关文件、运行对应验证、审查差异，再提交精确文件。执行过程中发现当前代码与计划不符，应更新计划并记录原因，不能机械照抄已过时行号。

本轮仅落盘方案，没有创建上述运行时代码、迁移或部署资源，也没有运行任何付费模型验证。
