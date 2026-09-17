# Eino Agent V3 实施与验收（2026-09-08）

本记录承接第三轮 review，不覆盖历史失败证据。代码在现有框架与未提交工作区内修改；未 reset、commit、push、部署或修改 restart.bat。生产开关保持 legacy / async=false / worker=false / AUTO_ANALYZE=false。所有本轮模型/MCP调用使用隔离假服务；真实付费、生产数据库和生产发布均未执行。

“代码完成”表示计划内公共入口已接通；“离线通过”表示下面列出的可复跑检查已通过；两者均不等于真实供应商或生产已验收。真实项统一待明确服务、凭证、额度与执行授权。

## V1—V10

| 项 | 代码与业务不变量 | 离线状态与证据 | 真实状态 |
|---|---|---|---|
| V1 | `agent-transaction.ts` / `agent-completion.ts` 统一同步、自动、异步结果及失败/unknown/到期提交。真实事务，job→run→材料锁，锁后 wall clock 检查；业务行、run、job、预算一起提交；同终态同摘要重放返回原 ID。 | 通过。PG-F01/F02/T03/T04；成功/失败/unknown 各自旧 claim 等锁后拒绝、双 complete 同 ID；SQL 故障全回滚。`postgres-final.txt`。 | 生产库竞争待授权；本地是真实 PostgreSQL，不是 SQL mock。 |
| V2 | 严格 complete/checkpoint/renew 信封；内外 run/mode/response 一致；身份与 provider、范围、意图绑定，保存 sources/policy，重放不重选材料；不支持的已存 provider 显式拒绝。 | 通过。TSP01—04、R/S；正常 npm test；三入口传输回滚测试。 | 实际供应商响应兼容性待验。 |
| V3 | 每日准入＋job＋reservation 同事务；跨价格版本共享日限额；价格/模型快照和实际 wire 上界；跨日首发重新准入；真实调用回执驱动结算。invalid_output/无回执/unknown 均不能证明免费。 | 通过。8 项预算回归；18 项 PG 中包含最后额度竞争、双释放/结算、中途 SQL 失败；明细/日汇总守恒。 | 真实计费字段、单价及账单核对待授权。AUTO 关闭。 |
| V4 | Skill 每次实际 Get 与资源读取扣同一正额度；模型、内部工具、MCP 共用预算。Generate/Stream 生命周期、关闭/取消、修复请求含原文及错误、累计 usage；未知 usage 保持 null。 | 通过。正式 TestFollowup、TestThird、TestInvariant；0/1/3/9 额度并发40调用；stream 延迟错误/消费者关闭/取消；真实 wire 修复内容与累计用量；Linux race。 | 真实模型 tool calling/usage/output limit 待验。 |
| V5 | MCP initialize/list/call/auth/allowlist→started→不可变持久收据→引用验证；有界响应、禁重定向、文本解析。Skills 根边界、junction/路径、32KiB单文件及版本扫描上限、按需资源只读；未支持操作明确错误。 | 通过。fake MCP 真实协议与浏览器外部引用保存；跨 run/伪 quote/伪 metadata/不安全 URL 拒绝；Go 路径与预算测试。 | 生产 MCP 的认证/名单/资源兼容性待验；未宣称 OAuth/Prompts 全支持。 |
| V6 | Worker 续租至 ACK；同一序列化 complete 重传；409终止；实际 Eino checkpoint/StatefulInterrupt/Resume，保存预算、事件、证据与 Skill 版本。新 generation 旋转 token，无法安全恢复则 unknown，不重跑不确定调用。 | 通过。dev/built 均完成真实进程 kill→重启 Resume，已完成模型调用不再发送；complete 丢响应后仅一份 note；PG 同序号异 payload 竞争。 | 实际供应商长任务、真实网络分区待验。 |
| V7 | 当前完整材料指纹＋material_version，OCR变化使旧材料失效；统一 Item 映射保留毫秒；get_analysis freshness；头/尾/命中窗口明确 partial；历史真实引用元数据；async能力与实际参数、刷新恢复、终态清理、瞬时错误保留地址并手动重试。修复 inbox 父路由缺 Outlet 导致分析入口不渲染。 | 通过。R/M、材料/OCR/尾部回归；浏览器三模式、失败重提、缺失 job 清理、动态引用与手机无横向溢出；截图已逐张检查。 | 生产 OCR/长文分布及真实答案质量待验。 |
| V8 | 评测直接调用生产 `retrieveAgentItems` SQL→rank→`selectResearchSeeds`；98条语料超过40候选上限，24例含尾部/范围/噪声/无答案；等候选与字符预算比较窗口。 | 通过预设门槛：范围越界0、无答案误取0、关键尾部命中1；有大小、耗时、partial率、语料/代码/工作区hash。c11召回0.5明确保留，并非全样本满分。 | 模型答案质量未评测；真实业务集扩评待提供数据/授权。 |
| V9 | 正常测试入口纳入第三轮正式探针；harness 自有PG、当前Go、fake模型/MCP、当前应用、Playwright；新/旧库升级、失败回滚、重复迁移；Windows preview 独立端口；自有资源清理。 | 通过。npm test/typecheck/build、Go test/vet/race、PG18项、dev/built全链与桌面/手机smoke，零 skip。 | 生产拓扑与生产数据升级仍待授权。 |
| V10 | readiness/liveness分离且零模型请求；worker独立开关、Skills只读、无Agent主机端口；回滚取消未领取job，不换provider重跑；保留历史数据。 | 通过离线部分：三操作 legacy→eino→legacy；dev/built Eino→legacy停Agent仍浏览、排队取消、claim503且无新增模型调用。 | **待授权**：真实三模式、供应商MCP、生产部署与灰度/回滚。不能标“生产完成”。 |

