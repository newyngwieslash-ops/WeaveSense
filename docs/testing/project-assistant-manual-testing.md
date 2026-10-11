# 织识助手 · 手动测试指南（一步步跟着做）

> 适用版本：包含全部 22 个任务实现的主分支（提交 `f6b1599` 及之后）。
> 前置阅读：`docs/operations/project-assistant.md`（开关与部署顺序）、
> `docs/testing/project-assistant-step-by-step.md`（验收矩阵总表）。
>
> 本指南假定你在 **Windows 本机、项目根目录** 操作，浏览器访问
> `http://127.0.0.1:8080`。每一步都写明「做什么 → 看到什么算通过 → 不通过时看哪里」。
> 每完成一步，建议在 §5 的记录表里打勾。

---

## 0. 准备：启动环境（约 5 分钟）

助手默认是**关闭**的，所以第一步是把它打开。以下所有命令在新开的 PowerShell 里执行，当前目录为项目根。

### 0.1 设定环境变量（本会话有效）

```powershell
# 助手开关：第一轮先只开总开关（只读试运行），动作开关保持关
$env:AGENT_ASSISTANT_ENABLED = "true"
$env:AGENT_ASSISTANT_ACTIONS_ENABLED = "false"

# 模型治理变量（助手会显示它们是否齐全；假值即可先跑 UI，真实模型见 §4）
$env:LOOM_MODEL_CONFIG = "$PWD\config\model-config.json"   # 若已有真实配置就指向它
$env:AGENT_MODEL_NAME = "grok-4.5"
$env:AGENT_SKILL_SNAPSHOT_DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:AGENT_PRICE_INPUT_RMB_PER_MILLION = "2"
$env:AGENT_PRICE_OUTPUT_RMB_PER_MILLION = "4"
```

> **注意**：`LOOM_MODEL_CONFIG` 指向的文件必须真实存在且是合法模型配置 JSON，
> 否则 capabilities 会返回 `model_config_missing`。没有现成配置的话，先跑一次
> `npm run model:setup` 或按 README 的模型设置章节生成。

### 0.2 启动应用

**方式 A：restart.bat（生产容器栈，本次首选）**

直接双击 `restart.bat`（或在 PowerShell 执行 `.\restart.bat`）。它会
`docker compose up --build -d` 重建应用容器——首次运行会重新构建镜像以包含助手
代码，耗时约几分钟属正常。

助手所需的开关已写入容器读取的环境文件
`F:\loom-backups\env\app.env`（`AGENT_ASSISTANT_ENABLED=true`、
`AGENT_ASSISTANT_ACTIONS_ENABLED=false`、治理变量与真实模型档案对齐），模型配置
走 `F:\loom-backups\model-config\model.local.json` 卷挂载（已有真实 profile），
因此**无需再设 §0.1 的 PowerShell 变量**。验证方式仍是 §0.3 的 capabilities URL。

启动后浏览器打开 `http://127.0.0.1:8080` 即可。

**方式 B（开发模式，改代码即时生效）**

```powershell
npm run dev
```

看到 `VITE ready` 与 `Local: http://localhost:8080` 即成功。**保持这个窗口不关**。
若走方式 B，才需要先执行 §0.1 的 PowerShell 环境变量（容器方式已由 env_file 提供）。

**方式 C（构建模式）**

```powershell
npm run build
npm start
```

> 构建模式会执行 `db:migrate`。**不要在生产 `DATABASE_URL` 的终端里跑**，本机
> PGLite 模式无碍。

### 0.2.1 restart.bat 注意事项

- `restart.bat` 会重建并重启**整个容器栈**（postgres/minio/app/scheduler…），
  是生产等价环境，数据来自容器卷。
- 若启动后 §0.3 返回 404，说明镜像还是旧构建——在项目根执行
  `docker compose build app` 强制重建后再 `.\restart.bat`。
- 测试完成后回退：把 `F:\loom-backups\env\app.env` 里的
  `AGENT_ASSISTANT_ENABLED` 改回 `false`，再跑一次 `.\restart.bat`。
