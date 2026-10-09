# 项目助手验收基线（Task 18 / 2026-10-09）

## 环境与版本

| 项 | 值 |
| --- | --- |
| 实现基线 HEAD | `e6e7d26`（2026-10-08 冻结），实施自基线起 24 个提交至 `9819e7f` 之后 |
| 本轮验收 HEAD | `9aa51ec` + Task 18 补齐提交 |
| Node / Go / Docker | v24.13.0 / go1.24.1 windows-amd64 / 28.5.1 |
| 操作系统 | Windows（本机 Docker Desktop，Linux 容器） |
| 测试数据库 | PGlite（单元/e2e）+ 一次性 `postgres:16-alpine` 容器（A27，`assistant-pg-a27`，schema `assist_<uuid>` 用后即删） |
| 浏览器 | Playwright Chromium（真实驱动，非 CUA 转述） |

## 已执行的验收与结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 助手全量测试（显式清单，15 个 TS 文件） | `npm run test:assistant` | 113/113 通过，0 fail |
| 故障验收（A13/A17/A14/A31/A12-A13） | `node --experimental-strip-types --test validation/agent/assistant/faults.test.ts` | 5/5 通过 |
| 隔离验收（A19 Go profile 隔离 6 项 + A20/A25 合同表面） | `node validation/agent/assistant/isolation.test.mjs --run` | 3/3 通过（Go 子集 6 pass 0 fail） |
| 浏览器冒烟（A02 桌面+移动 390px、A03 IME） | `ASSISTANT_SMOKE_BASE=… ASSISTANT_SMOKE_HOST_IP=… node validation/agent/assistant/browser-smoke.mjs --run` | 3/3 通过；截图 `screenshots/assistant-smoke-{desktop-panel,mobile-panel,composer}.png`；verdict `screenshots/assistant-smoke-verdict.json` |
| A27 真实 PostgreSQL 迁移链 + 崩溃恢复收敛 | `ASSISTANT_MIGRATION_DSN=… node validation/agent/assistant/a27-real-pg.mjs --run` | 2/2 通过（迁移链 OK；result_saved→重启→收敛恰 1 条消息） |
| 助手 e2e（A04/A05/A12/A13/A30/A31） | `node validation/agent/assistant/e2e.mjs --run` | 8/8 通过 |
| 既有回归 | `npm test`（296 项）、`go test ./...`、`typecheck`、`lint` | 全绿，0 fail |

## 浏览器冒烟环境说明（如实记录）

本 Windows 宿主的 `127.0.0.1:8080` 被 Docker Desktop 端口转发常驻占用（转发到
不含助手 UI 的旧容器），因此冒烟使用 `--host-resolver-rules=MAP localhost
<eth0-IP>` 将浏览器对 `localhost` 的解析指向真实 dev 服务器（Host 头保持
`localhost`，满足可信本机访问门禁）。dev 服务器带一次性环境变量
（`LOOM_MODEL_CONFIG`/`LOOM_MODEL_MANAGE_ALLOWED=true`/`AGENT_ASSISTANT_ENABLED=true`/
假治理定价变量）以启用 composer 渲染；这些变量未写入任何持久配置。控制台错误
过滤仅豁免平台注入的 `grok.com/extensions.js` 资源加载失败（workspace 契约注入
的平台 chrome，沙箱无外网时不计入应用错误），其余全部计入。

## 已修复的实现缺陷（验收过程中发现并修复）

1. `crypto.randomUUID` 在非安全上下文（http:// LAN）不存在 → 面板渲染崩溃导致
   整树卸载。修复：decision id 使用安全上下文探测 + 随机 hex 回退（fa084d7 之后的
   浏览器冒烟提交）。
2. `not_found` 回执缺 `error_code` 字段 → A14 断言失败。修复：全部 not_found
   回执补 `error_code: "not_found"`。
3. smoke 脚本对 Vite 重新优化导致的 DOM detach 增加水合等待。

## 尚未执行（不视为已验收）

- **A16/A19 完整链**：真实 OpenCode 1.3.13 二进制 + assistant profile 的端到端
  运行（需要 Linux 隔离容器构建与运行 runtime 镜像；Go 层隔离测试已通过，但完整
  链需按既有 `agent:research:e2e` 模式在 Linux 容器执行，本 Windows 沙箱无法
  运行 linux/amd64 OpenCode 二进制）。
- **Q01 付费质量试运行**：需要真实模型供应商、冻结样本与价格配置（计划明确
  单列，禁止以假模型结果替代）。
- 人工的 IME 组合键真机验证（A03 的 Playwright 部分已覆盖提交与文本保真，
  组合键 isComposing 行为需真实 IME）。

清理承诺：`assistant-pg-a27` 容器在本轮验收后删除；测试 schema 已随脚本
`drop schema cascade` 清除；未触碰工作区外任何资源。
