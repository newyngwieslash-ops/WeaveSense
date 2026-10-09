# 可选 OpenCode 库内研究运行手册

截至 2026-10-07，默认关闭：`AI_ENGINE=legacy`、`AGENT_ASYNC_RESEARCH_ENABLED=false`、`AGENT_WORKER_ENABLED=false`、`AGENT_OPENCODE_WORKER_ENABLED=false`、`AGENT_RESEARCH_RUNTIME=eino`、`AGENT_RESEARCH_REVIEW=off`。普通问答、同步分析及已有笔记不依赖 OpenCode。

固定版本的离线协议、Linux 隔离和真实 OpenCode→Go ModelProxy 假供应商链路已有证据；`live_accepted=false`。这些结果证明受限执行器可集成，不能证明回答质量、成本或延迟改善。采用条件见 [decision](../../validation/agent/opencode/decision.md)、[质量政策](../../validation/agent/opencode/quality-policy.md) 和 [实现计划 Task 17](../plans/2026-10-07-agent-capability-opencode-implementation.md)。本手册没有执行生产部署、付费评测或生产回滚。

## 访问边界与三个信任域

首期仅向可信本机操作者提供深入研究。提交、状态和取消使用既有 `localModelAccess`：必须配置 `LOOM_MODEL_CONFIG`，拒绝 Vercel；主机名限 localhost/回环，写操作要求同 origin。容器使用既有 `LOOM_MODEL_MANAGE_ALLOWED=true` 时，应用端口仍须仅发布到宿主回环。当前不是多人账号授权，不应直接开放到公网。

| 信任域 | 组件与权限 |
| --- | --- |
| 应用宿主 | TypeScript 应用、数据库、队列、冻结候选/审核及发布事务。宿主验证语料范围、版本、租约、角色预算和模型回执，持数据/作业服务 token。 |
| 可信执行控制 | opencode-worker 持 controller token 和短期 run 数据令牌；agent-bridge 持供应商 key、数据服务 token 和 opaque grant 映射。独立 Go Reviewer 持自己的可信服务凭据及模型 key。Worker 不持供应商 key。 |
| 受限运行时 | 固定 OpenCode 1.3.13，独立 HOME/XDG/cwd、子进程环境白名单、批准 Skill；仅有短期 opaque run grant。MCP 只有 corpus_search_items、corpus_get_item；文件/编辑/shell、外网、数据库、其他 Agent 不在批准范围。 |

`AGENT_SERVICE_TOKEN`、`AGENT_DATA_TOKEN`、`OPENCODE_WORKER_TOKEN`、`OPENCODE_RUNTIME_TOKEN`、`OPENCODE_BRIDGE_CONTROL_TOKEN` 必须是不同的随机秘密。wrapper/controller token 只用于可信控制通道，不能当模型凭据或短期 grant；`CRON_SECRET` 不能复用。秘密保留在工作树外的部署配置中，不写入镜像、日志或报告。

## 构建、版本与部署主机复验

新增三个服务属于 `opencode` profile。它们是本地构建镜像，不能把本地 image ID 称作已发布 registry digest。Reviewer 使用另外的 `agent` profile：**只启动 opencode profile 不会启动 Reviewer**。

| 服务 | 构建入口 | 网络与凭据 |
| --- | --- | --- |
| agent-bridge | workers/agent/Dockerfile.bridge | 应用网络与 runtime 网络；固定供应商/模型，拒绝跳转，只有这里及 Reviewer 持供应商 key |
| opencode-runtime | workers/opencode-runtime/Dockerfile production target | 仅 internal/isolated runtime 网络，无宿主端口或 bind mount；供应商/应用 master token 不进入运行时 |
| opencode-worker | workers/agent/Dockerfile.worker | 应用网络与 runtime 网络；可信控制与 Reviewer 服务 token，无供应商 key |
| agent / Reviewer | workers/agent/Dockerfile | 内部服务，POST /v1/review；审核上下文不含 Producer 历史或工具 |

保持单实例、并发 1；不能 scale runtime/worker。运行时必须保持 init、非 root、read-only、cap_drop ALL、no-new-privileges、PID/内存上限及 /state、/tmp tmpfs，不发布 4096/4097/8791/8792。Docker 28+ `gateway_mode_ipv4=isolated` 是实测边界的一部分；普通 internal 网络或 DNS 失败不是等价证明。

