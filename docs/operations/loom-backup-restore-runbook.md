# 织识 Loom 备份与恢复手册

适用范围：本机 / 受控内网单用户部署。日期 2026-09-16，对应计划 T03 / T22。
**本手册是操作程序，不是已完成迁移的证据**；真实业务备份与切换在 T22（Gate B）授权后执行。

---

## 1. 数据资产与备份方式

| 资产 | 位置 | 备份方式 | 一致性要求 |
|---|---|---|---|
| 业务数据库 | PostgreSQL 16（compose `postgres` 服务，卷 `pgdata`） | `pg_dump --format=custom` | 先停写或确认无进行中任务；导出后校验 SHA-256 与迁移清单 |
| 开发/预览内嵌库 | PGLite 进程内存（`DATABASE_URL` 为空时） | **无法在外部进程备份**（见 §5） | 必须在存活进程内导出（现有 `/__qa/backup` 隔离入口，仅开发环境） |
| 微信网关账本 | 卷 `wechat-gateway-data` 内 SQLite | 运行中 SQLite **不能**直接复制主文件；用 `.backup` 或停写后复制 **含 `-wal`/`-shm` 的全套** | 单文件复制会得到撕裂快照 |
| 媒体对象 | MinIO 卷 `miniodata`，桶 `loom` | 对象清单（键 + 大小 + ETag/SHA-256）另存；对象本体可用 `mc mirror` | 清单与对象必须来自同一时点 |
| Telegram 会话 | 卷 `telethon-session` 内 `loom.session` | **秘密**：单独加密保存，不入 git、不入常规备份包、不打印内容 | 泄露等于账号被接管 |
| 模型配置 | `config/model.local.json` | **秘密**：按密钥管理，不入备份包 | 与业务数据分开处理 |

---

## 2. PostgreSQL 备份（已验证流程）

已实现并验证：`node scripts/postgres-recovery-check.mjs`（隔离演练，见 §2.4）。

### 2.1 备份（生产库已验证流程，2026-09-17）

**前置：确认目标目录在工作树之外**（`F:\loom-backups\` 已用于生产备份；不要放进仓库）。

```bash
# 1) 目标目录（工作树之外，避免被 git/lint/打包扫到）
mkdir -p /f/loom-backups

# 2) 只读导出。凭据由容器内的 PGPASSWORD 提供，不进 argv、不进日志。
#    生产容器：gig5cyrba5yn3tsi-grok-workspace-postgres-1（数据库 loom，用户 loom）
# 单行形式（本机 Git Bash 实测可用；换行续接符在该 shell 下会被吞掉）
docker exec gig5cyrba5yn3tsi-grok-workspace-postgres-1 sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U loom -d loom --format=custom --no-owner --no-acl' > "F:/loom-backups/loom-prod-$(date +%Y%m%d-%H%M%S).dump"

# 3) 立即校验（三项缺一不可）
head -c 5 <file>.dump                                                  # 必须是 PGDMP
sha256sum <file>.dump                                                  # 记录哈希
docker exec -i <container> pg_restore --list < <file>.dump | head -12  # 必须可读

# 4) 记录行数（同一时点，供日后比对）
docker exec <container> psql -U loom -d loom -t -A -c "select json_build_object('sources',(select count(*) from sources),'items',(select count(*) from items),'jobs',(select count(*) from jobs));"
```

**注意**：`> file.dump` 由 **shell** 完成重定向，dump 写在**你的机器**上，容器只负责把字节推到 stdout。

### 2.1.1 实测（2026-09-17，以此为准）

库 15 MB → 1.59 MB dump，**约 2 秒**完成；源库全程 `Up (healthy)`，未停写、未改动。

### 2.1.2 复核清单（每次备份后照做）

- [ ] `PGDMP` 头部正确
- [ ] SHA-256 已记录到 manifest
- [ ] `pg_restore --list` 可读，且关键表齐全（items / sources / _migrations / keywords / jobs）
- [ ] 迁移清单已记录（生产当前 **19/20**，缺 `0021_stage_windows.sql`）
- [ ] 各表行数已记录（与备份同一时点）
- [ ] 文件位于工作树之外
```

导出后立即记录：

- `sha256sum backup.dump`
- `pg_dump --version`（工具版本必须 ≥ 服务端主版本）
- 源库 `select name from _migrations order by name`（迁移清单）
- 每张 public 表的行数

