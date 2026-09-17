# 本地模型配置与手动测试

本次功能位于独立工作区 `.worktrees/local-model-settings`，原项目 8080 服务保持原样。Key 由你自行填写，不需要发到对话里。

## 1. 填写配置文件

在独立工作区运行一次 `npm run model:setup`，生成 `config/model.local.json`，已有文件不会被覆盖。编辑为：

```json
{
  "baseURL": "http://localhost:10100/v1",
  "model": "网关模型列表中的完整模型ID",
  "apiKey": "在这里填写你的网关API Key"
}
```

Key 的位置就是 **apiKey 的双引号内**。模型 ID 必须与网关提供的 ID 一致，截图中只有接口地址，不能据此推断模型 ID。

配置文件、锁文件与临时文件已被 Git 和 Docker 构建忽略；开发服务器禁止下载 `*.local.json*`。不要把配置放进 `public`、截图或提交记录。Windows 文件权限继承配置目录权限，请放在仅可信本机用户可访问的目录。

自定义路径也必须以小写 `.local.json` 结尾，且原路径和真实路径都不能位于 `public` 目录。否则应用拒绝读取。此规则使自定义文件同样受 Git、Docker、开发服务器和源码归档保护。页面显示配置版本；若进程意外中断遗留同名 `.lock` 文件，应先确认没有保存进程，再手动移除该锁文件。

项目已有的 `npm run dev`、`npm run preview` 会在启动时自动识别该文件。首次创建文件后需重新启动对应实例；之后修改文件不需要重启。也可通过服务端环境变量 `LOOM_MODEL_CONFIG` 指定其他私有文件的绝对路径，不要使用 `VITE_` 前缀。没有配置文件时，原有 `XAI_API_KEY` 与默认 xAI 模型行为保持兼容。

## 2. 页面操作

本机设置实例推荐用 `npm run dev -- --host 127.0.0.1 --port 8182` 启动。正式构建用 `npm run preview -- --host 127.0.0.1 --port 8183`。预览适配器不提供对端 IP 时，只允许启动包装器确认了显式回环绑定的实例；不能靠请求头开启。禁止把该管理实例通过反向代理暴露给其他用户。

1. 打开新版本，选择左侧「模型设置」；手机点击右上角齿轮。
2. 确认「API Key：已配置」。这里只说明文件中存在 Key，还没有验证它是否有效。
3. 填写基础 URL `http://localhost:10100/v1` 和完整模型 ID。
4. 点击「保存设置」，刷新页面，确认两个字段保留。
5. 点击「测试连接」。成功应显示「接口认证成功，模型 ID 已找到。尚未测试生成。」

连接检查只发送 `GET /v1/models`，不会调用 Chat Completions 或 Responses。页面加载、刷新和保存不访问网关。若网关不提供模型列表接口，会显示检查失败；这本身不能证明生成接口不可用。

## 3. Docker 场景

地址由执行模型请求的服务所在位置决定：

| 应用位置 | 基础 URL |
| --- | --- |
| Windows 本机 Node | `http://localhost:10100/v1` |
| Docker 容器，网关在 Windows 宿主机 | `http://host.docker.internal:10100/v1` |

容器运行同步入口时，应把包含私有文件的目录挂载到容器，并将 `LOOM_MODEL_CONFIG` 指向容器内路径。只读挂载支持读取配置；原子保存需要目录写权限，单文件挂载不适合原子替换。当前管理 API 严格验证真实对端 IP，不信任 X-Forwarded-For，Docker 端口映射及反向代理访问可能显示 403；这种部署请在宿主机编辑文件，或使用本机 Node 的设置页。不能通过关闭对端检查来绕过限制。

此配置作用于当前 legacy 同步入口的分析、问答和简报。Eino 服务继续使用其既有 `AGENT_MODEL_BASE_URL`、`AGENT_MODEL_NAME`、`AGENT_MODEL_API_KEY`；本次保存不切换引擎，也不打开后台研究或自动分析。

## 4. 手动验收表

| 编号 | 操作 | 预期 |
| --- | --- | --- |
| MS01 | 空 Key 打开页面 | 显示未配置，测试连接禁用 |
| MS02 | 在文件填写 Key，点重新读取 | 显示已配置，页面与响应均不含 Key |
| MS03 | 修改 URL/模型后尚未保存 | 测试连接禁用，避免误测旧配置 |
| MS04 | 保存后刷新 | 值保留，Key 不变，无模型调用 |
| MS05 | 两个页面读取相同配置，分别保存 | 后保存的旧版本被拒绝，刷新后重试 |
| MS06 | 同文件填入非法 JSON | 显示配置无效，不默默退回其他供应商 |
| MS07 | 测试正确地址、Key、模型 | 认证通过且模型存在，明确尚未测试生成 |
| MS08 | 错误 Key/模型/停止网关 | 明确失败，不展示服务端原始错误或 Key |
| MS09 | 直接请求私有文件 | 无法读取 Key |
| MS10 | 手机查看、编辑、保存 | 可操作，无横向溢出 |
| MS11 | 已授权后分别点击 LLM 分析、提问、生成简报 | 使用已保存模型，结果实际写入；需单独记录真实调用费用与结果 |
| MS12 | 请求进行中更改模型 | 原请求继续使用原模型，后续请求使用新模型 |

MS11 属于真实生成，可能消耗网关上游额度。2026-09-09 用户实测：分析与问答的生成展示、刷新保留通过；今日简报生成“未提供具体问题”，未通过。账单、调用次数及服务重启持久化尚未验证。逐项结果见主工作区 `docs/operations/2026-09-09-manual-test-record.md`；不能将离线假网关验收等同于完整真实验收。既有完整业务测试继续参照 `2026-09-08-eino-agent-manual-test-guide.md`。

## 5. 离线复核命令

```powershell
npm run test:model-settings
node --experimental-strip-types --test src/lib/server/analyze.test.ts
npm run typecheck
# 运行构建时确保 DATABASE_URL 未指向真实数据库
npm run build
```

浏览器脚本 `scripts/model-settings-ui.mjs` 只使用固定本机假网关 8190 和 `artifacts/model-settings-qa/model.local.json` 测试夹具。启动隔离应用时必须将 `LOOM_MODEL_CONFIG` 指向该夹具；禁止用真实配置运行脚本。