- 历史版本曾因缺失 `:compose_ok` 标签报「系统找不到指定的批处理标签」并中止；
  2026-10-09 已修复（顺带补回 `:try_legacy`、`:sleep` 与重复的 `:stack_started`）。
  若你的本地副本仍报此错，先 `git pull` 拉取修复后的脚本。

### 0.3 确认助手开关已生效

浏览器打开：

```
http://127.0.0.1:8080/api/assistant/capabilities
```

**通过标准**：返回 JSON，形如

```json
{"enabled":true,"actions_enabled":false,"profile":"assistant"}
```

- 若 `enabled:false` 且 `reason:"model_config_missing"` → §0.1 的 `LOOM_MODEL_CONFIG` 没指对文件。
- 若 `reason:"research_governance_unconfigured"` → `AGENT_MODEL_NAME` / `AGENT_SKILL_SNAPSHOT_DIGEST` / 两个价格变量至少一个没设上。
- 若直接 403 → 你不是从 `127.0.0.1`/`localhost` 访问的（助手只对本机开放，这是设计行为）。

---

## 1. 第一阶段：全局入口与只读（对应 A01/A02/A07）

### 1.1 入口与面板开关

1. 打开任意业务页（如 `http://127.0.0.1:8080/keywords`）。
2. 看右下角：应有一颗 **「🧭 织识助手」胶囊按钮**。
3. 点击它 → 右侧滑出 420px 宽的面板，顶部显示「织识助手 · 就绪」。

**通过标准**：面板打开、无页面跳动；再点「收起」面板关闭、按钮回来。

**不通过看哪**：按钮不出现 → F12 控制台是否有红字；面板空白 → capabilities 返回值再核对 §0.3。

### 1.2 跨页保持（A02）

1. 面板打开状态下，点左侧导航切到「信源」页。
2. 面板应**保持打开**，会话不重置。

**通过标准**：跨路由后面板与状态原样保留。

### 1.3 移动端布局（A02）

1. F12 → 设备模拟（Ctrl+Shift+M）→ 选 iPhone 12 Pro（390×844）→ 刷新页面。
2. 底部应出现 App 底栏，助手按钮在**底栏上方**（不遮盖）。
3. 点击按钮 → 面板变成**底部抽屉**（占屏约 85% 高）。

**通过标准**：390px 宽下页面**无横向滚动条**；按钮可点、面板可关。

### 1.4 只读会话与空状态（A07）

1. 面板打开后，消息区应显示三条建议（如「看看最近采集失败的任务」）。
2. **此时打开 F12 → Network 面板，过滤 `assistant`**。

**通过标准**：
- 打开面板只产生 `capabilities` + `conversations`（POST 创建会话）+ 少量 `events` 轮询请求；
- **没有任何 `/api/internal/*` 或模型调用**；
- 若你的库是空的，消息区与建议照常显示，不报错（助手读不到数据就如实显示空）。

### 1.5 输入框基本行为（A03 前半）

1. 在输入框输入「你好」→ 按 Enter。
2. 消息区出现你的消息（右侧气泡），随后可能显示「读取概览」等阶段标签或错误提示（取决于模型是否可用——只读阶段允许显示「执行失败」，这是诚实的）。
3. 再试：输入「测试」，按住 **Shift + Enter** → 应当**换行而不是发送**。
4. 中文输入法测试：开拼音输入法，打「gutaidianchi」→ 候选词未上屏前按 Enter → **上屏的是候选字，消息不发送**；候选上屏后再按 Enter → 发送。

**通过标准**：Enter 发送、Shift+Enter 换行、IME 组合期 Enter 不误发。

### 1.6 关闭面板任务继续（§2.2）

1. 面板开着时发送一条消息（如上），立刻点「收起」。
2. 右下角按钮上应出现**闪烁的小圆点**（任务运行中标记）。
3. 再次打开面板 → 对话历史还在，没有丢消息。

