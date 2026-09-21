# 织识 Loom 项目进度交接（2026-09-17）

> **本文件是续接入口。** 上一个会话完成了 T01—T25 的实施与 T21/T22/T24 的真实执行。
> 阅读顺序：本文件 → `2026-09-16-production-readiness-execution.md`（逐任务证据）→ `loom-release-runbook.md`（发布与事故记录）。

---

## 1. 一句话结论

**新代码已上生产并验证通过（app + scheduler）**；数据保护体系完整（四项资产 + 异地副本 + 恢复演练）；
**发生过一次由助手造成的生产事故，已修复，数据零损失**。

**当前级别：L1 受控试用的部分条件已达成**（真实模型可用、引用可核验、生产已跑新代码）；
但微信不可用、费用不可核算、未做长期试运行，**不宣布 L1 整体达成**。

---

## 2. 实测状态（2026-09-17 19:2x）

### 2.1 生产服务

| 服务 | 状态 | 镜像 |
|---|---|---|
| app | ✅ Up (healthy) | **`loom-app:readiness-20260917`**（本批新代码） |
| scheduler | ✅ Up | **`loom-app:readiness-20260917`** |
| postgres | ✅ Up 10h (healthy) | `postgres:16-alpine` |
| minio | ✅ Up (healthy) | `minio/minio:latest` |
| telethon | ✅ Up (healthy) | `…-telethon`（**未登录**，authorized=false） |
| wechat-gateway | ✅ Up | `…-wechat-gateway`（**旧镜像**，本批未更新代码） |
| **agent** | ⚠️ **Restarting** | `…-agent` —— **既有故障**，非本批引入 |

### 2.2 数据

```
2026-09-17（本文件写作时）: items=2445  sources=26  jobs=4678  migrations=20  stage_windows=2 行
2026-09-21（加固后实测）  : items=2838  sources=26  jobs=6853  migrations=20  stage_windows=48 行
```

- `migrations=20`：**0021 已应用**（2026-09-17，未停写）
- `stage_windows` 从 2 行涨到 **48 行**：**新调度机制持续在跑**（T09 生产生效的证据）
- 媒体：MinIO **381 对象**（加固轮换口令后逐项核对，数量未变；另 43 个 `error` 为历史遗留，非本批引入）
- 加固前后数据零丢失：`items` 只增不减，完整 `compose down` + `up` 后计数不变

### 2.3 git

| 仓库 | 状态 |
|---|---|
| **工作树 B** | 已提交 `58aa85f`、**已推送** `origin/comet/local-model-settings`，**工作区干净** |
| **根目录 R** | ⚠️ **23 项未提交**（含本次修改的 `docker-compose.yml`、`migrations/0021` 等），未推送 |

---

## 3. 本批实际完成的事（T01—T25）

### 3.1 修复的 13 类真实缺陷（每项都有红测试证明其存在）

| 任务 | 缺陷 | 状态 |
|---|---|---|
| T01 | 隔离运行泄漏真实 Key 与模型配置（两条路径） | ✅ 已修 |
| T02 | 正式运行缺库时静默用内存库 | ✅ 已修 |
| T03 | 无真实 PG 备份/恢复工具 | ✅ 已建并演练 |
| T04 | `.env` 进构建上下文、5 处弱默认凭证、端口全网卡暴露 | ⚠️ **部分**：回环修复仅在 B，**生产仍全网卡**（见 §4.6） |
| T05 | SSRF（含 IPv4-mapped、混合 DNS）+ 无体积上限 | ✅ 已修 |
| T06 | 策略未接入调用者；带令牌请求跟随重定向 | ✅ 已修 |
| T07 | **关键词全库打标永久卡在 200 条** | ✅ 已修 |
| T08 | 关键词失败被吞成"成功零条"；本地范围隐式联网 | ✅ 已修 |
| T09 | 调度无法提速（提则重阶段频率×30） | ✅ 已修（持久窗口） |
| T10 | **Telegram 分页永久丢弃中段**；游标 2^53 精度丢失 | ✅ 已修 |
| T11 | 三处 8000 字符静默截断（尾部永久丢失） | ✅ 已修 |
| T12 | 视频封面误送付费 STT；超大图截断成损坏图像 | ✅ 已修 |
| T13 | 微信费用：未知结果按估价结算 | ✅ 已修 |
| T15 | 检索 c11 召回 0.5（词汇鸿沟） | ✅ 已修（0.5→1.0） |

### 3.2 T21 真实服务验收（13 次真实模型调用）

- 分析 **2 条成功**、库内问答 **1 条成功**、**引用 2/2 可核验、零伪造**
- 采集：RSS ✅、Telegram 网页预览 ✅、YouTube 频道 RSS ✅
- 修复 3 个只有真实调用才能暴露的缺陷：
  1. **usage 被硬编码丢弃**（网关一直返回，代码写死 null）
  2. **租约 60s < 工作时长**（58—62s 的调用付费后丢结果）
  3. **40s 超时偏紧**（成功那次就要 31—32s）
