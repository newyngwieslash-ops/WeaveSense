# 织识 Loom

行业媒体矩阵采集与知识引擎。订阅 Telegram / 微信公众号 / B 站 / 抖音 / 小红书 / YouTube / 西瓜 / RSS，按 5 / 10 / 30 分钟做**增量**扫描，只入库新消息；支持用户自设关键词雷达；文本、作者、时间、浏览量、媒体 URL 归一化进 PostgreSQL，再交给 LLM 做分析、简报和问答。

**最新完整版说明书：** 应用内「指南」页，或 [`docs/使用指南.md`](docs/使用指南.md)（v1.3）。产品规格在「规格」页。

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

Compose 的 `scheduler` 会在浏览器关闭后继续按默认 30 分钟间隔调用受保护的定时入口，并等应用健康后才发起首轮。调度器也保持单副本，不要用 `--scale scheduler=...` 扩容；每轮服务端工作预算为 10 分钟，循环只在剩余预算足够覆盖下一项最坏外部超时时才启动，未执行项保留到下轮。发布时先停调度器，等待当前 JSON 结果（客户端最多 10 分 30 秒）后再重启应用与网关，最后启动调度器。

付费兜底默认每日 20 RMB 是硬上限，不是费用预测。按[极致了接口价格页](https://www.dajiala.com/main/interface?actnav=0)，列表查询约 0.06–0.08 RMB/信源调用，正文详情约 0.045 RMB/新文章；实际用量取决于主源失败率和新文章数。

迁移：`migrations/0002_schema.sql`、`0003_keywords.sql`、`0004_production.sql`、`0005_scheduler_leases.sql`、`0006_reconciliation_queue.sql`。

## 产品怎么用

详见 [`docs/使用指南.md`](docs/使用指南.md)。摘要：

- **总览**：扫描到期；页面可见时约每 2 分钟再 tick。
- **信源**：RSS / Telegram（可批量 1000 频道）/ WeWe / B 站 / YouTube。
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
