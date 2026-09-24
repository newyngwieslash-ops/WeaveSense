# 织识 Loom 离线候选交接（历史批次 pr-20260916-a1）

> **当前状态（2026-09-21）以[统一交付状态](loom-current-status.md)为准。** 本文下方为历史方案或执行快照；其中“未发布、待授权、未修复”只适用于当时，不覆盖后续证据。T21 部分通过、T22 已验证、T23 未完成、T24 已发布但完整回滚验收未闭环；完整 PRD 尚未完成。本次文档修订尚未发布到生产镜像或下载源码包。

日期：2026-09-16。**级别：L0 离线候选。**
上游文档：`2026-09-16-production-readiness-execution.md`（逐任务执行记录）、`loom-release-candidate.md`（候选说明）、`loom-authorization-checklist.md`（待批准操作）。

---

## 1. 一分钟结论

- **已完成**：T01—T20 全部离线任务通过；T25 指南与本文档交付。共修复 **15 类真实缺陷**（多数有红测试证明其存在）。
- **未完成且需授权**：T21（真实服务）、T22（数据迁移）、T23（长期试跑）、T24（正式发布）——逐条列在授权清单里，**额度字段待你填写**。
- **一处能力缺口（如实报告）**：本会话模型**无法接收图像输入**，因此计划要求的"实际查看截图"**未完成**；已用 DOM 断言 + 像素审计替代，但**不能**判断重叠/裁切/对齐。**需要你或一个有视觉能力的复核者看一眼**（截图在 `screenshots/readiness-{dev,built}-*.png`）。

## 2. 本批实际改动

### 新增（源码）
```
src/lib/server/outbound-policy.ts     出站策略（SSRF/体积/钉连接）
src/lib/server/stage-windows.ts       重阶段持久窗口准入
src/lib/server/cursor.ts              安全数值游标（>2^53）
src/lib/server/term-glossary.ts       术语等价表（检索）
src/lib/server/media-kind.ts          媒体类型分类
src/lib/server/scheduler-outcome.ts   关键词运行结果判定
migrations/0021_stage_windows.sql     新迁移（唯一新增）
scripts/{runtime-policy,restore-policy,deployment-policy}.mjs      策略模块
scripts/{readiness-offline,readiness-e2e,readiness-ui}.mjs         隔离/UI 验证
scripts/{operations-status,collection-load-check,screenshot-audit}.mjs  运维与评测
scripts/zip.mjs                       无依赖 ZIP 写入器（打包跨平台）
```

### 修改（要点）
```
src/lib/db.ts                 正式模式缺库拒绝启动
scripts/migrate.mjs           容器入口同样拒绝
scripts/with-app-env.mjs      未改（隔离改用显式传参）
Dockerfile / docker-compose.yml / env.example / .dockerignore   部署边界
src/lib/server/http.ts        公共下载统一走策略 + 测试缝
src/lib/server/{rss,telegram,media,extract,collectors/*}.ts     接入策略/结果契约/分页/类型
src/lib/server/{scheduler,scheduler-atomic}.ts                  全库打标、游标安全、结果落库
src/lib/server/{nodes,api/cron/tick}.ts                         阶段窗口与耗时
workers/telethon/server.py    升序分页
workers/wechat-gateway/*.mjs  费用保守预留、错误细分、迁移
package.json                  聚合测试命令
外加 6 个前端文件（文案与语义修正）
```

完整清单与哈希：`artifacts/production-readiness/pr-20260916-a1/candidate-manifest.md`

## 3. 命令与计数（复现用）

| 命令 | 结果 |
|---|---|
| `npm test` | 388 项，0 失败 |
| `npm run test:manual-fixes` | 32/32 |
| `npm run gateway:test` | 116/116 |
| `npm run typecheck` | exit=0 |
| `npm run lint` | 应用代码 0 error |
| `go -C workers/agent test ./... -count=1` / `vet` | ok / exit=0 |
| `REVIEW_PG_PORT=<p> npm run agent:pg` | 18/18（隔离 PG） |
| `REVIEW_PG_PORT=<p> npm run agent:retrieval` | exit=0，26 例全通过 |
| `npm run agent:e2e` | exit=0（18 假模型/1 MCP/7 note/2 checkpoint） |
| `node --experimental-strip-types scripts/readiness-e2e.mjs` | exit=0（dev+built × 2 视口，10 项/次） |
| `node --experimental-strip-types scripts/collection-load-check.mjs --sources 100\|1000` | exit=0（每源 20 条、重放 0 新增、重复 0） |
| Python `unittest discover -s workers/telethon -p test_history.py` | 5/5（隔离 venv） |

## 4. 证据位置