以下供隔离 QA 主机执行，不部署现网或调用付费模型。镜像缺失、测试失败或不支持 isolated 模式均不能算通过：

```powershell
docker build --platform linux/amd64 -f workers/opencode-runtime/Dockerfile --target production -t weavesense-opencode-runtime:1.3.13 .
docker build --platform linux/amd64 -f workers/opencode-runtime/Dockerfile --target probe -t weavesense-opencode-probe:1.3.13 .
docker build --platform linux/amd64 -f workers/agent/Dockerfile.bridge -t weavesense-agent-bridge:offline-proxy-test workers/agent
docker build --platform linux/amd64 -f workers/agent/Dockerfile.worker -t weavesense-opencode-worker:pilot workers/agent
node --test validation/agent/opencode/isolation.test.mjs
node --test validation/agent/opencode/model-proxy-isolation.test.mjs
go -C workers/agent test ./...
go -C workers/agent vet ./...
```

每个部署主机须重新证明批准 bridge 可达，公共 IPv4/IPv6、link-local、宿主别名与数字 IP 均不可达，并提供可达宿主 canary 的独立阳性对照。ModelProxy 测试还检查 runtime 不能直连供应商。测试使用独立标签资源并验证清理，不能复用生产网络。isolation.test.mjs 更新 runtime-lock 的观测字段，须与版本变更一起审阅。具体二进制/包装器 hash、Docker Desktop 观测范围及待复验项见 [runtime-lock](../../validation/agent/opencode/runtime-lock.json)；真实代理链路见 [model-proxy-isolation.fixture](../../validation/agent/opencode/model-proxy-isolation.fixture.json)。

## 配置冻结与启用顺序

把下列变量加入已验证的部署插值源，保留既有变量和 service env_file。Compose environment 的空默认值会覆盖 env_file 同名值，不能只写 app.env 就认为已生效。沿用 [部署与恢复约定](loom-backup-restore-runbook.md)，不要拿本例替换完整生产配置。可使用 `docker compose --env-file <工作树外、已合并验证的配置> --profile agent --profile opencode config --quiet` 校验结构；不要输出含秘密的完整 resolved config。

| 配置 | 要求与效果 |
| --- | --- |
| AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN | 默认内部 URL http://agent:8791；先启动 agent profile，供应用及 Worker 调独立 Reviewer |
| AGENT_DATA_TOKEN / OPENCODE_WORKER_TOKEN | 分别授权数据/回执及 OpenCode 作业路由；Eino Worker 使用既有数据凭据，不能领取另一 provider 队列 |
| AGENT_MODEL_BASE_URL / AGENT_MODEL_NAME / AGENT_MODEL_API_KEY | Producer/Reviewer 固定同一已验证、已定价模型；真实 key 仅进入可信 bridge/Reviewer |
| AGENT_PRICE_INPUT_RMB_PER_MILLION / AGENT_PRICE_OUTPUT_RMB_PER_MILLION | 严格正数、有限的人民币价格；先验证供应商的 usage/请求上限，不用 0 或假价格开启真实请求 |
| AGENT_RESEARCH_PRICE_VERSION | 默认 research-price-v1；reservation 保存单价/版本，更换价格版本不能重置每日额度 |
| AGENT_RESEARCH_DAILY_LIMIT / AGENT_RESEARCH_DAILY_BUDGET_RMB | 默认 20 次/20 元，上线前由操作者设定。最坏预留由宿主计算，浏览器不能传入 |
| AGENT_SKILL_SNAPSHOT_DIGEST | 与批准镜像一致的 64 位 SHA-256；从 agent /readyz 取得并核对三份批准 Skill bytes，不能猜。Worker 不匹配则在模型前拒绝 |
| AGENT_EXECUTE_TIMEOUT_MS / AGENT_HTTP_TIMEOUT_MS | 默认 120000/130000；HTTP 至少比执行多 10 秒。首次 claim 固定绝对期限，renew/恢复不延长 |
| AGENT_MODEL_TIMEOUT_MS | Go 单次默认 30000，不能超过执行期限；每次请求再取角色/全局剩余期限中的更短者 |
| AGENT_RESEARCH_QUEUE_TTL_MS | 默认 600000；与首次 claim 后的期限独立，未发送排队超时才可释放已证明未发送的预留 |
| AGENT_RESEARCH_REVIEW | off/shadow/enforce 冻结进作业；shadow 不称作已审核通过，enforce 需要匹配候选的有效独立审核 |
| AGENT_RESEARCH_RUNTIME | eino/opencode 只选择新异步研究，不影响同步 AI_ENGINE 或已有 job/provider |
| AGENT_ASYNC_RESEARCH_ENABLED | 新研究总入队开关，关闭它同时停止两个运行时的新任务 |
| AGENT_WORKER_ENABLED / AGENT_OPENCODE_WORKER_ENABLED | 对应 provider 的领取能力；drain 时保留旧 provider Worker 开关 |

