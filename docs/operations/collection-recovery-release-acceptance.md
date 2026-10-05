# T18 恢复与发布候选验收（2026-10-05）

**已验证源码：`7cf37b75b21010fa87b293d2135a3644e940f9d7`。** 后续证据/文档提交不改变本页测试对象。未部署生产、未启用定时备份、未读取生产 env/session、未登录 Telegram。整分支最终回归和独立审查是另一个验收门。

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