写入 `manifest.json` 与备份同目录。**备份目录不得在 git 工作树内，也不得位于打包/公开路径**（T04 的打包边界会拒绝 `artifacts`、数据库目录等）。

### 2.2 恢复（恢复到新库，绝不覆盖）

1. **先确认目标库不存在。** 目标已存在是停止条件，不是 `--clean` 的理由（T03 已验证该守卫：`restore_target_exists`）。
2. `createdb <target>`
3. `pg_restore -U <user> -d <target> --exit-on-error --no-owner --no-acl backup.dump`
4. 校验：逐表行数与有序行摘要必须与 `manifest.json` **同一快照时点**一致；再读出指定历史记录（简报、分析、引用、pending 任务）确认可读。
5. 损坏的备份必须在 `pg_restore` 阶段被拒绝（非 0 退出），**不得**出现"一半成功"的报告。

### 2.3 目标与承诺（待 T22 确认为运营指标）

| 指标 | 建议目标 | 状态 |
|---|---|---|
| RPO | ≤ 24 小时 | proposed，未演练真实业务库 |
| RTO | ≤ 2 小时 | proposed，未演练真实业务库 |

**未在真实业务库上演练前，不得对外承诺上述数字。**

### 2.4 隔离演练命令与既有结果

```bash
node scripts/postgres-recovery-check.mjs        # 创建自己的隔离容器与库，失败保留现场
LOOM_T03_KEEP=1 node scripts/postgres-recovery-check.mjs   # 保留容器以便检查
```

最近一次结果（2026-09-16，批次 `pr-20260916-a1`）：19 项迁移 / 18 张表 / 25 行，备份 40,582 字节，SHA-256 `2894ab86…f6cbd6`，恢复副本逐表摘要一致，指定简报/分析与 1 条 pending 提取任务均可读；三个拒绝场景（覆盖既有目标、损坏归档、资源标签不符）全部按设计拒绝。证据：`B/artifacts/production-readiness/pg-recovery/run-y1lZwZ/` 与对应日志。

---

## 3. 微信网关 SQLite（一致性备份）

运行中的 SQLite 主文件**单独复制不是备份**：写入可能仍在 `-wal` 中，复制品会缺少最近事务或撕裂。

```bash
# 首选：SQLite 自身的备份 API，得到单文件一致快照
docker exec <gateway_container> sh -c 'sqlite3 /data/wechat-gateway.sqlite ".backup /data/backup-$(date +%s).sqlite"'
```

或停写后复制 `wechat-gateway.sqlite` + `-wal` + `-shm` **三者**。恢复前备份当前文件，恢复后执行一次完整性检查（`pragma integrity_check`）。

---

## 4. MinIO 对象与清单

1. 生成对象清单：`mc ls --recursive --json local/loom` → 记录 `key`、`size`、`etag`（多分片上传时 ETag 非内容哈希，需另存 SHA-256 才可与恢复副本比对）。
2. 对象本体：`mc mirror local/loom <备份目标>`。
3. 恢复后按清单逐项核对键、大小与哈希；**清单与对象必须同一时点**，否则无法区分"丢失"与"清单过时"。
4. 公开访问：compose 的 `minio-init` 默认对桶执行匿名下载。**只有明确为公开资料时**才允许；私有资料必须先撤销匿名访问，且**不能宣称关闭匿名桶后既有公开 URL 仍然可用**——它们会失效，这是预期行为。

---

## 5. PGLite（开发/预览内存库）的特殊性

- `DATABASE_URL` 未设置时数据库是**进程内存**：外部新进程无法取得它（新进程会得到自己的空库）。
- 唯一可行路径是在**存活进程内**导出。现有隔离入口 `scripts/backup-qa.vite.ts`（`/__qa/backup`，仅开发配置挂载、要求同源 POST + 本机令牌 + 回环对端）已验证：导出→恢复→重开→新增记录再重开均通过。
- 该入口**未挂载到正常业务路由**。把它加载进某个实例不触发整服重启（HMR 加载）这一前提需要单独确认。
- **绝不能**用"重启后看看"的方式尝试恢复内存数据；也不得把新启动的空库当作旧数据恢复。

---

## 6. 恢复演练检查清单（每次真实演练照此执行）

