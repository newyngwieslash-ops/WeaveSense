# 织识 Loom

> 当前支持范围、剩余验收与版本以[统一交付状态](docs/operations/loom-current-status.md)为准。Telegram 公开频道走 Telethon 增量（未登录才回退网页预览）；怎么加频道见[使用指南 §3.2](docs/使用指南.md#32-telegram-公开频道怎么加)。下载源码包不代表本次文档已重新打包。

行业媒体矩阵采集与知识引擎。订阅 Telegram / 微信公众号 / B 站 / 抖音 / 小红书 / YouTube / 西瓜 / RSS，按 5 / 10 / 30 分钟做**增量**扫描，只入库新消息；支持用户自设关键词雷达；文本、作者、时间、浏览量、媒体 URL 归一化进 PostgreSQL，再交给 LLM 做分析、简报和问答。

**最新完整版说明书：** 应用内「指南」页，或 [`docs/使用指南.md`](docs/使用指南.md)（v1.5）。产品规格在「规格」页。

## 从 GitHub 克隆并运行（新机器）

```bash
git clone https://github.com/newyngwieslash-ops/WeaveSense.git loom
cd loom
# 凭据：按 env-templates/README.md 复制模板到 F:/loom-backups/env/（或改
# docker-compose.yml 里的 env_file 路径指向你的位置）并填值；Telegram 的
# api_id/api_hash 写进项目根 .env（模板 env.example）
npm install                      # 仅本地开发需要；纯 Docker 部署可跳过
docker compose run --rm -it telethon python login.py   # 首次登录（可选）
docker compose up --build
```

浏览器打开 `http://127.0.0.1:8080`。完整变量说明与数据迁移见
[`env-templates/README.md`](env-templates/README.md)。LLM 分析还需挂载
模型配置目录（compose 默认 `F:/loom-backups/model-config`，含
`model.local.json`，结构见 `docs/operations/local-model-gateway.md`）——
没有它应用照常跑，只是分析/简报功能不可用。

## 下载最新完整版

这个 zip 就是当前可运行的完整源码（不含 `node_modules`）：

- 预览「指南」页右上角 **下载完整版**
- 或包内同名文件 `zhishi-loom-source.zip`（打包时生成到 `public/`）

解压后目录名为 `zhishi-loom`。需要 Node.js **22** 与 npm。生产扫 Telegram 请用 Docker。

```bash
unzip zhishi-loom-source.zip
cd zhishi-loom
npm install
npm run dev          # 本地开发，没有 Postgres 时用内嵌库
# 或
docker compose run --rm -it telethon python login.py
docker compose up --build
```

## 这是什么

不是「一个全能爬虫」。各平台反爬、许可和接口完全不同。织识是统一控制平面：

```
信源 / 关键词
    ↓  到期 tick（游标 last_external_id）
RSS · Telethon GetHistory / t.me/s · API/SDK · 浏览器适配器
    ↓
归一化 items
    ↓
PostgreSQL + MinIO
    ↓
ASR / OCR · LLM
    ↓
行业知识库
```

预览对公开 RSS 与 Telegram 网页预览做实采；Docker 生产栈接入 Telethon、MinIO、Grok OCR/ASR。风控平台保留适配器，填入 WeWe RSS / RSSHub 即走同一管道。

## 本地开发

```bash
unzip zhishi-loom-source.zip
cd zhishi-loom
npm install
npm run dev
```

首次打开总览会写入示例信源并扫描到期任务。没有 Postgres 时用内嵌 PGLite。

### 环境变量

不要把密钥提交进仓库。本仓库**没有** `.env` 文件，模板见 `env.example`。

| 变量 | 必需 | 作用 |
| --- | --- | --- |
| `DATABASE_URL` | Docker 下是 | Postgres。未设置时用内嵌 PGLite。 |
| `XAI_API_KEY` | 否 | LLM 分析、简报、问答、OCR、ASR。 |
| `TELEGRAM_WORKER_URL` | Docker 下是 | Telethon 节点，例如 `http://telethon:8787`。 |
| `MINIO_ENDPOINT` | Docker 下是 | MinIO / S3 兼容地址。 |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 配 MinIO 时 | 对象存储凭证。 |
| `WECHAT_GATEWAY_URL` | 非 Compose 必填 | 微信源网关地址；Compose 默认使用内部地址。 |
| `WECHAT_GATEWAY_TOKEN` | 是 | 应用与微信源网关共享的 Bearer 密钥。 |
| `WECHAT_PRIMARY_ALLOWED_HOSTS` | 是 | 可信 WeWe / RSSHub 主源域名白名单，逗号分隔。 |
| `CRON_SECRET` | Compose 下是 | 应用与常驻调度器共享的 Bearer 密钥。 |
| `CRON_INTERVAL_MS` / `CRON_TICK_LIMIT` | 否 | 常驻调度间隔（默认 30 分钟）与每轮上限（默认 200）。 |
| `DAJIALA_KEY` / `DAJIALA_VERIFYCODE` | 否 | 极致了付费兜底凭证；均为空时保持纯主源模式。 |
| `DAJIALA_DAILY_BUDGET_RMB` | 否 | 付费兜底每日硬上限，默认 20 RMB。 |
| `TICK_LIMIT` | 否 | 每轮扫描到期信源数，默认 5，Docker 建议 20。 |
| `EXTRACT_AUTO` | 否 | `true` 才在扫描时自动 OCR/ASR。 |
| `AI_ENGINE` | 否 | `legacy`（默认）或 `eino`。未显式切换时不调用 Go 分析服务。 |
| `AGENT_SERVICE_URL` / `AGENT_SERVICE_TOKEN` | eino 时 | 内部分析服务地址与独立服务凭证。 |
| `AGENT_DATA_TOKEN` | eino 研究问答时 | 内部只读数据 API 凭证，与执行 token 分离。 |
| `VITE_AUTH_ENABLED` | 已关闭 | 本产品无登录。见 `.grok/app-env.json`。 |

## Docker 生产

到 [my.telegram.org](https://my.telegram.org) 申请 `api_id` / `api_hash`。

```bash
export TELEGRAM_API_ID=...
export TELEGRAM_API_HASH=...
export XAI_API_KEY=...          # OCR / ASR / LLM
export WECHAT_GATEWAY_TOKEN=... # 必填，使用高强度随机密钥
export WECHAT_PRIMARY_ALLOWED_HOSTS=feeds.example.com,rsshub.example.com
export CRON_SECRET=...          # 必填，使用另一枚高强度随机密钥

docker compose run --rm -it telethon python login.py
docker compose up --build
```

- Postgres：元数据与游标
- MinIO：API 9000，控制台 9001
- Telethon：`GetHistory` 增量，FloodWait 自动推迟
- 控制面：对外 8080

登录一次后会话写在 `telethon-session` volume。未登录时 Telegram 信源回退 `t.me/s`。

### 微信公众号源网关

微信公众号通过带 Bearer 鉴权的源网关接入；已配置的 WeWe / RSSHub 兼容订阅仍是主数据源。启动前必须设置 `WECHAT_GATEWAY_TOKEN`，并把可信主源域名（不含协议和端口、多个用逗号分隔）写入 `WECHAT_PRIMARY_ALLOWED_HOSTS`。Compose 默认使用内部地址 `http://wechat-gateway:8790`；非 Compose 部署还必须显式设置 `WECHAT_GATEWAY_URL`。密钥只放运行环境，不提交到仓库；`qa` profile 中的 `wechat-fixture` 仅用于确定性验收，正常生产栈不会启动它。

微信源网关当前只支持生产单副本，禁止使用 `docker compose up --scale wechat-gateway=...` 扩容；同源互斥由进程内锁保证。进程若在付费供应商调用中崩溃，SQLite 会保留保守的预算预留，恢复后应检查当天用量；该策略可能高计，但不会低计费用。

#### CSV 批量导入公众号

在「信源 → 接入 → 微信公众号 → CSV 批量」中上传 `.csv` 或直接粘贴内容。表头必须完全一致：

```csv
name,wechat_id,sample_url,primary_feed_url,interval_minutes,priority
示例科技,gh_example,https://mp.weixin.qq.com/s/example,https://feeds.example.com/example.atom,60,normal
```

示例均为虚构数据，不包含真实账号或凭证。文件使用 UTF-8；支持 BOM、CRLF、带逗号的引号字段和双引号转义。`name`、`wechat_id`、`sample_url`、`primary_feed_url` 必填；样例链接必须是无账号密码的 `https://mp.weixin.qq.com` 原文链接，主源必须是无账号密码的 HTTP/HTTPS URL。`interval_minutes` 固定为 `60`；`priority` 留空时按 `normal`，也可填写 `high`。文件内重复或数据库中已存在的 `wechat_id` 会标记为重复。

单个文件不超过 1 MiB、最多 1000 条数据行；系统保证 500 条合法数据可在一次预览中完整校验。预览不会写入数据，只有勾选有效行并确认后才开始导入。每行都先幂等配置微信源网关，网关返回成功后才写入 Loom 数据库；单行失败不阻断后续行，使用确定性信源 ID 重试不会产生新的映射。

Compose 的 `scheduler` 会在浏览器关闭后继续按默认 30 分钟间隔调用受保护的定时入口，并等应用健康后才发起首轮。调度器也保持单副本，不要用 `--scale scheduler=...` 扩容；每轮服务端工作预算为 12 分钟，循环只在剩余预算足够覆盖下一项最坏外部超时时才启动，未执行项保留到下轮。发布时先停调度器，等待当前 JSON 结果（客户端最多 12 分 30 秒）后再重启应用与网关，最后启动调度器。

网关把付费对账成功来源写入 SQLite outbox；应用先用一条 PostgreSQL 语句幂等写入重扫队列，成功后才 ACK。ACK 前中断会在下轮安全重放。付费正文因期限或临时错误未补齐时也会持久排队，技术错误按 5/15/60 分钟再按小时退避，映射错误不自动重试；后续重扫会更新同一文章而不是生成重复项。OCR/ASR 按最多四个媒体目标分别记终态，空文本也算成功；每四个半小时轮次安排三轮 9 路固定并发采集和一轮完整提取，对账重扫固定 2 路并发，最坏一轮预算为 680 秒，100 个到期信源可在两小时容量窗口内处理。失败目标最多重试三次且不会重复调用已成功目标。

付费兜底默认每日 20 RMB 是硬上限，不是费用预测。按[极致了接口价格页](https://www.dajiala.com/main/interface?actnav=0)，列表查询约 0.06–0.08 RMB/信源调用，正文详情约 0.045 RMB/新文章；实际用量取决于主源失败率和新文章数。

迁移：`migrations/0002_schema.sql`、`0003_keywords.sql`、`0004_production.sql`、`0005_scheduler_leases.sql`、`0006_reconciliation_queue.sql`、`0007_extract_target_state.sql`、`0008_reconciliation_queue_retry.sql`、`0009_extract_claim_fencing.sql`。后续迁移从 `0010` 开始。

## 产品怎么用

详见 [`docs/使用指南.md`](docs/使用指南.md)。摘要：

- **总览**：扫描到期；页面可见时约每 2 分钟再 tick。
- **信源**：RSS / Telegram（用户名或 `t.me/用户名`，可批量 1000）/ WeWe / B 站 / YouTube。Telegram 步骤见[使用指南 §3.2](docs/使用指南.md#32-telegram-公开频道怎么加)。
- **关键词**：一个词一条监听器。立即收集 / 暂停 / 移除。
- **内容**：过滤、OCR/ASR、LLM 分析。
- **节点**：看 Telethon / MinIO / ASR 是否在线，批量落盘。
- **知识库**：简报与问答，只引用已采集材料。

## 目录

```
src/routes/            页面
src/lib/server/        采集、调度、MinIO、Telethon 客户端、LLM
workers/telethon/      Python GetHistory 节点
migrations/            Postgres / PGLite schema
docker-compose.yml     生产栈
docs/使用指南.md
```

## 许可与合规

核心代码与优先依赖：MIT / Apache-2.0 / BSD / Unlicense。商业化还需核对运行时依赖、浏览器自动化、FFmpeg、第三方 API 和平台条款。只采集你有权访问的公开源；不要把 Cookie、Telethon 会话或个人数据写入无账号数据库。

## 技术栈

TanStack Start · React 19 · Tailwind v4 · PostgreSQL / PGLite · MinIO · Telethon · xAI Grok（可选）
