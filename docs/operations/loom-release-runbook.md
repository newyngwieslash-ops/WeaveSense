# 织识 Loom 正式发布运行手册（T24 / Gate D）

日期：2026-09-17。**状态：待用户逐条批准后执行。**

---

## 0. 当前状况（预检实测）

| 项 | 实测 |
|---|---|
| 生产构建源 | **根目录 `R`**（`docker-compose.yml` 的 `build: .` 指 R），镜像构建于 **2026-09-09** |
| 本批修复位置 | **工作树 `B`**（`.worktrees/local-model-settings`），**112 个 src 文件与 R 不同** |
| git 血统 | `76b6da1` 分叉为 R 的 `db99bb1` 与 B 的 `58aa85f`；Go agent 代码与 0014/0020 迁移**内容相同** |
| 生产数据库 | 已应用 `0021`（20/20），但**仍跑旧代码**，未使用 `stage_windows` |
| **生产容器 DNS** | 公网域名解析到 **`198.18.0.x`**（fake-IP 代理） |
| 生产容器直连外网 | ✅ 可用（实测 `ifanr.com` HTTP 200） |
| 回滚镜像 | app `5c386de1a3a3`、scheduler `cea7e671ca0a`、wechat-gateway `a7a4d4d196c6` |

## 1. ⚠️ 阻断性风险（必须先解决）

**本批 T05 引入了 SSRF 防护：默认拒绝 `198.18.0.0/15`。**
而生产容器的 DNS 恰好把公网域名解析到该网段。

**若直接部署新代码而不配置出口声明，生产采集会全部失败**（`blocked_address`）。

**解决**：部署新代码时**必须同时**设置环境变量：

```
LOOM_EGRESS_CIDRS=198.18.0.0/15
```

该变量的语义（已在 T21 实现并测试，26 项通过）：
- 默认关闭：不设置时行为与旧代码一致（该网段被拒）
- 仅声明的网段放行；loopback / 元数据 / 多播**永不放行**

**验证方式**：切换后立即做一次采集，确认不再是 `blocked_address`。

## 2. 发布方案（推荐：B 构建，不动 R）

### 2.1 为什么不覆盖根目录 R

R 有独立提交 `db99bb1`（agent validation + handoff，158 文件）。把 B 整树覆盖 R
会丢掉这份历史，且计划明令禁止"整树覆盖"。

### 2.2 方案：用 B 作为构建上下文，产出新镜像

```bash
cd F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/.worktrees/local-model-settings
docker build -t loom-app:readiness-20260917 .
```

然后让 compose 用该镜像（`image: loom-app:readiness-20260917` 覆盖 `build:`），
**不修改 R 的源码树**。

### 2.3 切换前的兼容性演练（必做）

1. 用**最新的生产备份**恢复一个隔离库（已验证可行）
2. 用新镜像连接该隔离库启动
3. 验证：页面可加载、采集可用（含 `LOOM_EGRESS_CIDRS`）、旧数据可读、
   新表 `stage_windows` 被新调度使用
4. 演练失败 → **不动生产**

### 2.4 切换步骤（待批）

| 步 | 操作 | 说明 |
|---|---|---|
| 1 | 记录回滚点 | 镜像 ID + 一份新备份 |
| 2 | 停 `scheduler` | 停止发起采集（避免切换期间半写） |
| 3 | 重建并替换 `app` | 新镜像 + `LOOM_EGRESS_CIDRS` |
| 4 | 验证 app | 页面 200、库可读、采集可用 |
| 5 | 替换 `scheduler` | 同样加 `LOOM_EGRESS_CIDRS` |
| 6 | 观察一轮窗口 | 确认 `stage_windows` 有记录、无异常错误 |

**预计中断**：app/scheduler 各重启约 10—30 秒；采集在调度停止期间暂停（可接受）。

### 2.5 回滚（任一步失败）

```bash
docker tag <回滚镜像ID> gig5cyrba5yn3tsi-grok-workspace-app:latest
docker compose up -d app scheduler
```
数据库无需回滚（`0021` 只加表；如需彻底回退见 runbook 末节）。

