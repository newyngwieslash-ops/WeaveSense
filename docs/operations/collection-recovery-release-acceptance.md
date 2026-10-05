# 最终修复候选镜像及继承的恢复证据（2026-10-05）

候选运行源码为 `1e260c4fe435d6b2cdf0d8d70c8b7e6f40bfe664`。应用/调度/网关真实镜像ID `sha256:fcb70d08562daab8a0c150916778f2411fa1bcb2c134cccec7749493c2627a17`，Telethon真实镜像ID `sha256:f33c93aa2c79b7aec5a5e8b9ca93453d7913f42e11a1e6451724255d3a1d1302`；两者OCI revision均为完整源码SHA。四角色实际隔离启动、26迁移、Node148/Python29和镜像内pip check均通过，桌面/手机截图已实际查看，七个本轮容器及网络已独立确认清理。镜像内源码包415条目、64注册测试，实际SHA256 `bb76328f947aff151df275680cda91cd85c645a08e9b5945b5761f0efd90e950`；后续文档包含的public源码包是另一交付文件，不混称镜像内版本。

[最终验证及范围](collection-final-verification.md)、[镜像原始记录](../../validation/collection/2026-10-02/final-1e260c4/final-release-1e260c4.json)、[raw Git/实际镜像绑定](../../validation/collection/2026-10-02/final-1e260c4/source-image-binding.json)。源码复核通过，生产晋级仍受下述依赖和真实运行验收门约束；没有生产部署或备份调度激活。

下方17b91d7的D/E加密演练、原生全CLI恢复时间和POSIX权限检查均是原始实际记录。最终修复未改备份/恢复组件及其锁定依赖，父代理核对相应Git不变性并重新核对两份密文哈希；没有重新运行恢复并将其标为新SHA。D与Docker C盘共物理盘，E为另一物理盘，仍属同一主机。旧镜像ID保留为历史候选，不能当作当前运行镜像。

---

## 17b91d7 及此前的恢复/发布记录（原样保留）
# T18 恢复与发布候选验收（2026-10-05）

**当前复验源码：`17b91d79e3397dae88d7dd816d0cb667570ce99d`。** 下方保留的 7cf37b7 记录是历史基线，不冒充修正后的证明。后续证据/文档提交不改变被测源码身份。未部署生产、未启用定时备份、未读取生产 env/session、未登录 Telegram。整分支最终回归和独立审查是另一个验收门。

## 17b91d7 修正后复验

Linux 恢复输出改为复用现有 `snapshotSqlite`：受限、不可变 scratch 不需要额外写入锁，原生 backup API 创建新文件后设置权限，仍验证恢复内容。最终根镜像实际运行 **148/148** Node 检查，包括 `umask 022` 下 gateway/session 两个实际 SQLite 输出均 **0600**、内容一致、拒绝覆盖；完整 CLI 编排则在 Windows 对两份密文分别实际恢复 PG/MinIO/SQLite，并验证 NTFS ACL 与有序摘要。这两个平台范围分别记录，不声称根服务镜像内包含 Python/Docker 备份操作工具。

媒体路由测试的独立夹具问题也已修正：空库会播种 26 个 enabled 演示输入，导致原测试可能派发无关采集。保留安全的确定性 RED（只调用播种，26≠0），改用 seeded marker 与 disabled radar/keyword 后，实际 01:30/02:00 路由断言前后 enabled=0、collection ran/items_new=0、Telegram 延后再单次落盘；focused **23/23**。没有修改业务调度代码、放宽阈值或跳过断言。原全套失败和随后单文件通过的历史记录仍由父代理保留。