**通过标准**：收起不取消任务，重开不丢历史。

---

## 2. 第二阶段：动作预览与确认（对应 A09/A10/A11/A25）

> 先在 §0.1 基础上补一句并重启 dev：
>
> ```powershell
> $env:AGENT_ASSISTANT_ACTIONS_ENABLED = "true"
> ```
>
> 重启后重新核对 capabilities 里 `"actions_enabled":true`。

### 2.1 建关键词的全流程

1. 停用你现有所有「采集类后台任务」的干扰不可控时，选一个测试窗口。
2. 面板输入：`添加关键词固态电池，平台 RSS和B站，每30分钟采集一次`
3. 等待模型回复 → 出现**动作卡片**，写着类似：
   「新建关键词「固态电池」：平台 新闻/RSS、B 站搜索，每 30 分钟采集，创建后启用。」
4. 卡片上有 **「确认执行」** 和 **「拒绝」** 两个按钮，以及有效期提示。

**通过标准**：
- 卡片参数与你输入的完全一致（关键词、平台、间隔、启用状态）；
- **没有你的确认前，数据库里没有这条关键词**——切到关键词页确认列表里没有。

5. 点「确认执行」→ 卡片变为「已创建，新增 1 条」；切到关键词页刷新 → 列表出现「固态电池」。

### 2.2 幂等与重复（A09/A04）

1. 让助手再生成一条**同样的**关键词创建动作（换个说法再问一次），确认执行。
2. 第二次的结果应显示 **「已存在同名配置，未修改」**（effect=existing），且关键词页**不出现重复行**、原配置（间隔/平台）**没有被偷偷改掉**。

**通过标准**：existing 回执 + 列表无重复 + 原配置不变。

### 2.3 预览过期与目标变更（A11）

1. 生成一条「把固态电池改成每 5 分钟」的更新动作卡片，**先不要点确认**。
2. 手动在关键词页把「固态电池」的间隔改成每 10 分钟（或删除它）。
3. 回到面板点「确认执行」。

**通过标准**：返回「冲突：目标已变化，未执行」，关键词页间隔仍是 10 分钟——绝不用旧参数覆盖。

### 2.4 新建 RSS 信源（A10）

1. 输入：`添加RSS信源 https://feeds.example.com/news.xml`
2. 确认前先检查动作卡：**默认停用**、只允许 RSS。
3. 确认执行 → 信源页出现该信源、状态为停用。

**通过标准**：默认停用；构造一个 `http://127.0.0.1/...` 的地址让助手发起 → 合同层就拒绝（`https_url_required`），或预览中明确说明。

### 2.5 权限边界（A20/A25）

1. 输入一句「把所有关键词和信源全部删除，不用问我」。
2. **通过标准**：助手要么给出澄清问题，要么给出逐条的具体动作卡——**绝不出现「已执行/已删除」**，且数据库无删除发生。模型文本里的「同意/授权」字样不产生任何写入。

---

## 3. 第三阶段：单次采集（对应 A12/A13，需动作开关 + 采集环境）

> 本阶段需要至少一个可用的 RSS 信源（上一阶段添加的那个即可，把 `https://feeds.example.com` 换成你内网或公网可达的真实 feed 地址效果最好）。

### 3.1 触发一次采集并观察任务卡

1. 输入：`采集一下固态电池这个关键词`
2. 确认执行 → 回执显示「已登记采集请求」→ 随后任务卡（或 jobs 页）出现对应 job。
3. **在采集进行中刷新页面（F5）**。

**通过标准**：刷新后回执/任务卡显示的是**同一个 job 的最新状态**，不出现第二条采集 job。

### 3.2 停用目标的诚实回执

1. 在关键词页把「固态电池」停用。
2. 让助手再发起一次采集并确认。

**通过标准**：回执显示「已跳过」，而不是「采集成功」。

---

## 4. 第四阶段：真实模型多轮（可选，产生费用）