| 内容 | 位置 |
|---|---|
| 生产库备份（2026-09-17，只读） | `F:\loom-backups\loom-prod-20260917-141815.dump` + `manifest-20260917-141815.json`；SHA-256 `fc118253…763d` |
| 备份/恢复操作手册 | `R/docs/operations/loom-backup-restore-runbook.md`（§2.1 为生产已验证流程） |
| 逐任务记录（含失败尝试） | `R/docs/operations/2026-09-16-production-readiness-execution.md` |
| 本批日志与清单 | `B/artifacts/production-readiness/pr-20260916-a1/` |
| 容量结果 | `B/artifacts/production-readiness/load/run-{100,1000}-*/` |
| PG 恢复演练 | `B/artifacts/production-readiness/pg-recovery/` |
| UI 结果与截图 | `B/artifacts/production-readiness/ui/`、`B/screenshots/readiness-*.png` |
| 检索评测数据 | `B/validation/agent/implementation-v3-2026-09-08/retrieval-sql.json` |
| 指南与手册 | `R/docs/operations/loom-{user-quickstart,backup-restore-runbook,real-service-acceptance,capacity-report}.md` |

## 5. 数据位置与保护（当前真实状态）

| 资源 | 状态 |
|---|---|
| 55192 假模型手测应用 | **存活**（本轮只读核对，未重启） |
| 55191 手测 PG 容器 | **存活**（`loom-agent-harness-b7e5daa3`，未重启） |
| 8182 开发实例 | **未运行**；其内存库历史数据**无已证实备份**，不承诺找回 |
| 生产 compose 栈 | 运行中，本轮**未** up/down/rebuild，未删任何卷 |
| **生产业务库** | 容器 `…-postgres-1`（卷 `…_pgdata`）：**2,409 items / 26 sources**，仍在活跃采集 |
| **生产库备份有效性** | ✅ **已通过恢复演练验证**（恢复到隔离库后逐表 6/6 一致）；备份文件与 SHA-256 见 runbook |
| **备份覆盖** | PostgreSQL ✅ / MinIO ✅（332 对象）/ 网关 SQLite ✅ / Telethon 会话 n/a（无会话） |
| **异地副本** | ✅ `G:\QBXT_0917\loom-backup-20260917\`（68 MB）；已通过"从副本恢复"验证；**仍与源同机、未加密、无自动同步** |
| 生产实例迁移版本 | ✅ **20/20**（0021 已应用；但生产仍跑**旧构建**，新调度行为需部署新代码才生效） |
| 本轮自建容器 | 全部自清理（每次核对 `docker ps` 为空） |
| `config/model.local.json` | **未读取内容**（仅记录存在与哈希） |

## 6. 历史回滚设想（已失效，不作为操作步骤）

- 历史未提交状态已被后续提交及发布取代。禁止按本节丢弃当前文件；当前回滚资源与执行步骤以 `loom-release-runbook.md` 为准。
- 新增迁移 `0021` 只**新增表**，不改历史迁移；回滚可 `drop table stage_windows`（不再需要窗口功能时）。
- 部署配置（compose/Dockerfile/env.example）改动可单独回退。
- 真实发布回滚方案属 T24，**尚未准备**。

## 7. 需要你提供/批准的最小清单

1. **首版平台清单**（从 release-scope 的 proposed 项里勾选）。
2. **真实服务额度**：模型/MCP/OCR/ASR 的次数与金额上限、时间窗（填 `loom-authorization-checklist.md` 的 Gate A 表）。
3. **业务数据归属**：唯一源库与目标库（Gate B）。
4. **长期试点参数**：账号、窗口、预算、参考集维护人、通知渠道（Gate C）。
5. **发布目标**（Gate D）。
6. **一张截图的目视确认**（或指定有视觉能力的复核者）。

## 8. 下一具体操作（建议顺序）

1. **你**：花两分钟看一眼 `screenshots/readiness-built-long-1280.png` 与 `readiness-built-jobs-1280.png`，确认没有明显视觉问题。
2. **你**：在授权清单里填 Gate A 的额度与样本，然后**告诉助手"批准 A1+A2 于 <时间窗>"**。
3. **助手**：按批准的额度执行 T21 最小验收；完成后更新执行记录并把 C05 标为 real_pass 或如实标注失败/未测。
4. 其余各门按同一模式推进（每次都要具体授权，不用一次性批准全部）。

## 9. 明确不在本批承诺内

- 生产就绪、公网可用、多租户。
- 抖音/小红书/西瓜全站检索；YouTube 全站视频搜索。
- 1000 信源持续稳定（仅突发评测）。
- 8182 历史数据找回。
- 任何未列在 Gate A—D 里的真实调用。