## 3. 需要用户确认的清单

- [ ] **构建源**：确认用工作树 B 构建（不动根目录 R）
- [ ] **LOOM_EGRESS_CIDRS=198.18.0.0/15**：确认接受该出口声明（否则采集不可用）
- [ ] **停写窗口**：是否指定（技术上仅需 10—30 秒重启，可不专门安排）
- [ ] **切换批准**：是否执行
- [ ] **其他服务**：`wechat-gateway`、`telethon`、`agent` 是否一并更新（它们也有本批改动）

## 4. 明确不在本手册范围

- 不重建数据库、不动数据卷
- 不启用 `AUTO_ANALYZE` / OCR 自动提取 / 付费兜底
- 不恢复微信试点
- 不处理 `agent` 容器当前的 `Restarting` 状态（既有问题，需单独排查）

---

# ⚠️ T24 执行事故与修复记录（2026-09-17）

**如实记录，不掩饰。本次事故由助手的操作失误造成。**

## 事故

执行切换时使用了：

```bash
POSTGRES_USER=loom MINIO_ROOT_USER=loom MINIO_ROOT_PASSWORD=x \
CRON_SECRET=x WECHAT_GATEWAY_TOKEN=x ... \
docker compose up -d --no-build app scheduler
```

**`docker compose up` 会重新解析整个 compose 文件并把命令行传入的变量注入到所有相关服务**，
因此我传的占位值 `x` 覆盖了**并未打算改动**的服务（minio / telethon / wechat-gateway / app）的真实凭据。

### 后果

| 服务 | 影响 |
|---|---|
| **MinIO** | 密码变成 1 位，启动校验失败（要求 ≥8 位）→ **进入 Restarting 循环** |
| app / telethon | `MINIO_SECRET_KEY` 被污染 → 媒体落盘不可用 |
| app / scheduler | `CRON_SECRET` 被污染 → scheduler 无法调用 app 的 tick |
| app / wechat-gateway | `WECHAT_GATEWAY_TOKEN` 被污染 → app 无法调用网关 |

### 数据安全（最重要）

**全部业务数据完好**——事故只影响容器环境变量，未触及任何数据卷：
- MinIO 对象：**340 个 / 66 MiB**
- PostgreSQL：**items=2441、migrations=20**

## 修复（用户授权方案 A）

| 凭据 | 恢复方式 |
|---|---|
| `MINIO_ROOT_USER/PASSWORD` | ✅ 从**未受污染的** `minio-init` 容器读取（8 天前创建，未被本次 `up` 影响） |
| `WECHAT_PRIMARY_ALLOWED_HOSTS` | ✅ 同上 |
| `CRON_SECRET` | ⚠️ **原值无副本可恢复** → 经用户授权**重新生成**（64 位随机） |
| `WECHAT_GATEWAY_TOKEN` | ⚠️ 同上 → 重新生成（64 位随机） |

新令牌写入 **`F:\loom-backups\.env.t24`**（权限 600、工作树之外、未入 git），
并**成对注入**需要保持一致的双方（app+scheduler 共享 CRON_SECRET；app+wechat-gateway 共享网关令牌）。

### 修复步骤

```bash
set -a; . /f/loom-backups/.env.t24; set +a
docker compose up -d --force-recreate --no-deps minio
docker compose up -d --force-recreate --no-deps minio-init
docker compose up -d --force-recreate --no-deps wechat-gateway
docker compose up -d --force-recreate --no-deps telethon
docker compose up -d --force-recreate --no-deps app scheduler
```

**关键**：每一步都加 `--no-deps` 且**只指定一个服务**，避免再波及其他容器。

## 修复验证