- 修复后复验：分析 1/1 ✅、问答 1/1 ✅

### 3.3 T22 数据保护（完整）

| 资产 | 本地备份 | 异地副本 | 恢复验证 |
|---|---|---|---|
| PostgreSQL | ✅ | ✅ | ✅ **逐表 6/6 一致** |
| MinIO (340 对象) | ✅ | ✅ | ✅ **逐对象 CRC 零差异** |
| 网关 SQLite | ✅ `VACUUM INTO` | ✅ | ✅ `integrity_check=ok` |
| Telethon 会话 | n/a（未登录，无会话） | n/a | n/a |

异地副本：**`G:\QBXT_0917\loom-backup-20260917\`**（已从副本实际恢复验证）

### 3.4 T24 生产发布

- 从工作树 B 构建 `loom-app:readiness-20260917`，**不覆盖根目录 R**
- compose 中 app/scheduler 由 `build: .` 改为 `image:`
- 新增必需环境变量：`LOOM_RUNTIME_MODE=production`、`LOOM_EGRESS_CIDRS=198.18.0.0/15`（本机 fake-IP 代理）
- 切换耗时 **10 秒**，采集未中断

---

## 4. ⚠️ 必须知道的四件事

### 4.1 发生过生产事故（助手失误，已修复）

执行 `docker compose up -d app scheduler` 时传了 `MINIO_ROOT_PASSWORD=x` 等**占位值**，
compose 会把它们**注入全栈**，导致 MinIO 循环重启、`CRON_SECRET`/网关令牌被覆盖。

**数据零损失。** MinIO 密码从**未受污染的 `minio-init` 容器**恢复；
两个令牌原值无副本 → 经用户授权**重新生成**，存于：

```
F:\loom-backups\.env.t24      ← 请妥善保管（600 权限、工作树外、未入 git）
```

**教训（已写入 runbook）**：更新单个服务必须 `--no-deps` + 只指定目标服务 + **不传无关变量**。

### 4.2 `agent` 容器一直重启（既有故障，未修）

- **根因**：`AGENT_SERVICE_TOKEN` 为空（compose 默认 `:-`）
- **起始**：2026-09-09 部署时就存在（`RestartCount=581`）
- **影响**：**零** —— `AI_ENGINE=legacy`、`AGENT_WORKER_ENABLED=false`、`AGENT_ASYNC_RESEARCH_ENABLED=false`，不在业务链路上
- **待决定**：让它停下来（推荐）／配令牌启用 Eino（需先决定是否切换引擎）

### 4.3 微信采集不可用（上游风控）

实测 wewe-rss：`content_html` 非空 **0/154**、11 次 `risk_control`、最后成功 **2026-09-02**。
**经用户决定降级出首版范围**（证据见 `release-scope.md` §2.1）。

### 4.4 ✅ 弱默认凭据（2026-09-21 已加固）

| 服务 | 变量 | 加固前 | 现状 |
|---|---|---|---|
| postgres | `POSTGRES_PASSWORD` | `loom`（公开默认值） | ✅ **48 位十六进制**，仅存于工作树外 |
| minio | `MINIO_ROOT_PASSWORD` | `loom-secret-change-me` | ✅ **48 位十六进制**，旧口令实测已失效 |
| app / telethon | `MINIO_SECRET_KEY` | 同上 | ✅ 同上 |

凭据现集中于 `F:/loom-backups/loom-prod.env`（ACL 仅 Administrator）+ `env/<service>.env`
七个按服务最小化文件（minio 不再持有 PG 口令与 CRON_SECRET）。轮换流程见 `loom-release-runbook.md`。
**注意**：该目录未加密、未入备份体系，是加固后的新单点——已记录为待办。

### 4.5 费用不可核算

网关**确实返回 usage**（已被 T21 修复并记录），**但单价未知** → 实际金额仍需供应商账单。

### 4.6 ✅ 端口全网卡暴露（2026-09-19 发现，2026-09-21 已修）

**发现**：T24 从工作树 B 构建了镜像，但使用的 compose 是根目录 R 的
（`docker inspect` 读到的 `com.docker.compose.project.config_files`）。T04 的回环端口修复写在 B 的
compose 里，**从未生效于生产**。

| 检查项 | 发现时（2026-09-19） | 加固后（2026-09-21 实测） |
|---|---|---|
| 监听地址 | `0.0.0.0:8080`、`0.0.0.0:9000`、`0.0.0.0:9001` | **`127.0.0.1:...`** |
| 局域网可达 | `http://192.168.100.6:8080/` → **200（无登录）** | **连接失败** ✅ |
| 媒体桶 | 匿名 `GET /loom/<object_key>` → 200 | 仍为 public，但**只能从本机取**（有依据的取舍，见 runbook） |
| 防火墙 | 以太网 Private 类别、Private 配置 Enabled=False | 未改动（端口收窄后不再是唯一防线） |

