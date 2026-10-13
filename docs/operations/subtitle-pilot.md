# YouTube 字幕试点（C01）

更新时间：2026-10-13。**工具前提和离线验证完成；真实字幕验收 pending。** 本提交没有接通视频下载、音频下载、ASR、浏览器 Cookie 或模型服务，也没有修改应用依赖、全局工具或生产配置。

| 证据 | 实际结果 | 能说明什么 |
|---|---|---|
| 新建任务隔离 Python 环境中的固定工具 | Python 3.12.14；yt-dlp CLI 2026.08.19（发行包版本 2026.8.19）；yt-dlp-ejs 0.8.0 | 本机隔离工具已安装，离线版本命令可运行 |
| 显式 JS 运行时 | `F:/nodejs/node.exe`，v24.16.0 | 符合官方 Node >=22 的运行时前提 |
| 合成字幕回放 | 10 个用例通过；另有 URL、参数、环境隔离、超时、输出上限检查 | 离线逻辑检查通过，不能证明公开视频实际可读 |
| 真实 YouTube 内容 | **0 条真实提取，0 次字幕/视频/音频请求** | 公网地址策略阻断、已有业务样本不足和逐请求安全传输待接通；真实 gate 未通过 |

## 固定样本与来源

`validation/collection/subtitle-samples.json` 固定了十条 **proposed public reference candidates**，逐条记录公开来源证据。它们来自 yt-dlp 2026.08.19 的公开测试用例，**不是现有业务条目，也不是已接受或本次已读取的字幕样本**。

应用 `src/lib/server/seed.ts` 中现有 YouTube 条目仅含 `yt-tmp-001`、`yt-tmp-002`、`yt-yc-001`、`yt-yc-002` 占位 ID，均不符合 11 字符视频 ID。未读取生产数据库或私人配置来补齐样本。真实业务样本集合仍为 `waiting_for_business_samples`。

三个历史期望有公开依据：QRS8MkLhQmM 的人工字幕用例、8YoUxe5ncPo 的自动字幕用例、Ky9eprVWzlI 的历史不可用跳过标记。其余七条 `expected_kind:null`，没有猜测字幕类型或当前公开可访问状态。依据见 [固定版本字幕测试](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/test/test_subtitles.py) 和 [固定版本视频测试](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/yt_dlp/extractor/youtube/_video.py)。

8YoUxe5ncPo 的 `nosubtitles` 测试只证明缺人工字幕；同一视频还有自动字幕。不能把它用作“无任何字幕”的实测证据。短视频、音乐、无对白内容也不能仅凭内容类型标记为 none。合成无字幕用例不填补真实无字幕样本缺口。

## 可复现的离线验证

从项目根目录使用 Python >=3.10（回放不要求安装 yt-dlp）：

```powershell
python validation/collection/subtitle-validation.py --self-check --report artifacts/collection-capability/subtitle/offline-replay.json
```

默认不传参数只输出 pending 公共报告，不访问网络；`--replay` 只回放随仓库提交的 `subtitle-fixtures.json`。报告显式带 `mode:offline_replay`、`offline_acceptance:passed`、`live_gate:pending`、零真实请求和零真实公开视频样本。

用例覆盖人工优先、自动字幕、完整空字幕库存、目标语言缺失但其他语言存在、视频不可用、不完整库存、空字幕文本、负时间轴、缺失库存字段和 JSON3 不可用。自检另外覆盖非 YouTube/凭据/playlist/重复 v/query 尾巴/控制字符/错误 ID、语言表达式拒绝、各重试参数为零、非法 cue/segment、环境不继承密钥/私有索引/代理配置，以及子进程超时与输出越界。子进程只用于本地版本探测或合成检查，stdout/stderr 各上限 64 KiB；单次执行上限 45 秒。原始 stderr 不写入公共报告。

已执行的最小检查命令使用 bundled Python 3.12.14；工具探测使用本次新建 venv 的 Python。产物位于忽略的 `artifacts/collection-capability/subtitle/`，不提交原始元数据或字幕文本。

## 实际工具前提与固定安装记录

本次在任务 scratch 下新建隔离 venv，**一次**安装尝试成功。仅安装官方 PyPI 的两个精确版本，使用纯 wheel、无依赖扩展和零重试；没有全局安装或 broad upgrade。实际使用参数数组，禁用 pip 配置，环境只保留运行所需 Windows/PATH/temp 键，丢弃私有索引、代理凭据、Cookie 和用户配置；`NO_PROXY=*` 避免继承系统代理凭据。

精确安装参数（此段是记录，脚本不会自动安装）：