| 检查 | 结果 |
|---|---|
| 凭据长度 | app: CRON_SECRET=64 / 网关令牌=64 / MinIO=21；scheduler: 64；gateway: 64；telethon: 21；minio: 21 |
| MinIO 数据 | ✅ 340 对象 / 66 MiB |
| MinIO 健康 | ✅ healthy |
| tick 调用 | ✅ HTTP 200 |
| **端到端采集** | ✅ `ran: 5`、**`items_new: 3`**、**`collection_errors: 0`** |
| 分阶段日志 | ✅ `{"stages":{"collection":"ok","production":"ok","reconciliation":"reconciliation_deferred",...}}` |
| `stage_windows` | ✅ `ingest \| done \| stored=0 errors=0`（新窗口机制工作） |
| 调度频率 | ✅ 每 60 秒唤醒（日志时间戳印证） |

## 教训（写入操作手册）

1. **`docker compose up` 会把命令行变量注入全栈**。更新单个服务必须：
   - 用 `--no-deps`（不牵动依赖）
   - **只指定目标服务**
   - **绝不传与该服务无关的变量占位值**
2. **占位值必须是"无害"的**：若必须传占位，应传**长度合法且明确标记为占位**的值，
   而不是 `x` 这种会让下游校验失败的值。
3. **部署前应先备份 `docker inspect` 的完整环境**（本次 `minio-init` 意外成为唯一的凭据来源，
   纯属运气——若它也需重建，MinIO 密码将永久丢失）。
4. **正式部署不应依赖无副本的凭据**：应统一使用工作树外的 env 文件（本次已建立 `.env.t24`）。


---

# ✅ 镜像重建（2026-09-24）：让线上 PRD 文案与源码一致

## 为什么重建

2026-09-21 的文档校正把 PRD 页面里"适配器存在 = 平台可用"的误导表述改成了实测状态
（微信无正文移出首版、Telegram 未登录、B 站限流、抖音/小红书/西瓜未验收等）。
但那只是**源码改动**——生产镜像仍是 2026-09-17 构建的版本，页面显示的仍是 v1.1 旧文案。

## 做了什么

| 步骤 | 结果 |
|---|---|
| 构建前备份 | `F:/loom-backups/loom-prod-prerebuild-20260924-122508.dump`（2.38 MB，`pg_restore --list` 117 条目可读） |
| 给旧镜像打回滚标签 | `loom-rollback:app-20260924`（= 切换前的 `loom-app:readiness-20260917`） |
| 修正构建源 | B 的 README 是旧版（写着"L0 离线候选、尚未验收"）且链接指向仓库外；已用 R 的校正版覆盖，并把 3 份新文档同步进 B |
| 构建 | 从工作树 B 构建 `loom-app:readiness-20260924`（`sha256:a0790e04b401…`）；唯一 warning 是 `VITE_AUTH_ENABLED`，非敏感值 |
| **切换前演练** | 起隔离 PG（回环 60111）+ 恢复备份 → 新镜像连它启动 → 页面 200、**PRD 显示 v1.2 与"限流待验收"**（旧镜像对照为 v1.1、10 处"适配器"） |
| 切换 | app 与 scheduler **各自单独** `--force-recreate --no-deps`；app 用时 **4.4 秒** |

## 事后核验

- 6 个服务全部健康；`items` 从 3230 增至 3232（切换期间采集未中断）
- 生产 `/prd` 现在返回 `PRD / v1.2 / 2026-09-21`，含"限流待验收""频道 RSS 实测"等实测表述
- 演练容器与隔离库已删除，未接入生产

## ⚠️ 切换时观察到的两件与本次重建无关的事

1. **本机模型网关（`127.0.0.1:10100`）已停止运行**——进程退出，端口无监听。
   新旧镜像连它**都失败**（已用回滚镜像对照验证），所以不是重建引入的。
   影响：分析与问答暂时不可用，直到该服务重新启动。属外部依赖，不在本仓库内。
2. **3 个 RSS 源（36氪 / Solidot / 量子位）报 `socket disconnected before TLS connect`**——
   同样在新旧镜像上都复现，属本机网络/代理对该域名的瞬时问题，与镜像无关。
   任务页会如实显示该错误，下一轮 tick 会自动重试。

## 回滚

```bash
# 镜像：把 compose 里的 readiness-20260924 改回 readiness-20260917，然后逐服务重建
docker compose up -d --force-recreate --no-deps app
docker compose up -d --force-recreate --no-deps scheduler

# 或直接把回滚标签重新打回
docker tag loom-rollback:app-20260924 loom-app:readiness-20260917
```

