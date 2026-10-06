# 智能体链路手把手测试指南（LLM / eino / 模型网关）

> 写作日期：2026-10-05。本指南面向**手动测试**：你在浏览器里点、在 PowerShell 里敲命令、对照预期结果逐项打勾。
> 深度用例（并发竞争、预算守恒、进程恢复等）已有专项指南 [2026-09-08-eino-agent-manual-test-guide.md](2026-09-08-eino-agent-manual-test-guide.md)（A01–A20 / B01–B12 / C01–C05，共 37 项）；本指南是**从零开始的手把手版本**，覆盖三条链路的日常验证，与该指南互补不重复。测到本指南边界时按 §10 跳转。
>
> **重要现状（2026-10-05 实测）**：本机（E 盘工作区）**没有运行中的 Loom 生产栈**（`docker ps` 无 loom 容器、`127.0.0.1:8080` 无响应、`F:\loom-backups` 不存在——生产部署在另一台机器上，见 `docs/operations/manual-testing-guide.md`）。因此本指南**全部测试都在本工作区自建隔离环境进行**，不碰任何生产。本机已实测可用：opencodex 网关 `127.0.0.1:10100`（healthy，119 个模型）、Go 1.24.1、Docker 28、Node 24、项目 `node_modules` 已安装、agent 可编译、Playwright Chromium 可启动。

## 0. 三条链路是什么（先读这个再动手）

