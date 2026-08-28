# Outcome

在项目根目录提供 Windows 一键脚本 `restart.bat`：双击后停掉已有 Docker 栈并重新 `docker compose up --build`，等控制面就绪后自动打开浏览器，窗口继续跟随容器日志。

# Scope

- 新增根目录 `restart.bat`（Windows cmd）。
- 脚本切到自身所在目录；检查 Docker Desktop / `docker compose` 可用。
- 真正重启：`docker compose down`（不带 `-v`，保留 Postgres / MinIO / Telethon 会话卷）后执行 `docker compose up --build -d`。
- 若本机 `8080` 仍被非 Compose 进程占用，先结束该监听进程，避免控制面端口冲突。
- 轮询 `http://127.0.0.1:8080/`，就绪后打开默认浏览器；随后 `docker compose logs -f`，窗口不自动关闭。
- Docker 未安装、引擎未启动、或等待超时：中文说明并 `pause`，不闪退。

# Non-goals

- 不改 `startup.sh`、`docker-compose.yml`、Telethon 镜像或登录流程。
- 不自动执行 `docker compose run ... python login.py`（交互登录仍按使用指南手动做）。
- 不创建或不改写 `.env`，不把密钥写进脚本。
- 不实现 `npm run dev` 本地开发路径，也不做 Linux/macOS 脚本。
- 不 `docker compose down -v`（禁止清数据卷）。

# Acceptance examples

- A1: 双击 `restart.bat` 后，脚本对当前目录执行 `docker compose down` 再 `docker compose up --build -d`，不带 `-v`。
- A2: 控制面 `http://127.0.0.1:8080/` 返回成功后，脚本用默认浏览器打开该地址。
- A3: Docker 未安装或守护进程未运行时，窗口显示中文错误并等待按键，不立刻关闭。
- A4: 再次双击同一脚本可完成重启：旧栈被停掉后新栈拉起，不因 `8080` 占用而失败。
- A5: 启动成功后命令窗口保持打开并跟随 `docker compose logs`；用户关掉窗口不作为失败条件。
- A6: 脚本不写入 `.env`、不含 Telegram / xAI 密钥，也不调用 Telethon `login.py`。

# Constraints and invariants

- 工作目录必须是脚本所在项目根（`cd /d "%~dp0"`），以便找到 `docker-compose.yml`。
- Compose 项目与现有 `docker-compose.yml` 一致：Postgres、MinIO、Telethon、控制面；控制面映射 `8080`。
- 数据卷必须保留：`pgdata`、`miniodata`、`telethon-session`。
- 控制台 UTF-8（`chcp 65001`），中文提示可读。
- 优先 `docker compose`（V2 插件）；若无则回退 `docker-compose`。
- 不提交密钥；运行时也不创建 `.env`。Compose 若发现用户已有 `.env` 会自行读取，脚本不干预。

# Decisions

- 隔离模式：当前目录（无 Git 仓库，无并行变更）。
- 制品语言：zh-CN。
- Q1：默认路径为 Docker 生产栈，不是 `npm run dev`。
- Q2：控制面就绪后自动打开 `http://127.0.0.1:8080`。
- 重启语义：`compose down`（保留卷）+ `up --build -d`，再跟随日志。
- 不自动做 Telethon 交互登录；未登录时沿用产品已有的 `t.me/s` 回退。
- 若宿主 `8080` 被非容器进程占用，先结束该监听进程再拉栈。
- 首次构建可能较久：就绪轮询上限约 10 分钟，超时则报错并保留已启动容器，不自动 `down`。

# Open questions

（无。用户已确认共享理解。）

# Verification expectations

- 静态：根目录存在 `restart.bat`；含 `compose down`、`up --build`、打开 `http://127.0.0.1:8080`；不含 `-v`、不含 `login.py`、不写 `.env`、不含 `npm run dev` 作为启动路径。
- 本机有 Docker 时：执行脚本后 8080 可访问，浏览器打开命令存在；再执行一次仍能重启。
- 无 Docker 时：走错误分支文案验收（A3）。