- 主副本：`D:/Weave-things-1005/collection-backup-17b91d7-24ef4fb39a/t18-muunyxcz-316d1a/generation.loom-backup`。
- 补充副本：`E:/AI-JIANSHI-20260825/WeaveSense/.worktrees/collection-backup-17b91d7-24ef4fb39a/t18-muunyxcz-316d1a/generation.loom-backup`。
- 两份 SHA-256：`5cd25ae8a35ff58e1454ea7a904af55052086497b962eb33fd7b0053c892788a`；密钥分离，实际 NTFS current SID + SYSTEM ACL；所有有序数据/媒体摘要及 pending extract/detail/outbox 各 1 项保持一致。最慢恢复 **17.387 秒**，最大快照年龄 **56.913 秒**。6 个备份夹具容器已清理，密文保留；仍是同机、小型夹具证明。
- `t18-backup-final-17b91d7.json` 为成功完整复验；`t18-backup-17b91d7.json` 与 `t18-backup-failed-retention-17b91d7.log` 保留第一次失败：两次恢复已通过，但 retention-plan 在共享 D 父目录遇到旧密钥归档并拒绝认证。没有删除旧代或改变 fail-closed 行为；复演选择唯一 D/E 父目录隔离该次 generation，retention 仅提出计划、未激活删除。
- app/scheduler/gateway：`loom-collection:17b91d79e3397dae88d7dd816d0cb667570ce99d`，实际 ID `sha256:44c19ee6dd3fa4659d53ddac0ac1c624217ea8301ac759e4121d0a63d071d3c8`。
- Telethon：`loom-telethon:17b91d79e3397dae88d7dd816d0cb667570ce99d`，实际 ID `sha256:2ca43a6c165d1d7d20a668193ae2e01578469e15eefe6a0ceb86dd0a2e4db855`。代码/requirements 未变，revision 元数据更新；依赖安装实际重新执行并核对固定闭包，不能称该层命中缓存。Python **25/25**、pip check 通过。
- 两镜像 OCI revision 均为 17b91d7 完整 SHA；Node **22.23.3** / Python **3.12.15**。实际四角色入口、鉴权 tick HTTP200/error0、enabled=0、网关/Telethon 无账号健康状态、26 个迁移通过；7 个角色夹具与网络均清理。
- 最终镜像下载 ZIP **414 项 / 64 个注册测试**，SHA-256 `53681eb04a667903d887912ea7a4a89273a6e44902a20f4094a9684727ef1df4`。最终镜像桌面/移动截图均已查看，无横向溢出或 console/page error，既有英文背景装饰与 OG 占位提示保持原样。

复验文件：`t18-release-final-17b91d7.json`、`t18-{root,telethon}-build-17b91d7.log`、`t18-linux-{node,python}-tests-17b91d7.log`、`t18-{desktop,mobile}-17b91d7.png`、`t18-manifest-17b91d7.json`。清单记录 21 个源文件的快照原始 hash、规范 LF hash 和由其计算的 Git blob OID；直接 Git blob 绑定由父代理复核。下方 DEP-01/DEP-02 仍未修复，未宣称安全门通过，生产晋级须另行处理。

## 历史基线：7cf37b7

## 加密夹具备份与实际恢复

同一个交付 CLI 经受限配置调用，使用新建有标签的固定 PostgreSQL/MinIO 容器、真实追加迁移、网关 SQLite 与虚构 Telegram SQLite session。备份身份检查使用已停止的四角色占位容器；它们只用于停写契约验证，服务镜像就绪证据在下一节。

- 主副本：`D:/Weave-things-1005/t18-muumals7-ec589f/generation.loom-backup`。
- 补充副本：`E:/AI-JIANSHI-20260825/WeaveSense/.worktrees/collection-backup-7cf37b7-20261005/t18-muumals7-ec589f/generation.loom-backup`。
- 两份均为 167427 字节，SHA-256 `c1db748ef72fb4f528f4987e4970e702869c3d1922ae2e9e2a6abbb577ced5ba`；AES-GCM 密文相同，密钥不在这两个目录、仓库或构建上下文中。NTFS 实际检查仅当前 SID 和 SYSTEM 有权，父代理另行只读核对密文 hash 和 magic；只读时普通沙箱返回 EPERM，获准读取后验证成功。
- 两份分别恢复到全新 PG 库、MinIO 桶及 SQLite/session 目录；所有 PG/SQLite 表有序行摘要匹配，stored 媒体字节/hash 匹配，pending extract、detail queue、outbox 各保留 1 项，游标和费用状态保留。6 个演练容器均经完整 ID/标签核验后清理，备份文件保留。
- 最慢单次恢复 **19.491 秒**，演练时最大 snapshot age **62.192 秒**。这是小型夹具的恢复耗时与快照年龄，不是持续 RPO 证明，也不证明生产容量达到 RTO≤2h。
- 已实测拒绝：错误标签、已有备份代/恢复目标、损坏密文、hash、schema、路径穿越、manifest 多余凭据字段；失败输出未泄露 fixture 凭据。

C/D 都在物理 disk0，Docker 数据 VHD 观测在 C；E 在 disk1。E 提供相对 Docker 的另一物理存储验证，但两份仍在同一台主机。**生产自动备份、跨机器灾备和持续 RPO≤24h 均未启用/未证明。** 归档仍受 256 MiB 序列化容量上限约束。