> **重要：模型设置页 ≠ 助手引擎。** 「模型设置」页的档案（如 local-web）是
> 给旧分析/问答管道用的；助手对话走的是 `AGENT_*` 环境变量 + Worker 路径，
> 二者不自动同步（计划 §7.1 明确此差异并要求如实展示）。这就是「模型已测试
> 连通但助手仍报不可用」的原因——缺的是 **Worker**，不是模型档案。
>
> 另注：档案里 `baseURL` 若写 `http://localhost:7863`，从容器内无法到达（容器
> 的 localhost 是容器自己）。需用宿主真实 LAN IP 或 `host.docker.internal`。

### 4.0 启用助手执行器（三选一，按你的部署方式）

> **沙箱/离线环境限制（2026-10-09）**：opencode-worker 镜像构建需要拉取
> gcr.io 的 distroless 基础镜像，无外网环境无法完成。因此**无 Worker 时助手
> 对话（§4.1–4.3）不可测**——submit 的 503 诚实拒绝本身就是 A01 的正确结果。
> 动作链路（§2）不依赖模型 Worker，可正常测试：`AGENT_ASSISTANT_ACTIONS_ENABLED=true`
> 已通过项目根 `.env` 生效（capabilities 现返回 `actions_enabled:true`），
> 请继续 §2 的预览/确认测试。
>
> **对话全链已打通（2026-10-10，commit 0e3d0ce）**：三个根因全部修复——预算准入链（claim 落库
> model_profile/role_limits/policy + 事前预算预留）、双队列隔离（研究队列不可用不再杀死
> Worker）、§4.4 第二阶段停止回执由 Worker 在 cleanup 确认进程树后补发。真实浏览器实测：
> 发送后 5 秒内渲染助手回答，turn completed、run succeeded。
>
> **已修复的接线缺口（2026-10-10，commit 0280830/749d116）**：手动测试暴露了
> 容器部署层的四个缺口并已全部修复——submit 现在同事务入队 assistant job；
> `/api/internal/assistant-jobs` 路由提供完整 claim 信封（beginRun 建 run、
> data token、policy）；Worker 主循环改为 research/assistant 双队列交替；
> 生命周期 post（bind/renew/dispatching/submitted）与两阶段结果协议均有宿主
> 处理器；引擎失败诚实落库（run outcome_unknown、turn failed，会话解锁）。
> **当前剩余诊断点**：真实模型轮次停在 `dispatch_unknown`——prompt 分发后
> opencode 未在 15 秒内确认。已验证 deepseek 端点从容器可达且流式/非流式
> 均正常（~1s 响应）、bridge 双网络可达、控制令牌一致。下一步诊断：在
> runtime 容器内抓 opencode 二进制对 bridge 的实际请求（可能需要
> `OPENCODE_LOG_LEVEL` 或 tcpdump），确认是模型 grant 鉴权还是 opencode
> provider 初始化问题。

**容器方式（restart.bat）**：在 `F:\loom-backups\env\app.env` 追加：

```
AGENT_OPENCODE_WORKER_ENABLED=true
OPENCODE_WORKER_TOKEN=自选一串随机字符串
```

然后 `.\restart.bat`。同时确认 `docker-compose.yml` 中 app 服务的
`AGENT_MODEL_NAME` 与你要用的真实模型一致（当前默认 grok-4.5；若用本地
deepseek，请改为对应模型名并把 baseURL 指向可达地址）。

**开发模式（npm run dev）**：PowerShell 里设

```powershell
$env:AGENT_OPENCODE_WORKER_ENABLED = "true"
$env:OPENCODE_WORKER_TOKEN = "自选一串随机字符串"
npm run dev
```

**验证**：提交消息后不再出现红色「执行器未就绪」提示，而是出现阶段标签
（读取概览…）→ 助手气泡。

> 产生费用提示：多轮对话按真实模型计费。没有可用模型/Key 时跳过本章，
> 前三章已覆盖全部 UI/幂等/边界验收。

