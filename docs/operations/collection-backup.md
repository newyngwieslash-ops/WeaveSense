# 采集备份、隔离恢复与保留策略（T18）

这是可由运维配置的工具和操作契约，不会自动启用生产备份。最终固定提交、镜像、恢复计时及副本位置见同目录的 T18 验收记录；开发夹具结果不能替代生产演练。

## 支持的入口与边界

在受控宿主运行 `node scripts/collection-backup.mjs`，需要 Node 22.16+ 的 `node:sqlite.backup`、Docker CLI、以及安装 `workers/telethon/requirements.txt` 固定版本的 Python。Windows 已有 `.venv/Scripts/python.exe` 可用。根应用镜像没有 Python，**不把备份安排在 app/scheduler 镜像内运行**。不增加服务、业务调度协议或新依赖。

工具只支持运营配置的、带标签且发布在 `127.0.0.1` 的 PostgreSQL/MinIO 容器；容器必须有 `loom.backup.group` 和 `loom.backup.role`（postgres/minio）。不接受网页传入的内部地址。宿主必须能访问网关 SQLite 与文件形式的 Telethon SQLite session（Docker 卷先由运维在停写维护窗口提供受限路径；不尝试从生产卷自动读取）。StringSession、PGLite 内存库、模型密钥/配置不在本工具范围。

整个备份代（数据库、媒体、网关与 session）采用 AES-256-GCM 随机 nonce 认证加密。磁盘只交付 `generation.loom-backup`；manifest 在密文内，只列资源名、时间、版本、迁移名、文件大小和 SHA-256。没有签名 URL、连接串、密码或 session 内容。加密密钥必须在仓库、临时明文区、两个备份副本之外；Windows 检查 NTFS ACL 只允许当前 SID 与 SYSTEM，Linux 检查属主和 0700/0600。session、密钥、数据库、备份和本地工具状态均不进入源码包或任何 Docker 上下文。

**容量上限：** 当前为有界内存实现，序列化后的 base64 JSON 最多 256 MiB（原始数据可用容量更小，内存峰值会高于归档大小）。超限失败，不生成成功备份。大数据集需另行升级到流式认证加密、分页对象清单和 multipart 传输；小夹具通过不能证明任意规模可用。MinIO 专用桶/凭据及没有工具外写入者是运维前置条件；工具不备份桶 ACL、版本历史或对象自定义 metadata，恢复桶默认私有。

## 同一备份代的一致性契约

1. 关闭用户写入口/定时触发/外部导入；停止接收新任务。让已在途工作完成并保留 pending/queued/outbox。不要强杀后把 running 标成成功，也不要清空游标、租约或费用预留。无法排空就中止本轮维护。
2. 停止 app、scheduler、telethon、gateway（以及已启用的 agent/其他写服务）。每个写容器必须带同组标签和独立 role。工具枚举**全部**同组容器，要求四个核心角色齐全且所有写者都是 exited（paused/restarting 不算）。未纳入标签的外部脚本/客户端必须由运维停用；不能仅声称“调度停了”。
3. 工具拒绝 PG 的其他连接与 sources/keywords/media/extract/AI 的 running、stage claimed、预算 reserved；拒绝网关 open 费用预留。pending/queued、unknown 费用结果和 ACK 前 outbox 原样保留。
4. 在 PG 所有 public 表持 SHARE 锁，网关和 session 同时持 SQLite BEGIN IMMEDIATE 写入锁；SQLite 通过 backup API 读取已提交页和 WAL，绝不把运行中的单个 DB 文件复制成备份。pg_dump 只执行一次，必须成功退出且返回二进制归档。
5. 对每个 stored 媒体检查 object_key、大小、SHA-256 与 MinIO 对象一致；采集前后再次核对 PG 有序摘要、SQLite 有序摘要、全部 MinIO 对象摘要和停写状态，任何变化均失败。成功保存后才由运维恢复服务。工具不负责自动恢复生产调度。

## 配置与命令（示例只含占位符）

把下列 JSON 放在仓库外的受限文件中，路径父目录先用同样的权限策略保护。所有目标父目录必须已存在且无符号链接/junction。`generation` 每次唯一；不能覆盖旧备份代。