## Linux 固定版本镜像与角色证据

| 角色 | 固定 tag / 实际 image ID | 已核对入口 |
|---|---|---|
| app | `loom-collection:7cf37b75b21010fa87b293d2135a3644e940f9d7` / `sha256:2248ccc7f16fe11f7ef9e5b405a1a50a01683e703c405a2b495a79e4a3830e10` | `npm run start`：migrate + 实际构建产物，首页/指南/源码下载 |
| scheduler | 同一根镜像 ID | `npm run cron:start`：对隔离 app 真实鉴权 tick，HTTP 200、error_count=0；前后 enabled 输入均为 0 |
| gateway | 同一根镜像 ID | `npm run gateway:start`：network-none，实际 SQLite、鉴权 health、无付费 provider |
| telethon | `loom-telethon:7cf37b75b21010fa87b293d2135a3644e940f9d7` / `sha256:51aeacb29b6ba780e8548565041a468e2c73905787341eb4977a8ed7b4982646` | `python server.py`：network-none，health 正确报告 unconfigured/authorized=false，FakeTelethon 测试 |

OCI revision 均为上述完整 SHA。实际运行 Node **22.23.3**、Python **3.12.15**；Linux pip freeze 和 pip check 与固定的已有依赖闭包核对，Telethon 1.45.0、aiohttp 3.14.3、minio 7.2.20。宿主备份证据是 Node24.16.0/Python3.12.14，二者没有混称。

Linux Node 备份/恢复策略、调度、网关行为检查 **147/147**；Python FakeTelethon **25/25**。Node22 检查实际运行 SQLite backup API。迁移清单为 0002 至 0027 共 **26** 个追加迁移。没有新增或回退迁移。

构建镜像的真实 `/zhishi-loom-source.zip` 返回合法 ZIP，**413 项、64 个注册测试文件**，必要相对 import 和 analyze-valid fixture 存在；排除私密状态，ZIP SHA-256 为 `b697149a3f73e098b50eba27b6254752c7f596795775fae2662d4f7492296bb6`。这是源提交 7cf37b7 的镜像内下载包，后续文档证据提交不冒充已重新构建该镜像。

真实镜像浏览器 desktop 1280×800、mobile 390×844 均 HTTP200、有可见内容、无横向溢出、无 console/page error；两张截图已人工查看。现有背景媒体内嵌英文装饰字样仍在，本任务未改页面视觉。品牌工具提示未提供自定义 og.jpg、使用平台占位图；本采集管理工具保留既有品牌输入，没有隐藏平台标识。

隔离发布网络为新建带归属标签的 bridge，masquerade=false，仅 app 发布 loopback 端口；未配置真实账号/付费服务，所有自动 AI/extract/agent 关闭。浏览器外部请求替换为空响应。最终测试前先用同一镜像迁移并插入 disabled radar/keyword 与 seeded marker，调度前后显式检查 enabled=0。**首页初始化和 tick 都可能写库，不能当成只读检查。**

回滚清单记录四个候选完整 image ID，可在隔离演练中按 ID 重建相同候选。**真实生产切换前的四角色旧 image IDs 本轮没有调查，生产回滚点仍待单独批准后登记**，不能以候选 ID 冒充。发布/回滚均须停新任务、排空、保留新字段/数据/游标/队列，不执行 down migration；详见[发布契约](loom-release-runbook.md)。

## 保留的失败与警告

开发第一次 Docker pipe 访问被普通沙箱拒绝，后续授权提升成功；第二次夹具误用不存在的 `sources.cursor`，已更正为真实 `last_external_id`。这两次不算验收通过。

发布演练最初采用 Docker internal 网络，当前 Desktop 不提供该网络的发布端口；应用进程存活但端口映射为空，全部资源已清理。改为上述 bridge 后，首次 tick 暴露应用空库会自动播种演示信源，返回 16 个 collection error、0 新条目；该次“空库等于无输入”的假设无效，记录原样保留。网络当时也禁用 masquerade，未配置真实账号/付费凭据；不能把该失败报告标为零信源采集成功。修正仅发生在演练初始化，最终 disabled 输入及 error_count=0 检查均通过。

未隐藏构建警告：BuildKit 将 `VITE_AUTH_ENABLED` 判为潜在 secret，但 Dockerfile 字面值是非秘密 `false`；Node SQLite 仍提示 experimental；pip 提示容器 root 安装。现有 npm lock 安装提示 **2 个 high severity vulnerabilities** 以及 recharts/eslint 弃用；本任务未升级依赖，也不声称完成依赖安全审计，需另行评估这些既有告警。