- [ ] 唯一源库、唯一目标库已书面确认（Gate B）
- [ ] 已停止新写入入口/相关调度，并处理 running 任务
- [ ] 备份在写入停止后取得，SHA-256 与迁移清单已记录
- [ ] 恢复到**新**库，未覆盖任何既有资源
- [ ] 逐表行数/摘要与同一快照时点一致
- [ ] 指定历史记录（简报、分析、引用、媒体对象）可读出
- [ ] 在恢复副本上启动独立应用，重启该副本后再读一次
- [ ] **源库始终保持不变**；失败不删除现场
- [ ] 真实宿主重启由用户安排（助手不得自行重启机器），按真正重启记录恢复时间与丢失窗口
- [ ] 验证通过前不记录 RPO/RTO 达标

---

## 7. 明确未完成

- 真实业务库的备份与迁移（T22 / Gate B）
- 8182 内存库的历史数据：**无已证实备份**，重启即丢；不得承诺找回
- 微信网关 SQLite 与 MinIO 的真实备份演练
- 宿主重启验证与 RPO/RTO 实测

---

# 生产库首次备份记录（2026-09-17，只读）

授权：用户批准"对生产库做一次只读 pg_dump，落到 F:\loom-backups\，记录 SHA-256 与迁移清单；**不恢复、不停写、不切换**"。

## 备份

| 项 | 值 |
|---|---|
| 源 | 容器 `gig5cyrba5yn3tsi-grok-workspace-postgres-1`，卷 `…_pgdata`，数据库 `loom` |
| 方式 | `pg_dump --format=custom --no-owner --no-acl`（**只读**，未停写、未改动源库） |
| 文件 | `F:\loom-backups\loom-prod-20260917-141815.dump` |
| 大小 | 1,595,256 字节 |
| SHA-256 | `fc118253653a6033aec0c3b4c60c481d6af2a632cd5a56ba81a49ff0d99f763d` |
| 格式校验 | `PGDMP` 头部正确；`pg_restore --list` 可读；101 个 TOC 条目、97 个对象条目 |
| 关键表 | items / sources / _migrations / keywords / jobs **均存在** ✓ |
| 工具版本 | pg_dump 16.15 / 源库 16.15（版本一致） |
| manifest | `F:\loom-backups\manifest-20260917-141815.json` |

## 备份时的业务数据（只读计数）

| 表 | 行数 |
|---|---|
| sources | 26 |
| **items** | **2,409** |
| keywords | 8 |
| jobs | 4,538 |
| analyses | 0 |
| knowledge_notes | 0 |
| 最新采集时间 | 2026-09-17T06:05:54Z |

**平台分布**：rss 2134 / youtube 139 / telegram 45 / bilibili 44 / wechat 39 / xhs 3 / douyin 3 / xigua 2

## 重要发现

1. **生产库是真实业务数据**，且**备份时仍在活跃采集**（最新 06:05）。
2. **生产实例缺 `0021_stage_windows.sql`**（已应用 19/20 项迁移）。
   本批新增的 `stage_windows` 表**尚未部署到生产**；部署时需走迁移流程（本批不含生产迁移，属 T24）。
3. `analyses` 与 `knowledge_notes` 均为 0 —— 生产库**尚未产生过分析或简报**（分析能力未在生产实际使用）。

## 本次备份**不是**什么（避免误读）

- **不是恢复演练**：未恢复到任何库，未验证可恢复性（需另行授权）。
- **不是完整备份**：不含 MinIO 对象、微信网关 SQLite、Telethon 会话（见 runbook 前文各自的备份程序）。
- **不构成 RPO/RTO 达标证据**：单次手工备份 ≠ 持续备份策略。

## 下一步（需另行授权）

- 恢复到新库并逐表核对（恢复演练）
- 建立定期备份（当前无自动化；如需定时任务须用户明确要求）
- 生产迁移部署（含 0021）→ T24/Gate D

---

# 恢复演练结果（2026-09-17）

授权：用户批准"把这份 dump 恢复到新建隔离库，逐表核对行数/摘要"。**全程只读源库、未停写、未切换。**

## 步骤与结果

