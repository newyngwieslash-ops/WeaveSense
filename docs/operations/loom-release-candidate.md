# 织识 Loom 候选版本说明（L0 离线候选）

> **当前状态（2026-09-21）以[统一交付状态](loom-current-status.md)为准。** 本文下方为历史方案或执行快照；其中“未发布、待授权、未修复”只适用于当时，不覆盖后续证据。T21 部分通过、T22 已验证、T23 未完成、T24 已发布但完整回滚验收未闭环；完整 PRD 尚未完成。本次文档修订尚未发布到生产镜像或下载源码包。

日期：2026-09-16。批次 `pr-20260916-a1`。**当前级别：L0 离线候选 —— 不是生产就绪，也不是受控试用。**

对应计划：T01—T20。级别定义见 `2026-09-16-release-scope.md`。

---

## 1. 版本标识

| 项目 | 值 |
|---|---|
| 分支 | `comet/local-model-settings` |
| HEAD（基线） | `76b6da1ac8a8d6d6c6a4b30e7f0309c9e18fd8b9` |
| 本批改动 | 未提交的工作区改动（95 个已跟踪文件被修改 + 174 个未跟踪文件；**全部保留，未 commit/push**） |
| Node | v24.13.0（仓库 lockfile，未升级依赖） |
| 迁移 | 20 个编号文件，`0002`—`0021`（本批新增 `0021_stage_windows.sql`） |
| 构建 | `npm run build` 通过（空 `DATABASE_URL` 时 migrate 明确跳过） |
| 清单 | `B/artifacts/production-readiness/pr-20260916-a1/candidate-manifest.md`（含关键文件哈希、迁移清单、公共配置变量名） |

**本清单不含任何 Key、账单账户标识或秘密值。**

## 2. 本批实际修复（全部先红后绿，失败尝试保留）

| 任务 | 修复内容 | 验证 |
|---|---|---|
| T01 | 隔离运行包装器（白名单式环境隔离，堵住真实 Key 与真实模型配置的两条泄漏路径） | 6/6 |
| T02 | 正式运行缺库拒绝启动（不再静默用内存库） | 7/7 + 四态门 |
| T03 | 真实 PG 备份/恢复演练 + 三个拒绝场景 + runbook | 4/4 + 演练 |
| T04 | 打包边界（`.env`、弱默认凭证、公开端口、浮动镜像）+ 跨平台打包脚本 | 13/13 |
| T05 | 出站策略：SSRF 防护（含 IPv4-mapped、混合 DNS）+ 流式上限 + DNS 重绑定钉连接 | 26/26 |
| T06 | 策略接入全部下载调用者；带令牌请求不再跟随重定向 | 40+1+32+235 |
| T07 | 关键词全库打标（旧实现永久卡 200 条，已实证）；集合式并发安全更新 | 7/7 + 真实 PG 2 万行 |
| T08 | 关键词失败不再被吞成"成功零条"；本地范围不再隐式联网 | 11/11 + 7/7 |
| T09 | 调度唤醒 60s 但重阶段按自身持久窗口（避免频率×30） | 12/12 + 迁移验证 |
| T10 | Telegram 中段永久丢弃 + 2^53 游标精度；B 站受控分页 | Python 5/5 + Node 12/12 |
| T11 | 三处 8000 字符静默截断（尾部永久丢失）；只读修复预览 | 10/10 |
| T12 | 视频封面误送 STT；扩展名优先级；超大图截断成损坏图像 | 22/22 |
| T13 | 微信费用：未知结果保留保守预留、overrun 可见、跨日归属 | 9/9 + 116/116 |
| T14 | 模型配置来源表（实测核对，无单一控制入口） | 复用离线契约 |
| T15 | 检索：c11 0.5→1.0（词汇鸿沟，数据驱动术语表） | 26 例全通过 |
| T16 | 分阶段运维可见性 + 只读状态 + 本地告警（非 0 退出） | 9/9 + 10/10 |
| T17 | 100/1000 源容量突发评测（每源 20 条、重放 0 新增、重复 0） | 两档均通过 |
| T18 | 汇总门禁（新增测试入聚合命令）+ 迁移升级路径验证 | 8 道门全绿 |

## 3. 门禁结果（候选版本快照）

| 门 | 结果 |
|---|---|
| `npm test` | **388 项，0 失败** |
| `npm run test:manual-fixes` | **32/32** |
| `npm run gateway:test` | **116/116** |
| `npm run typecheck` | **exit=0** |
| `npm run lint` | 应用代码 **0 error**（剩余 380 error 全在 vendored `.agents/skills/comet/`，非应用代码） |
| Go `test ./...` / `vet ./...` | **ok / exit=0**（`-race` 未在本机重跑，见限制） |
| `npm run agent:pg`（隔离 PG） | **18/18，零 skip** |
| `npm run agent:retrieval`（隔离 PG） | **exit=0**，26 例、范围违规 0、无答案误取 0 |
| 迁移升级（0020→0021） | 5 项验证通过（旧基线 / 升级 / 幂等 / 失败中止 / 业务数据保留） |
| dev + built 浏览器 | 10 项检查 × 2 视口，**零 console/pageerror**、无横向溢出 |

