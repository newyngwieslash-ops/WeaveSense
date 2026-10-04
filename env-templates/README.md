# 环境文件模板 — 新机器部署用

生产凭据按服务拆分放在**工作树外**的 `F:/loom-backups/env/`（不入 git）。
本目录提供同名模板：新机器上把 `env-templates/` 下的文件**复制**到
docker-compose.yml `env_file` 指向的目录（可改 `F:/loom-backups/env/`，
或改 compose 里的路径），填入真实值即可 `docker compose up --build`。

> 为什么不放 `.env`：compose 的 `env_file` 与 `${VAR}` 插值互不读取；
> 命令行传密钥是历史事故路径（T24）。这套拆分文件是安全基线，保持不变。

## 快速步骤（Windows Git Bash / PowerShell 均可）

```bash
# 1. 复制模板到 compose 期望的位置（默认 F:/loom-backups/env/）
mkdir -p /f/loom-backups/env
cp env-templates/*.env /f/loom-backups/env/

# 2. 为每个文件生成/填入密钥（见下表；<GEN> = openssl rand -hex 32 之类）
#    postgres.env / minio.env / minio-init.env 的密码三处必须一致联动：
#    DATABASE_URL 里的密码 = postgres.env 的 POSTGRES_PASSWORD
#    MINIO_ACCESS_KEY = minio.env 的 MINIO_ROOT_USER
#    MINIO_SECRET_KEY = minio.env 的 MINIO_ROOT_PASSWORD

# 3. Telegram：到 https://my.telegram.org 申请 api_id / api_hash，
#    只写进工作树外的 telethon.env（不要重复写进 Compose environment）：
#    TELEGRAM_API_ID=...
#    TELEGRAM_API_HASH=...

# 4. 模型配置目录（LLM 分析用，可后补）
#    compose 挂载 F:/loom-backups/model-config -> /app/config。
#    最小内容是一份 model.local.json（含 baseURL/model/apiKey）。

# 5. 仅在需要 Telegram 工作器且凭据已填写时，主动完成首次登录。
#    会话写在 telethon-session volume，无需重复；预检不会发起登录。
docker compose run --rm -it telethon python login.py

# 6. 起全栈
docker compose up --build
```

## 文件与变量对照

| 文件 | 变量 | 必填 | 说明 |
|---|---|---|---|
| `postgres.env` | `POSTGRES_USER/PASSWORD/DB` | 是 | 自定；建议全用 `loom` + 强密码 |
| `minio.env` | `MINIO_ROOT_USER/PASSWORD` | 是 | 自定强密码 |
| `minio-init.env` | `MINIO_ROOT_USER/PASSWORD` + `MINIO_BUCKET` | 是 | 与 minio.env 一致；bucket 建议 `loom` |
| `app.env` | `DATABASE_URL` | 是 | `postgres://<user>:<pwd>@postgres:5432/<db>`，密码与 postgres.env 一致 |
| | `MINIO_ACCESS_KEY/SECRET_KEY` | 媒体上传需要 | 与 minio.env 的 ROOT_USER/PASSWORD 一致；缺失不影响文本采集 |
| | `MINIO_BUCKET` / `MINIO_PUBLIC_URL` | 媒体需要 | `loom` / `http://127.0.0.1:9000/loom` |
| | `CRON_SECRET` | 自动调度需要 | `<GEN>`；app 与 scheduler.env 必须相同；缺失不禁用手动文本阅读 |
| | `WECHAT_GATEWAY_TOKEN` | 微信接入需要 | `<GEN>`；与 wechat-gateway.env 相同 |
| | `XAI_API_KEY` | 否 | OCR/ASR；缺失只关闭此供应商能力，模型档案另行配置 |
| `scheduler.env` | `CRON_SECRET` | 是 | 与 app.env 相同 |
| `telethon.env` | `MINIO_ACCESS_KEY/SECRET_KEY/BUCKET/PUBLIC_URL` | 媒体上传需要 | 与 app.env 一致 |
| | `TELEGRAM_API_ID/HASH` | 工作器需要 | 凭据存在不代表会话已登录；缺失仍可使用公开频道回退 |
| | `TELEGRAM_SESSION` | 否 | 可选字符串会话；默认使用 volume 内 `/data/loom.session` |
| | `TELETHON_CONCURRENCY` | 否 | 默认 `3`，按服务文件配置 |
| `wechat-gateway.env` | `WECHAT_GATEWAY_TOKEN` | 是 | 与 app.env 相同 |
| | `WECHAT_PRIMARY_ALLOWED_HOSTS` | 是 | 可信主源域名（不含协议/端口，逗号分隔）。本机 wewe-rss 部署填 `host.docker.internal`；自建 RSSHub 填其域名 |
| | `DAJIALA_KEY/VERIFYCODE` | 否 | 付费兜底只从此服务文件读取；密钥缺失关闭付费兜底 |
| | `DAJIALA_BASE_URL/DAILY_BUDGET_RMB/DAILY_CALL_LIMIT` | 否 | 保留供应商默认地址、每日预算与调用硬上限，可在此文件覆盖 |
| | `DAJIALA_LIST_COST_RMB/DETAIL_COST_RMB` | 付费调用需要 | 经核实的每次费用上界；留空时拒绝付费调用，不猜价格 |