compose 备份：`F:/loom-backups/docker-compose.yml.pre-rebuild-<时间戳>`

---

# 安全加固（2026-09-21 已执行完成）

**状态：已完成并验证。** 本节原为「未处理的安全加固项（用户决定暂缓）」；
用户于 2026-09-21 决定现在执行，两项（端口回环 + 强口令）**同批完成**，另接入生产模型。

> 保留下面的历史记录，是为了记住"当时为什么没做"以及实测暴露面的全貌；
> **执行结果见本节末尾的「执行记录」**，加固步骤已按实际执行更新。

## 历史现状（2026-09-17，加固前）

> **2026-09-19 复核更正**：下面「暴露面评估」原写"MinIO 仅本机可达、未暴露"，**实测不成立**，已按实测改写。
> 同时新增「端口暴露」一项——它是本批发布留下的真实缺口，不在原表中。

| 服务 | 变量 | 加固前的值 | 风险 |
|---|---|---|---|
| **postgres** | `POSTGRES_PASSWORD` | `loom` | **公开的默认值**（compose 文件里就有） |
| **minio** | `MINIO_ROOT_PASSWORD` | `loom-secret-change-me` | 同上 |
| app / telethon | `MINIO_SECRET_KEY` | 同上 | 同上 |
| scheduler / wechat-gateway | — | ✓ 未发现弱默认值 | — |
| agent | `AGENT_SERVICE_TOKEN` | 空 | 已通过 profile 停用，不再重启 |
| **app / minio** | 端口绑定 | **`0.0.0.0` 全网卡** | **任何同网段设备可直接访问；应用无登录** |

## 端口暴露（2026-09-19 实测发现，此前被误记为"已修"）

**事实**（全部实测，非推测）：

| 检查项 | 实测结果 |
|---|---|
| 生产实际使用的 compose | **根目录 `R/docker-compose.yml`**（`docker inspect` 读到的 `com.docker.compose.project.config_files`） |
| 当时的端口行 | `"8080:8080"`、`"9000:9000"`、`"9001:9001"` —— **无 `127.0.0.1` 前缀** |
| 回环绑定在哪 | 只在**工作树 B** 的 compose 里；**从未生效于生产** |
| 端口演进 | 基线 `25d60e6` 至今的 4 次提交，R 的端口行**始终是全网卡**（21 处 `:?`/回环改动都在 B） |
| 当时的监听 | `0.0.0.0:8080`、`0.0.0.0:9000`、`0.0.0.0:9001` |
| 局域网可达 | ✅ 实测 `192.168.100.6:8080` → **200**（无登录页）、`:9001` → **200**、`:9000` → 403 |
| 防火墙 | 以太网 = **Private** 类别，而 Private 配置文件 **Enabled=False** |
| 媒体桶匿名读 | ✅ 实测匿名 `GET /loom/<object_key>` → **200**，对象可直接下载 |

**因果**：T04 的回环修复写在工作树 B，T24 从 B 构建**镜像**但使用的是 **R 的 compose 文件**——
镜像层修复生效，compose 层的端口修复没有跟着上线。

---

# ✅ 执行记录（2026-09-21）

## 做了什么

| 项 | 变更 | 验证 |
|---|---|---|
| **端口收窄** | `8080`/`9000`/`9001` 全部改为 `127.0.0.1:` 前缀 | 局域网三端口**全部连接失败**；本机 `127.0.0.1:8080` → 200、`:9001` → 200、`:9000` → 403 |
| **PG 强口令** | `ALTER USER loom WITH PASSWORD '<48 位十六进制>'`（**只改角色，不动数据**） | `psql` 新口令可连；app 健康 |
| **MinIO 强口令** | 环境变量轮换 + `minio-init` 同步重建 | 新口令能列出 **381 个对象**；旧口令**已失效** |
| **凭据外部化** | 新建 `F:/loom-backups/loom-prod.env`（600）+ `env/<service>.env` 七个按服务最小化文件 | `compose config` 通过；minio 只拿到自己的口令，不再持有 PG 口令/CRON_SECRET |
| **生产模型接入** | 挂载 `F:/loom-backups/model.local.json`（含 Key）+ `extra_hosts: localhost:host-gateway` | 容器内真实生成 **HTTP 200**；端到端分析成功落库 |

