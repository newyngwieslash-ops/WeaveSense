# 本机模型网关（opencodex）启动与恢复手册

调查日期：2026-09-24。**本文只记录事实与操作，不含任何密钥。**

## 1. 它是什么，为什么生产依赖它

织识 Loom 的「分析 / 简报 / 问答」走 **legacy 同步入口**，模型地址来自
`F:/loom-backups/model-config/model.local.json`（2026-09-30 起为多档案格式，
应用内「模型设置」页可直接增删改与切换）：

```json
{ "active": "8e097bfa", "profiles": [
  { "id": "default", "name": "默认配置", "baseURL": "http://localhost:10100/v1", "model": "gpt-5.6-luna", "apiKey": "…" },
  { "id": "8e097bfa", "name": "cli-proxy", "baseURL": "http://localhost:8317/v1", "model": "grok-4.5", "apiKey": "…" }
] }
```

`localhost:10100` **不是** Loom 自己的组件，而是本机的 **opencodex** 代理
（`@bitkyc08/opencodex` v2.45.0，一个把多家 provider 统一成 OpenAI 兼容接口的中转）。

生产容器通过 `extra_hosts: localhost:host-gateway` 访问它——代理只接受来自回环的请求
（它自己的 DNS-rebinding 防护），所以要让它看到回环来源，而不是降低那个校验。

**它一停，分析与问答就不可用**（页面会明确报连接失败，不会伪造答案）。

## 2. 安装形态（2026-09-24 实测）

| 项 | 值 |
|---|---|
| 包位置 | `C:\Users\Administrator\AppData\Roaming\nvm\v24.13.0\node_modules\@bitkyc08\opencodex` |
| 全局命令 | `opencodex`（等价别名 `ocx`），位于 `C:\Program Files\nodejs\opencodex.cmd` |
| 版本 | 2.45.0 |
| 运行时 | 包内自带的 `bun.exe`（`Runtime source: bundled`） |
| 配置 | `C:\Users\Administrator\.opencodex\config.json` |
| PID 文件 | `C:\Users\Administrator\.opencodex\ocx.pid` |
| 服务日志 | `C:\Users\Administrator\.opencodex\service.log`（**当前不存在**，因为服务未安装） |
| 崩溃日志 | `C:\Users\Administrator\.opencodex\crash.log`（最后写入 2026-08-19，与本次无关） |
| 监听 | `127.0.0.1:10100`（`config.json` 的 `port: 10100`，未设 hostname = 默认回环） |
| 默认 provider | `openai`（`authMode: forward`，走 ChatGPT 后端） |

> ⚠️ **同名的东西不要混淆**：Windows 服务 `CodexSandboxService.OpenAI.Codex`
> （显示名 "ChatGPT"）是 **OpenAI Codex 官方客户端自己的沙箱服务**，路径在
> `C:\Program Files\WindowsApps\OpenAI.Codex_…\codex-windows-sandbox-service.exe`。
> **它与 opencodex 代理无关**，不要为了修模型去动它。

## 3. 为什么它会消失（2026-09-24 的实例）

- 宿主 **09:05 重启**（`LastBootUpTime` 实测），代理**没有随系统自启**
- 根因：**它从未被安装为持久服务**。`ocx service status` 明确报告
  `service not installed (Task Scheduler)`，而 `ocx status` 也提示
  `No background service was available to restart it`
- 它只有 **Codex autostart shim**（`codex.cmd` 包装器）——那个 shim 只在**运行 `codex` 命令时**
  才拉起代理，**Loom 不运行 codex，所以永远不会触发它**
- 历史线索：`ocx.pid` 里是 27404、启动时报
  `Previous session (PID 27404) did not shut down cleanly`，说明上一次是**非正常退出**
  （与系统重启一致），崩溃日志里没有任何 9 月的记录

**结论**：不是崩溃，是**从未配置自启**。

## 4. 怎么启动