每个作业冻结语料范围、模型/价格、review policy、Skill digest 及角色预算。当前 Producer 最多 6 次模型、4 次工具调用、每次输出 1800 token；shadow/enforce 额外预留 Reviewer 1 次，off 没有审核调用。序列化模型请求上限 512 KiB。存在前序 started/unknown 时，新 call ID 也不能获得再次发送的准入。

1. 全部开关保持默认关闭，先完成隔离假端点的合同、迁移、恢复和浏览器检查。
2. 有明确限额与授权时先做真实 Eino+shadow 的 B−A 实验；达到真实审核门槛后才考虑新研究 enforce，不能降低已冻结作业的审核要求。
3. OpenCode 限可信操作者、固定语料和并发 1；满足部署主机隔离及真实计费/usage 前置条件，再明确授权有预算的 C−B 实验。禁用自动回修、子 Agent fan-out 和未知重试。
4. 只有实际采用门槛通过后才打开入队。启动示例：`docker compose --env-file <已验证配置> --profile agent --profile opencode up -d --no-deps agent agent-bridge opencode-runtime opencode-worker`；应用重建仍走现网流程，使静态读取的配置生效。

/readyz 只验证本地配置/Skill，model/MCP 的 not_probed 是真实状态。bridge/worker 目前没有独立 readyz/Compose healthcheck，service_started 不证明业务就绪，必须检查端到端链路。agent-bridge 使用单次 30 秒默认值；非默认 AGENT_MODEL_TIMEOUT_MS 必须实际传进该服务。

## 观测与异常处理

复用现有数据库与结构化状态。只读查询例：

```sql
select runtime_provider,status,count(*) as jobs,max(clock_timestamp()-created_at) as oldest_age
from ai_jobs where item_id like 'research:%' group by runtime_provider,status;
select r.provider,c.role,c.state,count(*) as calls,sum(c.input_tokens) as known_input_tokens,sum(c.output_tokens) as known_output_tokens
from ai_model_calls c join ai_runs r on r.id=c.run_id where r.mode='research' group by r.provider,c.role,c.state;
select day,price_version,status,count(*) as reservations,sum(reserved_rmb) as reserved_rmb,sum(actual_rmb) as known_settled_rmb
from ai_budget_reservations group by day,price_version,status;
select v.state,r.error_code,count(*) from ai_research_reviews v join ai_runs r on r.id=v.run_id group by v.state,r.error_code;
select run_id,count(*) from knowledge_notes where run_id is not null group by run_id having count(*)>1;
```

监测排队年龄、期限/租约失效、completed/unknown 调用、预留/未知金额、发布率、重复 note 和每份接受报告成本。actual_rmb 是已知 usage 按冻结单价结算值，须另核对供应商账单。unknown 不是 0 元；审核误报需独立人工标签，不能用 Reviewer 自评推导。无接受报告/无用量时，分母或金额记未知。

| 情况 | 操作 |
| --- | --- |
| dispatching/dispatch_unknown、超时、断流、缺 usage/完成 ACK | 保留 started/unknown 和预留，不重发 prompt，不自造 message ID，不改 provider；新尝试须明确是新工作 |
| 失联/租约过期 | 同一兼容版本 Worker 依据 runtime binding、candidate/review 和宿主调用事实 reconcile；已有候选/审核只继续审核/发布，不重跑 Producer。无法证明则 unknown |
| 取消 | UI 记录 cancel_requested 并撤数据/审核能力；Worker 停执行、撤 bridge grant、abort/stop 进程树、报告终态。取消请求不等于停止确认，也不等于零费 |
| 来源改变、候选不匹配、旧 claim、审核失败 | 宿主拒绝发布；不在 SQL 中签发审核通过或修改不可变候选 |
| revoke/stop 未确认 | 停止该 Worker 领取下一任务，保存证据并恢复控制；失败 stop 不能当作 slot 已释放 |

