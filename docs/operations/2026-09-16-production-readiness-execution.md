# 织识 Loom 生产就绪执行记录

> 当前结论更新至 **2026-09-21**，见 [统一交付状态](loom-current-status.md)。下文按时间保留历史事实；早期“待授权/未执行”不覆盖后续已完成结果。文末总表为当前任务状态。T21 部分通过、T22 已验证、T23 未完成、T24 已发布；完整 PRD 尚未收尾。

计划：`R/docs/plans/2026-09-16-loom-production-readiness-implementation.md`（T01—T25）
业务工作树：`B = F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/.worktrees/local-model-settings`（分支 `comet/local-model-settings`）
根目录：`R = F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace`
执行批次：`pr-20260916-a1`，证据目录 `B/artifacts/production-readiness/pr-20260916-a1/`

状态取值：`not_started / implementing / offline_pass / awaiting_authorization / real_pass / partial_real_pass / partial_delivery / blocked / deferred_by_scope`

---

## 0. 基线与保护边界（只读核对，2026-09-16）

| 项 | 实测值 |
|---|---|
| 分支 / HEAD | `comet/local-model-settings` / `76b6da1ac8a8d6d6c6a4b30e7f0309c9e18fd8b9` |
| 未提交修改 | 61 个已跟踪文件修改 + 135 个未跟踪文件（全部保留，未 reset/clean/stash） |
| Node | v24.13.0 |
| 迁移 | `0002`—`0020`（含 0009—0020 共 19 项编号；目录内另有 `auth/` 子目录，不递归应用） |
| 父进程真实配置 | `DATABASE_URL` / `XAI_API_KEY` / `LOOM_MODEL_CONFIG` / `WECHAT_GATEWAY_TOKEN` 等**均未设置**；`config/model.local.json` 存在（仅记录哈希 `f7da0ed7f382acc7…`，未读内容） |
| `.env` | 不存在（不新建） |

### 服务存活（只读 `netstat` + `docker ps`，未重启/未强杀）

| 实例 | 端口 | 本次实测 | 处置 |
|---|---|---|---|
| 55192 假模型手测应用 | 127.0.0.1:55192 | **存活**（PID 45656） | 不动 |
| 55191 手测 PG 容器 | 127.0.0.1:55191 | **存活**（PID 8180，`loom-agent-harness-b7e5daa3`，Up 3h） | 不动 |
| 8182 legacy 开发实例 | 127.0.0.1:8182 | **未运行** | 不启动；不将新空库冒充旧内存数据 |
| 10100 本地模型网关 | 127.0.0.1:10100 | 存活（PID 26288） | 不调用（未授权真实模型） |

生产 compose 栈（`gig5cyrba5yn3tsi-grok-workspace-*`）仍在运行，本轮**未执行**任何 `compose up/down/rebuild`，未删除任何数据卷。其中 `…-agent-1` 显示 `Restarting (1)`，属既有状态，本轮未干预。

### 基线 manifest

`B/artifacts/production-readiness/pr-20260916-a1/baseline-manifest.md`：分支/HEAD/Node、19 项迁移哈希、11 个关键源码哈希、配置存在性（不含内容）。

---

## T01 — 固定基线、范围与隔离运行入口

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/scripts/readiness-offline.mjs`、`B/scripts/readiness-offline.test.mjs`
  - 新增 `R/docs/operations/2026-09-16-release-scope.md`、本文件
  - 只读核对：`B/package.json`、`B/AGENTS.md`、`B/docker-compose.yml`（模板，未展开秘密）、`B/scripts/with-app-env.mjs`、`B/scripts/agent-integration-harness.mjs`
- **缺陷复现（期望/实际）：** 计划要求隔离子进程不得继承真实配置。实测两条泄漏路径均成立：
  1. 既有 harness 模式 `env:{...process.env,...env}`（`agent-integration-harness.mjs:36/100/106`）把 `XAI_API_KEY`、`WECHAT_GATEWAY_TOKEN`、真实 `DATABASE_URL` 原样传给子进程 → 实际输出 `{"xai":"xai-REALKEY-LEAK","gw":"gw-LEAK"}`。
  2. `with-app-env.mjs:115` 在 `LOOM_MODEL_CONFIG` 为空且 `config/model.local.json` 存在时**自动指向开发者真实模型配置文件**。
  - 证据：`logs/t01-red-env-leak.txt`、`logs/t01-red-model-autodiscovery.txt`
- **最小实现：** 单一包装器提供 `offlineEnv(parent, overrides)`（运行期键**白名单**，非"删除已知 Key"）+ `offlineChildProcess()`，并固定离线默认值（`AUTO_ANALYZE=false`、`EXTRACT_AUTO=false`、`AGENT_WORKER_ENABLED=false`、`AGENT_ASYNC_RESEARCH_ENABLED=false`、`XAI_API_KEY=""`）。`overrides` 传 `undefined` 可显式移除键，`DATABASE_URL`/`LOOM_MODEL_CONFIG` 默认**不存在**（不继承、不自动发现）。
- **验证命令/退出码/数量：**
  - `node --test scripts/readiness-offline.test.mjs` → 红：exit=1，`ERR_MODULE_NOT_FOUND`（`logs/t01-red-test.txt`，属预期的实现缺失，非业务断言）
  - 同一命令 → 绿：**exit=0，6 tests / 6 pass / 0 fail / 0 skip**（`logs/t01-green-test.txt`）
  - 泄漏复验：同一条子进程探针在包装器下输出 `{"db":null,"xai":null,"gw":null,"mc":null,"explicit":"yes"}`，**exit=0**（`logs/t01-green-env-leak-blocked.txt`）
- **浏览器截图与实际查看：** 不适用（无前端改动）。
- **资源/费用：** 仅本机进程；零真实模型/采集调用，未读取任何 Key 内容。
- **已知限制与未完成项：**
  - 包装器已建立但**尚未改造既有 `agent-integration-harness.mjs`**（计划 W03/T19 范围）；本轮不扩大改动以保留既有已通过证据的可比性。
  - `with-app-env.mjs` 的自动发现行为按计划属既有部署语义，未单方面修改；隔离运行改由显式传 `LOOM_MODEL_CONFIG` 覆盖（由本包装器保证不被继承）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/`
- **下一独立任务：** T02。

---

## T02 — 正式运行缺数据库时拒绝启动

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/scripts/runtime-policy.mjs`、`B/scripts/runtime-policy.test.mjs`
  - 修改 `B/src/lib/db.ts`（模块加载即断言）、`B/scripts/migrate.mjs`（容器入口监听前断言）、`B/Dockerfile`（`ENV LOOM_RUNTIME_MODE=production` 置于 `RUN npm run build` **之后**）、`B/docker-compose.yml`（app 服务显式声明）
- **缺陷复现（期望/实际）：** 期望正式运行缺库时拒绝启动且零建库。实际原实现中 `db.ts` 在 `DATABASE_URL` 为空/空白时**静默回落到进程内存 PGLite**，写入看似成功、重启即丢；`NODE_ENV` 不能作为该判断依据（built 隔离预览同样处于 production 模式），故使用显式 `LOOM_RUNTIME_MODE`。
- **最小实现：** 单一 7 行策略函数 `assertRuntimeDatabase(env)`：非法模式抛 `invalid_runtime_mode`；`production` 且 DSN 空白抛 `production_database_required`。默认模式为 `development`（保守放行 dev/build/preview）。错误信息只含稳定代码，**不含 DSN**。
- **验证命令/退出码/数量：**
  - `node --test scripts/runtime-policy.test.mjs` → 红：exit=1，`ERR_MODULE_NOT_FOUND`（`logs/t02-red-test.txt`）
  - 同命令 → 绿：**exit=0，7 tests / 7 pass / 0 fail / 0 skip**（`logs/t02-green-test.txt`）
  - 门行为四态（`logs/t02-gate-behavior.txt`）：production 无 DSN → **exit=1** `production_database_required`；production 空白 DSN → **exit=1**；development 无 DSN → **exit=0** 输出 skip 提示；非法模式 `staging` → **exit=1** `invalid_runtime_mode`。四例均在建立任何连接**之前**抛出 → 零建库。
  - dev 不受影响（`logs/t02-dev-build-unaffected.txt`）：development 下策略放行 exit=0；production 下同上被阻断。
  - `npm run typecheck` → **exit=0**（`logs/t02-typecheck.txt`）。首轮 typecheck exit=2（`.mjs` 参数隐式 any），补 JSDoc 类型注解后复跑通过；失败尝试保留在 `t02-typecheck.txt` 的复跑覆盖中，红绿顺序见上。
- **浏览器截图与实际查看：** 不适用（无前端改动）。
- **资源/费用：** 仅本机进程与纯函数；零数据库连接、零模型调用。
- **已知限制与未完成项：**
  - `src/lib/db.ts` 的断言在**模块加载**时执行，故 `npm run build` 期间的 `db:migrate` 与 Vercel 构建若显式设置 `LOOM_RUNTIME_MODE=production` 且无 DSN 会被拒绝——这正是期望行为（构建阶段本就不该连正式库）。
  - 未在真实容器内 smoke 该门（需 build 镜像）；T19 会在隔离构建中一并验证。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/`
- **下一独立任务：** T03。

---