| 步骤 | 结果 |
|---|---|
| 守卫：损坏归档 | ✅ 被拒（`input file does not appear to be a valid archive`） |
| 守卫：目标库必须不存在 | ✅ 先 drop 容器初始库，确认 `count=0` 后才建 `restored_20260917` |
| 恢复 | ✅ `pg_restore --exit-on-error --no-owner --no-acl` → **exit=0，零错误** |
| 逐表行数 | ✅ **6/6 与 manifest 完全一致**（sources 26、items 2409、keywords 8、jobs 4538、analyses 0、notes 0） |
| 表数量 | ✅ 18 张全部恢复；迁移 19 项 |
| 内容完整性 | ✅ `external_id` 2409/2409、`published_at` 2409/2409、非空正文 2301 |
| 编码 | ✅ 中文标题可读回（无乱码） |
| 可重复性 | ✅ 有序行摘要两次一致（`f208a767…`） |
| 业务数据读回 | ✅ 平台分布与最新条目（2026-09-17）均可读出 |

## 关键结论

**这份备份是可用的**：它能在一个全新的库上完整重建生产数据，行数、结构与内容都一致。
这是"备份存在"升级为"备份可用"的唯一证据。

## 演练中的两个技术细节（供下次参考）

1. **不要用 `pg_restore --create`**：它会按 dump 记录重建数据库并设置原始属主，
   在只有 `postgres` 角色的容器里会因 `role "loom" does not exist` 失败。
   正确做法：**先 `create database`，再 `pg_restore -d <目标库> --no-owner --no-acl`**。
2. **不要拿生产库实时快照去比对**：生产库仍在采集，实时比对必然有差异。
   比对基准应为**备份时记录的 manifest 行数**（本次即如此）。

## 附带发现：T11 截断影响已量化

恢复副本中**正文恰为 8000 字符**的条目共 **10 条**（旧截断特征，收集时间跨 2026-08-28 ~ 09-16）。

对恢复副本运行 T11 的只读修复预览脚本：

```
扫描 33 条，需重抓 33 条
原因分布：at_cut_boundary=10、marked_incomplete=23
（脚本明确不执行修复；被截断的正文无法从自身重建）
```

**这 33 条的历史尾部已永久丢失**，若要补全需经授权的重新抓取（属 Gate B/C 范围，尚未授权）。

## 仍未验证

- **RPO/RTO 未达标验证**：单次备份 + 单次演练，不是持续备份策略；恢复耗时也未在压力下测量。
- **未在"停写窗口"下演练**：本次源库仍在写入，只证明了 dump 的可用性，未证明"停写 → 备份 → 切换"的完整流程。
- **不含 MinIO / 网关 SQLite / Telethon 会话**：这三项的备份程序在 runbook 前文，均未演练。


---

# 三项资产备份演练结果（2026-09-17）

授权：用户批准"补齐另外三项备份演练（MinIO / 网关 SQLite / Session）"。
**全程只读源系统、未停止任何服务。**

## 1. MinIO 对象存储 — ✅ 通过