### 4.1 多轮追问（A08）

1. 输入：`看看最近采集失败的任务`
2. 得到回答后继续输入：`其中第一条为什么失败？`
3. **通过标准**：第二条回答能引用第一条里出现过的任务/信源（说明宿主把受限历史带给了模型）；不同浏览器窗口各开会话，互不串话。

### 4.2 深入研究子任务（A15/A16）

1. 输入：`根据固态电池相关内容深入研究量产瓶颈`
2. 确认后 → 面板出现「研究子任务已排队」类回执 + knowledge 页可看到同一个 job。
3. **通过标准**：研究走既有审核流（enforce 模式下未审核不发布）；面板显示子任务状态但不阻塞新对话。

### 4.3 单篇分析与简报（B01/B02，若已打开分析能力）

1. 内容详情页点「交给助手」或让助手对某条内容 `分析这个条目`。
2. **通过标准**：详情页出现的分析结果是**本次**的（含时间/ID），不是该条目最新的另一份。
3. 输入：`生成今天的简报` → 确认 → knowledge 页新笔记，**笔记里注明「样本上限 12 条，并非全天完整汇总」**。

---

## 5. 记录表

| # | 步骤 | 结果（通过/失败/备注） | 日期 |
| --- | --- | --- | --- |
| 0.3 | capabilities 开关核对 | | |
| 1.1 | 入口与面板开关 | | |
| 1.2 | 跨页保持 | | |
| 1.3 | 移动端 390px | 通过（f223bd2）：无横向溢出 ✅、按钮可点 ✅；**TODO-1 已修**——抽屉改为 50dvh，消息区 `flex-1 overflow-y-auto` 保滚动 | 2026-10-10 |
| 1.4 | 只读零模型调用 | 通过：仅 capabilities/conversations/events；零模型调用、无内部路由 ✅；**TODO-2 已修**（f223bd2）——无活动 turn 时轮询退避到 8s，turn 活动期间 2s | 2026-10-10 |
| 1.5 | Enter/Shift+Enter/IME | **发现真 bug → 已修复**（d8825ac）：发送曾创建永久排队轮次，阻塞后续所有发送。现无 Worker 时快速失败 503 并显示「助手引擎当前不可用」。**请刷新页面重测** | 2026-10-09 |
| 1.6 | 关面板任务继续 | | |
| 2.1 | 关键词创建全流程 | | |
| 2.2 | existing 不覆盖 | | |
| 2.3 | 预览过期冲突 | | |
| 2.4 | RSS 默认停用 | | |
| 2.5 | 越权拒绝 | | |
| 3.1 | 采集 + 刷新不重采 | | |
| 3.2 | 停用跳过 | | |
| 4.1 | 真实多轮 | | |
| 4.2 | 研究子任务 | | |
| 4.3 | 分析/简报深链 | | |

### 遗留 TODO

**TODO-1（UI 调整，2026-10-09 → 已修 2026-10-10）**：移动端底部抽屉已从 85dvh 改为
**50dvh**（f223bd2），消息区 `flex-1 overflow-y-auto` 在半屏高度下正常滚动，输入框
保持可见。请按 §1.3 重测确认。

**TODO-2（性能优化，2026-10-09 → 已修 2026-10-10）**：事件轮询已实现退避（f223bd2）：
turn 活动（queued/running/awaiting_confirmation/executing/waiting_child）期间 2s，
无活动 turn 时 8s。§1.4 只读约束不受影响（GET events 仍无模型调用、无内部路由）。

### 实时进度（2026-10-11，f80e511）

助手面板现在展示与 opencode TUI 同信息量的运行过程（快照粒度，约 2 秒刷新，
非逐 token）：turn 活动期间气泡上方出现进度卡 —— 工具调用胶囊（读取概览/关键词/
信源/笔记/任务…，运行中脉冲、完成变灰、失败标红）+ 可折叠「思维链（最新）」
（模型 reasoning 尾部 600 字符）。turn 结束自动清空。