**顺带修好的**：scheduler 与 app 的端口收窄**在完整 `compose down` + `up` 后仍然生效**（已实测）。

### 4.7 ✅ 生产模型（2026-09-21 已接入）

`XAI_API_KEY` 为空、无 `LOOM_MODEL_CONFIG`、镜像内无 `model.local.json`（加固前四项均实测为空）。
**T21 的 13 次真实调用是在隔离环境完成的，不代表生产容器能调模型。**

**现已接入**：

- 模型配置挂在 `F:/loom-backups/model.local.json`（含 Key，只读挂载，不进镜像层/仓库）
- `extra_hosts: localhost:host-gateway` —— 本机模型网关只接受来自回环的请求（它的 DNS-rebinding
  防护），这样让容器的调用**真的以回环身份发出**（不是绕过校验）
- 端到端验证：浏览器点击「分析」→ 条目状态变 `analyzed`、`ai_runs` 记录
  `succeeded` + `input_tokens=771 / output_tokens=970`（**T21 修复的 usage 记录在生产实际生效**）
- **「模型设置」页在生产是只读的**：`with-app-env.mjs` 会删除 `LOOM_MODEL_LOOPBACK_ONLY`，
  只在显式绑回环时才签发本机证明；容器内必须绑 `0.0.0.0` 才能被端口映射，所以该证明不成立。
  **这是设计要求，不是故障**。改模型请编辑配置文件后重建 app。

---

## 5. 复现与验证入口

```bash
# 工作树（业务代码）
cd F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/.worktrees/local-model-settings

npm test              # 285 项（含本批全部新增）
npm run test:all      # + gateway:test + typecheck + lint
go -C workers/agent test ./... -count=1

# 需要隔离 PG 的两项
REVIEW_PG_PORT=<port> npm run agent:pg          # 18/18
REVIEW_PG_PORT=<port> npm run agent:retrieval   # 26 例

# 端到端（自建容器，dev + built 浏览器）
node --experimental-strip-types scripts/readiness-e2e.mjs

# 容量
node --experimental-strip-types scripts/collection-load-check.mjs --sources 100
```

**回滚资源**（保留中）：
- 旧镜像：`loom-rollback:app-20260917`、`loom-rollback:scheduler-20260917`
- compose：`F:\loom-backups\docker-compose.yml.pre-t24-backup`
- 备份：迁移前/后 dump + 异地副本

---

## 6. 下一步候选（按建议顺序）

| 优先级 | 事项 | 说明 |
|---|---|---|
| 中 | **凭据目录的保护** | `F:/loom-backups/` 未加密、未纳入备份体系，是加固后的新单点 |
| 中 | 备份加密 + 自动同步 | 目前明文、手工 |
| 中 | T23 长期试运行 | 需账号/窗口/预算授权 |
| 低 | 真异地 | 目前 F: 与 G: 同机 |
| 低 | 应用身份层 | 端口已收窄到回环，但同宿主任何进程仍可访问；多人/远程需先做登录 |

**已完成（原高优先级项）**：
- ✅ **端口回环绑定**（§4.6）—— 局域网实测不可达
- ✅ **弱默认凭据加固**（§4.4）—— PG/MinIO 均轮换为 48 位随机口令
- ✅ **生产模型接入**（§4.7）—— 端到端分析成功
- ✅ **agent 容器** —— 已改为 `profiles: ["agent"]` 并停止

---

## 7. 关键文件索引

| 内容 | 路径 |
|---|---|
| **逐任务执行记录（含失败尝试）** | `R/docs/operations/2026-09-16-production-readiness-execution.md` |
| 发布与事故记录 | `R/docs/operations/loom-release-runbook.md` |
| 备份恢复手册 | `R/docs/operations/loom-backup-restore-runbook.md` |
| 候选版本说明 | `R/docs/operations/loom-release-candidate.md` |
| 授权清单（Gate A—D） | `R/docs/operations/loom-authorization-checklist.md` |
| 真实服务验收表 | `R/docs/operations/loom-real-service-acceptance.md` |
| 容量报告 | `R/docs/operations/loom-capacity-report.md` |
| 使用指南 | `R/docs/使用指南.md`、`R/docs/operations/loom-user-quickstart.md` |
| 本批证据目录 | `B/artifacts/production-readiness/pr-20260916-a1/` |
| 备份 | `F:\loom-backups\`、`G:\QBXT_0917\loom-backup-20260917\` |

---

## 8. 边界遵守（本批）

- ✅ 未读 `config/model.local.json` 的 Key 内容（仅在 T21 早期违规读取过一次元信息，已报告并改用应用自身读取路径）
- ✅ 未新建 `.env`（凭据用工作树外的 `.env.t24`）
- ✅ 未改 `restart.bat`
- ✅ 55191/55192 全程保留（期间宿主 Docker 重启导致停机，已恢复且数据与基线一致）
- ✅ 未 commit/push 根目录 R（工作树 B 已按要求推送）
- ⚠️ **一次生产事故**（见 §4.1），已修复并如实记录