| 链路 | 是什么 | 关键配置 | 入口 |
|---|---|---|---|
| **A. legacy LLM**（同步） | 应用内 TypeScript 直连 OpenAI 兼容接口，做分析/简报/问答 | `LOOM_MODEL_CONFIG` 指向多档案 JSON（生产挂在 `F:/loom-backups/model-config/`）；无此文件时回退 `XAI_API_KEY` 直连 `api.x.ai` | 「内容」详情页 **LLM 分析**、「知识库」**向矩阵提问**/**生成今日简报** |
| **B. Eino Agent**（Go worker） | `workers/agent` 的 Go 服务，用 cloudwego/eino 框架执行模型+工具+Skills，支持异步任务、检查点恢复、预算 | `AI_ENGINE=eino` + `AGENT_SERVICE_URL/TOKEN` + `AGENT_WORKER_ENABLED` + `AGENT_ASYNC_RESEARCH_ENABLED`；Go 端 `AGENT_MODEL_*` | 同上入口；勾选 **后台研究（刷新后继续）** 即走异步 Eino |
| **C. 模型网关（opencodex）** | 本机 `127.0.0.1:10100` 的 OpenAI 兼容代理（`ocx` 命令），把多家 provider 统一成 `/v1` | 独立于 Loom；`ocx health` 管理；模型档案的 baseURL 指向它 | 无页面；被 A/B 链路作为模型端点使用 |

引擎切换规则（`src/lib/server/agent-client.ts:19`、`analyze.ts:42`）：

- `AI_ENGINE=legacy`（默认）：走 A。生产当前就是这个配置（`docker-compose.yml:226`）。
- `AI_ENGINE=eino`：走 B。生产**未启用**（agent 是 compose profile，默认不启动）。
- **两条链路的模型配置是独立的**：A 读 `LOOM_MODEL_CONFIG` 档案；B 读 Go 进程的 `AGENT_MODEL_*` 环境变量。想都走本机网关，两边都要指到 `http://127.0.0.1:10100/v1`。

费用事实：分析与问答**只在按键时调用**（`AUTO_ANALYZE=false` 时不自动烧钱）；一次问答最多 6 次模型调用、4 次工具调用、单次输出上限 1800 token（`analyze.ts:407`）；单次模型调用超时 120 秒（`analyze.ts:97`）。

---

## 1. 阶段零：环境就绪检查（10 分钟，全部命令可直接复制）

打开 **PowerShell**（Win+R 输入 `powershell`），每条命令后看输出是否符合预期：

```powershell
# 1. 进入项目根目录（本指南所有命令都在这里执行）
cd E:\AI-JIANSHI-20260825\WeaveSense

# 2. Node 依赖已装？（本机已实测：428 个包）
npm install --no-audit --no-fund
# 预期：很快结束，无 error

# 3. Docker 可用？（本机已实测：Docker version 28.0.1）
docker version --format '{{.Server.Version}}'
# 预期：28.0.1 之类的版本号；报错则先启动 Docker Desktop

# 4. postgres:16-alpine 镜像已在本地？（本机已实测：已拉取）
docker image inspect postgres:16-alpine --format 'OK'
# 预期：OK；报 no such image 则：docker pull postgres:16-alpine

# 5. opencodex 网关活着？（本机已实测：Proxy healthy, port 10100）
ocx health
# 预期：Proxy healthy (PID …, port 10100)
# 若显示未运行：ocx start（注意它是前台进程，用单独窗口跑，别用 timeout 包它）

# 6. 网关模型列表可见？（本机已实测：119 个模型，含 gpt-5.6-luna / gpt-6-astra / cursor/grok-4.5）
curl.exe -s http://127.0.0.1:10100/v1/models | findstr /C:"luna" | findstr /C:"id"
# 预期：能看到 "id":"gpt-5.6-luna" 等行

# 7. Go 1.24.1 可用？（agent 的 go.mod 要求 go 1.24.1；本机已实测装在 sdk 目录）
& "C:\Users\yi'da'dui\sdk\go1.24.1\bin\go.exe" version
# 预期：go version go1.24.1 windows/amd64
# 若报找不到：执行下面两条装一次即可（已装过可跳过）
#   go install golang.org/dl/go1.24.1@latest
#   & "F:\goFrameLearn\bin\go1.24.1.exe" download
```

**⚠️ Go 环境变量坑（本机实测踩过）**：系统 PATH 里的 `go` 是 1.22.12，且 `GOROOT` 全局指向 `C:\Program Files\Go`。直接用 1.24.1 的 go.exe 而不改 GOROOT 会报 `compile: version "go1.22.12" does not match go tool version "go1.24.1"`。**每个新开的 PowerShell 窗口跑 Go 命令前，先执行这行**（后续 Go 命令都用 `go` 简写）：

```powershell
$env:GOROOT = "C:\Users\yi'da'dui\sdk\go1.24.1"
$env:Path = "C:\Users\yi'da'dui\sdk\go1.24.1\bin;" + $env:Path
$env:GOTOOLCHAIN = 'local'; $env:CGO_ENABLED = '0'
go version   # 应输出 go1.24.1
```

**快速自检（可选，30 秒）**——跑一个最小测试确认工具链完整：

```powershell
node --experimental-strip-types --test src/lib/server/model-config.test.ts
# 预期：pass 4, fail 0
```

---

## 2. 阶段一：建隔离测试环境（15 分钟）

本指南全程使用**一次性隔离环境**：独立 PG 容器 + 一次性模型配置 + 两个终端（应用 + Go agent）。与生产零交集，测完 `Ctrl+C` 停掉、容器删掉即可。

**先选模型方案**（影响后面两条命令）：

- **方案 1（推荐，本机免费额度内）**：用本机 opencodex 网关 `http://127.0.0.1:10100/v1`，模型 `gpt-5.6-luna`。注意这是真实供应商调用，会消耗网关后面的账号额度——**每项测试只点一次按钮**。
- **方案 2（零费用）**：跑 `npm run agent:e2e`（§5），它用假模型自动完成全部链路验证，但不是常驻环境，无法手动点击。

选方案 1 就继续往下；想先零费用看全链路直接跳 §5。

### 2.1 建数据库并灌测试材料

**终端 A**（保持打开，变量后面还要用）：

```powershell
cd E:\AI-JIANSHI-20260825\WeaveSense

# 建隔离 PG（端口 57894 若被占用，换一个并在后文全部同步替换）
$manualContainer = 'loom-agent-manual-' + (Get-Date -Format 'yyyyMMddHHmmss')
$manualPgPort = 57894
docker run --detach --name $manualContainer --label loom.agent.validation=manual `
  -e POSTGRES_PASSWORD=review-only-local -e POSTGRES_DB=review `
  -p "127.0.0.1:${manualPgPort}:5432" postgres:16-alpine
# 预期：输出完整容器 ID

# 等 5 秒后确认就绪
docker exec $manualContainer pg_isready -U postgres -d review
# 预期：accepting connections

# 建表（跑完项目全部迁移）
$env:DATABASE_URL = "postgres://postgres:review-only-local@127.0.0.1:${manualPgPort}/review"
$env:AI_ENGINE='legacy'; $env:AGENT_ASYNC_RESEARCH_ENABLED='false'
$env:AGENT_WORKER_ENABLED='false'; $env:AUTO_ANALYZE='false'; $env:EXTRACT_AUTO='false'
$env:XAI_API_KEY=''
npm run db:migrate
# 预期：无报错退出。这一步创建 items/ai_runs/ai_jobs/agent_checkpoints 等全部表

# 灌 6 条测试材料（对后面判定引用/范围/长文很关键）
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
insert into sources(id,platform,name,enabled) values('manual-v3-source','rss','MANUAL V3 测试来源',false) on conflict do nothing;
insert into items(id,source_id,platform,external_id,title,body,published_at,pipeline_status,media_type) values
('manual-v3-main','manual-v3-source','rss','main','MANUAL V3 Battery 主材料','Battery 试验线良率为97%。验证样本为120片。结论仅针对试验线，不代表全面量产。',clock_timestamp(),'extracted','article'),
('manual-v3-second','manual-v3-source','rss','second','MANUAL V3 Battery 寿命','Battery 试验线循环寿命为800次，测试温度为25摄氏度。',clock_timestamp(),'extracted','article'),
('manual-v3-old','manual-v3-source','rss','old','MANUAL V3 Battery 昨日','旧试验线良率为81%，此记录只代表昨日状态。',clock_timestamp()-interval '1 day','extracted','article'),
('manual-v3-long','manual-v3-source','rss','long','MANUAL V3 Battery 长文',repeat('Battery背景说明。',2000)||'MANUAL-TAIL-973：末尾结论为隔膜返工率3%。',clock_timestamp(),'extracted','article'),
('manual-v3-empty','manual-v3-source','rss','empty','MANUAL V3 空正文','',clock_timestamp(),'ingested','text'),
('manual-v3-pending','manual-v3-source','rss','pending','MANUAL V3 待OCR','尚未完成图片提取的占位正文',clock_timestamp(),'ingested','image')
on conflict do nothing;
'@ | docker exec -i $manualContainer psql -v ON_ERROR_STOP=1 -U postgres -d review
# 预期：INSERT 0 1 / INSERT 0 6，无 ERROR
```

**常见失败**：
- `pg_isready` 不 ready → 等 10 秒重试一次，别反复建容器。
- psql 中文乱码或 INSERT 报错 → 确认整段 heredoc 一起复制（不能拆行），且 `$manualContainer` 变量还在当前会话里。

### 2.2 建一次性模型配置 + 启动应用

继续**终端 A**：

```powershell
# 一次性模型配置（文件名必须以 .local.json 结尾——readDocument 会拒绝其他后缀，
# 见 src/lib/server/model-config.ts:60；.local.json* 已被 .gitignore 排除，不会进仓库）
@'
{
  "active": "gw",
  "profiles": [
    { "id": "gw", "name": "本机网关", "baseURL": "http://127.0.0.1:10100/v1", "model": "gpt-5.6-luna", "apiKey": "none-needed" }
  ]
}
'@ | Set-Content -Encoding utf8 config/model.manual-test.local.json

$env:LOOM_MODEL_CONFIG = (Resolve-Path config/model.manual-test.local.json).Path
npm run dev -- --host 127.0.0.1 --port 18080 --strictPort
```

预期：Vite 启动完成。浏览器开 `http://127.0.0.1:18080`——应看到「总览」页深色指挥台、底边四个格子有数字。

**验证配置真的生效**（新开一个浏览器标签即可，此时是 legacy 引擎）：左侧「模型设置」页应显示档案「本机网关」，且页面顶部提示「当前为同步问答」。**别在页面里改这份配置**——页面保存走的是 `LOOM_MODEL_CONFIG`，会改写你刚建的文件；本阶段直接用文件即可。

### 2.3 启动 Go Agent（Eino 链路要用）

**终端 B**（新开一个 PowerShell）：

```powershell
cd E:\AI-JIANSHI-20260825\WeaveSense

# Go 1.24.1 环境三件套（见 §1 的坑说明）
$env:GOROOT = "C:\Users\yi'da'dui\sdk\go1.24.1"
$env:Path = "C:\Users\yi'da'dui\sdk\go1.24.1\bin;" + $env:Path
$env:GOTOOLCHAIN = 'local'; $env:CGO_ENABLED = '0'

# 先编译一次（首次约 1-2 分钟，下载依赖后很快）
go -C workers/agent build -o artifacts/agent-manual-bin/agent.exe ./cmd/agent
# 预期：无输出即成功

# agent 环境变量（模型指向同一个网关）
$env:AGENT_LISTEN_ADDR = '127.0.0.1:18791'
$env:AGENT_SERVICE_TOKEN = 'manual-local-service-only'
$env:AGENT_DATA_TOKEN = 'manual-local-data-only'
$env:AGENT_DATA_URL = 'http://127.0.0.1:18080/api/internal/agent-data'
$env:AGENT_MODEL_BASE_URL = 'http://127.0.0.1:10100/v1'
$env:AGENT_MODEL_NAME = 'gpt-5.6-luna'
$env:AGENT_MODEL_API_KEY = 'none-needed'
$env:AGENT_SKILLS_DIR = (Resolve-Path workers/agent/skills).Path
$env:AGENT_WORKER_ENABLED = 'false'   # 先 false：阶段二只测同步
$env:AGENT_MCP_CONFIG = ''

# 启动（前台常驻，别关窗口）
artifacts\agent-manual-bin\agent.exe
# 预期：无报错挂起。它监听 127.0.0.1:18791
```

健康检查（**终端 C**，或任意新终端）：

```powershell
curl.exe -s http://127.0.0.1:18791/healthz   # 预期 {"ok":true}
curl.exe -s http://127.0.0.1:18791/readyz    # 预期 {"ok":true}（表示配置+skills 就绪，不请求模型）
```

`readyz` 若返回 `unconfigured` → 检查终端 B 的 `AGENT_MODEL_*` 三个变量是否都在；返回 `skills_unreadable` → `AGENT_SKILLS_DIR` 路径写错。**healthz/readyz 永远不该引起模型调用**（§4 的 T12 会验证这一点）。

### 2.4 切到 Eino 引擎

回到**终端 A**：`Ctrl+C` 停掉 dev，追加环境变量后重启：

```powershell
$env:AI_ENGINE = 'eino'
$env:AGENT_SERVICE_URL = 'http://127.0.0.1:18791'
$env:AGENT_SERVICE_TOKEN = 'manual-local-service-only'
$env:AGENT_DATA_TOKEN = 'manual-local-data-only'
$env:AGENT_MODEL_NAME = 'gpt-5.6-luna'
npm run dev -- --host 127.0.0.1 --port 18080 --strictPort
```

刷新浏览器。「模型设置」页顶部此时应显示「当前使用 Eino；此处配置只作用于同步入口，Eino 仍读取其服务配置」。

环境就绪。接下来按阶段逐项测试。

---

## 3. 阶段二：legacy 同步链路（页面点击，约 30 分钟）

> 测这条链路先把 `AI_ENGINE` 设回 `legacy`（终端 A Ctrl+C → `$env:AI_ENGINE='legacy'` → 重启 dev）。每项都**只点一次按钮**（真实模型调用）。

### T01 网关连通性（不花模型钱）

「模型设置」页 → 档案「本机网关」行 → 点 **测试连接**。

- **预期**：几秒内显示「接口认证成功，模型 ID 已找到。尚未测试生成。」
- 这只调 `GET /v1/models`（`model-config.ts:169`），不产生对话费用。
- 若显示「连接失败」→ §1 第 5/6 步的网关检查重做。
- 若显示「模型列表中未找到此模型 ID」→ 模型名抄错了，回网关模型列表核对完整 ID。

### T02 LLM 分析（A 链路核心）

1. 「内容」页 → 过滤平台 rss → 点开 **MANUAL V3 Battery 主材料**。
2. 右上点 **LLM 分析**。执行中按钮应变为「分析中」且不可再点。
3. 等 30–120 秒，出现「已写入知识层」，分析区显示摘要/主题/实体/洞察。

**判定**：摘要里的数字必须是 **97%、120 片、仅试验线**——模型把「试验线良率」扩大成「量产良率」即为失败。刷新页面结果仍在。

### T03 知识库问答与引用

1. 「知识库」页，输入框（aria-label「向矩阵提问」）输入：`Battery试验线的良率、样本量和适用范围是什么？请引用原文。手测01`。
2. 点 **提问**，等待回答。

**判定**：回答含关键事实（97%/120片/仅试验线）；下方有**引用条目**；点击引用打开真实条目详情；**没有**引用指向不存在的 itemId 或默认 rss 占位。

### T04 无答案问题（防编造）

输入：`zzxyqv-no-answer-314159 的出厂质量数字是多少？只根据已采集材料。`

**判定**：返回「材料不足，没有编造引用。」的明确提示（`knowledge.tsx:157`），不编造事实或引用。库里没有含该随机串的材料。

### T05 今日简报与时间范围

点 **生成今日简报**（执行中显示「正在编报」）。

**判定**：简报引用覆盖 main/second/long（今日材料），**不包含** old（昨日）的 81%。刷新后历史简报仍在。此项在生产环境**从未实测过**（见 `manual-testing-guide.md` §3），测到即补白。

### T06 空正文/未提取材料的拒绝

分别打开 **MANUAL V3 空正文** 和 **MANUAL V3 待OCR**，各点一次 LLM 分析。

**判定**：分别提示无可分析材料/材料未就绪；**不产生**成功分析行，也不该发起模型请求（用 §6 的 Q1 查 `ai_runs`，`model_calls` 应为 0 或无新行）。

### T07 手机视口

浏览器 DevTools（F12）→ 设备模拟 → iPhone 尺寸 390×844 → 刷新知识库。

**判定**：无横向滚动条（`document.documentElement.scrollWidth <= innerWidth`）；提问输入、按钮、引用卡不重叠。

**阶段二通过标准**：T01–T06 全部符合预期。T02–T05 每项恰好 1 次模型调用（§6 Q1 核对 `model_calls`）。

---

## 4. 阶段三：Eino 同步链路（页面点击，约 30 分钟）

> 前置：§2.4 已完成（`AI_ENGINE=eino`，agent 在 18791 跑着，`AGENT_WORKER_ENABLED=false`）。

### T08 Eino 单条分析

重复 T02 的操作（同一条 main 材料）。

**判定**：与 T02 同样的内容判定；但**落库 provider 变了**——§6 Q1 里这一行 `provider` 列应为 `eino`（T02 那行是 `legacy`）。这是「引擎真的切换了」的唯一硬证据。

### T09 Eino 同步问答（工具+Skills 路径）

1. 知识库输入：`Battery试验线良率是多少？请逐条引用原文材料。手测eino01`。
2. 点提问。

**判定**：回答含 97%/120片/仅试验线且带引用；§6 Q1 该 run 的 `tool_calls ≥ 1`（get_item 内部工具被调用），`model_calls` 在 1–6 之间。若 `tool_calls=0`，记「未触发工具」，不能算通过——Eino 的价值就在工具链。

### T10 引用回链（Eino 结果页）

点击 T09 回答中的材料引用。

**判定**：打开真实条目；quote 是材料中**连续原文**（不是模型改写）；标题/来源正确。

### T11 Agent 停机时业务仍可浏览（不静默回退）

1. 终端 B `Ctrl+C` 停掉 agent.exe。
2. 刷新应用 → 内容/知识库/历史问答**仍可读**（浏览不依赖 agent）。
3. 发起一次提问（如 `Battery 停机测试`）。

**判定**：得到明确的**失败/不可用**提示——**绝不**静默回退到 legacy 再调模型（这是设计红线，`agent-client.ts:42`：engine 不是 eino 直接抛 `agent_unconfigured`）。§6 Q1 该 run 应为 `failed`。

4. 重启 agent（终端 B 按原命令再跑一次），**提一个新问题** `Battery 停机后恢复`。

**判定**：新问题成功，provider=eino。旧失败 run 不会自己变成成功。

### T12 健康端点零模型调用

终端 C（agent 运行中）：

```powershell
# 记录当前 run 数
# （用 §6 Q1 的查询记下 ai_runs 总数，或直接看时间戳）
curl.exe -s http://127.0.0.1:18791/healthz
curl.exe -s http://127.0.0.1:18791/readyz
# 再查一次 ai_runs——总数不应变化
```

**判定**：健康检查不产生任何模型调用（省红线，`server.go:54`）。

**阶段三通过标准**：T08–T12 全部符合。此时可进入异步测试：终端 A、B 都 Ctrl+C，两边都加 `$env:AGENT_WORKER_ENABLED='true'`，终端 A 再加 `$env:AGENT_ASYNC_RESEARCH_ENABLED='true'`，各自按原命令重启——知识库会出现**后台研究（刷新后继续）**复选框。异步深测（断网恢复/任务恢复/进程 kill）不在本指南展开，直接做 §5 的 e2e 即可覆盖。

---

## 5. 阶段四：全自动端到端验证（零费用，一条命令）

> **本机已验证前置就绪**：Go 1.24.1 编译通过、`node_modules` 齐全、`postgres:16-alpine` 已拉取、Playwright Chromium 可启动。此命令用**假模型+假 MCP**自动跑完同步问答→工具→Skills→MCP→异步断流→进程 kill 恢复→预算耗尽→引擎回滚全链路，**不花一分钱**，结束后自动清理。

```powershell
cd E:\AI-JIANSHI-20260825\WeaveSense
$env:GOROOT = "C:\Users\yi'da'dui\sdk\go1.24.1"
$env:Path = "C:\Users\yi'da'dui\sdk\go1.24.1\bin;" + $env:Path
$env:GOTOOLCHAIN = 'local'; $env:CGO_ENABLED = '0'
npm run agent:e2e
```

**预期**（全程 5–15 分钟，会自动起 Docker PG + 假模型 + 假 MCP + 应用 + 浏览器）：

1. 末尾打印 JSON，`"ok": true`。
2. `checks` 数组包含这些关键项：
   - `browser synchronous answer persisted`（同步问答落库）
   - `Skill + internal get_item + real fake MCP protocol + authenticated evidence receipt + cited note`（工具链完整走通）
   - `async refresh and committed complete response loss retried without duplicate note`（异步丢响应不重复落库）
   - `real process kill after durable Eino checkpoint; new worker Resume; no repeated model call`（**进程级**检查点恢复——手动极难复现的核心能力）
   - `C02 Eino unavailable: ... no model/fallback/note`（停机不回退）
   - `owned app rollback to legacy cancels unstarted job; claim gate closed`（回滚取消在途任务）
3. 截图生成在 `screenshots/agent-v3-built-desktop.png` / `-mobile.png`。

**判读**：任何 `ok:false` → 看输出里的 `error` 栈；最常见的是端口占用（关掉 18080/18791 的残留进程重跑）和 Go 环境变量没设（§1 的坑）。

---

## 6. 只读证据查询（判定「到底落库没有」）

页面看着成功 ≠ 落库成功。每个阶段测完，在还保留 `$manualContainer` 变量的终端里查：

```powershell
docker exec -it $manualContainer psql -U postgres -d review
```

进入 psql 后逐条执行：

```sql
-- Q1: 最近 30 个 run——provider/model_calls/tool_calls/状态一目了然
select id, mode, provider, status, error_code, model_calls, tool_calls,
       input_tokens, output_tokens, created_at
from ai_runs order by created_at desc limit 30;

-- Q2: 异步任务（同步操作无 job 行）
select id, item_id, run_id, status, error_code, attempts, lease_until, created_at
from ai_jobs order by created_at desc limit 30;

-- Q3: 幂等检查——每个 run 的落库条数（analysis/note 都必须 ≤1）
select r.id, r.mode, r.status,
  (select count(*) from analyses a where a.run_id = r.id) as analysis_count,
  (select count(*) from knowledge_notes n where n.run_id = r.id) as note_count
from ai_runs r order by r.created_at desc limit 30;

-- Q4: 简报的时间范围与选材数
select id, request_json->'range' as range,
  jsonb_array_length(coalesce(request_json->'sources','[]'::jsonb)) as source_count,
  skill_versions
from ai_runs order by created_at desc limit 30;

-- Q5: 真实调用收据（Eino 链路才有）
select run_id, call_id, model, state, input_tokens, output_tokens
from ai_model_calls order by started_at desc limit 50;

-- Q6: 预算账本（AUTO_ANALYZE 关闭时应无自动条目）
select job_id, day, price_version, status, reserved_rmb, actual_rmb
from ai_budget_reservations order by created_at desc limit 50;
```

查完 `\q` 退出。**注意**：查询结果里可能出现 token 类字段，截图/外发前先脱敏。

**快速判读**：
- 页面成功但 Q1 无新行 → 落库失败，记「页面通过/落库失败」。
- `analysis_count` 或 `note_count` 出现 2 → 重复落库，bug。
- T11 的失败 run `error_code` 应是 `agent_unavailable` 或类似明确码，不是笼统 `failed`。

---

## 7. 排障速查

| 现象 | 先查 | 解法 |
|---|---|---|
| 分析/问答报连接失败 | `ocx health` | 网关停了：`ocx start`（独立窗口跑）；重启电脑后需手动起（未装持久服务，见 `local-model-gateway.md` §3） |
| `ocx status` 说 running 但端口无监听 | `curl 127.0.0.1:10100/healthz` | 以 netstat+healthz 为准，`ocx.pid` 可能是陈旧记录 |
| Go 编译报 version mismatch | `go version` 输出 | §1 的 GOROOT 坑：GOROOT 必须指向 sdk\go1.24.1 |
| agent readyz 返回 unconfigured | 终端 B 环境变量 | `AGENT_MODEL_BASE_URL/NAME/API_KEY` + `AGENT_SERVICE_TOKEN` 四个都要非空（`config.go:57`） |
| dev 起不来 / 8080 被占 | 本指南用 18080/18791 | 别用默认 8080（生产端口约定）；`--strictPort` 报错就是占用 |
| e2e 超时 app render | 90 秒窗口 | 首次 Vite 冷启动慢，重跑一次；仍失败查 `validation/agent/implementation-v3-2026-09-08/harness-built.json` |
| psql 中文乱码 | heredoc 是否整段复制 | 整段一次粘贴；确认 `$OutputEncoding` 那行执行过 |

---

## 8. 测完清理

```powershell
# 1. 停进程：终端 A、B 各 Ctrl+C（dev 与 agent.exe）

# 2. 删隔离库（先核对名字确实是本轮建的 manual 容器，别按端口盲删）
docker inspect $manualContainer --format '{{.Name}} {{index .Config.Labels "loom.agent.validation"}}'
# 预期：/loom-agent-manual-… manual
docker rm --force $manualContainer

# 3. 删一次性配置与测试二进制
Remove-Item config/model.manual-test.local.json
Remove-Item -Recurse -Force artifacts/agent-manual-bin

# 4. 证据（可选保留）：screenshots/agent-v3-*.png、§6 查询输出
```

`npm run agent:e2e` 自己建的容器自己删，无需手动。**不要**动 `weave-collection-ui-9faa-1004`、`grok2api`、`workbuddy2api` 等无关容器。

---

## 9. 记录模板（每轮复制一份）

```text
用例：T__
状态：通过 / 失败 / 阻塞 / 未测
环境：dev；engine=legacy/eino；模型=gpt-5.6-luna（网关10100）
时间：
输入与操作（顺序很重要）：
预期：
实际：
run_id（§6 Q1 可查）：
页面截图 / 命令输出：
模型调用次数 / token 用量（Q1/Q5）：
能否重现：
```

失败时保留原记录，修复后**另记一条**复测结果，不把失败改成通过。

---

## 10. 边界与跳转

| 本指南没覆盖 | 去哪测 |
|---|---|
| 并发竞争 / 幂等重放 / 预算守恒 / 双 complete（B01–B12） | [2026-09-08-eino-agent-manual-test-guide.md](2026-09-08-eino-agent-manual-test-guide.md) §4 |
| MCP 真实第三方工具、真实供应商计费对账（C05） | 同上 §5；需要已授权的 MCP 服务与额度 |
| 自动分析准入与日预算（C03） | 同上 §5 C03；只在隔离库做 |
| 采集平台（RSS/Telegram/B站/微信） | `manual-testing-guide.md` §2–§4 |
| 网关运维（持久服务安装、provider 切换） | `local-model-gateway.md` §4–§7 |
| 单元测试全量回归 | `npm test` / `npm run agent:go` / `npm run typecheck` / `npm run lint`（组合命令 `npm run test:all`） |

**一句话总结**：§1 查环境 → §2 建隔离栈 → §3 点 legacy → §4 点 eino → §5 一条命令全链路零费用验收 → §6 用 SQL 收证据。
