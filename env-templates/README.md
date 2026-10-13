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
#    写进项目根 .env（gitignored）——compose 用 ${TELEGRAM_API_ID:-} 插值读取：
#    TELEGRAM_API_ID=...
#    TELEGRAM_API_HASH=...

# 4. 模型配置目录（LLM 分析用，可后补）
#    compose 挂载 F:/loom-backups/model-config -> /app/config。
#    最小内容是一份 model.local.json（含 baseURL/model/apiKey）。

# 5. 首次登录 Telegram 会话（之后写在 telethon-session volume，无需重复）
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
| | `MINIO_ACCESS_KEY/SECRET_KEY` | 是 | 与 minio.env 的 ROOT_USER/PASSWORD 一致 |
| | `MINIO_BUCKET` / `MINIO_PUBLIC_URL` | 是 | `loom` / `http://127.0.0.1:9000/loom` |
| | `CRON_SECRET` | 是 | `<GEN>`；app 与 scheduler.env 必须相同 |
| | `WECHAT_GATEWAY_TOKEN` | 是 | `<GEN>`；与 wechat-gateway.env 相同 |
| `scheduler.env` | `CRON_SECRET` | 是 | 与 app.env 相同 |
| `telethon.env` | `MINIO_ACCESS_KEY/SECRET_KEY/BUCKET/PUBLIC_URL` | 是 | 与 app.env 一致（媒体上传用） |
| `wechat-gateway.env` | `WECHAT_GATEWAY_TOKEN` | 是 | 与 app.env 相同 |
| | `WECHAT_PRIMARY_ALLOWED_HOSTS` | 是 | 可信主源域名（不含协议/端口，逗号分隔）。本机 wewe-rss 部署填 `host.docker.internal`；自建 RSSHub 填其域名 |
| 根 `.env`（模板 `.env.example`） | `TELEGRAM_API_ID/HASH` | 生产是 | Telegram 采集；不填则公开频道回退 t.me/s |

可选（写入 wechat-gateway 的 `environment` 或用 compose 默认）：
`DAJIALA_KEY`/`DAJIALA_VERIFYCODE`（极致了付费兜底）、`DAJIALA_DAILY_BUDGET_RMB`、
`DAJIALA_DAILY_CALL_LIMIT`、`XAI_API_KEY`（OCR/ASR）、`AI_ENGINE`。

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

## 公开文章读取开关与验收（2026-10-13）

`app.env` 已有两个非敏感设置，公开模板默认值如下：

```text
ARTICLE_READER_ENABLED=false
ARTICLE_READER_ALLOWED_HOSTS=
```

只允许显式开启后读取确切 HTTPS hostname 名单内的公开文章，不支持通配符、query/hash、凭据、非默认端口或微信原文。当前 20 条样本属于待验参考，**经实际候选正文比对通过的 hostname 名单仍为 `[]`**；保留关闭与空名单，不把参考样本域名复制成已支持名单。现有共享通道的匿名 Jina 401 与非公网 DNS 证据见[正文验收](../docs/operations/collection-capability-acceptance.md#b01b04-article-enrichment-scope-2026-10-13)。不为此添加 Key/Cookie、放开 SSRF 防护或重复二十次同样的失败。

关闭开关只禁止新读取；已完成候选、已采用正文、快照和受材料版本保护的恢复继续可用。普通采集独立于 reader，回退不能重置游标、删条目或覆盖后续 OCR / ASR。全局单请求限制是每个应用进程的并发保护，不是每日付费预算硬上限；第三方费用仍需独立确认。Hosted Jina 下游导航不属于本机 DNS pinning 边界，隔离自托管仅属于 C04 的另行试验门。

可移植最小权限检查现在只读本目录公开模板及 Compose，按 `write-service-envs.mjs` 的 `SERVICE_VARS` 严格核对凭据名称；app 另外只允许上述两个非敏感设置，且要求默认关闭/名单为空。缺失模板或额外变量都会失败。检查不再打开 `F:/loom-backups/env/*.env`，不能用它宣称已检查生产凭据库存。已有生成器仍只拆分凭据，reader 非敏感设置需单独保留在 app 配置中；该生成器 CLI 会读取真实凭据源，不能拿来执行离线验收。

OpenCode 现行硬件合同仍是 `pids_limit: 512`、`mem_limit: 768m`；Bun 启动/迁移线程令旧 64 限制不稳定。守护检查精确核对四个任务运行时变量：`OPENCODE_RUNTIME_TOKEN`、`OPENCODE_BRIDGE_URL`、`OPENCODE_MODEL_NAME`、`OPENCODE_MAX_OUTPUT_TOKENS`，以及后者来自 `AGENT_ASSISTANT_MAX_OUTPUT_TOKENS`、默认 `1800` 的配置。供应商密钥、DB 凭据、共享 env 文件、对外端口等原有拒绝检查继续保留；没有为了通过旧断言修改实际 Compose。

从仓库根运行以下独立检查；均默认不联网：

```powershell
node scripts/readiness-offline.mjs -- node --test scripts/service-env-least-privilege.test.mjs
node scripts/readiness-offline.mjs -- node validation/collection/article-reader-validation.mjs --self-check
node scripts/readiness-offline.mjs -- node validation/collection/article-reader-validation.mjs
```

样本验证入口默认给出 20 条未尝试/未知记录。只有网络已恢复为符合安全策略的公开解析、匿名通道可用后，才显式使用 `--run --network-changed` 做有限实际读取。仅 `--run` 会拒绝且不发请求。实际结果仍需要人工核对标题、域名、原文首尾和三处中间事实；改写参考摘要不等于逐字标记，完整性未知不得计入完整率。新入口详见上述正文验收文档，不改变生产配置或发布状态。