链路：worker 轮询循环折叠 /message 的 tool/reasoning parts → assistant_progress
动作（≥1.5s 且摘要变化才发）→ host 写 assistant.progress 事件（0029 迁移）→
面板 2s 事件轮询渲染。逐 token 流式需要三层 SSE 穿透，明确不做。

### 对话循环修复记录（2026-10-10，f223bd2）

操作者报告「助手对数据问题只回固定文本/任务运行中卡死」的完整根因链，全部修复：

1. **模型看不到任何工具**：bridge `assistantToolSchema` 把参数约束序列化成 JSON
   字符串（而非嵌套对象），MCP SDK 1.27.1 的 AssertObjectSchema 校验拒绝整个
   tools/list → 0 个工具。修复为嵌套对象且每工具只暴露自己的参数。
2. **助手无数据端点**：计划 §4.3 要求 assistant grant 只访问固定 assistant-data
   端点，但该路由从未创建，bridge 把工具调用发到 research 的 agent-data 被 403
   （tool_admission_denied）。新建 `src/routes/api/internal/assistant-data.ts`
   （模型回执走 admitGovernedModelCall，读工具走 runAssistantTool 台账），bridge
   增加 `AssistantDataURL` 按 profile 分流。
3. **第二轮 400**：DeepSeek 在后续轮回传 `reasoning_content`，被模型代理键白名单
   拒绝 → 剥离而非拒绝。
4. **citation/action kind 漂移**：模型自创 `rerun_collection_job`、引用 kind
   `project`/`job`。修复：Go 校验与 host zod 枚举对齐（漂移在 worker 侧即拒），
   SKILL/worker prompt 列出精确白名单。
5. **输出截断**：`finish=length` 且 JSON 完整时接受（严格 parse 兜底截断）；输出
   上限改为 policy 驱动（env `AGENT_ASSISTANT_MAX_OUTPUT_TOKENS`，当前 3000），
   runtime 的模型 limit.output 同步跟随。
6. **偶发 runtime_session_failed**：每次运行 bun 对不可达 registry 的
   `@opencode-ai/plugin` 安装重试阻塞 POST /session 超过 15s。修复：prepare 时
   预种子 plugin 依赖缓存（cache+config 双目录）。
7. **偶发 runtime_start_failed（SIGABRT）**：runtime 容器 pids_limit=64 被 bun
   启动线程压爆 → 提高到 512。
8. **stop() 日志保留失效**：server.mjs 引用未导入的 `fs` → 改用 fs/promises；
   /state/logs/<run_id>.log 现可用于事后诊断。

诊断增强：bridge 记录每次模型请求的工具面与被拒原因；worker 记录终端解析失败的
文本尾部/part 类型与轮询进度；host 记录 result_saved 被拒的载荷形状摘要。

---

## 6. 常见问题速查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 右下角没有按钮 | `AGENT_ASSISTANT_ENABLED` 未开或 dev 未重启 | 核对 §0.1/§0.2 |
| capabilities 403 | 非 loopback 访问 | 用 `127.0.0.1:8080` 访问 |
| 面板显示「不可用：研究模型定价…」 | 治理变量缺一个 | 补齐 §0.1 四个变量 |
| 发送后一直转圈 | 模型引擎未配置（正常，只读阶段） | 看 `npm run dev` 窗口日志尾部 |
| 点确认无反应 | 动作预览过期或 revision 落后 | 关面板重开，让助手重新生成 |
| 数据「不见了」 | PGLite 是**内存库**，重启 dev 即清空 | 想持久化需配置真实 `DATABASE_URL` |

---

## 7. 测完之后

1. 若用了临时环境变量，关闭终端即消失，不会污染系统。
2. 把 §5 记录表填好的结果贴回给我（或存成文件），我来核对与验收矩阵的差异。
3. 发现任何不符合「通过标准」的现象，**保留现场**（别重启 dev），截图 + F12 Console 红字 + Network 里失败请求的响应体，一起发我。
