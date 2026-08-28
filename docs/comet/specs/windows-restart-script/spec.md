# 织识 Loom Windows 一键重启脚本

Windows 用户通过项目根目录的 `restart.bat` 重启 Docker 生产栈（Postgres、MinIO、Telethon、控制面），并在控制面就绪后打开浏览器。

## 触发

- 双击 `restart.bat`，或在项目根目录从 cmd 运行 `restart.bat`。
- 脚本首先 `cd /d "%~dp0"`，始终以脚本所在目录为 Compose 项目根。

## 前置检查

1. 将控制台代码页设为 UTF-8，窗口标题标明「织识 Loom」。
2. 检测 `docker` 是否在 PATH，并能执行 `docker info`（引擎已运行）。
3. 检测 Compose：优先 `docker compose version`，否则 `docker-compose version`。后续命令使用检测到的那一种。
4. 确认存在 `docker-compose.yml`。
5. 任一项失败：打印中文原因（未安装 Docker Desktop / 引擎未启动 / 缺少 compose 文件），`pause` 后以非 0 退出。不闪退。

## 重启步骤

1. 结束占用本机 TCP `8080` 且处于 LISTENING 的进程（覆盖上次残留的 Node 开发服务或失联容器映射）。结束失败不视为致命，继续往下。
2. 执行 `<compose> down`。禁止带 `-v` 或 `--volumes`，保留 `pgdata`、`miniodata`、`telethon-session`。
3. 执行 `<compose> up --build -d`，后台拉起 `docker-compose.yml` 中的全部服务。
4. 轮询 `http://127.0.0.1:8080/`，间隔约 3 秒，上限约 10 分钟。
   - 成功：用默认浏览器打开 `http://127.0.0.1:8080`。
   - 超时：打印中文超时说明，提示查看窗口中的 Compose 日志；不自动 `down`；`pause` 后非 0 退出。
5. 成功路径执行 `<compose> logs -f`，窗口保持打开。用户关闭窗口或 Ctrl+C 只停止跟随日志，不作为脚本启动失败。

## 环境与密钥

- 脚本不创建、不覆盖 `.env`，不内嵌 `TELEGRAM_API_ID`、`TELEGRAM_API_HASH`、`XAI_API_KEY`。
- 用户若已在项目根放置 `.env`，由 Docker Compose 自行读取。
- 脚本不调用 `workers/telethon` 的 `login.py`。未登录时产品按现有行为回退公开网页预览。

## 非行为

- 不运行 `npm run dev` / 不直接调用 `vite`。
- 不修改 `startup.sh`、`docker-compose.yml`、Dockerfile。
- 不打开 MinIO 控制台（9001），只打开控制面 8080。