## 4. 支持范围与规模

**支持范围以 `2026-09-16-release-scope.md` 为准（该表状态为 proposed）。** 摘要：

- 采集（按真实证据）：**RSS/网页 Feed ✅、Telegram（网页预览）✅、YouTube 频道 RSS ✅**；B 站 ⚠️（接口限流，需退避）；
  **微信公众号 ❌ 当前不可用**（上游风控，Feed 无正文，证据见 release-scope §2.1）。
- **明确不承诺**：抖音、小红书、西瓜等无独立实现的平台；公网部署；多租户。
- 规模：100/1000 源**突发**评测通过，但**不代表持续运行能力**；真实规模承诺待 T23。
- 正文：存储层不再截断；模型上下文另有预算。
- 费用：微信付费默认关闭（无经验证上界时拒绝准入）；真实金额须由用户提供。

## 5. 备份、恢复与回滚

| 项目 | 方案 | 状态 |
|---|---|---|
| 恢复演练（隔离夹具） | `scripts/postgres-recovery-check.mjs`（自建容器，拒绝覆盖/损坏/错标签） | **已通过** |
| **生产库备份** | 只读 `pg_dump` → `F:\loom-backups\`；SHA-256 与迁移清单已记录 | **已完成**（2026-09-17） |
| **备份覆盖范围** | PostgreSQL + MinIO（332 对象）+ 网关 SQLite；Telethon 无会话 | **已完成**，四项均验证 |
| **异地副本** | `G:\QBXT_0917\loom-backup-20260917\`；逐字节 + 逐对象 CRC + 从副本恢复验证 | **已完成**（但仍与源同机、未加密、无自动同步） |
| **生产库恢复演练** | 把该 dump 恢复到新建隔离库并逐表核对 | **已完成并通过**（2026-09-17：`pg_restore` exit=0；逐表 6/6 与 manifest 一致；内容与编码完整；见 runbook 末节） |
| 操作手册 | `loom-backup-restore-runbook.md`（§2.1 生产已验证流程；网关 SQLite/MinIO/Telethon 各自程序） | 已交付 |
| RPO/RTO | 建议 ≤24h / ≤2h | **proposed**：单次备份 + 单次演练已完成，但**未建立持续备份**，也未在停写窗口下演练，故不达标 |
| 回滚资源 | 候选为工作区改动（未提交）；停用新源/关付费/MCP；Dockerfile 与 compose 变更可回退 | 已记录 |
| 真实发布回滚 | 属 T24/Gate D，**未准备**（需唯一目标与版本） | 未开始 |

## 6. 已知限制与未完成（不得越界宣称）

1. **本会话模型无图像输入** → 计划要求的"实际查看截图"**未完成**；已用 DOM 断言 + 像素审计替代，但**不能**判断重叠/裁切/对齐。**需人工或视觉模型复核一次。**
2. **Go `-race` 未在本机重跑**（Windows）；沿用历史 Linux 证据。
3. **P95 due-to-start ≤120 秒门槛未验证**（T17 为本地突发；真实节奏需 T23）。
4. **真实服务全部未验收**：模型、MCP、OCR/ASR、各采集平台、微信账单 → T21/Gate A。
5. **业务数据迁移未做**；8182 内存库**无已证实备份**，不承诺找回 → T22/Gate B。
6. **长期运行未验证**（72h/7 天）→ T23/Gate C。
7. **正式发布未准备**（唯一目标、迁移演练、回退清单）→ T24/Gate D。
8. `src/routes/inbox.tsx` 有 1 个既有的未使用导入 warning（未清）。
9. 检索术语表目前仅 1 组等价对（按"错配比漏配更危险"保守维护）。
10. 真实领域检索质量仍缺用户材料样本。

## 7. 复现候选版本

```bash
# 依赖与类型
npm ci
npm run typecheck

# 全部门禁（一条命令）
npm run test:all

# 需要隔离 PG 的两项
docker run -d --name loom-candidate-pg -e POSTGRES_PASSWORD=review-only-local \
  -e POSTGRES_DB=review -p 127.0.0.1:54176:5432 postgres:16-alpine
REVIEW_PG_PORT=54176 npm run agent:pg
REVIEW_PG_PORT=54176 npm run agent:retrieval
docker rm --force --volumes loom-candidate-pg

# 浏览器（dev + built 全自动，自建容器）
node --experimental-strip-types scripts/readiness-e2e.mjs

# 容量（突发）
node --experimental-strip-types scripts/collection-load-check.mjs --sources 100
node --experimental-strip-types scripts/collection-load-check.mjs --sources 1000
```

## 8. 结论

**L0 离线候选已完成**：代码、隔离验证、迁移路径、容量突发评测与候选清单齐备，
未获授权的真实门（T21—T24）已逐条列明待批。

**不得**据此宣称"生产就绪"或"受控试用可用"——那些需要 L1/L2 条件，见 release-scope。