## 原20任务逐项

| 原项 | 代码 | 离线验收 | 真实/仍待验证 |
|---|---|---|---|
| 1 依赖基线 | 完成，沿用锁定依赖 | Go编译/test/vet/race、npm构建 | 供应商版本兼容性待验 |
| 2 双端契约 | 完成（V2） | 严格信封、模式、run一致性 | 真实响应结构待验 |
| 3 幂等账本 | 完成（V1/V2） | 三终态竞争、同ID重放、unknown | 生产DB待验 |
| 4 材料快照 | 完成（V1/V7） | OCR/来源/日期/正文/版本和锁等待 | 生产材料分布待验 |
| 5 Go服务 | 完成 | 实际Go HTTP三入口、健康、故障 | 实际服务部署待授权 |
| 6 固定模型流程 | 完成（V4） | 修复wire/预算/累计usage | 真实模型质量、usage待验 |
| 7 引擎切换/客户端 | 完成 | 三入口完整往返切换、宕机不fallback | 生产灰度回滚待授权 |
| 8 三操作保存 | 完成（V1） | note/analysis/run/job事务、PG回滚 | 生产DB待验 |
| 9 页面 | 完成（V7） | 同步/异步/刷新/错误/引用/三模式 | 真实使用数据待验 |
| 10 内部工具 | 完成 | 受限范围、freshness、动态收据 | 生产规模性能待验 |
| 11 研究循环 | 完成（V4） | 正预算逐次扣减、并发耗尽、零预算 | 实际tool calling待验 |
| 12 MCP | 完成（V5） | 真实fake协议、认证、名单、持久外部引用 | 实际MCP待授权 |
| 13 Skills | 完成（V4/V5） | 正额度、路径/junction、资源、版本 | 生产只读挂载待验 |
| 14 事件/错误 | 完成（V4/V6） | 流全生命周期、unknown usage、ACK | 真实故障分布待验 |
| 15 部署 | 配置完成，默认关闭 | build/built、迁移、停Agent浏览 | 未部署，待授权 |
| 16 统一验收 | 完成（V9） | 正式npm/Go/PG/harness/race全通过 | 真实服务验收待授权 |
| 17 真实集成回滚 | 离线门禁完成 | 假服务切换、停机、排队取消 | **真实集成未执行，待授权** |
| 18 自动分析 | 完成（V3/V7） | 准入/材料/结算/跨日/竞争 | AUTO保持关闭；真实计费待验 |
| 19 长任务恢复 | 完成（V6） | 真正进程故障、Resume、不重复模型调用 | 真实长任务待验 |
| 20 检索升级 | 完成（V8） | 生产SQL评测、98条/24例 | c11召回0.5；真实答案质量未验 |

