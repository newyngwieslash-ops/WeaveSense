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

# ⚠️ 未处理的安全加固项（用户决定暂缓，2026-09-17）

**用户明确选择"先不改，记录待办"。以下是完整现状与操作步骤，供后续执行。**

## 现状（实测，非推测）

| 服务 | 变量 | 当前值 | 风险 |
|---|---|---|---|
| **postgres** | `POSTGRES_PASSWORD` | `loom` | **公开的默认值**（compose 文件里就有） |
| **minio** | `MINIO_ROOT_PASSWORD` | `loom-secret-change-me` | 同上 |
| app / telethon | `MINIO_SECRET_KEY` | 同上 | 同上 |
| scheduler / wechat-gateway | — | ✓ 未发现弱默认值 | — |
| agent | `AGENT_SERVICE_TOKEN` | 空 | 已通过 profile 停用，不再重启 |

## 暴露面评估（如实，不夸大也不掩饰）

**当前缓解因素**：
- PostgreSQL **未发布宿主端口**（只在 compose 内网 `postgres:5432`），外部无法直连
- MinIO 端口（9000/9001）映射到宿主，但**仅本机可达**（无公网映射）
- 部署方式是单机 Docker，未暴露到互联网

**仍然存在的风险**：
- 同一宿主上的**任何进程/容器**都能用这套公开凭据读写数据库与对象存储
- 任何拿到 `docker-compose.yml` 的人（它已在 git 里）都知道密码
- 若将来把服务暴露到内网/公网，风险会立刻放大
- **本批事故已证明**：弱默认值 + 无凭据副本 = 最难恢复的组合

## 加固步骤（执行时照此操作）

**前置**：先做一次备份（`F:\loom-backups`），并确认 `minio` 数据卷完好。

### 1. 生成强随机密码（写入工作树外的凭据文件）

```bash
NEW_PG_PW=$(openssl rand -hex 24)
NEW_MINIO_PW=$(openssl rand -hex 24)
# 追加到 F:\loom-backups\.env.t24（600 权限、工作树外、绝不入 git）
```

### 2. PostgreSQL（**不改数据，只改角色密码**）

```bash
# 2a. 改密码（幂等，可重复执行）
docker exec gig5cyrba5yn3tsi-grok-workspace-postgres-1   psql -U loom -d loom -c "ALTER USER loom WITH PASSWORD '<新密码>';"

# 2b. 更新连接方（app / scheduler）——每个服务单独重建，不牵动依赖
#     必须用 --no-deps，且只指定一个服务（见本文件 T24 事故教训）
docker compose up -d --force-recreate --no-deps app
docker compose up -d --force-recreate --no-deps scheduler
```

**注意**：`docker-compose.yml` 里 app/scheduler 的 `DATABASE_URL` 当前是硬编码
`postgres://loom:loom@postgres:5432/loom`，需改为从环境变量取值。

### 3. MinIO（改凭据后必须同步 minio-init，否则桶策略失配）

```bash
docker compose up -d --force-recreate --no-deps minio
docker compose up -d --force-recreate --no-deps minio-init
docker compose up -d --force-recreate --no-deps app       # 它用 MINIO_* 凭据
docker compose up -d --force-recreate --no-deps telethon
```

**关键**：MinIO 密码**不能只改环境变量**——`minio-init` 会用同一凭据设置桶策略，
若两处不一致，媒体落盘会失败（本次事故已演示过这个失败模式）。

### 4. 验证清单

- [ ] `docker exec <pg> psql -U loom -d loom -c "select 1"` 用新密码可连
- [ ] app 健康（`/` 返回 200）、scheduler 日志显示 tick 成功
- [ ] MinIO `mc du` 可列出 340 对象
- [ ] 手动触发 tick：`items_new > 0` 且 `collection_errors: 0`
- [ ] 媒体落盘：新条目的 `media_objects.status='stored'` 能增加
- [ ] 旧密码**不再可用**（用旧密码连接应失败）

### 5. 回滚

- 镜像/配置：`F:\loom-backups\docker-compose.yml.pre-t24-backup`
- 数据：迁移前/后 dump + 异地副本 `G:\QBXT_0917\loom-backup-20260917\`
- **注意**：PG 密码改错会导致 app 连不上；此时用 `ALTER USER` 改回即可（数据不受影响）

## 为什么当时没做（用户原话）

用户选择 **B：先不改，记录待办**。推测考虑：可能要先做手动测试，不想在此期间引入变动。
**记录在案，不做评判。**