```text
<isolated-python> -I -m pip --isolated --disable-pip-version-check install --no-cache-dir --index-url https://pypi.org/simple --only-binary :all: --no-deps --retries 0 --timeout 10 yt-dlp==2026.08.19 yt-dlp-ejs==0.8.0
```

创建 venv 使用 bundled Python 3.12.14；安装执行有 90 秒截止和 stdout/stderr 各 64 KiB 上限。依赖安装是单独授权的固定公共 registry 操作，不修改应用 publicFetch/DNS 防护，也不构成字幕验收。工具版本报告与包安装日志仅存 scratch；本提交不新增第二份 requirements 文件。后续 C02 的 `workers/subtitle/requirements.txt` 应成为 worker 唯一依赖清单。

在已安装上述固定工具的隔离 Python 环境中，可以执行仅版本探测：

```powershell
& '<isolated-venv>/Scripts/python.exe' -I validation/collection/subtitle-validation.py --probe-tools --node 'F:/nodejs/node.exe' --report artifacts/collection-capability/subtitle/tool-probe.json
```

Node 路径必须是实际已安装的本地绝对路径。探测显式指定 `--no-js-runtimes --js-runtimes node:<path>` 并使用 `--ignore-config --no-plugin-dirs --no-remote-components --no-cache-dir --version`，不传任何视频 URL。报告只保留通过校验的版本与本地运行时路径，提取字段保持独立。

官方依据：[固定版本 pyproject](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/pyproject.toml) 要求 CPython >=3.10，并为该版本指定 EJS 0.8.0；[EJS 官方说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS) 要求匹配的 EJS 和受支持的 JS 运行时，Node 需显式启用。单独安装 yt-dlp 不足以宣称完整 YouTube 支持。

旧缓存镜像 `yt-dlp-image:latest` 的独立无网络、无挂载临时容器版本探测结果是 **Python 3.9.21／yt-dlp 2025.3.21，无 EJS、Node、Deno、Bun**。镜像 ID `sha256:7e6f62e70c48cd899fd1463fd4f5519c4db701d0d69c20f5a9fd44c7865071e2`。没有读取镜像 Env/秘密或修改运行服务；该旧镜像没有被当作本次支持的提取器。

## 真实读取失败关闭

```powershell
python validation/collection/subtitle-validation.py --live --report artifacts/collection-capability/subtitle/live-pending.json
```

该命令目前**预期退出 1**，立即输出 `live_refused` 和 `guarded_transport_pending`，不做 DNS 查询或启动 yt-dlp 网络提取。十条候选报告的 `tool_version/kind/chars` 均为 null、`status:pending`；已安装的工具版本只出现于独立 tool_probe 报告。无字幕样本的 observed kind 不能在实际读取前填成 none。

先前单次 DNS 检查中，`www.youtube.com` 返回 198.18.0.88 与 2001:2::57，其他 YouTube 主机也返回保留/合成地址。既有 `resolvePublicAddresses(...,[])` 在 HTTP 前正确拒绝 `blocked_address`。没有进行新的真实请求、备用 DNS/IPv6/代理/egress 绕过或重复重试。

一个初始 DNS preflight 加普通无限制 yt-dlp CLI 不满足请求时 DNS/IP 固定和逐跳重定向防护。C01 不提供绕过参数；后续仅在 C02 的受审查逐请求传输可用、公开地址允许且业务样本接受之后接入真实验证。

真实提取仍需满足：单视频，不扫描频道/playlist；先列字幕并验证目标 language；同语言人工优先，人工不可用才选自动；只下载单一列出的 JSON3 轨道；`--ignore-config --skip-download --no-playlist --no-cache-dir --no-plugin-dirs --no-remote-components`，socket timeout 10 秒、所有 retry families 为零；独立临时目录、45 秒硬截止与进程回收、2 MiB 字幕上限；文本非空且时间轴有序/有限/非负。库存失败、挑战页或缺 PO token 不能当作真实 none。禁止字幕兜底自动下载音轨、调用 ASR/模型或读取 Cookie。

## Gate 与后续

实现/离线验证可审查；**C01 实际字幕 gate 仍 pending**，没有声称通过十条真实公开视频验收。需要接受的业务样本覆盖人工、自动、真实无目标语言字幕和不可用视频，并留下真实可访问字幕文本/时间轴检查证据。

用户后续明确授权 C02 在 C01 真实 gate 未通过时实现与离线验证，但功能/profile 必须默认关闭；该授权不覆盖真实字幕成功率、生产启用、部署或放宽公网策略。C03 独立渠道试点和付费/ASR能力不由此提交开启。