凭据的唯一来源是对应的服务文件：`TELEGRAM_*` → `telethon.env`，
`DAJIALA_*` → `wechat-gateway.env`，`XAI_API_KEY` → `app.env`。
不要在 `environment` 中再次声明这些字段，空插值与默认值都会覆盖 `env_file`。
可选 agent profile 保持单独显式配置：启用时需要自己的 `AGENT_MODEL_API_KEY`，
不再隐式借用 `XAI_API_KEY`。

若从组合来源生成文件，`node scripts/write-service-envs.mjs --check` 只打印变量名，
不打印值、不写文件；不带 `--check` 才写入。缺失 Telegram/付费/xAI 变量会被省略，
不会阻止生成。当前 Compose 默认启用 Postgres、MinIO、微信网关与调度器，因此
生成器继续要求它们的基础凭据；尤其不能生成缺失 MinIO ROOT 凭据的文件，避免使用
服务默认账号。生产 app 只依赖数据库健康，其他能力通过独立诊断判断。

## 接入预检

默认不连接任何服务、不读取凭据文件、不登录、不采集；输出仅含 `code/ready`。
使用 Node 自带 `--env-file` 显式加载运维选定的文件，或在相应容器环境运行：

```bash
node --experimental-strip-types scripts/collection-preflight.mjs
# 显式在线诊断：仅固定健康端点，各请求最多 3 秒、响应最多 16 KiB、禁止重定向。
node --experimental-strip-types scripts/collection-preflight.mjs --probe-workers
# 显式出口诊断：仅请求固定 example.com，复用公共 URL/DNS 固定/SSRF/体积限制。
node --experimental-strip-types scripts/collection-preflight.mjs --probe-egress
```

检查范围以进程实际注入的变量为准：app 不应持有 Telegram/付费供应商凭据；
其结果中对应的凭据行缺失不代表 worker 文件也缺失。Telegram 的
`telegram_credentials` 仅代表字段存在，`telegram_session` 仅代表字符串会话或
指定会话文件存在；`telegram_worker_endpoint` 仅代表地址配置有效。
只有显式 probe 的 `telegram_worker_connectivity` 和 `telegram_session_authorized`
才报告当前健康端点状态；连接失败时输出 `telegram_session_authorization_unchecked`。
微信 probe 只调用 `/v1/health`，不会访问 feed、ACK、对账或付费 API。
数据库与 MinIO 行是配置检查，不宣称数据库鉴权、桶权限或上游采集已经成功。
`collection_egress_policy` 检查声明范围是否可被现有安全策略接受，未声明表示默认
公共出口策略；只有显式出口 probe 才报告该固定目标的当前连接结果。
默认退出码仅因数据库配置缺失而失败；显式在线 probe 失败也返回非零。

## 网络出口注意（2026-09-30 事故教训）

应用容器出网走宿主机出口。若宿主机挂着 Clash 类代理：

- **global 模式会旁路全部规则**，所有流量走 GLOBAL 单节点；节点失效时
  大量信源同时 `ECONNRESET`（看起来像应用故障，实际是代理层）。
- 规则模式（rule）下"全球直连"名单里的国内站不依赖节点，更稳。
- 排障顺序见
  [docs/operations/loom-source-errors-fix-2026-09-30.md](../docs/operations/loom-source-errors-fix-2026-09-30.md)。

## 数据迁移（可选：把现有数据带到新机器）

旧机器上导出：

```bash
# Postgres
docker exec <旧postgres容器> pg_dump -U loom -d loom > loom.dump
# 微信网关 SQLite
docker cp <旧gateway容器>:/data/wechat-gateway.sqlite ./gateway.sqlite
```

新机器上导入：`psql -f loom.dump`；gateway.sqlite 放回 named volume
`<project>_wechat-gateway-data/_data/`。不迁移则从空库开始，功能不受影响。