## T03 — PG 备份与恢复副本工具

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/scripts/postgres-recovery-check.mjs`（真实 pg_dump/pg_restore 演练）、`B/scripts/restore-policy.mjs`、`B/scripts/restore-policy.test.mjs`
  - 新增 `R/docs/operations/loom-backup-restore-runbook.md`
  - 复用：既有 `migrations/*.sql`、`validation/agent/search-followup-fixtures.sql` 的夹具风格、既有隔离容器模式（`agent-integration-harness.mjs`）
  - **未复用**既有 `scripts/pglite-recovery-check.mjs` / `pglite-backup-http-check.mjs`：那是 PGLite **物理归档**，不能作为 `pg_restore` 输入（计划本身已指出两者不可互换），故新增真实 PG 路径而非改写旧证据。
- **缺陷复现（期望/实际）：** 计划要求"真实 PG 上可 dump/restore 且失败场景先拒绝"。执行前实际状态是：只有 PGLite 隔离恢复证据，**没有任何真实 PostgreSQL 备份/恢复工具或演练**；首次运行因 `mkdtempSync` 早于 `mkdirSync` 报 `ENOENT`（保留在 `logs/t03-pg-recovery.txt` 首轮，属实现缺陷而非业务断言）。
- **最小实现：** 一个自建资源的演练脚本（标签 `loom.readiness.t03=isolated`、回环随机端口、唯一容器名）+ 三个纯守卫函数（`assertRestoreTargetIsNew`、`assertTaggedResource`、`exitStatusFor`）。脚本**不接收生产 DSN**——连接地址由它自己创建的容器推导，指向真实库需刻意改文件。失败时保留现场（非 0 退出且不删容器）。
- **验证命令/退出码/数量：**
  - `node --test scripts/restore-policy.test.mjs` → **exit=0，4 tests / 4 pass / 0 fail**（`logs/t03-policy-test.txt`）
  - `node scripts/postgres-recovery-check.mjs` → **exit=0**（`logs/t03-pg-recovery.txt`）。结果：19 项迁移、18 张表、25 行；备份 40,582 字节，SHA-256 `2894ab861cc7ae9e2ac701a93f2d2e3b83dbd702b7ce405b562309ba1af6cbd6`；恢复到第二库后**逐表行数与有序行摘要完全一致**；恢复副本读出简报「T03恢复简报」、分析「恢复摘要97%」、pending 提取任务 1 条。
  - 三个失败场景均**真实执行并按设计拒绝**：覆盖既有恢复目标 → `restore_target_exists`；损坏归档 → `pg_restore --list` exit=1；资源标签不符 → `resource_label_mismatch`。
  - 资源核对：脚本自建容器已在成功后被删除（`docker ps -a --filter label=loom.readiness.t03` 为空）；受保护的 `loom-agent-harness-b7e5daa3`（55191）**仍 Up 3 hours，未受影响**。
- **浏览器截图与实际查看：** 不适用（无前端改动）。计划步骤 4 要求的"恢复副本启动独立应用读取历史记录"以**数据库级**读回实现（指定简报/分析/pending 任务）并记录；整应用读回留在 T19/T22，未伪称已完成。
- **资源/费用：** 仅本机隔离容器与纯函数；零真实模型/采集调用，未读取任何 Key 或 DSN 秘密（凭据经容器内 `PGPASSWORD`/`pg_dump` 环境传入，不进 argv 与日志）。
- **已知限制与未完成项：**
  - 未对真实业务库执行；未验证宿主重启与 RPO/RTO（T22/Gate B）。
  - 网关 SQLite 与 MinIO 的**真实**备份演练未做，仅写入 runbook 程序（含"运行中 SQLite 单文件复制不是备份"的明确警示）。
  - 8182 内存库无已证实备份，runbook 已写明不得承诺找回。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`、`B/artifacts/production-readiness/pg-recovery/run-y1lZwZ/`
- **下一独立任务：** T04。

---

## T04 — 部署配置与打包边界

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/scripts/deployment-policy.mjs`、`B/scripts/deployment-policy.test.mjs`、`B/scripts/zip.mjs`、`B/scripts/pack-source.test.mjs`
  - 修改 `B/.dockerignore`、`B/docker-compose.yml`、`B/env.example`、`B/scripts/pack-source.mjs`
- **缺陷复现（期望/实际）：** 4 项真实缺陷（`logs/t04-red-test2.txt` 为首次真跑，前 2 项通过、后 4 项失败）：
  1. `.dockerignore` **未排除 `.env`**（构建上下文会上传到 builder，git 忽略的文件仍会被打包）。
  2. compose 发布**弱默认凭证**：`POSTGRES_PASSWORD: loom` 字面量；`MINIO_ROOT_PASSWORD:-loom-secret-change-me`、`MINIO_ACCESS_KEY:-loom` 等模板默认值共 7 处 —— 忘记覆盖的部署会得到公开已知口令。
  3. `8080:8080` / `9000:9000` / `9001:9001` **绑定所有网卡**：该应用无登录，等于把全部写接口暴露到网络。
  4. `minio/minio:latest`、`minio/mc:latest` **浮动标签**，重新部署可能换掉引擎版本。
  5. 额外发现：`scripts/pack-source.mjs` 硬编码 `/workspace`、`/tmp`、`python3`，**在本机 Windows 环境完全不可运行**（计划未列，属打包路径的真实阻断）。
  - 首次运行另有我自己的实现缺陷：`assertLoopbackPorts` 把 `127.0.0.1:9000:9000` 误判为公开绑定（主机提取写错），已修正并补正向对照测试。失败尝试保留（`t04-test2.txt`）。
- **最小实现：**
  - 排除策略集中到 `packExcluded()`，**由打包脚本与测试共同导入**，两者不可能对"被排除"有不同定义；打包后再走一次"fail closed"扫描，任何漏网路径都拒绝出包。
  - compose 弱默认值 → `${VAR:?set VAR}` 必填（缺变量 `compose up` 直接拒绝）；端口默认回环；镜像按**实测摘要**固定（`docker image inspect` 读到的 digests，非猜测）。
  - `minio-init` 匿名桶改为 `MINIO_BUCKET_ACCESS`（默认 `private`），并写明关闭匿名后既有公开 URL 会失效属预期。
  - 打包脚本改为纯 Node（`scripts/zip.mjs`，zlib + 手写 ZIP 记录，无新依赖），输出到 `artifacts/` 与 `public/`（应用内下载链接依赖后者）。
- **验证命令/退出码/数量：**
  - `node --test scripts/deployment-policy.test.mjs scripts/pack-source.test.mjs` → **exit=0，13 tests / 13 pass / 0 fail**（`logs/t04-pack-test.txt`），其中 4 项为**正向对照**（证明守卫在遇到坏输入时确实会失败），1 项用**外部 Python zipfile 回读**归档（不是"写入器自己说没问题"）。
  - `node scripts/pack-source.mjs` → **exit=0**，产出 3129 KB / **308 条目**；`missing required: (none)`、`suspicious: (none)`（`logs/t04-pack-run.txt`）。
  - compose 门（`logs/t04-compose-config.txt`）：不设任何秘密 → **exit=1**，报 `required variable MINIO_ROOT_USER is missing a value`；仅用假值 → **exit=0**，`LOOM_RUNTIME_MODE: production`（T02 标志已生效）、三个端口 `host_ip: 127.0.0.1`、三个镜像均为 `@sha256:`。
- **浏览器截图与实际查看：** 不适用（无前端改动）。应用内下载链接所用文件已重建于 `public/`（同一路径）。
- **资源/费用：** 仅本机文件与容器 CLI 解析；零真实服务调用。
- **已知限制与未完成项：**
  - **未执行镜像轮换**。既有卷上的密码不会因改环境变量而改变——runbook 已写明必须走 SQL/服务内更新。
  - 未在真实生产 compose 上 `up`（禁止）；仅 `config` 校验。真实部署属 T24/Gate D。
  - `public/zhishi-loom-source.zip` 被 `.dockerignore` 排除，因此**部署镜像内不含该 zip**；若线上"下载源码"按钮需要该文件，属另有既有行为，本轮未改变其路径语义，仅重建内容。
  - 打包未包含 `docs/使用指南.md` 之外的新运营文档（属 T25 范围）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T05。

---

## T05 — 外部下载的安全/大小边界

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/src/lib/server/outbound-policy.ts`、`B/src/lib/server/outbound-policy.test.ts`、`B/src/lib/server/outbound-policy.integration.test.ts`
  - 只读审计：`B/src/lib/server/http.ts`（原唯一通用下载 helper）、全部 `fetch(` 调用者、`B/workers/agent/internal/agent/mcp.go`
- **缺陷复现（期望/实际）：** 计划要求 public-fetch 禁止私网/元数据地址、限重定向、限体积。执行前实际状态：
  - `http.ts:18/32` 两处均 `redirect: "follow"` + `await res.text()`/`res.json()`，**无体积上限、无目标校验**：单个恶意/失控响应可耗尽内存，公开 Feed 可 302 到 `169.254.169.254` 或内网服务（SSRF）。
  - 复用判断：Go 侧已有 `limitedMCPBody`（64 KiB 流式上限，`mcp.go:128-145`），但那是 Go 且仅 MCP；Node 侧**无任何**同类实现，故新增（非重复开发）。
- **最小实现：** 单一策略模块，含 4 层：
  1. `assertPublicUrl`：仅 http(s)、拒绝 URL 内嵌用户名/密码。
  2. `addressBlocked`/`hostBlocked`/`resolvePublicAddresses`：拒绝 0/8、10/8、127/8、169.254/16（元数据）、172.16-31、192.168/16、100.64/10、224+/多播、`::1`/`::`/fe80/fc/fd/ff、**IPv4-mapped IPv6**；**混合 DNS 答案整体拒绝**（一公一私不允许）。
  3. `publicFetch`：**手动跟随重定向**，每一跳重新校验协议+DNS+地址（`redirect: "follow"` 无法做到这点）；超 `MAX_REDIRECTS=5` 拒绝。
  4. `readCapped`：**流式计数**，超限即刻 `cancel()` 断开并抛 `response_too_large`（带 bytes/limit，不携带正文）；首版上限常量 `TEXT_MAX_BYTES=4 MiB`、`MEDIA_MAX_BYTES=25 MiB`。
  - **DNS 重绑定防护**：`createPinnedLookup()` 把 socket 连接钉在校验通过的地址上（`http(s).request` 的 `lookup` 参数），TLS 仍按原域名校验 SNI/证书——不是"检查完再用普通 fetch"。
  - 内部服务（本机模型网关、MinIO、Telegram worker、微信网关、MCP）**不走此路径**，保持各自既有传输规则。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types --test src/lib/server/outbound-policy.test.ts src/lib/server/outbound-policy.integration.test.ts` → **exit=0，26 tests / 26 pass / 0 fail**（`logs/t05-final.txt`）：22 单元 + 4 **真实 socket** 集成。
  - 单元覆盖：非法协议/URL 凭证、14 类私网/元数据地址、9 类公网地址允许、内部域名、**混合 DNS 答案双向顺序**、IP 直连绕过、超限中途取消、恰好等于上限、伪造 Content-Length、"内容长度撒谎"、错误不含正文、上限选择、重定向到私网**请求次数为 1 未发出**、跨公网主机重定向复验、相对重定向、超重定向数、缺 Location、**钉连接断言**。
  - 集成（真实 Node 传输，回环，无外网）：不可解析主机名 + 钉住地址 → **成功取到回环服务器响应**（证明连接确实用了钉住地址）；**不钉住时请求不会到达回环服务器**（安全性质对照）；超时 destroy；302 的 Location 上浮给调用方复验。
  - `npm run typecheck` → **exit=0**（多轮红→绿，失败尝试保留于 `logs/t05-typecheck.txt`）。
  - 回归：`scripts/{runtime-policy,deployment-policy,pack-source,restore-policy}.test.mjs` → **24/24 pass**。
- **浏览器截图与实际查看：** 不适用（尚无调用者接入；T06 才改变运行时行为）。
- **资源/费用：** 纯本机回环 socket 与纯函数；零外网请求、零模型调用。
- **已知限制与未完成项：**
  - **尚未接入任何调用者**——`http.ts`/`rss.ts`/`media.ts`/`extract.ts` 等仍用旧路径，属 T06 范围。本任务的产物是策略与证据，不是已生效的行为改变。
  - 未启用自动代理/环境代理（`HTTP_PROXY`）纳入测试；计划提到"自动代理须纳入测试"，当前实现不使用 `fetch` 的代理发现，故该风险面不适用；如后续改用 `undici` 的 ProxyAgent 需补测。
  - 环境经诊断实测：本机解析器对任何域名都返回地址（存在 DNS 劫持/通配），故集成测试断言的是"是否到达回环"这一安全性质，而非特定 DNS 错误码；已在测试注释中说明。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T06。

---

## T06 — 将下载策略接入全部真实调用者

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 修改 `B/src/lib/server/http.ts`（`fetchText`/`fetchJson` 改走 `publicFetch`，导出 `FetchIo` 测试缝）
  - 修改 `B/src/lib/server/rss.ts`、`B/src/lib/server/telegram.ts`、`B/src/lib/server/collectors/index.ts`（含 `collectSource`/各 adapter 透传 `io`）、`B/src/lib/server/collectors/types.ts`（adapter 签名）、`B/src/lib/server/media.ts`、`B/src/lib/server/extract.ts`
  - 新增 `B/src/lib/server/download-integration.test.ts`；修改 `B/src/lib/server/collectors/index.test.mjs`
- **缺陷复现（期望/实际）：** T05 建了策略但**零调用者接入**。逐个 caller 的真实问题：
  - `rss.ts`：任意 `feed_url` → `redirect: "follow"`（SSRF + 无上限）
  - `telegram.ts`：抓 `t.me` 页面走同一 helper
  - `collectors/keyword.ts` + `collectors/index.ts`：Google News / HN / B站 JSON 全走同一 helper
  - `media.ts:59` / `extract.ts:17`：`fetch(...{redirect:"follow"}) + arrayBuffer()`，**无上限**（媒体摄取可打爆内存）
  - `collectors/index.ts:74`：微信网关 `redirect: "follow"` **且携带 Bearer token** —— 跟随重定向会把令牌交给重定向目标
- **最小实现：**
  - 公共 helper（`fetchText`/`fetchJson`）统一改走 `publicFetch`，一次覆盖 RSS/Telegram/关键词/B站 四类 caller；保留原有 UA/Accept/Referer 与错误文本语义。
  - `media.ts` / `extract.ts` 改走 `publicFetch({kind:"media", as:"bytes"})`（25 MiB 流式上限）。
  - 微信网关属**内部服务**，保留自身传输但把 `redirect: "follow"` 收紧为 `redirect: "error"`（带令牌的请求不得跟随重定向），并加 8 MiB 字符上限。
  - 测试缝 `FetchIo`（`resolver`/`transport`/`maxBytes`）：生产不传；**没有"允许私网"后门**——测试只能替换为更严格的双桩。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types --test src/lib/server/download-integration.test.ts src/lib/server/rss.test.ts src/lib/server/outbound-policy.test.ts src/lib/server/outbound-policy.integration.test.ts` → **exit=0，40 tests / 40 pass / 0 fail**（`logs/t06-verify.txt`）
  - `node --test src/lib/server/collectors/index.test.mjs` → **exit=0，1/1**（`logs/t06-collectors-regression.txt`）
  - `npm run test:manual-fixes` → **exit=0，32/32**（`logs/t06-manual-fixes.txt`）
  - `npm test` → **exit=0，234/234**（25+1+183+25，与历史基线一致；`logs/t06-npm-test.txt`）
  - `npm run typecheck` → **exit=0**（`logs/t06-typecheck.txt`）
  - 新增 9 项 caller 级边界：RSS 正常解析 / RSS 拒绝 loopback+metadata+file 协议 / RSS 重定向到 metadata **第二个请求从未发出** / RSS 超文本上限 / Telegram 页面抓取走策略 / Telegram 拒绝私网 / 关键词 JSON 走策略并拒绝私网 / 关键词超上限 / 媒体用更大上限且仍拒绝私网。
- **过程中发现并修正的真实缺陷：**
  1. `capFor` 原实现把 `kind` 当默认值处理，导致显式 `kind: "text"` 仍会因响应头自称 `image/png` 而放宽到 25 MiB。已改为：显式 `kind` 是**硬上限**，仅未指定时才由 content-type 决定。
  2. `rss.ts` 原有**无扩展名导入**（`./http`、`./rss-parser`），仅在 Vite 下可解析；Node ESM 直跑会 `ERR_MODULE_NOT_FOUND`。已补 `.ts`（与仓库其余文件一致）。失败尝试保留在 `logs/t06-test.txt`。
  3. 既有 `collectors/index.test.mjs` 用全局 `fetch` 打桩，在新策略下**正确失败**（回退路径不再走全局 fetch）。未降低断言，改为使用 `io` 缝保持同一期望（`attempts: ["primary","dajiala","rss"], paid_call: true`）。
- **浏览器截图与实际查看：** 尚无前端行为变化（采集为后台路径），T19 统一做 dev/built 浏览器验证。
- **资源/费用：** 全部离线双桩与回环；零真实外网请求、零模型调用。
- **已知限制与未完成项：**
  - **有意未接入的既有 fetch**（审计结论，均为内部/自有端点，保持原样）：`analyze.ts:53`、`model-config.ts:68`、`extract.ts:48/83`（xAI，均 `redirect:"error"`）、`agent-client.ts`（内网 agent，已 `redirect:"error"`）、`storage.ts:83/104/142`（MinIO SigV4，自签端点）、`telethon.ts:26/66`（内网 worker）、`collectors/index.ts:80`（微信网关，本轮已收紧重定向）、`app-data/client.server.ts`、`gateway` 相关（另仓）。
  - `storage.ts:89` 仍 `arrayBuffer()`：MinIO 为自签内部端点且调用方带签名，未纳入本次公共下载策略；如后续改为公网对象存储需补。
  - 关键词采集的**结果契约**（失败被吞成空数组）尚未动，属 T08。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T07。

---

## T07 — 历史关键词完整、并发安全的打标

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/src/lib/server/scheduler-atomic.ts` 中的 `tagCorpusWithPhrase`（集合式更新）
  - 修改 `B/src/lib/server/scheduler.ts`（删除旧 `limit 200` 实现，改为薄包装并传入平台范围）
  - 新增 `B/src/lib/server/scheduler-atomic.test.ts`、`B/scripts/postgres-tagging-check.mjs`
- **缺陷复现（期望/实际）：** 期望全库可标记、重复执行不重复标签。实际（旧 `scheduler.ts:145` 形状，**已实证**）：
  - `select ... where title/body/author ilike ... limit 200` 后再跳过已打标行 → 语料 >200 或前 200 条已打标时**永远无法完成**。
  - 红证据（`logs/t07-red-proof.txt`，450 匹配 + 前 200 已打标 + 50 无关）：**第 1/2/3 次运行后命中数始终为 200**，单次新增 0 —— 不是"慢"，是结构上不可能完成。
  - 另有 `like = '%' + phrase.replace(/[%_]/g,"") + '%'`：把 `%`/`_` 从短语中**删除**后当通配符使用，短语语义被改写。
  - 旧实现为读-改-写整列（`update ... set matched_keywords = $2`），并发两个短语会互相覆盖。
- **最小实现：** 单条集合式 `update ... returning id`（置于 `scheduler-atomic.ts`，scheduler 提供 `sql` 与平台范围）：
  - 匹配用 `strpos(lower(title||E'\n'||body||E'\n'||author), lower($1)) > 0` —— **大小写不敏感且 `%`/`_` 为字面字符**。
  - 幂等用 `not exists (... jsonb_array_elements_text ...)`，`lower()` 比较避免大小写重复标签。
  - 追加而非覆盖：`coalesce(matched_keywords,'[]') || jsonb_build_array($1)`，并发不丢标签。
  - 平台范围 `$2::jsonb`，空数组 = 全部平台；调用点传 `kw.platforms`，**本地打标不再跨平台**（UI 中"公众号信源/Telegram 信源"等本地模式的语义现在与范围一致）。
  - 边界校验：短语 <2 或 >40 字符抛 `invalid_phrase`（与 `parseKeywordList` 同规则）。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types --test src/lib/server/scheduler-atomic.test.ts` → 红（模块不存在）→ **exit=0，7 tests / 7 pass / 0 fail**：450 条（前 200 已打标）一次补 250 条、再跑 0 条；1200 条超单页语料一次完成；**并发两短语互不丢失**；大小写不重复；中文与 `%`/`_` 字面量；平台范围过滤；空/非法短语拒绝。
  - 真实 PostgreSQL 隔离验证 `node --experimental-strip-types scripts/postgres-tagging-check.mjs` → **exit=0**（`logs/t07-pg-check.txt`）：2 万行语料，首轮补标 10,000 行 **72 ms**，复跑 **0 行 / 22 ms**，两个短语并发各覆盖 20,000 行且 `bothTagged=20000`（**零标签丢失**）、总耗 **223 ms**；平台范围、`%`/`_` 字面量、无关行零污染均通过。自建容器已自行删除，55191/55192 未受影响（Up 4 hours / PID 8180、45656）。
  - `npm test` → **exit=0，234/234**（`logs/t07-regression.txt`）；`npm run typecheck` → **exit=0**。
- **过程中发现并修正的问题（均为我自己的脚本缺陷，产品代码无回退）：**
  1. `g < $1` 差一 → 期望 10000 实得 9999（PG 检查首次失败）。
  2. 断言 `a+b = rows` 错误：两短语各自匹配全部行，正确期望是各自 20000。
  3. 字面量 `50%` 断言写在 20k 生成语料上失败（生成 id 含 "50" 属正确匹配）→ 改为受控小数据集。
  4. catch 路径未关闭 pg 连接导致进程悬挂；改为 `finally` 中关闭并显式 `process.exit`。
  - 失败尝试全部保留在 `logs/t07-pg-check.txt`（每次失败均保留现场容器，核对后再删除自建容器）。
- **浏览器截图与实际查看：** 尚未在页面验证（打标为后台路径），T19 统一做 dev/built 浏览器验证。
- **资源/费用：** 仅本机 PGlite 与自建隔离 PG 容器；零外网、零模型调用。
- **已知限制与未完成项：**
  - 集合式更新持有行锁至语句结束：2 万行 72 ms 属安全范围；如未来语料显著增大，按计划改为主键游标批处理（函数注释已写明升级路径）。
  - `recountKeywordHits` 仍按短语全局计数（不按平台），属既有口径；本轮未改，避免扩大范围。T08 会核对命中数展示口径。
  - 未在真实业务库上运行（需 Gate B/T22 授权）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`、`B/artifacts/production-readiness/pg-t07/`
- **下一独立任务：** T08。

---

## T08 — 关键词结果契约与真实状态

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 修改 `B/src/lib/server/collectors/types.ts`（新增 `KeywordAttempt` / `KeywordBatch`）
  - 重写 `B/src/lib/server/collectors/keyword.ts`（返回 attempts；新增 `classifyFailure`；**本地平台不再触发外部检索**）
  - 新增 `B/src/lib/server/scheduler-outcome.ts` + `B/src/lib/server/keyword-outcome.test.ts`
  - 修改 `B/src/lib/server/scheduler.ts`（依结果落库 `ok`/`error` 与真实 note）
  - 修改 `B/src/lib/keyword.ts`（YouTube 标签改为「YouTube 新闻索引」并加语义注释）、`B/src/routes/keywords.tsx`（说明改为与真实行为一致）
  - 新增 `B/src/lib/server/collectors/keyword-contract.test.mjs`
- **缺陷复现（期望/实际）：** 原实现两处真实缺陷，均已由测试证实：
  1. `safeRss`/`biliSearch` 为 `try { … } catch { return [] }`：请求失败、限流、真正无结果**三者不可区分**，全部变成空数组，`runKeywordJob` 再统一记成 `ok` 成功零条。任务页因此无法显示"来源挂了"。
  2. **本地范围隐式联网**：`if (wants(platforms,"rss") || wants(platforms,"wechat"))` 让只勾选「公众号信源」的关键词**照样发起 Google News 查询**。我的测试 `a local-only scope makes no external request at all` 首次运行即失败（`logs/t08-test.txt`）——这是计划的 T08 步骤 4 所描述的行为，证据确凿。
  3. YouTube 在 UI 上显示为「YouTube」，实际查询是 Google News 的 `site:youtube.com` 新闻索引，非全站视频搜索。
- **最小实现：**
  - `collectKeyword` 返回 `{ items, attempts }`；每个来源一条 `attempt`（`status: ok|error`、`count`、稳定 `error_code`）。
  - `classifyFailure`：`HTTP 429 → rate_limited`、`HTTP <n> → http_error`、超时/abort → `timeout`、`response_too_large`/JSON 解析失败 → `invalid_response`、其余 → `network_error`。**原始消息不入库**（可能含查询串/令牌）。
  - 本地范围只做库里打标，不发起任何外部请求；未选中的来源**不产生 attempt**（没请求就没失败）。
  - 落库三态由纯函数 `keywordRunOutcome` 决定：无外部来源=正常；**全部失败= `error`**（本地标签仍保留并写入 note）；部分失败=`ok` + 「部分来源失败（来源：代码）」；成功零条=`ok` + 暂无新结果。**不再让本地命中抵消全部外部失败。**
- **验证命令/退出码/数量：**
  - `node --test src/lib/server/collectors/keyword-contract.test.mjs` → 首轮 **exit=1，10/11**（本地范围联网被抓住，`logs/t08-test.txt`）→ 修复后 **exit=0，11/11**（`logs/t08-test2.txt`）：全成功、成功零条=ok、全失败带码、部分失败、非法 JSON、B站 provider 级拒绝、超限、网络错误、按范围不越界、**本地范围零外部请求**、真实 source 身份。
  - `node --experimental-strip-types --test src/lib/server/keyword-outcome.test.ts` → **exit=0，7/7**：本地范围非失败、全失败=error 且保留本地计数、部分失败只点名失败来源、成功零条、外部静默+本地命中、**失败运行不得因历史本地标签被判 ok**、note 不含原始 provider 文本。
  - `npm test` → **exit=0，234/234**（`logs/t08-npm-test.txt`）；`npm run typecheck` → **exit=0**。
- **过程中的实现误差（自有缺陷，已修）：** 首版测试写成 `.test.ts` 直接 `import "./keyword.ts"`，因该模块使用 `@/` 值别名导致 `ERR_MODULE_NOT_FOUND` —— 正是计划警告的**假失败**。改为仓库既有的 Vite SSR runner 模式（`.mjs`），并补 JSDoc 类型满足 `checkJs`。
- **浏览器截图与实际查看：** 文案已改（关键词页说明、YouTube 标签）；页面视觉验证合并到 T19 的 dev/built 检查。
- **资源/费用：** 全部注入双桩，零真实外网请求、零模型调用。
- **已知限制与未完成项：**
  - `attempts` 目前只写入 job 的 `error`/状态（复用既有 `jobs.error` 字段，**未新增状态枚举或迁移**，符合计划）。
  - 未接 T16 的分阶段日志（`stages`/`error_code` 结构化字段）——那是 T16 范围。
  - 新增测试文件尚未纳入聚合命令，属 T18。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T09。

---

## T09 — 后台短周期调度与原生产阶段解耦

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/migrations/0021_stage_windows.sql`（持久窗口准入表）
  - 新增 `B/src/lib/server/stage-windows.ts` + `B/src/lib/server/stage-windows.test.ts`
  - 修改 `B/src/lib/server/nodes.ts`（`runProductionTick`：ingest/extract 走各自持久窗口，新增 `stages` 输出）
  - 修改 `B/src/routes/api/cron/tick.ts`（对账走持久窗口；业务窗口先于取号）
  - 修改 `B/env.example`、`B/docker-compose.yml`（`CRON_INTERVAL_MS` 默认 1800000 → **60000**，并注释说明这是**唤醒间隔**而非采集频率）
  - 修改 `B/src/lib/server/seed.ts`（仅 `export const SOURCES` 供测试读取，无行为变化）
- **缺陷复现（期望/实际）：** 计划要求"5/10 分钟可调度"但**不能**让落盘/OCR/付费对账频率随之翻 30 倍。执行前实际状态：常驻调度固定 30 分钟（`CRON_INTERVAL_MS=1800000`），且**没有任何全局周期状态**（`grep window|period migrations/*.sql` 无结果）——即提速只有"整 tick 提速"一条路，必然带动重阶段。
- **最小实现：** 引入 `stage_windows(stage, window_key, status, claimed_at, finished_at, note)`，`window_key = <stage>:<按其自身 interval 取整的周期起点>`：
  - 采集保持每 tick 执行，**每个源仍按自己的 `interval_minutes`**（改唤醒不改频率）。
  - 落盘（ingest）/提取（extract）各自 30 分钟窗口，对账 1440 分钟兜底窗口 + 既有 23:30 上海业务窗 **双重条件**。
  - 单条 `insert ... on conflict do update ... where 状态为 claimed 且已超时` 实现"跨进程/跨重启只准入一次"；不用内存时间戳。
  - 失败窗口**不在同一窗口内重试**（避免付费阶段变成花钱循环）；进程被杀留下的 `claimed` 超过 30 分钟可被接管（否则崩溃会静默跳过整个周期）。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types --test src/lib/server/stage-windows.test.ts` → **exit=0，12/12**（`logs/t09-verify.txt`）：**60 秒唤醒 × 29 次仅执行 1 次**（跨窗后再次执行）、重启后不重复、并发两路只准入一路、完成窗口报告 `already_ran`、**失败窗口不重试且报 `already_failed`**、抛异常记为 failed 而非遗留 claimed、陈旧 claim 超时可接管、未知 stage 拒绝、finish 不凭空造行、微信源 60 分钟约定锁定、阶段间隔锁定。
  - `node --test scripts/cron-loop.test.mjs` → **6/6**；`node --experimental-strip-types --test src/lib/server/cron.test.ts` → **19/19**；`npm test` → **234/234**；`npm run typecheck` → **exit=0**。
  - 迁移在**隔离真实 PostgreSQL 16** 验证（`logs/t09-migration.txt`）：20 项迁移全部应用成功、`stage_windows` 存在、**全量重放幂等 OK**、同 `(stage,window_key)` 冲突插入被阻止（`rowCount===0`）。自建容器已删除；55191/55192 未受影响。
- **过程中发现并修正的真实缺陷：**
  1. `claimed_at` 原用数据库 `now()`、窗口键用传入时钟 → 两个时间源混用，注入时钟下判断失真。改为**单一可注入时钟**（`to_timestamp($millis/1000)`）。
  2. 我的首版 tick 接入会**重复执行 ingest**（窗口内先跑一次、预算判断后又跑一次），已重写为在窗口回调内单次执行并捕获计数。
  3. 首版对账接入在**业务窗之外**取号，会消耗掉当天窗口、导致真正的 23:30 对账被静默跳过。已改为业务窗优先、仅在其内取号。
  4. 测试缺陷：30 次迭代跨窗导致断言错误（我的算术）；`.mjs` 别名导入假失败；`seed.ts` 按 `\n  {` 切块遇到无 `interval_minutes` 行的条目而误判。均已修正。
- **浏览器截图与实际查看：** 无新增前端交互（任务页 `stages` 展示属 T16），T19 统一验证。
- **资源/费用：** 隔离容器 + 纯函数；零真实采集、零模型调用、零付费。
- **已知限制与未完成项：**
  - `stages` 字段已进 `runProductionTick` 返回值，但 **cron 响应/UI 的结构化展示属 T16**。
  - 建议候选门槛"due-to-start P95 ≤ 120 秒"需要 **T17 容量评测**才能给数；本轮不修改门槛、也不声称达标。
  - 任务失败重试规则沿用既有实现，本轮未改。
  - 新迁移已入 `migrations/`，`npm run build` 的 `db:migrate` 会在下次构建时应用（T19 会在空 `DATABASE_URL` 下验证跳过路径）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T10。

---

## T10 — Telegram / B 站分页与安全游标

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 修改 `B/workers/telethon/server.py`（`history()` 改升序分页）、新增 `B/workers/telethon/test_history.py`
  - 新增 `B/src/lib/server/cursor.ts` + `B/src/lib/server/cursor.test.ts`
  - 修改 `B/src/lib/server/scheduler.ts`（`pickCursor` 用安全比较；**游标只在覆盖度被证明已达边界时推进**）
  - 修改 `B/src/lib/server/collectors/index.ts`（B站受控多页 + `coverage`）、`B/src/lib/server/collectors/types.ts`（`CollectorCoverage`）
  - 新增 `B/src/lib/server/collectors/pagination.test.mjs`
- **缺陷复现（期望/实际）：** 三处真实缺陷，均以红测试证实：
  1. **Telegram 中段永久丢弃**：`get_messages(min_id, limit=80)` 取的是**最新** 80 条（无 `reverse`），而旧代码把那批的最大 ID 当作新游标。cursor=100、新消息 101..350 时返回 251..350，游标跳到 350 → **101..250 永不采集，且无任何报错**。
  2. **游标精度丢失**：`pickCursor` 用 `Number()` 比较。红证据：`2^53+1`（`9007199254740993`）被压成 `9007199254740992`，断言 `'9007199254740992' != '9007199254740994'` 失败（`logs/t10-red-test4.txt`）。
  3. **B站只读第一页**：仅 `pn=1`（20 条）且 `bvid` 非数字 → `pickCursor` 退回 `items[0]`，游标跳到最新一条，中间视频被跳过。
- **最小实现：**
  - Telegram：`get_messages(..., reverse=True)` 升序取**最老未见**的有界页；`last_id` 只取该页最大值，由调用方持久化后才推进。首次 cursor=0 仍只取有界窗口（不拉全史）。
  - `cursor.ts`：纯字符串十进制比较（先比长度再字典序）、`canAdvanceCursor`（只前进、相等不算推进、非数字不接受）。
  - B站：最多 5 页 × 20 条，**遇到已知边界即停**（证明无缺口）；命中页上限则 `coverage.complete=false, note="page_cap"`；跨页去重。
  - 调度器：`coverage.complete === false` 时**不推进游标**（宁可在下一轮重扫，也不静默丢数据）。
- **验证命令/退出码/数量：**
  - Python（隔离 venv `artifacts/production-readiness/pr-20260916-a1/venv-t10`，不污染全局）：`python -m unittest discover -s workers/telethon -p 'test_history.py'` → 红（4 项 fail/error，见 `logs/t10-red-test4.txt`）→ **exit=0，5 tests OK**：升序页从游标开始、**逐页走完 101..350 无缺口**、首次不拉全史、FloodWait 不推进、**2^53+1 精度保持**。
  - `node --experimental-strip-types --test src/lib/server/cursor.test.ts` → **6/6**（含对照：证明 `Number()` 下两个不同 ID 相等）。
  - `node --test src/lib/server/collectors/pagination.test.mjs` → **6/6**：首页内边界一次读完、跨页边界读到即停、**超页上限报 incomplete**、短页证明边界、冷启动有界且不谎称完整、跨页去重。
  - `npm test` → **234/234**；`npm run typecheck` → **exit=0**。
- **过程中的问题（均为测试夹具/断言，产品行为正确）：** 缺依赖导致 5 项 skip（非绿，装隔离 venv 后重跑）；`sys.modules` 假 stub 抢占真实 telethon；`FakeMessage` 缺 `is_connected`/`web_preview`；`isinstance(msg, Message)` 过滤假消息；我的两处断言算错页边界（第 20/30 条位置）。失败尝试全部保留。
- **浏览器截图与实际查看：** 无前端改动。
- **资源/费用：** 全部离线假客户端；**未连接 Telegram、未登录、未读会话**。隔离 venv 位于本批 artifact 目录内。
- **已知限制与未完成项：**
  - Telegram 真实分页**未对真实账号验证**（需 T21 授权）；Python 依赖从网络安装到隔离 venv，未修改全局环境或 `requirements.txt`（镜像仍为 `telethon>=1.36`；本轮宿主 telethon 为 1.33.1，测试用隔离 venv 内的版本）。
  - B站 page-cap 为 5；高频频道会报 `page_cap` 并在下轮继续（不推进游标），其真实吞吐需 T17/T21 观察。
  - RSS/网页属有限窗口，`coverage.window_only` 字段已定义但**尚未在各 RSS 适配器上填充**——属 T11/T19 范围，未伪称已标记。
  - B站 `coverage` 已随 batch 返回但未写入 DB（不新增字段，符合计划"避免不必要迁移"）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T11。

---

## T11 — 全文保存与历史修复预览

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 修改 `B/src/lib/server/rss-parser.ts`（移除非微信 8000 截断；体积上限改为**所有平台**显式拒绝并标注）
  - 修改 `B/src/lib/server/scheduler.ts`（两处入库路径不再截断正文）
  - 新增 `B/src/lib/server/content-integrity.test.ts`；修改 `B/src/lib/server/rss.test.ts`（见下）、`B/src/lib/server/scheduler.test.ts`（补 merge 路径）
  - 新增 `B/scripts/content-repair-preview.mjs`（只读预览）
- **缺陷复现（期望/实际）：** 期望"超过 12,000 字符材料通过解析→入库→详情→检索仍可定位尾部"。实际三处截断：
  - `rss-parser.ts:122` 非微信 `slice(0, 8000)`
  - `scheduler.ts:146`（关键词入库）、`:273`（信源入库）`it.body.slice(0, 8000)`
  - 红证据（`logs/t11-red-test2.txt`）：断言失败 `stored body was cut at 8000 chars` —— 12,500 字符夹具（尾部唯一串 `TAIL-READINESS-12500`）在**解析阶段**即被砍到 8000。这正是既有长正文夹具无法发现该缺陷的原因：它断言的本就是已截断的正文。
- **最小实现：** 存储层不再截断（模型预算仍由 `agent-context` 负责，两层契约分离）。唯一的体积约束是传输级安全网：UTF-8 超过 `MAX_BODY_BYTES`（2 MiB）的正文**显式拒绝**（`body_error='body_too_large'` + `body_complete=false`），且从"仅微信"扩大到所有平台——不再无标记丢尾。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types --test src/lib/server/content-integrity.test.ts src/lib/server/rss.test.ts` → **9/9 pass**（红→绿，`logs/t11-red-test*.txt` → `logs/t11-test.txt`）
  - `node --experimental-strip-types --test src/lib/server/scheduler.test.ts src/lib/server/content-integrity.test.ts` → **10/10**，含新增 merge 路径长正文断言
  - `npm test` → **235/235**（较基线 +1，为 T11 新增用例）；`npm run typecheck` → **exit=0**
  - 预览脚本：`--help` exit=0；无数据集时**拒绝运行** exit=1（`logs/t11-preview-guards.txt`）；隔离 PGlite 上端到端输出只读 JSON（`scanned/needs_refetch/by_reason/sample`，**无正文**）
- **关于修改既有测试预期（计划禁止"改旧测试预期制造 PASS"，此处为有意且公开的产品变更）：** `rss.test.ts` 原用例名为"keeps the legacy 8,000-character limit for non-WeChat feeds"。该断言**编码的正是本次要修的缺陷**，因此未删除、未降级，而是重命名为「keeps a long non-WeChat body in full」并提高断言强度（`body.length === 原文长度` 且 `body_complete === true`），原地注明变更理由与新的证据位置。其余历史测试一律保留原断言。
- **过程中发现并修正的真实缺陷：** 预览脚本 `classifyCandidate` 用布尔 `false` 比较 `extra->>'body_complete'`，而 jsonb `->>` 返回**字符串** `"false"`，导致"已标记不完整"的行被漏判。实测发现（`logs/t11-preview-classify.txt` 中 `trunc-marked` 未命中）并修正，复验通过（`logs/t11-preview-classify2.txt`）。
- **浏览器截图与实际查看：** 无前端改动；长正文页面验证归 T19。
- **资源/费用：** 纯本地 PGlite 与文件；零外网、零模型调用。**未对任何真实库执行修复**。
- **已知限制与未完成项：**
  - **预览只有只读模式**：按计划，apply 模式需要"经授权的恢复副本 + 固定 manifest + 旧摘要校验"，属 T22/Gate B，本轮**刻意不实现**。
  - 被截断的历史正文**无法从自身重建**，一律标 `requires_authorized_refetch`；不"补造"尾部。
  - `at_cut_boundary`（恰好 8000 字符）是**特征而非证明**，可能与真实恰为 8000 字的文章混淆——报告用 `reasons` 区分，不将其单独当作确证。
  - 真实历史库中受影响行数**未统计**（需 Gate B 授权读取业务库）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T12。

---

## T12 — 媒体类型、提取输入与幂等

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 新增 `B/src/lib/server/media-kind.ts`（分类独立模块）+ `B/src/lib/server/media-kind.test.ts`
  - 修改 `B/src/lib/server/media.ts`（改用 `guessKind`）
  - 修改 `B/src/lib/server/extract-targets.ts`（`kindOf` 导出且以**实际 content-type** 为准；`asrFilename` 按真实 MIME 命名；不可分类目标明确关闭）
  - 修改 `B/src/lib/server/extract.ts`（`OCR_MAX_BYTES`，超大图**拒绝**而非截断）
  - 新增 `B/src/lib/server/extract-input.test.ts`；在 `keyword-contract.test.mjs` 增补 oversized-image 用例
- **缺陷复现（期望/实际）：** 四处真实缺陷，全部由红测试证实：
  1. **封面被当音轨**：B站条目 `media_type="video"` 而 `media_urls` 仅含 JPEG 封面，`kindOf` 见 `kind === "video"` 即判 ASR → 付费 STT 处理静态图。
  2. **扩展名优先级错**：`guessKind` 先看 `mediaType`，导致 `.mp3`（声明 audio）与 `.mp3`（声明 video）都判成 video；红测试 `audio extensions classify as audio` 失败。
  3. **STT 文件名硬编码**：`extract-targets.ts:86` 对所有音频/视频都传 `"media.mp4"`，音频文件被以 mp4 名提交。
  4. **超大图静默截断**：`extract.ts:46` `bytes.subarray(0, 4_500_000)` 把 JPEG/PNG 截断成**损坏图像**，仍会发起付费 vision 调用。
- **最小实现：**
  - `kindOf(target, contentType)`：**实际 content-type 优先**（描述真实字节），declared kind 仅作回退；已知但不可分类的 MIME（pdf/octet-stream）返回 `null` —— 不猜测、不调用模型。分类时机移到 `load()` 之后（拿到真实类型再决定）。
  - `asrFilename(contentType)`：按真实 MIME 给出 `.mp3/.wav/.ogg/.aac/.m4a/.webm/.mov/.mp4`。
  - `guessKind(url, mediaType)`：**扩展名优先**（依次 image → video → audio → file），无扩展名才用 declared kind。
  - `ocrBytes`：超过 `OCR_MAX_BYTES` 抛 `media_too_large`，**零模型调用**；不新增图像处理库做有损压缩。
  - 幂等保持：target key 稳定、已完成目标重跑 0 调用、失败上限 3 次、不可分类目标以 `unsupported_media_type` 终结（不永久 running）。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types --test media-kind.test.ts extract-input.test.ts extract-targets.test.ts` → **exit=0，22 tests / 22 pass**（`logs/t12-tests.txt`；红→绿过程见 `logs/t12-red-test.txt`）
  - `node --test collectors/keyword-contract.test.mjs` → **12/12**（含 oversized-image 用例）
  - `npm test` → **exit=0，235/235**（`logs/t12-npm-test.txt`）；`npm run typecheck` → **exit=0**
  - 关键断言：封面→OCR且 STT 调用为 0；实际类型覆盖声明类型；未知类型零模型调用且 job 以明确原因终结；已完成不重复计费；失败上限 3；哈希可复算；浏览器 URL 非回环。
- **过程中的问题：** 三处为我的测试缺陷（PGlite `query` 返回对象误按数组解构、`ok` 语义断言过严、把需要 `@/` 别名的 `extract.ts` 放进裸 Node 的 `.ts` 套件导致假失败）。后者按仓库既有方式改由 Vite runner 加载。失败尝试保留。
- **浏览器截图与实际查看：** 无新增前端交互；提取状态展示归 T19。
- **资源/费用：** 全部注入替身；**零真实 OCR/ASR 调用**，未读 Key。
- **已知限制与未完成项：**
  - 真实 OCR/STT 的语言、长度、时延与费用核对**未做**（清单随 T14/T21，需 Gate A 授权）。
  - `load()` 走 T05 的 25 MiB 媒体上限；`OCR_MAX_BYTES`（4.5 MB）是其更严的**模型侧**限制，两者关系已在代码注释中写明。
  - 落盘对象的真实读取/哈希比对需 MinIO 环境，属 T19/T21。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T13。

---

## T13 — 微信费用保守预留与诊断

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 修改 `B/workers/wechat-gateway/store.mjs`（`unknown` 状态 + `reason` 列 + 迁移；新增 `settleUnknown`/`listOverruns`/`lastReservationId`；`tryReserveSpend` 拒绝无上界的预留；`adjustSpend` 拒绝重开 unknown）
  - 修改 `B/workers/wechat-gateway/dajiala.mjs`（估价改为**注入的、经验证的上界**，不再硬编码 0.08/0.045；technical_error 细分 `timeout/network/rate_limited/provider_5xx/invalid_response`）
  - 修改 `B/workers/wechat-gateway/server.mjs`（env 提供上界；无上界则拒绝付费、详情入队；未知结果走 `settleUnknown`）
  - 修改 `B/env.example`（`DAJIALA_LIST_COST_RMB`/`DAJIALA_DETAIL_COST_RMB`，留空=关闭付费而非猜价）
  - 新增 `B/workers/wechat-gateway/t13-spend.test.mjs`
- **缺陷复现（期望/实际）：** 历史事故：日累计 1.92 后下一次按 0.08 预留、实际扣 0.14。实际代码中：
  - 估价被**硬编码**为 `estimatedListCost: 0.08` 并在 `catch` 中以 `adjustSpend(reservation, listEstimate)` 结算 —— 未知结果被记为估价，**可能已扣的 0.14 被记成 0.08**，且剩余预算被高估。
  - 没有 `unknown` 终态，也没有 overrun 的可见清单。
  - `technical_error` 单一码，无法区分限流/超时/供应商故障。
- **最小实现：**
  - **估价是预留（reservation）而非价格，也不是 cap**：改由 `DAJIALA_*_COST_RMB` 提供经验证上界；缺失/非法 → **付费准入直接拒绝**（主 Feed 不受影响，详情入队）。
  - **未知结果保留保守预留**：新增 `settleUnknown()`，金额不释放、不重估，状态 `unknown` 与 `settled`/`overrun` 区分；该预留**不可被重开成更小金额**。
  - **overrun 可见**：实际 > 估价记为 `overrun` 并进入 `listOverruns()`（含 excess 合计）。
  - **跨日归属**：结算按预留所属 day 记账，不因跨午夜泄漏到新一天。
  - **safe 错误细分**：5 个稳定子码，`attempt.error_code` 落地；**不含** URL/查询串/供应商正文/Key。
  - SQLite 迁移沿用既有 openStore 风格（重建表 + 原样搬移历史行，**不把历史 unknown/金额改写为 0**）。
- **验证命令/退出码/数量：**
  - `node --test workers/wechat-gateway/t13-spend.test.mjs` → **exit=0，9/9**（红→绿：首轮 7 fail，见 `logs/t13-red-test.txt`）：unknown 保留 0.08、unknown 不可被重开、overrun 记账 1.92+0.14=2.06、overrun 列表 excess=0.12、按真实花费而非估价守预算、跨日不泄漏、昨日 unknown 仍占预算、最后额度只给一个调用者、**无上界则拒绝准入**。
  - `npm run gateway:test` → **exit=0，116/116**（`logs/t13-verify.txt`）
  - `npm test` → **235/235**；`npm run typecheck` → **exit=0**
- **过程中发现并处理的问题：**
  1. 我的 `server.mjs` 补丁引入真实 bug：`createDajialaClient` 用解构参数而我引用了不存在的 `options` → 31 项失败。已修。
  2. 另一处我写了 `continue` 于非循环上下文 → 语法错误。已改为 `return "deferred"`（语义也更正确：详情留队列）。
  3. 既有 `gateway.test.mjs` 中 `serves authenticated source, health, and feed routes` 失败。**先用 HEAD 基线版本复现同样失败**（`logs/t13-baseline-isolation.txt`）证明与 T13 无关；随后**实证根因**：夹具文章日期写死 2026-08-28，而网关按 now-30 天清理（`deleteGatewayItemsBefore`），真实时钟已到 2026-09-16，条目被正常清理→7 天窗口为空。属**时间依赖的夹具老化**，非产品缺陷。按 `createGatewayServer` 既有 `now` 注入能力给该用例注入时钟，恢复其原意（**未削弱断言**）。
  4. `dajiala.test.mjs` 两处期望需随契约有意更新（估价改为 null + 可注入；`attempt` 新增 `error_code`），已在原处注明理由。
- **浏览器截图与实际查看：** 不适用（网关为后台服务）。
- **资源/费用：** 全部本地假供应商与内存 SQLite；**未查询真实账单、未调用真实供应商、未读 Key**。
- **已知限制与未完成项：**
  - 真实账单核对/风控恢复、真实续期与付费重试仍 **awaiting_authorization**（T21/T23）。
  - 价格上界的具体数值**必须由用户按账号实际单价提供**，本任务不代为填写。
  - 旧的、已发布的历史七天对账窗口未改动。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T14。

---

## T14 — C05 准备与模型配置来源核对

- **状态：offline_pass（准备部分）／C05 真实执行 awaiting_authorization**
- **代码基线与本项文件：**
  - 新增 `R/docs/operations/loom-real-service-acceptance.md`（配置来源表 + 待批准操作表）
  - 只读核对：`B/src/lib/server/model-config.ts`、`agent-client.ts`、`extract.ts`、`workers/agent/internal/agent/{config.go,mcp.go}`、`B/src/routes/model-settings.tsx`
  - **未修改任何实现代码**（计划："找不到缺陷就不修改实现"）
- **核对结论（每一条都做了实证，不靠读代码下结论）：**
  1. legacy 模型配置**每次调用读取**（热加载）：写入 `model: first` → 读得 `first`；改文件为 `second` → 再读得 `second`，`hot-reload: true`。
  2. **OCR/ASR 与模型设置页无关**：`extract.ts` 中 `readModelConfig|LOOM_MODEL_CONFIG` 出现次数 = **0**；它们用 `XAI_API_KEY` + 硬编码端点和模型（`grok-4.5`/`grok-stt`）。
  3. **Eino 与模型文件无关**：`workers/agent` 全部 Go 文件中 `LOOM_MODEL_CONFIG` 出现次数 = **0**；它只读 `AGENT_MODEL_*` 环境变量，且**启动时**读取（缺失即拒绝启动）。
  4. MCP 默认关闭（`AGENT_MCP_CONFIG` 为空即无 server）。
  - **关键结论：没有任何单一入口能控制全部引擎。** 模型设置页只作用于同步入口，Eino/OCR/ASR 各自独立。页内已有正确提示（"此处配置只作用于同步入口，Eino 仍读取其服务配置"），故未改 UI。
- **验收表已备（待用户填额度）：** 6 类操作（分析/库内问答/工具研究/OCR/ASR/采集），每类含操作 ID、目标服务、模型版本、最大请求数、金额上限、材料、期望结果、停止条件、回滚方式；所有额度字段写"待用户指定"，**助手未自填任何授权金额**。
- **验证命令/退出码/数量：**
  - 复用既有离线契约（未新造测试）：`agent-budget` **8/8**、`agent-client` **8/8**、`agent-runs`+`agent-queue` **16/16**、Go `test ./...` **ok**（`logs/t14-offline-contracts.txt`）
  - 配置来源实证（`logs/t14-config-claims.txt`）：热加载 true、OCR/ASR 独立计数 0、Eino 独立计数 0
- **浏览器截图与实际查看：** 未改前端（页内文案核对为正确）。
- **资源/费用：** 全部本地纯函数与源码 grep；**零真实调用**，未读取任何 Key 内容。
- **已知限制与未完成项：**
  - **C05 不能标 real_pass**：真实工具兼容性、usage 口径、账单与生产部署都未验证。
  - OCR/ASR 的端点与模型目前是代码常量；若用户希望它们可配置（跟随网关），属**产品范围变更**，需单独确认后再做。
  - MCP/Skills 无专门管理页面（默认关闭），未在 T14 扩大范围。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`、`R/docs/operations/loom-real-service-acceptance.md`
- **下一独立任务：** T15。

---

## T15 — 引用契约与检索评测

- **状态：offline_pass（本地范围）**
- **代码基线与本项文件：**
  - 新增 `B/src/lib/server/term-glossary.ts` + `B/src/lib/server/term-glossary.test.ts`
  - 修改 `B/src/lib/server/agent-context.ts`（`scoreItemMatch` 计入等价形式，权重 0.75 使原文命中优先）
  - 修改 `B/src/lib/server/agent-retrieval.ts`（SQL 候选阶段同样展开等价形式）
  - 修改 `B/validation/agent/retrieval-cases.json`（新增 2 类样本：数字冲突、平台范围）
  - 只读核对引用契约：`B/src/routes/knowledge.tsx`（库内引用=内部链接 Badge；外部引用=独立区块并标「服务来源」）、`B/src/routes/prd.tsx`
- **缺陷复现（期望/实际）：**
  - **c11 = 0.5**（复现，非推测）：查询「电动垂直起降」，`phrase-1` 正文只写「eVTOL 适航审定」→ 词法层 0 命中；`phrase-2` 命中 6 个词元。根因是**词汇鸿沟**（中文全称 vs 英文缩写），字符 n-gram 不可能跨越（`logs/t15-c11-repro.txt` 显示 `phrase-1 | matched terms: []`）。
  - 夹具**缺少**计划点名的样本类别：数字冲突、平台范围（核对确认 `numeric-conflict case present: false`）。
- **最小实现（不删案例、不降阈值、不按问题硬编码）：**
  - `TERM_EQUIVALENTS` 术语表以**数据**形式声明等价关系，`expandTerms()` 是通用函数；测试用**另一组无关词对**验证机制与具体条目无关（证明不是为这条问题写的分支）。
  - 匹配仍为词法（**未引入向量库**，符合计划）；等价形式权重 0.75，保证字面命中排在前面。
  - 候选阶段与排序阶段**都**展开——只改排序无法让只含缩写的文档进入候选集。
- **验证命令/退出码/数量：**
  - 改进前：`REVIEW_PG_PORT=… npm run agent:retrieval` → **recall<1 共 1 例（c11=0.5）**（`logs/t15-retrieval.txt`）
  - 改进后：**exit=0，26 例全部 recall=1**（`logs/t15-retrieval-final.txt`）：c11 **0.5→1.0**；**范围违规 0**、**无答案误取 0**、尾部引用覆盖保持 true；23 个既有案例**零回归**
  - 新增样本：c23（数字冲突，「A 线良率」同时召回 92% 与 88% 两条）+ c24（平台范围，同一短语两个平台均召回）
  - `node --experimental-strip-types --test term-glossary.test.ts` → **4/4**；`agent-context`+`agent-data` → **19/19**；`npm test` → **235/235**；`npm run typecheck` → **exit=0**（`logs/t15-verify.txt`）
- **引用契约核对（计划步骤 1—2，无缺陷故未改实现）：**
  - 库内引用渲染为指向 `/inbox/$itemId` 的内部链接；外部引用单独区块、标注「服务来源」——两类**已在 UI 上区分**，未被混淆。
  - 无真实工具收据时不产生外部来源（既有 C05 范围，未执行真实调用）。
- **环境事项（重要，已按计划规则处理）：** 评测脚本内部的 `git rev-parse` 会触发 Windows 目录所有权错误。按计划规则 7，使用**进程级** `GIT_CONFIG_*` 注入精确单一目录的 `safe.directory`，**未写全局 git 配置**（对照验证：不注入时报错，注入后正常）。
- **资源/费用：** 自建隔离 PG 容器（已删除）、纯本地词法计算；零模型调用、零外网。
- **已知限制与未完成项：**
  - **夹具通过 ≠ 真实领域通过**：新增样本是合成 fixture；真实业务脱敏样本清单仍缺用户材料（需用户提供或授权）。
  - 术语表目前仅 1 组（低空经济/eVTOL），按"错配比漏配更危险"的原则保守维护；扩展需领域确认。
  - 引用契约的**真实工具链**证据属 C05（T21/Gate A）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`、`B/validation/agent/implementation-v3-2026-09-08/retrieval-sql.json`
- **下一独立任务：** T16。

---

## T16 — 阶段日志、只读状态与告警闭环

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 修改 `B/scripts/cron-loop.mjs`（`summarize` 增 `stages`/`duration_ms`/`deferred`/`error_code`）
  - 修改 `B/src/routes/api/cron/tick.ts`（响应增 `duration_ms`）
  - 新增 `B/scripts/operations-status.mjs` + `B/scripts/operations-status.test.mjs`
  - 修改 `B/scripts/cron-loop.test.mjs`（新增 3 项）
- **缺陷复现（期望/实际）：** 原 `summarize` 只有 `timestamp/status/item_count/error_count` 四个字段，**所有阶段的失败被合并成一个数字**——运维只能看到"8 个错误"，无法判断来自采集、落盘、提取、对账还是微信队列；也没有耗时与延迟计数。计划要求"注入一次故障可定位"。
- **最小实现：**
  - `stages`：5 个稳定阶段名 → 短状态（`ok`/`partial`/`skipped`/或稳定错误码）；`error_code` 只含**稳定码**（形如 `production:production_failed`）。
  - **保留既有字段**（`timestamp`/`status`/`item_count`/`error_count` 语义不变），不破坏既有消费方。
  - `operations-status.mjs`：**只读**（不调用 `ensureSeeded`/`tick*` 等会改状态的入口），输出最近成功时间、最老队列、未知费用、备份年龄；有 alert 时**退出码 1**，便于 cron 判断。
  - 告警规则是**纯函数** `evaluateAlerts`，可直接测；**「备份不存在」与「备份过旧」是不同代码**（计划明确要求分开）。
  - **未新增任何外部通知渠道**：只写本地结构化文件；计划要求"用户选定渠道后再做"。
- **验证命令/退出码/数量：**
  - `node --test scripts/cron-loop.test.mjs` → **9/9**：分阶段可见（`production_failed` 被点名、其余可选区分）、健康 tick 全 ok 且 `error_code` 为空、**敏感信息不泄漏**（测试注入 `https://secret.example.com/hook?token=abc123` 与 `Bearer sk-live-999`，断言 summary 中不含 `secret.example.com`/`abc123`/`sk-live-999`/`Bearer`，且无法识别的文本降级为固定码 `failed`）。
  - `node --test scripts/operations-status.test.mjs` → **10/10**：健康零告警、阶段陈旧点名、从未成功=warning 而非误报 alert、**未上报的阶段不臆造**、队列积压独立告警、unknown 费用为 warning 且金额可见、**备份缺失 vs 过旧分开**、多问题同时上报、**脚本退出码语义**（缺备份 exit=1；有新鲜备份 exit=0；备份过旧 exit=1）、告警无非结构化输出且**报告中不出现任何 URL**。
  - `node --experimental-strip-types --test src/lib/server/cron.test.ts` → **19/19**；`npm test` → **238/238**；`npm run typecheck` → **exit=0**
- **过程中修正的自有问题：** `operations-status.mjs` 初版留了一段从未填充的 unknown-spend 探测（付费账本实际在网关 SQLite，不在 PG），会把硬编码 0 读成"无未知费用"这一本数据源无法作出的断言；已改为显式标注 `source: "not_queried_gateway_sqlite"`。
- **浏览器截图与实际查看：** 不适用（运维脚本与日志字段）。任务页对 `stages` 的可视化属 T19 范围。
- **资源/费用：** 本地 PGlite 与文件系统；零外网、零模型调用。
- **已知限制与未完成项：**
  - **真实告警渠道未接**（需用户指定）：当前只有本地文件 + 退出码。
  - 微信付费的 unknown 余额需**网关 SQLite** 才可读，本脚本明确不做；未伪称已覆盖。
  - 真正的"注入故障→告警→恢复解除"端到端演练需在 T19/T23 的运行环境做。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T17。

---

## T17 — 100/1000 源离线容量评测

- **状态：offline_pass（突发测量）**
- **代码基线与本项文件：**
  - 新增 `B/scripts/collection-load-check.mjs`、`R/docs/operations/loom-capacity-report.md`
  - 修改 `B/src/lib/server/scheduler.ts`（为 `runSourceJob`/`runKeywordJob`/`tickDueSources` 增加可选 `FetchIo` 缝，生产调用不传）
- **缺陷复现（期望/实际）：** 执行前**没有任何容量评测**。逐项实证（每次失败都保留了原始输出）：
  1. `pg.Client.query` 返回结果对象，初版按数组解构 → `(intermediate value) is not iterable`。
  2. **注入缝传错参数位**：`tickDueSources(limit, budget, io)`，初版传第二参数被当作 budget 吞掉 → `transport_calls: 0`、**16 源全部报错**（真实网络传输被使用）。
  3. **未设 `DATABASE_URL`** → 调度器落回进程内 PGLite，出现"采集成功（items_new=270）但库中 0 行"。
  4. **桩传输用调用计数当源索引** → 每次请求看似不同源，重放也新增（1080 条）、每源条数超 20。
  5. 第 2 轮未推进轮次、后又未回拨 due 时间 → 首版第 2 轮 0 源。
  6. 搜索端点收到 RSS 体 → B 站 JSON 解析失败（`invalid_response`）；这是 **T08 的正确行为**，在本评测中是噪声。
- **最小实现：** 真实 `tickDueSources` + 真实 PG + 真实入库路径，仅桩 transport；每轮按 `last_scanned_at` 回拨 1 小时模拟到期（等价时钟前进）；第 3 轮**重放同一内容**以验证去重。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types scripts/collection-load-check.mjs --sources 100` → **exit=0**（`logs/t17-100.txt`）：每轮 102 个源+关键词、第 1/2 轮各 +1000、**重放 +0**、**重复 0**、**每源 20 条**、错误 0、延迟 0
  - `--sources 1000` → **exit=0**（`logs/t17-1000.txt`）：31 tick/轮、第 1/2 轮各 +10,000、**重放 +0**、**重复 0**、**每源 20 条**、错误 0、延迟 0；DB 21.2 MB；单轮 3.9—4.1 秒
  - 慢源（每 97 次调用慢 120 ms）未造成饥饿：错误 0、deferred 0、每源条数均匀
  - `npm test` → **238/238**；`npm run typecheck` → **exit=0**
- **关于计划门槛的诚实结论：** 计划建议"候选小规模 due-to-start P95 ≤ 120 秒"。实测单轮排空仅 **3.9—4.1 秒**（单 tick 约 130 ms），但**这不是该门槛的证据**——门槛针对真实 5/10 分钟节奏与真实网络时延。**P95 门槛标记为未验证**，留给 T23。计划同时允许"测不到则明确降级范围，不改门槛掩盖"，此处即按降级处理。
- **浏览器截图与实际查看：** 不适用（后端负载）。
- **资源/费用：** 自建隔离 PG 容器（每次运行后自动删除并已核对为空）、纯本地生成 feed；零外网、零模型调用。
- **已知限制与未完成项：**
  - **突发测量，非持续运行**：不得作为 72 小时 / 7 天证据（T23）。
  - **不构成真实平台容量声明**：真实网络时延、限流、内容大小差异未覆盖。
  - 未覆盖媒体落盘/OCR/ASR/模型/微信付费；**内存峰值未采样**。
  - 因此 release-scope 中的规模承诺仍为 pending。
- **证据目录：** `B/artifacts/production-readiness/load/`、`B/artifacts/production-readiness/pr-20260916-a1/logs/`
- **下一独立任务：** T18。

---

## T18 — 汇总自动门禁与新迁移验证

- **状态：offline_pass**
- **代码基线与本项文件：**
  - 修改 `B/package.json`（`test` 聚合并入本批全部新增测试；新增 `test:all` 一条命令跑全套）
  - 清理 `B/artifacts/.pack-staging`（T04 打包残留，曾被 lint 扫到）
  - 修正 lint：`scripts/cron-loop.test.mjs`（我的）、`scripts/agent-integration-harness.mjs`、`scripts/wechat-validation-report.mjs`、`src/lib/app-data/client.server.ts`、`workers/wechat-gateway/atom.mjs`、`workers/wechat-gateway/server.mjs`、`src/lib/server/{agent-context,telegram}.ts`、`src/lib/server/wechat-gateway-client.test.ts`
- **缺陷复现（期望/实际）：**
  1. **新增测试不在聚合命令里**：T01—T17 新增的 9 个测试文件中，**7 个只在手工列表存在**（`readiness-offline`/`runtime-policy`/`restore-policy`/`deployment-policy`/`pack-source`/`operations-status` 及 3 个 Vite-runner 套件），`npm test` 不会跑到——正是计划点名的"只在手工列表存在"。
  2. **尚未启用（gateway:test）**独立命令，计划要求保留其独立性，但需可从单一入口触达。
  3. **lint 无法声称全绿**：`npm run lint` 报 410 errors，需区分基线与新增。
- **最小实现：**
  - `npm test` 聚合：scripts → Vite-runner（`@/` 别名套件）→ strip-types TS 套件 → 历史 review 套件；`npm run test:all` 串起 `test + gateway:test + typecheck + lint`。
  - lint：逐文件判定基线/新增后，**应用代码全部修至 0 error**（含 3 处真修复：字符类内多余转义 ×3、`Boolean(x?.y)` 冗余 ×2、`catch {}` 空块 ×4 加说明；`atom.mjs` 的控制字符正则加**带理由的定向 disable**，因为它正是要剔除 XML 非法控制符）。
- **验证命令/退出码/数量（计划列出的 8 道门，逐条独立日志）：**
  | 门 | 结果 |
  |---|---|
  | `npm test` | **exit=0**，聚合后 **388 项**（68+19+276+25；聚合前为 234） |
  | `npm run test:manual-fixes` | **exit=0，32/32** |
  | `npm run gateway:test` | **exit=0，116/116** |
  | `npm run typecheck` | **exit=0** |
  | `npm run lint` | 应用代码 **0 error**（剩余 380 error 全部位于 vendored `.agents/skills/comet/scripts/comet-hook-router.mjs`，HEAD 即存在、非应用代码、不随应用发布）；另有 `src/routes/inbox.tsx` 1 个既有 **warning**（未使用导入，非本批引入） |
  | `go -C workers/agent test ./... -count=1` | **ok** |
  | `go -C workers/agent vet ./...` | **exit=0** |
  | `npm run agent:pg`（隔离 PG） | **exit=0，18/18，零 skip** |
  | `npm run agent:retrieval`（隔离 PG） | **exit=0**，26 例、recall<1 **0**、范围违规 **0**、无答案误取 **0** |
- **迁移验证（计划步骤 4，隔离 PG 上 5 项）：**
  - (a) **0020 旧基线**：19 项迁移应用后 `stage_windows` 不存在（符合部署前状态）
  - (b) **升级到 0021**：仅应用新迁移即创建 `stage_windows`
  - (c) **重复执行幂等**：全量重放 OK
  - (d) **失败中止**：事务中途失败 → 回滚，探针表未残留
  - (e) **既有业务数据保留**：升级后历史行完好
  - 未修改任何历史迁移（0014/0015 等保持原样）
- **资源/费用：** 自建隔离 PG（已删除并核对为空）；零外网、零模型调用。
- **已知限制与未完成项：**
  - **Go race 未在本机重跑**：计划建议在 Linux 隔离容器跑 `-race`（复用 09-16 证据的命令/依赖缓存）。本轮在 Windows 上跑 test/vet 通过；race 证据沿用历史记录，**未伪造新证据**——需在 T19 或 T24 的 Linux 构建环境补。
  - `test:all` 中 `lint` 仍会扫到 vendored `.agents`；未改 eslint ignore（避免为通过而扩大配置变更），改以"应用代码 0 error"的精确结论记录。
  - `src/routes/inbox.tsx` 的未使用导入 warning 未清（非本批引入，且属 T19 前端范围）。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/t18-*.txt`
- **下一独立任务：** T19。

---

## T19 — 候选构建与 dev/built 端到端

- **状态：offline_pass（含一项如实标注的能力缺口）**
- **代码基线与本项文件：**
  - 新增 `B/scripts/readiness-e2e.mjs`（自建容器+迁移+夹具+dev+built 全流程）、`B/scripts/readiness-ui.mjs`（浏览器检查）、`B/scripts/screenshot-audit.mjs`（截图程序化审计）
  - 复用：`B/scripts/agent-e2e.mjs`（其 worker 二进制每轮独立临时路径，未覆盖 55192 占用文件）
- **缺陷复现（期望/实际）：**
  1. **计划步骤 1**：需确认 build 时 `db:migrate` 明确跳过 → 实测 `[migrate] DATABASE_URL not set — skipping`，**exit=0**（`logs/t19-build.txt`）。
  2. **计划步骤 2**：`npm run agent:e2e` 默认离线场景 → **exit=0**，18 次假模型、1 次 MCP、7 条 note、2 个持久检查点；容器 `loom-agent-harness-55166aaa` 自行清理；dev/built 截图生成。
  3. **计划步骤 3**：本批新增交互**没有** UI 覆盖 → 新建检查脚本。
- **最小实现：** 一个 runner 拥有整栈（隔离容器 → 20 项真实迁移 → 直接以 SQL 插入夹具 → dev 服务器 → 构建 → built 预览），浏览器侧检查 5 类 × 2 视口 = 10 项：
  T11 长正文尾部 `TAIL-READINESS-12500` 在详情页可见；T08 任务页能区分 `ok`/`error` 且部分失败可见；T08 关键词页本地范围**不**被显示成全部失败；T12 提取拒绝（`media_too_large`）不被显示为成功；T15 库内/外部引用可区分。**夹具经 SQL 直接插入，未新增任何生产用 QA 端点。**
- **验证命令/退出码/数量：**
  - `env -u DATABASE_URL npm run build` → **exit=0**，migrate 明确跳过
  - `npm run agent:e2e` → **exit=0**（18 假模型 / 1 MCP / 7 note / 2 checkpoint）
  - `node --experimental-strip-types scripts/readiness-e2e.mjs` → **exit=0**（`logs/t19-ui-e2e.txt`）：dev 与 built 各 **10/10 项通过、零 console/pageerror**；桌面 1280 与手机 390×844 均无横向溢出（DOM 宽度断言）
  - `node scripts/screenshot-audit.mjs`（20 张截图）→ **exit=0**：均为深色主题、内容占比 33%–56%、文字墨迹 0.75%–10.5%、**零问题**；dev 与 built 数值几乎一致（同一渲染）
- **⚠️ 如实标注的能力缺口（不掩饰）：** 本会话模型**无法接收图像输入**（我本人与派出的子代理均确认 `Media omitted ... model does not support image input`）。因此计划要求的"**实际查看截图**"**未能完成**。替代措施（均已执行并记录）：
  1. **DOM 级**：可见元素断言（`:visible`）、横向溢出与元素宽度断言、console/pageerror 全量捕获；
  2. **像素级**：`screenshot-audit.mjs` 检测空白页（内容占比）、文字墨迹、单色填充——覆盖计划点名的"blank/white page"首要失败模式；
  3. **诚实边界**：像素统计**不能**判断重叠、裁切、对齐、观感。此项列入 T20 的待办与 T24 门禁（需有视觉能力的复核者或用户本人看一眼）。
- **过程中的问题（自有缺陷，均保留追溯）：** runner 缺 `try {` 与大括号导致语法错误（多轮修复）；UI 脚本先依赖了不存在的 seed 端点（改为 runner 直接 SQL 插夹具）；`keywords.tsx` 渲染 `<section>` 而非 `<article>`（选择器修正）；页面存在桌面/移动两个 `h1`，其一隐藏（改用 `:visible`）；dev 的 HMR WebSocket 噪声被误判为应用错误（仅对该模式加了带理由的豁免，built 无 HMR）；截图审计**初版假设浅色主题**，把深色页面误报为 99% "dark"（改为按实测背景色判断主题）。
- **资源/费用：** 自建隔离容器（每次自清洁，已核对为空）；零外网、零真实模型调用。
- **已知限制与未完成项：**
  - **截图未经人眼/视觉模型查看**（见上），属未完成的验证项。
  - **Go `-race` 未重跑**（沿用 T18 说明，需 Linux 环境）。
  - 断网专项、模型设置页、异步离线面板等**既有**脚本未重跑：本批未改动其相关源码（scheduler 仅新增可选参数、`http.ts` 走策略但假服务仍是本机回环），按计划"不盲目重复无变化测试"。
- **证据目录：** `B/artifacts/production-readiness/ui/`、`B/artifacts/production-readiness/pr-20260916-a1/logs/t19-*`、`B/screenshots/readiness-{dev,built}-*.png`
- **下一独立任务：** T20。

---

## T20 — 离线候选完成审计与真实门清单

- **状态：offline_pass（L0 达成）**
- **代码基线与本项文件：**
  - 新增 `B/artifacts/production-readiness/pr-20260916-a1/candidate-manifest.md`（哈希/迁移/公共配置变量名，**不含秘密**）
  - 新增 `R/docs/operations/loom-release-candidate.md`
  - 新增 `R/docs/operations/loom-authorization-checklist.md`
  - 更新 `R/docs/operations/2026-09-16-release-scope.md`（状态仍为 proposed）
- **审计结果（逐项核对，未虚构）：**
  - T01—T19 每项都有落盘证据（按任务前缀统计：最少 2 个文件，最多 29 个；全部位于本批 artifact 目录）。
  - 每项状态与验证数量已在各自章节记录；**无一项凭记忆宣称通过**。
- **候选 manifest 内容：** 分支/HEAD/Node、本批新增与修改的文件清单、20 个迁移文件、13 个关键文件哈希、env.example 中的公共配置**变量名**（无值）。**零 Key、零账单标识。**
- **真实门清单（逐门列明，字段缺失即不执行）：** Gate A（真实服务最小验收）、Gate B（业务数据迁移）、Gate C（长期试运行）、Gate D（正式发布）。每道门都写明：唯一环境、源/服务、次数/金额上限、时间窗、停止条件、回滚资源；**所有额度字段均为"待用户指定"，助手未自填**。
- **如实边界：**
  - **可称 L0（离线候选完成）**；**不可**称生产就绪或受控试用可用。
  - 未完成项已在候选说明第 6 节逐条列出（截图未经人眼、Go race 未重跑、P95 未验证、真实服务/Gate A-D 未做、8182 无备份等）。
  - 原始失败尝试全部保留，未删除任何失败日志。
- **资源/费用：** 仅本地文件与统计；零真实调用。
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/`、`R/docs/operations/loom-*.md`
- **下一独立任务：** T25（指南与交接；T21—T24 待授权）。

---

## T25 — 完整使用指南、运营手册与最终交接

- **状态：offline_pass（L0 阶段的指南已交付；L1/L2 后需按实际验证更新）**
- **代码基线与本项文件：**
  - 新增 `R/docs/operations/loom-user-quickstart.md`、`R/docs/operations/loom-release-handoff.md`
  - 修改 `R/docs/使用指南.md`（v1.3 → v1.4：修正"适配器=可用"误导、补范围语义与失败可见性）
  - 修改 `B/src/routes/guide.tsx`（B站只有封面非音轨、YouTube 非全站、抖音/小红书/西瓜**无内置检索**、关键词范围语义、去重措辞）
  - 修改 `B/README.md`（状态标注、平台能力更正）
  - 新增 `B/scripts/guide-walkthrough.mjs`（按指南步骤实走验证）
- **缺陷复现（期望/实际）：** 期望"用户只依指南完成一次有用研究"。执行前实际：指南与 README 存在**过度承诺**——把"有适配器"写成平台可用、把 YouTube 检索写成全站、未说明「信源」范围不联网、也未说明 B 站媒体只有封面。前述任务（T08/T11/T12）已修正行为，但**文档仍与行为不一致**。
- **最小实现：**
  - 文档按"用户动作"覆盖：启动、信源、关键词（含范围语义）、任务失败查看、内容库、知识库、模型设置、备份、故障定位。
  - 明确区分级别：指南开头即标注 **L0 离线候选**，并指向候选说明与授权清单。
  - 明确不承诺项：无内置全站检索的平台、YouTube 非全站、公网/多租户、1000 源持续运行。
- **验证命令/退出码/数量：**
  - `node --experimental-strip-types scripts/guide-walkthrough.mjs` → **exit=0，11/11 步**（`logs/t25-walkthrough.txt`）：隔离容器+20 迁移 → 应用启动 → 夹具先于首次页面加载 → 总览可读 → 信源页可见新源 → 关键词页**范围语义可见**（检索 vs 信源）→ 任务页**失败原因可见**（HTTP 500）→ 内容库可见条目 → 无模型 Key 时有明确提示 → **console/pageerror 干净**；容器自清理（已核对为空）。
  - `npm run typecheck` → **exit=0**（guide.tsx 改动后）
- **过程中发现并修正的问题（均为我的脚本/夹具缺陷，产品无回退）：**
  1. `try` 块与大括号缺失导致语法错误（多轮修复）。
  2. 依赖了**不存在的 QA 写入端点**——已移除；夹具改由 runner 直接 SQL 插入（不为测试新增生产端点）。
  3. **React Query `staleTime: 12s`**：页面先加载、夹具后插入时会读到缓存，导致"源不可见"的假失败。改为**夹具先于首次页面导航**。
  4. 页面文案断言取的是首屏 `innerText`，而 RSS 分组在页面末尾 → 改为滚动到该分组再断言。
  5. 内容库断言同样受加载时序影响 → 增加等待与失败时的载荷回显（便于定位）。
- **浏览器截图与实际查看：** 生成了 `screenshots/walkthrough-*.png`；**仍无法目视查看**（本会话模型无图像输入，已在 T19 章节如实记录）。像素审计工具可复用于这些图。
- **资源/费用：** 自建隔离容器（自清理）；零外网、零模型调用。
- **已知限制与未完成项：**
  - 指南中**真实资料示例**尚无（需用户提供或 Gate A 授权材料）；当前示例为结构说明。
  - `docs/使用指南.md` 的 Docker 生产章节未逐条重验（属 T24/Gate D 范围）。
  - 指南页与 `docs/使用指南.md` 内容需人工保持同步（本轮已同步本轮改动点）。
- **证据目录：** `B/artifacts/production-readiness/walkthrough/`、`logs/t25-walkthrough.txt`
- **下一独立任务：** T21—T24（均需用户授权）。

---

## T21 — 真实服务最小验收（Gate A，部分完成）

- **状态：部分 real_pass**（分析、库内问答、零成本采集）；**工具链 / OCR / ASR 未测**（未授权）；**微信实测不可用**
- **授权**：用户 2026-09-16 22:53 批准（分析 ≤3 次/≤1 元、问答 ≤3 次/≤1 元、平台范围含微信、MCP 不测、OCR/ASR 不测）
- **执行**：隔离 PG（自建容器，20 迁移）+ 真实网关 `localhost:10100` 模型 `gpt-5.6-luna`（legacy）
- **额度合规**：分析 3 次操作（4 次模型调用）、问答 3 次操作（4 次模型调用）；MCP/OCR/ASR/微信 **0 次调用**；**费用 unknown**（未声称 0）
- **成果：**
  - **分析 2 条**（312/289 字符，内容与原文相符）；1 条 `model_timeout` → `outcome_unknown`（未自动重试，正确）
  - **库内问答 1 条**（148 字符），**引用 2/2 逐条回查库中真实存在，零伪造**
  - **采集**：爱范儿 RSS 20 条、少数派 RSS 20 条、Telegram `@telegram`/`@durov` 各 20 条、YouTube 频道 RSS 15 条 → 入库 **34 条真实内容**
- **发现的问题：**
  1. **网关不返回 token usage**（成功调用 `model_calls=1` 但 tokens 全 null）→ 费用无法从账本核算，熔断只能按次数
  2. **40 秒超时偏紧**：5 次调用 3 次撞上限，成功用时 31—32 秒（占上限的 78%—80%）。
     **已调整为 120 秒**（`analyze.ts`，legacy 路径）；Eino 的 45 s 与 OCR/ASR 的 45/60 s **未动**（无实测依据）。
     ⚠️ **效果未实测**——改动发生在授权窗口用尽之后；下次授权时须一并复验（见 `loom-real-service-acceptance.md`）。
  3. **本机 DNS 是 fake-IP 代理**（全域名 → `198.18.0.0/15`），T05 的 SSRF 防护正确拦截 → 新增 `LOOM_EGRESS_CIDRS`（默认关闭、仅声明生效、loopback/元数据永不放行，26 项测试通过）
  4. **B 站接口限流**：实测返回 `{"code":-799,"message":"请求过于频繁"}`（**HTTP 200 内的业务错误码**）。
     原代码只在 `code !== 0` 时抛通用错误，**限流与普通故障无法区分**，会按原频率持续重试。
     已修：`-799/-412/-509` 识别为稳定码 `rate_limited`（`collectors/index.ts` + `keyword.ts` 的 `classifyFailure`）；
     **B 站默认间隔 180 → 360 分钟**（两个 seed 源）；指南补充说明。红→绿测试 8/8（`logs/t21-bili-*.txt`）。
  5. **微信公众号实测不可用**：上游 wewe-rss 被风控（11 次 risk_control、最后成功 9-02），Feed 与库内正文全空 → 按用户决定**降级为不纳入首版**（证据见 release-scope §2.1）
- **事件（已恢复）**：2026-09-17 01:35 宿主 Docker 整体重启，55191/55192 以 `Exited (255)` 停止；助手仅对 `loom-t21-*` 容器操作，但事件发生在执行窗口内，已如实记录。原容器+原数据卷恢复，数据核对 **items=81 / ai_runs=11 / analyses=1 / notes=8** 与交接基线**完全一致**。记录：`2026-09-16-t21-incident-and-restore.md`
- **证据目录：** `B/artifacts/production-readiness/pr-20260916-a1/logs/t21-*`、`.../wewe/`
- **待用户决定：** 超时时长、usage 缺失、B 站退避、Key 轮换
- **下一门：** T22（Gate B，需新的具体授权）

---

## T21-b — 超时复验与 usage 归因（2026-09-17）

- **状态：代码修复完成；端到端复验待下一次授权**
- **授权**：A2-b（分析 ≤3 次 / ≤1 元 / 11:05—13:05），实际用 3 次，未超用
- **实测结果**：1/3 成功；失败两次用时 **58.5 s / 61.7 s**，成功那次 25.4 s
- **两项修复（均为真实缺陷）：**
  1. **usage 被丢弃**：网关返回 `usage`（实测 `prompt_tokens: 7, completion_tokens: 5`），
     但 `legacy-output.ts` 硬编码 `input_tokens: null, output_tokens: null`，`chat()` 也从不读取。
     → 已贯通提取与累加记录；缺 usage 保持 null（不伪装 0）。
  2. **租约短于工作时长**：`expires_at` 固定 60 秒，而 analyze_item 允许 2×120 秒、research 6×120 秒。
     实测两次失败（58.5 s / 61.7 s）都因超过租约被 `ownsRun` 拒绝写入 → 上报 `persist_failed` / `invalid_output`。
     → 租约改为 `max_model_calls × 120 s + 60 s` 余量（analyze/briefing 300 s、research 780 s）。
- **验证**：`analyze.test.ts` **16/16**（含 usage 落库、无 usage 保持 null、三入口租约 > 预算）；`npm test` **285/285**；typecheck 0
- **附带发现（未改）**：`finishAnalyzeAtomically` 把多类失败统一归为 `persist_failed`，掩盖真实原因
- **证据**：`logs/t21b-{verify,summary,usage-red,usage-green3,lease-green3,offline-rootcause}.txt`
- **下一步**：下一次真实授权需同时确认 usage 落库与长材料落库成功率

---

## A2-c — 端到端复验通过（2026-09-17 14:00）

- **状态：两项修复均已真实确证**
- **授权**：A2-c（分析 ≤1 次 / ≤0.5 元 / 14:00—16:00），实际 1 次，未超用
- **结果（3/3 检查通过）**：
  - **usage 落库** ✅ `input_tokens: 9463`、`output_tokens: 1658`（此前恒为 null）
  - **长材料落库** ✅ 12,639 字符 → 396 字符分析入库
  - **在租约内** ✅ 35.9 秒 < 300 秒
- **对比（同一材料）**：修复前 `invalid_output` / 58.5 s / 无落库 / usage null → 修复后 `succeeded` / 35.9 s / 已落库 / usage 完整
- **累计真实调用**：12 次（T21-1 4、T21-2 4、T21-b 4、A2-c 1）
- **仍未验证**：库内问答在 780 s 租约下的表现（上次 2/3 超时）；长材料成功率的统计稳定性（当前为单点）；实际费用金额（usage 可读但单价未知）
- **证据**：`logs/t21c-verify.txt`、`logs/t21c-db-export.json`

---

## A2-d — 库内问答复验通过（2026-09-17 14:13）

- **状态：通过（4/4 检查）**
- **授权**：A2-d（问答 ≤1 次 / ≤0.5 元 / 14:13—16:13），实际 1 次，未超用
- **结果**：160 字符回答落入 `knowledge_notes`；**usage 18187/699 已落库**；**引用 1/1 可核验**；用时 **16.3 秒** < 780 秒租约
- **回答质量**：主动声明"材料未提到发布 iPhone 18 标准版"——符合"无依据不编造"的契约
- **与修复前对比**：T21-2 为 1/3（2 次撞 40 s 超时 + 60 s 租约）；本次 1/1，差异正对应两项修复
- **修复后累计**：2 次真实调用全部成功（A2-c 分析、A2-d 问答）；**样本量小，不足以给统计结论**，准确表述为"两个根因已被单点确证消除"
- **证据**：`logs/t21d-verify.txt`、`logs/t21d-db-export.json`

---

## T22（部分）— 生产库只读备份 + 恢复演练 + git 推送（2026-09-17）

- **状态：备份完成（仅备份，无恢复/停写/切换）；git 已推送新分支**
- **授权**：用户批准 (a) 生产库只读 pg_dump → `F:\loom-backups\`，记录 SHA-256 与迁移清单，**不恢复/不停写/不切换**；(b) 推送远端一次
- **备份结果**：
  - `F:\loom-backups\loom-prod-20260917-141815.dump`，1,595,256 字节
  - SHA-256 `fc118253653a6033aec0c3b4c60c481d6af2a632cd5a56ba81a49ff0d99f763d`
  - `PGDMP` 头部校验通过；`pg_restore --list` 可读（101 条目、关键表齐全）
  - manifest：`F:\loom-backups\manifest-20260917-141815.json`
- **备份时的真实业务数据**：items **2,409**、sources 26、jobs 4,538、keywords 8；analyses/notes 均为 0；**备份时仍在活跃采集**（最新 06:05Z）
- **重要发现（当时）**：生产实例缺 `0021_stage_windows.sql`（19/20）→ **已于同日修复**，见下方"生产库迁移 0021"章节
- **git 推送**：
  - 提交 `58aa85f`（272 文件，+26,745/−1,191）
  - 推送到**新远端分支** `origin/comet/local-model-settings`；**远端 `main` 未改动**（仍 `db99bb1`）
  - 推送前秘密扫描：`config/model.local.json` 与 `.env` 已被 gitignore；暂存区扫描仅命中**测试夹具假值**（`offline-intercept-only` 等），无真实 Key
- **恢复演练（同批获批）**：把 dump 恢复到**新建隔离库** `restored_20260917`
  - `pg_restore --exit-on-error --no-owner --no-acl` → **exit=0，零错误**
  - **逐表核对 6/6 与 manifest 完全一致**（sources 26 / items 2409 / keywords 8 / jobs 4538 / analyses 0 / notes 0）
  - 18 张表全部恢复、迁移 19 项；`external_id` 2409/2409、`published_at` 2409/2409、非空正文 2301；中文编码完整
  - 有序行摘要两次一致（`f208a767…`）；业务数据（平台分布、2026-09-17 最新条目）可读回
  - 损坏归档被 `pg_restore` 拒绝（守卫有效）；目标库先确认不存在才创建
  - **结论：这份备份是可用的**
- **附带发现**：恢复副本中**正文恰为 8000 字符**的条目 **10 条**（旧截断特征，2026-08-28 ~ 09-16）；
  T11 只读预览脚本对恢复副本报出 **33 条需重抓**（at_cut_boundary=10、marked_incomplete=23），
  这些历史尾部**已永久丢失**，补全需授权重抓
- **未做（需另行授权）**：定期备份、生产迁移部署、切换、停写窗口下的完整流程演练、MinIO/网关 SQLite/Telethon 会话备份演练
- **证据**：`loom-backup-restore-runbook.md` 末节、`artifacts/t22/migrations.txt`

---

## T22（续）— 三项资产备份演练（2026-09-17）

- **状态：两项通过、一项无对象可备（真实状态）**
- **授权**：用户批准「补齐另外三项备份演练（MinIO / 网关 SQLite / Session）」
- **全过程只读源系统、未停止任何服务**

### MinIO ✅ 通过

| 项 | 值 |
|---|---|
| 规模 | **332 对象 / 65 MiB**（`mc du` 经 S3 API 读取，非直接读盘） |
| 备份 | `F:\loom-backups\minio-20260917\mirror\`（66 MB） |
| **恢复验证** | 灌入**全新隔离 MinIO** → **332/332 对象、65 MiB** |
| **内容校验** | **逐对象 ETag：0 缺失 / 0 多余 / 0 不一致** |

### 网关 SQLite ✅ 通过

| 项 | 值 |
|---|---|
| 方式 | **`VACUUM INTO`**（SQLite 备份 API 等价物），**服务未停** |
| 备份 | `F:\loom-backups\gateway-20260917.sqlite`，SHA-256 `a021877e…` |
| `integrity_check` | **ok** |
| 内容 | 7 张表，`gateway_items` 36、`provider_reservations` 27、`gateway_sources` 5、`provider_usage` 3；业务样本可读 |
| 附注 | 源库**当前无 `-wal` 文件**，故"直接复制"这次也恰好一致；但那只说明此刻无待合并写入，**仍以 `VACUUM INTO` 为准** |

### Telethon 会话 ⚠️ 无会话可备份

- 卷 `…_telethon-session` **完全为空**；`TELEGRAM_SESSION` 为空；health `authorized: false`
- **这是真实状态而非演练失败**：worker 未登录，没有会话密钥
- 影响：Telethon 路径不可用，**网页预览回退仍可用**（实测 `@telegram`/`@durov` 各 20 条）
- 启用需交互式登录（Gate C/D 范围，未做）；登录后的备份须**加密、不入 git、只记哈希**

### 汇总与未覆盖

| 资产 | 备份 | 恢复验证 |
|---|---|---|
| PostgreSQL | ✅ | ✅ 逐表 6/6 一致 |
| MinIO | ✅ 332 对象 | ✅ ETag 零差异 |
| 网关 SQLite | ✅ | ✅ integrity ok + 内容读回 |
| Telethon 会话 | n/a | n/a |

**总清单**：`F:\loom-backups\INVENTORY.json`（含 SHA-256）

**仍未覆盖**：异地副本（全在本机同盘）、加密、自动化（手工执行）、MinIO/网关的**应用级**端到端恢复。

---

## 异地副本 — G:\QBXT_0917（2026-09-17）

- **状态：已完成并通过可恢复性验证**
- **授权**：用户指定 `G:\QBXT_0917` 作为异地副本位置
- **位置**：`G:\QBXT_0917\loom-backup-20260917\`（68 MB）；清单 `OFFSITE-MANIFEST.json`（源/副本双份 SHA-256）
- **校验（全部通过）**：
  - 文件级：`cmp` 逐字节 **4/4 相同**；SHA-256 双份一致
  - MinIO 镜像：**逐对象 CRC32，332/332 相同**（0 缺失 / 0 多余 / 0 不一致）
  - **可恢复性**：从**异地副本** `pg_restore` 到全新隔离库 → **exit=0**，
    数据 sources 26 / items 2409 / jobs 4538 / keywords 8 / migrations 19，**中文无乱码**
  - 网关 SQLite：异地副本直接打开 → `integrity_check=ok`，gateway_items 36，provider_reservations 27
- **解决了**：单目录损坏不再导致备份全失
- **未解决**：两端在**同一台机器**（整机故障/勒索软件仍会全失）；**未加密**；**无自动同步**
- **证据**：`G:\QBXT_0917\loom-backup-20260917\OFFSITE-MANIFEST.json`、runbook 末节

---

## 生产库迁移 0021（2026-09-17）— 已完成，未停写

- **状态：迁移完成并验证通过；业务全程未中断**
- **授权**：用户批准「生产迁移（含 0021）」，选择**只加表、不停写**
- **迁移前评估（决定不停写的依据）**：0021 **仅**创建新表 + 2 个索引，**不 ALTER、不 UPDATE**；
  生产 app 容器是**旧构建**（无 `stage-windows.ts`，不读该表）；无阻塞会话 → **无需停写窗口**
- **回滚资源**：`F:\loom-backups\loom-prod-premigrate-20260917-160638.dump`
  （SHA-256 `1d619a23…d42e4`，已同步异地副本；迁移前 items=2420 / sources=26 / jobs=4587 / migs=19）
- **执行**：单事务内 `CREATE TABLE` + `CREATE INDEX`×2 + `_migrations` 记录 → **COMMIT，exit=0**
- **迁移后验证（全部通过）**：
  - 表 + 3 个索引（pkey/status/claimed）+ 2 个约束齐全
  - 迁移记录 **19 → 20**
  - **旧数据完全一致**（items=2420 / sources=26 / jobs=4587）
  - 新表可插入/查询/删除
  - **容器全部未重启**（Up 7h）；**迁移后 10 分钟内新增 6 条**，采集正常
- **迁移后基线备份**：`loom-prod-postmigrate-20260917-160825.dump`（SHA `8514855d…`，已同步异地副本）
  → 恢复验证 exit=0、items=2420、migrations=20、`stage_windows` 存在
- **明确未做**：**未重启容器、未更新镜像**，故生产仍运行旧代码，**不使用** `stage_windows`；
  新调度行为（60s 唤醒 + 重阶段窗口）需**部署新代码**后才生效（属 T24 发布范围）
- **回滚**：`drop table stage_windows; delete from _migrations where name='0021_stage_windows.sql';`
  （本迁移只新增对象，回滚不需恢复整库）
- **证据**：runbook 末节、本记录

---

## T24 — 正式发布（2026-09-17）：**已切换，期间发生助手造成的生产事故并已修复**

- **状态：real_pass（含事故）**——新代码已上生产并验证；事故已恢复
- **授权**：用户批准（a）用工作树 B 构建新镜像；（b）接受 `LOOM_EGRESS_CIDRS=198.18.0.0/15`；（c）只更新 app + scheduler；（d）授权方案 A 修复事故
- **方案**：**不覆盖根目录 R**（R 有独立提交 `db99bb1`），改从工作树 B 构建 `loom-app:readiness-20260917`，
  compose 中把 app/scheduler 的 `build: .` 换成 `image:`
- **切换前兼容性演练（全部通过）**：用生产备份恢复隔离库 → 新镜像连接 → 页面 200、真实数据 60 条链接渲染、
  **`stage_windows` 被新调度使用**、采集错误均为真实上游响应（`rate_limited(-799)`/404/412/timeout），**零 `blocked_address`**
- **切换**：18:50:34 停 scheduler → 18:50:44 app healthy，**共 10 秒**

### ⚠️ 事故（助手失误，已如实记录于 runbook）

执行 `docker compose up -d --no-build app scheduler` 时传了 `MINIO_ROOT_PASSWORD=x`、`CRON_SECRET=x`、
`WECHAT_GATEWAY_TOKEN=x` 等**占位值**。`compose up` 会**重新解析全文件并把变量注入所有相关服务**，
导致 minio / telethon / wechat-gateway 的真实凭据被覆盖：
- **MinIO** 密码变 1 位 → 启动校验失败 → **Restarting 循环**
- app 的 `CRON_SECRET`/网关令牌被污染 → tick 与网关调用不可用

**数据零损失**：MinIO 340 对象 / 66 MiB、PG items=2441 / migrations=20 全部完好（事故只影响环境变量）。

### 修复（用户授权方案 A）

| 凭据 | 方式 |
|---|---|
| MinIO 用户/密码、`WECHAT_PRIMARY_ALLOWED_HOSTS` | ✅ 从**未受污染的** `minio-init` 容器恢复 |
| `CRON_SECRET`、`WECHAT_GATEWAY_TOKEN` | 原值无副本 → **经授权重新生成**（64 位随机），成对注入 |

新令牌存 `F:\loom-backups\.env.t24`（600 权限、工作树外、未入 git）。修复用**每服务单独 `--no-deps`** 重建。

### 修复后验证（全部通过）

| 检查 | 结果 |
|---|---|
| 凭据长度 | app 64/64/21、scheduler 64、gateway 64、telethon 21、minio 21 |
| MinIO | ✅ healthy，340 对象 / 66 MiB |
| tick | ✅ HTTP 200 |
| **端到端采集** | ✅ `ran: 5`、**`items_new: 3`**、**`collection_errors: 0`** |
| **T16 分阶段日志** | ✅ `{"stages":{"collection":"ok","production":"ok","reconciliation":...}}` |
| **T09 窗口机制** | ✅ `stage_windows: ingest \| done \| stored=0 errors=0` |
| **T09 唤醒频率** | ✅ 日志时间戳显示每 60 秒 |
| 页面 | ✅ /、/inbox（60 条真实链接）、/keywords、/jobs 均 200，零 console 错误 |

### 回滚资源（保留）

- 旧镜像标签：`loom-rollback:app-20260917`（`5c386de1a3a3`）、`loom-rollback:scheduler-20260917`（`cea7e671ca0a`）
- compose 备份：`F:\loom-backups\docker-compose.yml.pre-t24-backup`
- 备份：迁移前/后 dump 各一份 + 异地副本

### 明确未做

- **未更新 wechat-gateway 代码**（用户选择只更新 app+scheduler；其容器仅因事故被重建，代码仍是旧镜像）
- 未启用 `AUTO_ANALYZE` / OCR 自动 / 付费兜底；未恢复微信试点
- `agent` 容器仍 `Restarting`（**既有故障**，切换前即存在，未处理）

---

## 未处理项登记：弱默认生产凭据（2026-09-17 登记 → **2026-09-21 已解决**）

- **状态（2026-09-17）：known risk accepted（用户明确选择 B：先不改，记录待办）**
- **状态（2026-09-21）：✅ 已加固完成并验证** —— 用户决定执行，与端口收窄同批完成
- **实测（登记时）**：postgres `POSTGRES_PASSWORD=` 弱默认值；minio `MINIO_ROOT_PASSWORD=` 弱默认值；
  app/telethon `MINIO_SECRET_KEY` 同上（`T04` 改了 compose 模板，但**运行中的容器仍是旧默认值**）
- **缓解（登记时）**：PG 无宿主端口、MinIO 仅本机、单机未暴露公网
  —— ⚠️ **其中"MinIO 仅本机"于 2026-09-19 实测被推翻**（端口实为全网卡），见 `loom-release-runbook.md`
- **风险（登记时）**：同宿主进程可用公开凭据访问；未来暴露网络则风险放大
- **交付**：完整加固步骤（命令/验证/回滚）写入 `loom-release-runbook.md`
- **执行结果（2026-09-21）**：PG 与 MinIO 均轮换为 48 位随机口令（旧口令实测失效）、
  端口收窄到 `127.0.0.1`（局域网实测不可达）、凭据外置到 `F:/loom-backups/` 并按服务最小化。
  数据零丢失（items=2838、381 对象），完整 `down` + `up` 后仍生效。
  **详情见 `loom-release-runbook.md` 的「✅ 执行记录（2026-09-21）」。**

---

## 汇总状态表（2026-09-21）

离线通过仅覆盖对应代码与夹具，不等于真实平台或长期生产验收。`partial_real_pass` 表示部分真实范围通过；已执行的授权不需要重复申请，但不自动扩展为新的付费或规模授权。

| 任务 | 名称 | 状态 | 说明 |
|---|---|---|---|
| T01 | 固定基线、范围与隔离运行入口 | offline_pass | 6/6 通过；两条泄漏路径已证并阻断 |
| T02 | 正式运行缺数据库时拒绝启动 | offline_pass | 7/7 通过；四态门行为已验证，零建库 |
| T03 | PG 备份与恢复副本工具 | offline_pass | 4/4 + 真实 pg_dump/pg_restore 演练通过；3 个拒绝场景已验证；runbook 已出 |
| T04 | 部署配置与打包边界 | offline_pass | 13/13（含正向对照+外部 unzip 回读）；compose 缺变量拒绝已验证 |
| T05 | 外部下载安全/大小边界 | offline_pass | 26/26（含 4 项真实 socket）；钉连接与重定向复验已验证 |
| T06 | 下载策略接入全部调用者 | offline_pass | 40+1+32+234 全绿，typecheck 0；微信网关重定向收紧；capFor 语义缺陷已修 |
| T07 | 历史关键词完整并发安全打标 | offline_pass | 7/7 + 真实 PG 2万行验证（并发零丢失，72ms/223ms）；旧实现已证永久卡 200 |
| T08 | 关键词结果契约与真实状态 | offline_pass | 11/11 + 7/7，234/234 全绿；本地范围隐式联网已修；全失败不再记 ok |
| T09 | 后台短周期调度与重阶段解耦 | offline_pass | 12/12 + 6/6 + 19/19 + 234/234；迁移 0021 隔离 PG 验证；唤醒 60s 而重阶段频率不变 |
| T10 | Telegram/B 站分页与安全游标 | offline_pass | Python 5/5 + Node 6/6 + 6/6，234/234；Telegram 中段丢弃与 2^53 精度缺陷已修 |
| T11 | 全文保存与历史修复预览 | offline_pass | 10/10 + 235/235；三处 8000 截断已除；预览只读且不造尾 |
| T12 | 媒体类型、提取输入与幂等 | offline_pass | 22/22 + 235/235；封面误送 STT、扩展名优先级、超大图截断三缺陷已修 |
| T13 | 微信费用保守预留与诊断 | offline_pass | 9/9 + 116/116；unknown 保留、overrun 记录、跨日归属已固化；既有夹具老化已修 |
| T14 | C05 准备与模型配置来源核对 | offline_pass | 配置来源表已完成；真实验收结果归 T21，不再把准备任务标为待授权 |
| T15 | 引用契约与检索评测 | offline_pass | 26 例全通过（c11 0.5→1.0，零回归）；术语等价机制为数据驱动 |
| T16 | 阶段日志、只读状态与告警闭环 | offline_pass | 9/9 + 10/10 + 238；分阶段可见、敏感信息不泄漏、本地告警非0退出 |
| T17 | 100/1000 源离线容量评测 | offline_pass | 100/1000 各轮通过：每源 20 条、重放 0 新增、重复 0、错误 0；P95 门槛仍未验证 |
| T18 | 汇总自动门禁与新迁移验证 | offline_pass | 8 道门全绿；新增测试已入聚合命令；迁移 0021 升级路径 5 项验证；应用代码 lint 0 error |
| T19 | 候选构建与 dev/built 端到端 | offline_pass | 构建+agent:e2e+10 项 UI 检查×2 视口（dev/built）；**无法目视查看截图（本会话模型无图像输入），已用像素与 DOM 级检查替代并如实标注** |
| T20 | 离线候选审计与真实门清单 | offline_pass | manifest+候选说明+授权清单已出；L0 达成 |
| T21 | 真实服务最小验收（Gate A） | partial_real_pass | 修复后分析与库内问答各 1/1 通过、usage 已落库；9/21 生产分析成功。RSS/Telegram 网页/YouTube 频道 RSS 有真实证据；Telegram 账号未接入，微信不可用，B站限流，MCP/OCR/ASR 未测，真实费用未对账 |
| T22 | 业务数据迁移与恢复验收（Gate B） | real_pass | 9/17 完成 PG/MinIO/网关 SQLite 备份及副本恢复，迁移 0021 已应用；Telethon 当时无会话。自动/加密/跨机器备份与持续 RPO/RTO 不在已通过结论内 |
| T23 | 长期试运行与扩大范围（Gate C） | awaiting_authorization | 待用户指定账号/窗口/预算 |
| T24 | 正式发布与受控回滚（Gate D） | partial_real_pass | 9/17 app/scheduler 已发布并验证，事故已恢复；旧镜像及备份保留。9/21 加固及生产模型接入已验证。完整发布回滚演练未独立闭环，不能因已发布跳过 T23 或宣布 L2 |
| T25 | 使用指南、运营手册与最终交接 | partial_delivery | 历史指南交付已完成；9/21 PRD 源码、当前状态与任务总表口径统一。新版页面/源码包尚未发布；完整 PRD 最终交付依赖剩余验收 |