```json
{
  "group": "loom-local",
  "generation": "daily-YYYYMMDD-UNIQUE",
  "backupRoot": "D:/Weave-things-1005",
  "keyPath": "C:/private-backup-keys/encryption.key",
  "scratchRoot": "C:/private-backup-scratch",
  "sqlitePath": "C:/private-stopped-data/gateway.sqlite",
  "sessionPath": "C:/private-stopped-data/loom.session",
  "python": "C:/operator-python/Scripts/python.exe",
  "database": "loom",
  "bucket": "loom",
  "postgres": {"container":"operator-pg","host":"127.0.0.1","port":15432,"user":"postgres","passwordEnv":"LOOM_BACKUP_PG_PASSWORD"},
  "minio": {"container":"operator-minio","host":"127.0.0.1","port":19000,"accessEnv":"LOOM_BACKUP_MINIO_ACCESS","secretEnv":"LOOM_BACKUP_MINIO_SECRET"}
}
```

端口必须与指定容器实际 loopback 发布端口一致；compose 默认 PG 未发布宿主端口，运维需另行批准维护期 loopback 映射，不能为了演练启动真实 compose。PG 容器内 pg_dump/restore 使用其本地数据库身份认证；工具不会把密码传给 docker argv，须预先配置安全的容器内本地认证。

```text
node scripts/collection-backup.mjs init-key <已存在的仓库外密钥父目录> <全新子目录名>
node scripts/collection-backup.mjs backup <受限配置文件>
node scripts/collection-backup.mjs retention-plan <受限配置文件>
```

密钥仅初始化一次，另存受控密钥库；不要每次定时运行重建密钥。密码由凭据管理器注入命名的 `LOOM_BACKUP_*` 环境变量，不能写进命令参数/报告。所有子进程采用离线环境白名单；MinIO 凭据只经子进程 stdin。错误输出为固定错误码，不转发第三方异常中的敏感信息。

## 隔离恢复与失败处理

使用同一配置加 `archivePath`、`restoreRoot`、`restoreGeneration`、`targetDatabase`、`targetBucket`，postgres/minio 指向新建有标签的隔离服务。目标库、桶、恢复目录必须全新，禁止恢复到源库/源桶；目标桶使用小写 DNS 合法名。

```text
node scripts/collection-backup.mjs restore <受限恢复配置>
```

认证解密、manifest 字段白名单、schema、资源标识、hash/size、路径、标签、已有库/桶/目录、pg_restore --list 及 SQLite integrity_check 均在目标写入前检查。SQLite 检查用全新私有 scratch，不是恢复目标。恢复 PG 后先验证迁移与媒体关联，再创建私有桶/恢复 SQLite/session。失败保留全新隔离资源供运维诊断，不自动删除；绝不继续业务或宣称成功。运维只可删除自己记录过完整 ID、标签和路径的资源，删除前重新检查归属与解析后包含关系。

恢复输出包括每张表排序后行摘要及计数，涵盖待执行队列、outbox、游标、费用状态；与创建备份输出一一比较。媒体全部重新读取校验。RPO≤24h、RTO≤2h 是建议目标：一次夹具恢复只提供该归档的 snapshot age 和实测恢复耗时，不证明持续 24 小时 RPO 或生产容量。

## 保留与调度提案（未启用）

每天在已批准维护窗口执行一次上述停新写→排空→停止→备份→异存储复制/校验→恢复流程。保留最近 7 个不同日的备份，加最近 4 个不同 ISO 周的最新副本；同一代可同时满足日/周保留。`retention-plan` 仅解密验证本工具的同资源归档，打印可删除的 generation 名；**永不删除，也不安装定时任务**。人工批准删除前再次验证目录身份、解密和归属；遇到未知文件/错误密钥/损坏归档必须停下，不能宽泛递归清理。

后续可用 Windows Task Scheduler 或 cron 运行受限运维账户的包装脚本（单实例锁、失败告警、凭据库注入、维护失败不继续发布）；必须另获启用批准。本轮没有创建计划任务。

用户指定的 D 盘副本是主目标；当前观测 Docker 数据 VHD 在 C，C/D 同属物理 disk0。另在 E 的新任务目录存同一密文代，E 属 disk1，才提供相对 Docker 的异物理存储夹具验证。两者同机，**跨机器灾备仍未具备，生产备份仍未启用**。