## 为什么用 env_file 而不是继续用 `${VAR:?}` 插值

compose 的**插值不读 `env_file`**（实测：变量缺失时 `${VAR:?}` 直接让 `compose config` 失败）。
更关键的是——用命令行传变量正是 T24 事故的复现路径（`compose up` 会把命令行变量注入全栈）。
改用 `env_file` 后，**`restart.bat` 无需修改**，且整栈凭据不再经过命令行。

## 按服务最小化，避免权限扩散

最初直接给每个服务挂同一个 `loom-prod.env`，实测发现 **minio 容器也会拿到 PostgreSQL 口令和
CRON_SECRET**（`env_file` 注入文件里全部变量）。已改为 `scripts/write-service-envs.mjs` 生成的
七个文件：minio 只拿自己的根凭据，scheduler 只拿 `CRON_SECRET`（它只调 HTTP 端点，不连库）。

## 加固后的端口/凭据状态

| 服务 | 端口绑定 | 凭据来源 |
|---|---|---|
| app | `127.0.0.1:8080` | `env/app.env` |
| minio | `127.0.0.1:9000`、`127.0.0.1:9001` | `env/minio.env` |
| postgres | 不发布宿主端口 | `env/postgres.env` |
| scheduler / telethon / wechat-gateway | 不发布宿主端口 | 各自 `env/*.env` |

**媒体桶**：`MINIO_BUCKET_ACCESS=public` 保留（浏览器在宿主上，仍能显示媒体）。
这是**有依据的取舍**，不是遗漏——端口已收窄到回环，局域网无法到达。
若日后要远程访问，必须先改 `private` 或改用签名 URL。

## 兼容性验证（最重要的一条）

加固改了 compose 的必需变量与端口，而 **`restart.bat` 不能改**（重启契约）。已实测完整流程：

```
docker compose down          # 模拟 restart.bat [2/5]
docker compose up -d         # 模拟 restart.bat [3/5]，未传任何变量
```

结果：6 个服务全部健康，**数据零丢失**（items=2838、sources=26、数据卷 381 对象），
端口收窄与模型调用**在重启后仍然生效**。

## 回滚

- compose：`F:/loom-backups/docker-compose.yml.pre-hardening-20260921-092236`
- 凭据文件：`F:/loom-backups/.env.t24.bak-20260921-093133`
- 数据：迁移前/后 dump + 异地副本 `G:\QBXT_0917\loom-backup-20260917\`
- **PG 口令改错**时：用 `ALTER USER` 改回即可（数据不受影响），再重建 app/scheduler
- **MinIO 口令改错**时：改回环境变量并重建 minio + minio-init（两处必须一致，否则媒体操作失败）

## 仍然存在的风险（加固后未消除的）

- **应用无登录**：端口虽已收窄到回环，但同宿主的任何进程仍可访问。多人/远程使用需先做身份层。
- **凭据文件在工作树外**：`F:/loom-backups/` 未加密、未入备份体系；若该目录丢失，需按上文重建凭据。
- **备份仍是明文、手工**，且"异地"在同一台机器上（F: 与 G:）。
- **「模型设置」页在生产只读**：这是设计要求（`with-app-env.mjs` 只在显式绑回环时才签发本机证明），
  不是故障。改模型请编辑 `F:/loom-backups/model.local.json` 后重建 app。

## 暴露面评估（如实，不夸大也不掩饰）

**当前缓解因素**：
- PostgreSQL **未发布宿主端口**（只在 compose 内网 `postgres:5432`），外部无法直连
- 部署方式为单机 Docker，**未映射公网**（无端口转发/UPnP 证据）

**仍然存在的风险**（实测）：
- **同一局域网内任何设备**都能打开应用（无登录）与 MinIO 控制台，并**匿名下载**媒体对象
- 同一宿主上的**任何进程/容器**都能用公开凭据读写数据库与对象存储
- 任何拿到 `docker-compose.yml` 的人（它已在 git 里）都知道密码
- 若将来把服务暴露到内网/公网，风险会立刻放大
- **本批事故已证明**：弱默认值 + 无凭据副本 = 最难恢复的组合

## 再次轮换凭据的标准流程（加固后）

加固已完成，凭据现在集中在 `F:/loom-backups/loom-prod.env`。日后轮换照下面走：

```bash
# 1. 改单一凭据源
#    编辑 F:/loom-backups/loom-prod.env（改 POSTGRES_PASSWORD 或 MINIO_ROOT_PASSWORD）