runtime reconcile 不是账单对账工具。未知供应商费用没有一键证明免费或自动修复接口；保留账本并凭供应商确证处理，不手动把 unknown 改成 completed/not_sent。

## 关闭 OpenCode 与回滚演练

1. 把新任务默认值改为 AGENT_RESEARCH_RUNTIME=eino，保留 AGENT_ASYNC_RESEARCH_ENABLED=true、AGENT_WORKER_ENABLED=true 和旧 OpenCode 的领取能力，按现网流程使 app 配置生效；同步 AI_ENGINE 不必改变。
2. 按 provider 检查 queued/running/runtime bindings，让兼容旧版本 OpenCode Worker drain/reconcile，Eino 继续自己的队列。若不执行旧排队任务，用可信 UI 逐作业取消。cancelQueuedResearchJobs(sql,'opencode') 是事务 helper，不是对外 CLI，不能用裸 SQL 模拟预算结算。
3. active 作业先取消并等待 Worker cleanup：撤 bridge grant，再 abort/确认进程树停止，随后才能复用 slot。Worker 失联时保留原 instance/epoch 进行可信控制恢复，不能 prepare 新实例覆盖旧状态。
4. 无需继续的旧任务已终结、grant 已撤销且进程停止后，设 AGENT_OPENCODE_WORKER_ENABLED=false，再停止三个可选服务；agent/Reviewer 和 Eino 保持运行，不执行整栈 compose down。
5. 保留 jobs/runs、候选/审核、调用账本、runtime bindings 和历史 notes，不 down-migrate 0022–0025 或改写历史 note。0023 无法证明旧任务 ownership 时事务回滚并报告 IDs，先核查，不能猜 provider 强行迁移。
6. 升级固定版本前重跑协议/配置/故障/网络测试。不兼容状态禁止恢复发送，保留 unknown，新尝试明确是新作业。

可信控制恢复需要 ai_runtime_bindings 中的原 instance/epoch，及工作树外仅含 wrapper/controller token 的运维文件。以下是批准后的示例，不是本轮已执行的演练。先暂停 OpenCode 新 claims，使用实际 Compose 网络名；helper 不应获得数据库密码、供应商 key 或应用 master token：

```powershell
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges --network <实际项目名>_opencode-runtime --env-file <工作树外的controller-only配置文件> weavesense-opencode-runtime:1.3.13 node --input-type=module -e '
const identity={instance_id:"<原instance UUID>",epoch:"<原epoch UUID>"};
const send=(url,method,token)=>fetch(url,{method,headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(identity),signal:AbortSignal.timeout(15000)});
let revoke=null;try{revoke=await send("http://agent-bridge:8792/v1/grants","DELETE",process.env.OPENCODE_BRIDGE_CONTROL_TOKEN)}catch{}
const stop=await send("http://opencode-runtime:4097/stop","POST",process.env.OPENCODE_RUNTIME_TOKEN);const result=await stop.json();
if(!revoke?.ok||!stop.ok||result.stopped!==true)throw Error("cleanup_unconfirmed");
console.log("grant revoked; process tree stop confirmed");'
```

恢复 helper、provider drain/切换期间 Eino 继续工作、生产回滚尚未在部署栈实操。本轮运维核对和假供应商证据不能写作生产回滚通过。

## 与助手（Project Assistant）的关系（2026-10-09 起）

研究链路保持原语义不变；助手是叠加在同一条 OpenCode 基础设施上的第二个产品面：

- **Runtime**：prepare 增加可信 `profile` 枚举，省略仍严格等于 research。research
  三个批准 Skill、corpus 工具与结果协议不变；assistant 使用独立的
  `project-assistant` Skill、只读工具面与结果解码器（详见
  `docs/operations/project-assistant.md`）。
- **队列**：`ai_jobs.job_kind` 显式分派（analyze_item/research/assistant），
  0027 的触发器保证 assistant job 必须绑定真实会话轮次；旧研究 Worker 若不认识
  assistant 行为，按 §回滚 的版本兼容约束处理，禁止直接回退到前缀判别的旧二进制。
- **Worker 端点**：旧 `OPENCODE_JOBS_URL`（research/analyze）与新增
  `ASSISTANT_JOBS_URL` 使用分离的服务令牌；两队列交替调度，互不饥饿。
- **升级顺序**：先更 runtime/bridge/worker 镜像与批准 Skill（助手开关保持关闭），
  验证本页全部既有检查通过后，再按 project-assistant.md §6 分阶段打开助手。