### 生产晋级前的依赖债务（2026-10-05 复核）

独立空 npm user/global 配置、任务专属缓存、`offlineEnv` 和显式公共 registry 下执行 `npm audit --package-lock-only --json --ignore-scripts`，退出 1：仍为 **2 high / 0 critical**，不是干净安全门。原始结果见 `t18-dependency-audit-fix-wave.json`，锁文件路径见 `t18-dependency-paths-fix-wave.json`；没有升级或改写依赖锁。

| 债务 | 已锁定的依赖路径 | 当前可达范围与晋级要求 |
|---|---|---|
| DEP-01：brace-expansion 1.1.18 / 5.0.9 | eslint 9.39.5 → minimatch 3.1.5 → 1.1.18；typescript-eslint 8.68.0 → typescript-estree 8.68.0 → minimatch 10.2.6 → 5.0.9 | 两条锁路径均 dev-only，但根镜像 `npm ci` 实际保留它们。已读业务入口未使用其 glob API；恶意 lint/glob 输入仍可造成 CPU/栈耗尽。维护者须在晋级前验证兼容补丁、刷新锁并重跑相关 lint/build。 |
| DEP-02：js-yaml 4.3.1 | @tanstack/react-start 1.168.49 → start-plugin-core 1.171.39 → xmlbuilder2 4.0.3 → js-yaml；另有 eslint → @eslint/eslintrc 3.3.6 → 同版本 | 不是纯 dev 依赖：Vite 配置导入 Start 插件，实际入口 `npm start` 使用 Vite preview。插件的 sitemap 路径用对象/字符串节点构造 XML，未找到请求内容传给 YAMLReader 的路径；这只是当前代码的有限追踪，不能声称不可能利用。维护者须在晋级前验证 js-yaml ≥4.3.2 的兼容补丁、审计实际运行入口并重建验证。 |

公开公告：[brace 嵌套递归](https://github.com/advisories/GHSA-qhr7-859c-m2p7)、[brace 逗号递归](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)、[brace 二次复杂度](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)、[YAML 空 merge CPU 消耗](https://github.com/advisories/GHSA-2883-xcg3-v3hh)。修复全部已报 brace 告警需兼容版本至少 1.1.21 / 5.0.12。此处记录风险和后续门槛，不将“未发现业务请求入口”当作漏洞已消除；未执行攻击负载，也未测试真实服务。

## 复核与复现

证据目录：[`validation/collection/2026-10-02`](../../validation/collection/2026-10-02)。

- `t18-manifest-7cf37b7.json`：20 个被测源码文件的 Windows 构建快照原始大小/SHA-256，以及通过原始 `git show` 字节计算的 `gitBlobBytes`、`gitBlobSha256`、**Git blob OID**。已核对快照 CRLF→LF 后与提交内容相同；两种字节范围不会混称。证据另列原始生成字节摘要与文本 CRLF→LF 的 canonicalLF 摘要（PNG 保持二进制原样），供父代理对最终 Git blob 核验。清单还绑定四角色 image IDs。
- `t18-backup-7cf37b7.json`、`t18-release-final-7cf37b7.json`：最终恢复/发布角色证据。初次失败及干净复演 JSON、构建/Node/Python日志、desktop/mobile截图同目录保留。
- `backup-check.mjs` 调用交付 CLI；`release-check.mjs` 调用镜像实际入口。后者为证据阶段脚本，业务/构建源码仍绑定 7cf37b7。工作目录为仓库，先准备 `.superpowers/sdd` 日志目录及已存在的备份父目录；每次输出 report 名必须全新。

```text
node validation/collection/2026-10-02/backup-check.mjs <完整SHA> <主副本父目录> <补充副本父目录> <全新report.json> <已安装固定依赖的python>
node validation/collection/2026-10-02/release-check.mjs <完整SHA> <同SHA干净构建上下文> <根固定镜像tag> <Telethon固定镜像tag> <全新report.json>
```

固定源/依赖版本支持可复现验证与按 image ID 回滚；构建时间等因素可能改变镜像字节，不承诺每次重建得到相同 image ID。真实 Telegram 内容质量、24h 耐久、微信 72h/7d、1000信源延迟和应用预算门仍待实测；T14/T15 仍为指定站点需求条件项。