# 2. 重新生成按服务最小化的 env 文件（600 权限，工作树外）
node scripts/write-service-envs.mjs

# 3. 若是 PostgreSQL：先改角色口令（不动数据），再重建 app/scheduler
docker exec gig5cyrba5yn3tsi-grok-workspace-postgres-1 \
  sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d $POSTGRES_DB \
         -c "ALTER USER loom WITH PASSWORD '\''<新密码>'\'';"'
docker compose up -d --force-recreate --no-deps app
docker compose up -d --force-recreate --no-deps scheduler

# 4. 若是 MinIO：minio 与 minio-init 必须同批重建（否则桶策略失配，媒体落盘会失败）
docker compose up -d --force-recreate --no-deps minio
docker compose up -d --force-recreate --no-deps minio-init
docker compose up -d --force-recreate --no-deps app
docker compose up -d --force-recreate --no-deps telethon
```

**铁律（T24 事故教训）**：每条命令**只指定一个服务** + `--no-deps` + **不传任何变量到命令行**。
`compose up` 会重新解析全文件并把命令行变量注入所有相关服务，曾导致 MinIO 密码被占位值覆盖、整栈重启循环。

## 验证清单（每次轮换后逐条核对）

- [ ] `docker compose config` 通过（无插值警告）
- [ ] 6 个服务全部 `Up`（app / minio / postgres 应 `(healthy)`）
- [ ] app 健康：`curl 127.0.0.1:8080/` → 200
- [ ] 局域网不可达：`curl 192.168.100.6:8080/` → 连接失败（端口收窄未被回退）
- [ ] MinIO 新口令能列对象（当前 381 个）、**旧口令失败**
- [ ] scheduler 日志持续 `status:200`（`reconciliation_deferred` 属设计行为，见下）
- [ ] 手动触发一次分析：`ai_runs` 新增 `succeeded` 且 `input_tokens` 非 null
- [ ] **完整 down + up 演练**（模拟 `restart.bat`）：数据计数不变、端口仍收窄

> `reconciliation_deferred` 不是故障：对账窗口只在每天 23:30 后开启（上海时区）。

## 回滚

- compose：`F:/loom-backups/docker-compose.yml.pre-hardening-20260921-092236`（加固前）、
  `docker-compose.yml.pre-t24-backup`（T24 前）
- 凭据文件：`F:/loom-backups/.env.t24.bak-20260921-093133`
- 数据：迁移前/后 dump + 异地副本 `G:\QBXT_0917\loom-backup-20260917\`
- **PG 口令改错**：用 `ALTER USER` 改回（数据不受影响），再重建 app/scheduler
- **MinIO 口令改错**：改回并同批重建 minio + minio-init

## 桶策略回滚（若把 `MINIO_BUCKET_ACCESS` 改为 private）

```bash
# 恢复匿名读（仅当确认素材就是公开材料时才做）
docker exec gig5cyrba5yn3tsi-grok-workspace-minio-1 mc anonymous set download local/loom
```

改回 `public` 后已有的公开 URL 会重新可用；期间产生的失效链接不是数据丢失。

## 为什么当时（2026-09-17）没做

用户选择 **B：先不改，记录待办**。推测考虑：可能要先做手动测试，不想在此期间引入变动。
**记录在案，不做评判。** 2026-09-21 用户决定执行，两项同批完成并验证。