旧 C1—C12 均保留：C1→V1，C2→V2，C3→V2/V6/V7，C4→V4，C5→V5，C6→V4/V5，C7→V3，C8→V6，C9→V7，C10→V8，C11→V9，C12→V10。C1—C11代码及上述离线门禁通过；C12真实部分待授权。16项补强依次对应：1默认/同步、2身份/到期、3事务fencing、4快照/收据、5原子保存、6预算、7deadline/body/events、8异步、9页面、10checkpoint、11自动账本、12MCP、13Skills、14检索、15验收、16部署/真实回滚；均纳入本表对应项，没有因第三轮改名而取消。

## 可复跑命令与证据

全部从仓库根目录运行。以下隔离PG口仅为本次资源，复跑时须创建新的专用 PostgreSQL 并设置 `REVIEW_PG_PORT`，不能填生产端口。harness 自行创建并清理自身PG/进程。

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm test` | exit 0；228/228，正式R/S/M/TSP均通过 | [npm-test-final.txt](npm-test-final.txt) |
| `npm run typecheck` | exit 0 | [typecheck-final.txt](typecheck-final.txt) |
| `npm run build`（DATABASE_URL指向本次隔离58792库） | exit 0，迁移up to date | [build-final.txt](build-final.txt) |
| `go -C workers/agent test ./... -count=1` | exit 0 | [go-test-final.txt](go-test-final.txt) |
| `go -C workers/agent vet ./...` | exit 0，无输出 | [go-vet-final.txt](go-vet-final.txt) |
| `go -C workers/agent test ./internal/agent -run 'TestFollowup\|TestThird\|TestInvariant' -count=1` | exit 0，正式入口无overlay | [go-formal-probes.txt](go-formal-probes.txt) |
| `go test -race ./... -count=1`（Linux Go1.24 CGO容器） | exit 0 | [go-race-final.txt](go-race-final.txt) |
| `$env:REVIEW_PG_PORT='58792'; npm run agent:pg` | exit 0；18/18，无skip | [postgres-final.txt](postgres-final.txt) |
| `$env:REVIEW_PG_PORT='58792'; npm run agent:retrieval` | exit 0 | [retrieval-sql.json](retrieval-sql.json)、[corpus](retrieval-corpus.json) |
| `npm run agent:e2e -- --dev` | exit 0，真实当前Go＋应用 | [harness-dev.json](harness-dev.json) |
| `npm run agent:e2e` | exit 0，实际`npm run preview`产物 | [harness-built.json](harness-built.json)、[command](harness-built-command.txt) |
| `docker build -f workers/agent/Dockerfile -t loom-agent-v3-validation:20260908 workers/agent` | exit 0，独立镜像标签 | [docker-build-final.txt](docker-build-final.txt) |
| `node --experimental-strip-types --test src/lib/server/analyze.test.ts` | exit 0，含三模式引擎往返9次拦截请求 | [engine-rollback.txt](engine-rollback.txt) |

正式Go follow-up命令为 `go -C workers/agent test ./internal/agent -run 'TestFollowup|TestThird|TestInvariant' -count=1`，不再使用重名旧overlay。历史overlay文件和原失败日志仅作历史证据保留。

Linux race实际命令（只读挂载源码、独立容器）：

```powershell
docker run --rm --name loom-agent-v3-race --label loom.agent.validation=v3-race --mount 'type=bind,source=F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace,target=/workspace,readonly' --mount 'type=bind,source=D:\GoWorks1.18\pkg\mod,target=/go/pkg/mod' -w /workspace/workers/agent -e CGO_ENABLED=1 golang:1.24-bookworm go test -race ./... -count=1
```

最终镜像以 `--network none --read-only`、worker=false、无主机端口运行专用 `loom-agent-v3-readonly` 容器；`docker exec loom-agent-v3-readonly /app/agent healthcheck` exit 0。inspect确认 `user=nonroot readonly=true network=none ports={} running=true`，容器ID `0f4ac4d7ea310ab72ffbc22abd2728f49a207837ae5125a6835b0da05e97ae71`。没有真实模型网络可达性，也未执行生产启动。

[workspace-final.json](workspace-final.json)记录最终源码、测试及未跟踪新文件的SHA-256和HEAD；[verification-summary.json](verification-summary.json)记录最终命令状态、截图/证据哈希和资源清理。restart.bat已有的未提交修改保持原样，没有用HEAD覆盖它。

PG竞争不是顺序模拟：独立连接持有行锁，由 `pg_stat_activity` 确认一个/两个提交者处于锁等待，再提交新claim或释放锁。终态逐项检查run/job、业务行数和返回ID；预算检查reservation和daily totals守恒。测试名及锁等待诊断在postgres-final.txt中。旧库测试创建run_id=null旧数据，触发器注入0016失败并确认DDL/迁移账本回滚，再重跑到0020、重复运行无变化。

dev和built各自记录17次假模型请求、1次MCP工具调用、6条note、1条analysis、2次checkpoint。一次格式错误经过修复仍失败；一次Skill正预算耗尽；已有模型消息的checkpoint恢复不重复发模型请求；complete故意丢ACK后重传仍只有原note。健康检查和回滚零新增模型调用。PID、专属端口、容器名、逐次请求及run终态在harness JSON中。

## 截图与运行限制

- [dev桌面](../../../screenshots/agent-v3-dev-desktop.png)、[dev手机](../../../screenshots/agent-v3-dev-mobile.png)
- [built桌面](../../../screenshots/agent-v3-built-desktop.png)、[built手机](../../../screenshots/agent-v3-built-mobile.png)
- [dev smoke JSON](../../../screenshots/agent-v3-dev-smoke.json)、[built smoke JSON](../../../screenshots/agent-v3-built-smoke.json)

两种模式的桌面/手机全页截图及smoke截图均已实际查看：正文、历史引用和操作可见，无横向溢出；browser console/page error检查通过，built对dev baseline无失败。全页手机图中固定底栏处于视口底部，滚动内容在其后继续；smoke视口图显示正常。

隔离harness对非本机静态请求返回空响应，避免Google字体/品牌脚本联网成为验收依赖；应用代码未移除品牌注入。此验收证明本地业务与内置回退字体渲染，不证明外网字体/CDN可用性。首次外部字体等待超时以及迁移/竞争发现的失败均不算通过；最终以带final的日志及harness ok=true为准。

检索仍是有界关键词方案，无向量库；c11相关条目召回0.5诚实保留。`retrieval-sql-before-word-boundary.json`保存无答案短词误匹配的修复前失败，最终通过通用词边界修复而非改标签。预算实际费用依赖供应商提供完整usage及正确单价；缺失usage保留unknown预占，不释放、不伪造0。未知远端调用不会自动重新执行。

仍待明确授权：实际模型三模式/tool calling/JSON/usage/output限额、真实MCP认证和名单/外部引用、真实账单与人民币价格核对、生产库升级及真实部署/灰度/回滚。其余本记录覆盖的离线实现与验收已完成。未开启生产Eino、async、worker或AUTO。