### 4.1 临时（当前会话有效，重启电脑后失效）

```bash
opencodex start
```

它是**前台常驻进程**：不要用 `timeout` 包它——`timeout` 到点会把代理一起杀掉。
若在脚本里调用，必须脱离终端：

```powershell
Start-Process -FilePath 'opencodex.cmd' -ArgumentList 'start' -WindowStyle Hidden -PassThru
```

验证：

```bash
opencodex health          # 期望: Proxy healthy (PID …, port 10100)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:10100/healthz   # 期望: 200
```

### 4.2 持久（推荐，重启电脑后自动恢复）

```bash
opencodex service install
```

它注册为 **Windows 计划任务**（`ocx service status` 的判据就是计划任务是否存在）。
相关子命令：

| 命令 | 作用 |
|---|---|
| `ocx service install` | 安装并启动持久服务（可能在需要时提权） |
| `ocx service status` | 查看是否已安装、日志路径 |
| `ocx service restart` / `repair` | 修复或重启既有服务 |
| `ocx service uninstall` / `remove` | 移除服务 |

**未执行**：安装系统级持久服务会改变宿主状态并可能触发 UAC 提权，
**本助手未擅自执行**。`ocx status` 自己也提示：
`Restart safety: AT RISK for Codex Desktop after restart … run 'ocx service install'`。

## 5. 停止与恢复

```bash
ocx stop        # 停止代理，并把 Codex 恢复成原生（之后 plain codex 也能用）
ocx restart     # 原地重启
ocx restore     # 只恢复 Codex 指向，不停代理
```

## 6. Loom 侧的配套（已配置，无需每次改）

| 配置 | 位置 | 值 |
|---|---|---|
| 模型配置目录 | `F:/loom-backups/model-config/`（**可写**挂载进容器 `/app/config`，2026-09-30 起为多档案格式） | 默认档案 `baseURL: http://localhost:10100/v1` |
| 应用内管理 UI | 「模型设置」页（`/model-settings`），多档案增删改 + 一键切换 | 由 `LOOM_MODEL_MANAGE_ALLOWED=true` 门控 |
| 容器内 localhost 指向宿主 | `docker-compose.yml` → `extra_hosts: localhost:host-gateway` | — |

**注意**：容器的这个挂载与 `extra_hosts` 只在 app 服务上；改完要
`docker compose up -d --force-recreate --no-deps app` 才生效。
2026-09-30 起配置迁移到目录挂载（`F:/loom-backups/model-config/model.local.json`，
多档案 JSON：`{active, profiles:[...]}`）；旧单文件 `F:/loom-backups/model.local.json`
原地保留作回滚备份。模型可直接在 UI 里改，无需再登服务器编辑文件。

## 7. 排障速查

| 现象 | 检查 |
|---|---|
| 分析/问答报连接失败 | `ocx health`；`netstat -ano \| grep :10100` |
| 宿主机 curl `127.0.0.1:10100/healthz` 通、容器内不通 | 容器的 `extra_hosts` 是否还在（`docker inspect …-app-1`） |
| `ocx status` 说 running、但端口无监听 | 多半是 `ocx.pid` 陈旧记录；以 `netstat` + `healthz` 为准 |
| 代理进程被反复杀掉 | 是否被 `timeout`/脚本包住前台进程；改用 `service install` |
| 模型能连但报 provider 错误 | `ocx doctor`；`ocx provider` 查看 provider 与配额 |
| 端口被别的程序占用 | 改 `config.json` 的 `port` **并同步** 模型档案的 `baseURL`（UI 或 `F:/loom-backups/model-config/model.local.json`） |

## 8. 与 Loom 重建镜像的关系

2026-09-24 重建镜像时发现模型不可用，一度以为是重建引入的。
**已用回滚镜像对照验证：新旧镜像连它都失败**——问题在代理进程不在,
与镜像无关。记录在此，避免下次重复排查。