| 项 | 值 |
|---|---|
| 源 | 容器 `…-minio-1`，卷 `…_miniodata`，桶 `loom` |
| 规模 | **332 个对象 / 65 MiB**（用 `mc du` 经 S3 API 读取，非直接读盘） |
| 备份位置 | `F:\loom-backups\minio-20260917\mirror\`（66 MB） |
| 方式 | `mc mirror local/loom → 容器临时目录 → docker cp 到宿主` |
| **恢复验证** | 灌入**全新隔离 MinIO** 后：**332/332 对象、65 MiB** |
| **内容校验** | **逐对象 ETag 比对：0 缺失、0 多余、0 不一致** |
| manifest | `F:\loom-backups\minio-20260917\manifest.json` |

**注意**：ETag 对单分片上传即内容 MD5，故 ETag 相同意味着字节相同；
对多分片上传 ETag 不是内容哈希，因此同时核对了对象数与总字节数。

## 2. 微信网关 SQLite — ✅ 通过

| 项 | 值 |
|---|---|
| 源 | 容器 `…-wechat-gateway-1`，卷 `…_wechat-gateway-data` |
| 方式 | **`VACUUM INTO`**（SQLite 自身备份 API 的等价物），**服务未停** |
| 备份位置 | `F:\loom-backups\gateway-20260917.sqlite`（122,880 字节） |
| SHA-256 | `a021877e3975dff8…` |
| `integrity_check` | **ok** |
| 内容读回 | 7 张表：`gateway_items` **36**、`provider_reservations` **27**、`gateway_sources` **5**、`provider_usage` **3** |
| 业务样本 | 预留记录 `2026-09-05 / dajiala / estimate 0.08 / actual 0.08 / settled` 完整可读 |

**关于".backup vs 直接复制"**：本机源库当前**没有 `-wal` 文件**（WAL 已 checkpoint 或为 DELETE 模式），
所以直接复制这一次"看起来也对"。但那只说明**这一次**没有并发写入落在 WAL 里——
一旦有写入待合并，直接复制就会得到撕裂快照。**因此仍以 `VACUUM INTO` 为准**。

## 3. Telethon 会话 — ⚠️ 无会话可备份（真实状态，非演练失败）

| 检查 | 结果 |
|---|---|
| 卷 `…_telethon-session` 内容 | **只有 `.` 和 `..`——完全为空** |
| `TELEGRAM_SESSION` 环境变量 | 空 |
| 健康接口 | `authorized: false`、`me: ''` |
| `TELEGRAM_SESSION_PATH` | `/data/loom.session`（文件不存在） |

**结论**：Telegram worker **未登录**，因此没有会话密钥需要备份。
这不是"备份失败"，而是"确实没有可备份的对象"。

**影响**：Telethon 路径（完整历史）不可用；**网页预览回退仍可用**
（本次实测 `@telegram`、`@durov` 各取回 20 条）。要启用 Telethon，需先完成一次
交互式登录（`docker compose run --rm -it telethon python login.py`）——**属 Gate C/D 范围，本次未做**。

**一旦登录，其备份要求**（写入 runbook 供后续遵循）：
- `loom.session` 是**账号凭据**，泄露等于账号被接管；
- 必须**加密存储**，不得进入 git/常规备份包/日志；
- 备份时不得打印内容，只记录文件哈希与时间。

## 覆盖情况汇总

| 资产 | 备份 | 恢复验证 |
|---|---|---|
| PostgreSQL 业务库 | ✅ 已完成 | ✅ **通过**（逐表 6/6 与 manifest 一致） |
| MinIO 对象 | ✅ 332 对象 / 65 MiB | ✅ **通过**（ETag 零差异） |
| 网关 SQLite | ✅ VACUUM INTO | ✅ **通过**（integrity ok + 内容读回） |
| Telethon 会话 | n/a（无会话） | n/a |

**总清单**：`F:\loom-backups\INVENTORY.json`（含各文件 SHA-256）

## 仍未覆盖（诚实说明）

- **异地副本**：全部备份都在本机（同一块磁盘），磁盘故障会同时丢失源与备份。
- **加密**：备份文件未加密。
- **自动化**：全部为手工执行，**没有定时备份**。
- **应用级恢复**：MinIO/网关只做了对象级与文件级验证，
  **未**把备份灌回一个运行中的应用做端到端验证（数据库那项做到了）。


---

# 异地副本（2026-09-17）

授权：用户指定 `G:\QBXT_0917` 作为异地副本位置。

## 副本内容

| 项 | 值 |
|---|---|
| 位置 | `G:\QBXT_0917\loom-backup-20260917\` |
| 大小 | 68 MB |
| 来源 | `F:\loom-backups`（生产库 dump、网关 SQLite、MinIO 镜像、各 manifest） |
| 清单 | 该目录下 `OFFSITE-MANIFEST.json`（含源/副本双份 SHA-256） |

## 校验结果（全部通过）

| 层级 | 方法 | 结果 |
|---|---|---|
| 文件 | `cmp` 逐字节 | **4/4 完全相同** |
| 文件 | SHA-256 双份比对 | ✅ 一致 |
| MinIO 镜像 | **逐对象 CRC32** | **332/332 相同**，0 缺失、0 多余、0 不一致 |
| **可恢复性** | 从**异地副本** `pg_restore` 到全新隔离库 | **exit=0**；sources 26 / items 2409 / jobs 4538 / keywords 8 / migrations 19；中文无乱码 |
| 网关 SQLite | 直接打开异地副本 | `integrity_check=ok`；gateway_items 36；provider_reservations 27 |

**关键**：最后两项证明异地副本不只是"文件在"，而是**真的能用来恢复**。

## 这解决了什么 / 没解决什么

**解决了**：单一目录损坏（`F:\loom-backups` 被误删、该分区损坏）不再导致备份全失。

**没解决**：
- **同一台机器**：F: 与 G: 是同一台机器的不同卷。整机故障、勒索软件、误格式化整机仍会同时影响两端。
  真正的异地需要**另一台设备或云端**。
- **未加密**：副本与源同为明文。
- **无自动同步**：手工复制；源目录后续变化**不会**自动更新到此处。

## 更新异地副本的方法

```bash
DEST="/g/QBXT_0917/loom-backup-<日期>"
mkdir -p "$DEST"
cp /f/loom-backups/*.dump /f/loom-backups/*.json /f/loom-backups/*.sqlite "$DEST/"
cp -r /f/loom-backups/minio-<日期> "$DEST/"
# 复制后必须校验：cmp 逐文件 + MinIO 逐对象 CRC + 至少一次 pg_restore 到隔离库
```


---

# 生产库迁移记录：0021_stage_windows.sql（2026-09-17）

授权：用户批准「生产迁移（含 0021）」，并选择**只加表、不停写**方式。

## 迁移前评估（决定不停写的依据）

| 检查 | 结果 |
|---|---|
| 迁移内容 | **仅 `create table if not exists stage_windows` + 2 个 `create index if not exists`** |
| 是否改动现有表/数据 | **否**——不 ALTER、不 UPDATE，纯新增 |
| 运行中的 app 是否已依赖新表 | **否**——容器内是旧构建，`/app` 无 `stage-windows.ts`，不会读取该表 |
| 是否有阻塞会话 | 无（`idle in transaction` = 0） |
| 结论 | **无需停写窗口**：新增对象不触碰既有数据路径，且旧代码不感知新表 |

## 执行

```sql
begin;
\i 0021_stage_windows.sql          -- CREATE TABLE + CREATE INDEX ×2
insert into _migrations values ('0021_stage_windows.sql');
commit;
```

结果：`BEGIN / CREATE TABLE / CREATE INDEX / CREATE INDEX / INSERT 0 1 / COMMIT`，**exit=0**。

## 迁移前备份（回滚资源）

| 项 | 值 |
|---|---|
| 文件 | `F:\loom-backups\loom-prod-premigrate-20260917-160638.dump` |
| 大小 / SHA-256 | 1,627,275 字节 / `1d619a23fe7e17a06203cb6f9e552910146e6b2c01465e41557607eae09d42e4` |
| 异地副本 | ✅ 已同步到 `G:\QBXT_0917\loom-backup-20260917\`（逐字节一致） |
| 迁移前行数 | items=2420、sources=26、jobs=4587、migrations=19 |

**回滚方式**：`drop table stage_windows;` 并删除 `_migrations` 中的 0021 行——
因为本迁移只新增对象，回滚不需要恢复整库。

## 迁移后验证（全部通过）

| 检查 | 结果 |
|---|---|
| 表 | `stage_windows` 存在 ✓ |
| 索引 | `stage_windows_pkey`、`stage_windows_status_idx`、`stage_windows_claimed_idx` ✓ |
| 约束 | `stage_windows_pkey`、`stage_windows_status_check` ✓ |
| 迁移记录 | **19 → 20**，末条为 `0021_stage_windows.sql` ✓ |
| **旧数据完好** | items=2420、sources=26、jobs=4587 **与迁移前完全一致** ✓ |
| 新表可用 | 插入 / 查询 / 删除 均正常 ✓ |
| **业务连续性** | 容器**全部未重启**（Up 7 hours）；**迁移后 10 分钟内新增 6 条**，采集正常 ✓ |

## 迁移后基线备份

| 项 | 值 |
|---|---|
| 文件 | `F:\loom-backups\loom-prod-postmigrate-20260917-160825.dump` |
| 大小 / SHA-256 | 1,629,075 字节 / `8514855df13f19ab…` |
| 异地副本 | ✅ 已同步 |
| 恢复验证 | ✅ 恢复到全新隔离库：exit=0、items=2420、migrations=20、`stage_windows` 存在 |

## 这次迁移**没有**做的事

- **未重启任何容器**：因此生产 app 仍运行旧构建，**不会使用** `stage_windows`。
  新调度行为（60 秒唤醒 + 重阶段窗口准入）要**部署新代码**后才生效——属 T24 发布范围。
- **未更新镜像**：`gig5cyrba5yn3tsi-grok-workspace-app` 等镜像未重建。
- **未验证新调度在生产的实际行为**：需要新代码上线并观察一轮窗口。

## 回滚步骤（如需）

```sql
-- 仅当确认要回退本次结构变更时
drop table if exists stage_windows;
delete from _migrations where name = '0021_stage_windows.sql';
```
