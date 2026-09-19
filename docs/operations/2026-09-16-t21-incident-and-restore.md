# T21 期间的事件记录与恢复（2026-09-17 01:35 宿主 Docker 重启）

## 事件

2026-09-17 01:35（本地时间，`docker inspect` 的 `FinishedAt`），**宿主 Docker 守护进程整体重启**，
导致所有**没有重启策略**的容器以 `Exited (255)` 停止。

### 判定依据（非猜测）

| 证据 | 含义 |
|---|---|
| 所有 `restart: unless-stopped` 容器同一时刻 **Up 8 minutes**（生产栈 7 个 + workbuddy + wewe-rss + cli-proxy-api + yibin-db） | 守护进程重启后按策略自动拉起 |
| 无重启策略的容器停在 `Exited (255)`（`loom-agent-harness-b7e5daa3`、`loom-followup-20260911`） | 同一事件，因无策略未被拉起 |
| `ExitCode=255`、`OOMKilled=false`、`Error=` 空 | 非内存、非容器自身崩溃；是守护进程停止时未获优雅终止 |
| `loom-agent-harness-d90b98baa3 Exited (255) **3 days ago**` | 同样模式在 3 天前已发生过一次，属**既有周期性现象** |
| 我的容器 `loom-t21-pg` 同时 `Exited (255)` | 与手测容器**同样**受影响，说明是全局事件而非针对某个容器 |

### 与本次执行的关系（如实说明）

- 助手全程只对 `--name loom-t21-*` 的容器执行 `docker run/start/rm`，**从未对手测容器执行任何 docker 命令**；
  相关命令均可从执行日志复核。
- 但**事件发生在助手执行 T21 的时间窗内**，因此在此明确记录，不做"与我无关"的单方面结论。
- 另：早前（22:38 左右）观察到 `telethon` 容器 "Up 15 minutes"，与本次同为守护进程重启的早期迹象。

## 恢复（已完成，数据零丢失）

| 资源 | 操作 | 结果 |
|---|---|---|
| 55191 PG | `docker start loom-agent-harness-b7e5daa3`（**原容器、原数据卷** `4b73f952…`，非新建） | Up，127.0.0.1:55191 监听 |
| 55192 应用 | `node scripts/agent-integration-harness.mjs --manual --resume-sept13`（交接文档记录的原命令） | Up，HTTP 200 |
| 数据核对 | 按交接文档基线逐项比对 | **items=81、ai_runs=11、analyses=1、notes=8**；最近 3 个 run 状态与文档一致（99b1ada0/succeeded、beb611b0/succeeded、f6f099a0/failed） |

**历史基线（交接文档）：11 run / 1 条 Battery analysis —— 完全一致，数据未丢。**

恢复使用的是**本地假模型**（harness 内置），零真实费用。

## 教训与建议

1. 临时容器（`docker run`）在宿主的 Docker 重启后不会自动恢复。手测环境若要长期稳定，
   建议改为 compose 服务或加 `--restart unless-stopped`。
2. 本次恢复及时，但**如果宿主重启发生在无人值守时段**，手测环境会一直处于停止状态。
3. 该现象 3 天内已出现两次，建议排查 Docker Desktop / WSL 的资源或更新策略。
