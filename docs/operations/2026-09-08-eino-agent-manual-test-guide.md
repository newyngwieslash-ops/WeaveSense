# Eino Agent V3 完整手动测试指南

适用版本：2026-09-08 V3 实施后的未提交工作区。范围为 Eino Agent 三种操作、材料与引用、异步恢复、工具与 Skills、预算、迁移和回滚；采集平台本身的全面测试不在本指南范围内。

本指南是**待你执行的测试清单**，不是新一轮通过记录。上一轮结果见 [实施验收报告](../../validation/agent/implementation-v3-2026-09-08/acceptance.md)。每项均应重新记录“通过 / 失败 / 阻塞 / 未测”，不要直接沿用之前的通过结论。

## 1. 先选测试路线

| 路线 | 适合测试什么 | 需要什么 | 是否可能付费 |
|---|---|---|---|
| 页面手测 A01—A20 | 页面、三模式、引用、刷新、失败恢复、手机 | 一个已准备好的测试站点和测试材料；成功生成需模型服务 | 接真实模型/MCP时可能付费 |
| 辅助核验 B01—B12 | 幂等、竞争、正额度、流关闭、预算账本、checkpoint、迁移 | 当前源码、Node/Go；PG类需Docker隔离库 | 模型/MCP均为假服务，无真实供应商费用 |
| 集成与回滚 C01—C05 | 健康、引擎切换、自动分析、停机、真实供应商 | 独立测试环境及配置权限 | 真实调用必须先确认额度 |

建议顺序：准备环境与材料 → A01—A12 → A13—A20 → B01—B12 → C01—C05。预计页面基础部分约30—60分钟，完整高级核验另留1—2小时；实际模型响应、下载和故障排查时间另计。

**当前默认是 legacy、async=false、worker=false、AUTO_ANALYZE=false。** 看不到“后台研究”选项不一定是缺陷，先做A13配置核对。`/jobs` 的“任务”页面显示的是采集任务，并非 Agent 的 `ai_jobs` 管理台；不要在这里寻找完整的Agent预算、claim或checkpoint信息。

`npm run agent:e2e` 是自动驾驶且结束后清理资源的 harness，**不是常驻手动测试服务器**。它运行过的随机地址、旧58792数据库和上次截图里的地址已经失效。手动点击请用自己的测试站点，或按附录A新建环境。它的特殊提示词“Battery 失败测试”“Battery 预算耗尽”只对harness假模型脚本有确定效果，不能用这些词要求真实模型稳定制造故障。

## 2. 每轮开始前填写

| 记录项 | 本轮填写 |
|---|---|
| 测试日期、测试人 | |
| 站点地址；dev还是built | |
| 当前HEAD与源码版本标识 | |
| 浏览器及版本、桌面分辨率 | |
| 手机型号或390×844模拟视口 | |
| 数据库是否为独立测试库 | |
| 模型：fake / 实际服务、模型名 | |
| MCP：关闭 / fake / 实际服务与工具名 | |
| AI_ENGINE / async / worker / AUTO四项配置 | |
| 允许调用的服务、次数/费用上限 | |
| 本轮证据目录 | |

测试真实服务前，先明确服务、账号和本轮可消费额度。**AUTO日预算只管理自动分析，不是同步提问、简报和人工分析的全账户费用封顶器。** 人工测试的真实花费仍须在供应商侧设置/观察额度。OCR/ASR也可能使用独立收费服务，本指南的材料状态测试不要求你调用真实OCR。

本轮只在测试环境切换配置。不要 reset 工作区、修改 restart.bat、回改0014/0015历史迁移或运行生产全栈重启命令。数据库注入、停进程、并发故障只在专用测试资源中进行。截图或报告不要包含Authorization、API Key、data_access_token或claim_token。

### 2.1 证据与判定规则

- 每项记录：用例ID、输入、时间、配置、实际结果、run_id/job_id（若有）、截图/日志位置。
- 页面成功与落库成功分别核对；三模式成功后刷新再看一次。
- 自然语言答案无需逐字一致，但数字、范围、原文引句和“材料不足”必须符合材料。
- “模型没调用工具”不能记为“工具通过”；应记录未触发，结合B类确定性探针补证。
- 竞争、断流、重放、unknown预算不能仅靠页面点击验收；做对应B类核验。
- 没有凭证或权限时记“阻塞：缺什么”，不要记“通过”或静默跳过。

### 2.2 建议测试材料

在同一专用测试库准备下面6条材料。附录A提供可选SQL，不需要将真实业务资料改成测试数据。

| 标识 | 内容 | 用途 |
|---|---|---|
| manual-v3-main | 今日，标题“MANUAL V3 Battery 主材料”；正文“Battery 试验线良率为97%。验证样本为120片。结论仅针对试验线，不代表全面量产。” | 分析、问答、引用 |
| manual-v3-second | 今日；“Battery 试验线循环寿命为800次，测试温度为25摄氏度。” | 多材料、简报 |
| manual-v3-old | 昨日；“旧试验线良率为81%，此记录只代表昨日状态。” | 今日范围排除 |
| manual-v3-long | 今日，正文超过12000字符；末尾“MANUAL-TAIL-973：末尾结论为隔膜返工率3%。” | 尾部、partial |
| manual-v3-empty | 空正文 | 未发送前拒绝 |
| manual-v3-pending | 图片类型、ingested、提取未完成；有占位正文 | OCR未就绪拒绝 |

初次测试先不要修改main材料，完成A04—A11后再做A12。测试不同请求时在问题末尾加本轮编号，例如“手测20260908-01”，但保留“Battery”等检索关键词。

## 3. 页面手动测试

### A01 默认状态、浏览不触发模型

**准备：** 默认关闭Eino/async/worker/AUTO，记录模型服务调用数或测试网关日志基线。

1. 打开测试站点，依次进入“总览”“内容”“知识库”“任务”“节点”。
2. 在知识库刷新两次，停留15秒，不点生成按钮。
3. 核对服务端调用记录；浏览器Network只能看到应用请求，不能独自证明后端零模型调用。

**通过：** 页面有内容、无空白或崩溃；无后台研究复选框；模型调用数未增加。留首页、知识库截图和调用计数。缺计数渠道时只标记“页面部分通过”。

### A02 内容详情与返回路径

1. 从“内容”打开main材料。
2. 确认标题、正文、来源、发布时间可见，右上有“LLM 分析”和“OCR / ASR”。
3. 点“返回内容”，再进入相同条目。
4. 打开不存在的条目地址，例如 `/inbox/manual-v3-not-exist`。

**通过：** 真实详情页出现，不停留在父列表；返回正常；不存在条目显示“找不到这条内容”，不崩溃。

### A03 提问输入校验

1. 知识库输入空白、一个字、两个字，分别观察“提问”。
2. 两个字时只检查按钮，不必实际发送。

**通过：** 空白和少于2字符不可提交；有效长度可提交。校验本身不发起模型请求。

### A04 单条 LLM 分析

**准备：** Eino同步测试配置有效，async/AUTO保持关闭；有本轮调用额度。

1. 打开main，点一次“LLM 分析”。
2. 执行中观察“分析中”和禁用状态；不要等待完成后再点第二次。
3. 完成后查看分析区域和“已写入知识层”提示。
4. 刷新，再从知识库“条目分析”进入该结果。

**通过：** 摘要等分析内容来自main，不能把97%扩大解释为全面量产；结果刷新后存在；本run对应一条analysis，run=succeeded。用附录B核对。若模型失败，记录错误、run状态、模型请求数，转A17；不要伪报成功。

### A05 防连点、历史结果与重复请求的区别

1. 在另一条材料上开始分析，执行中尝试再次点击。
2. 完成后刷新两次，检查结果条数。
3. 记录原run_id及analysis_id。

**通过：** 执行中的按钮阻止连点；刷新不再次生成。**完成后再次点击是新的用户意图，可生成新run，不要求全局去重。** 同request_id的幂等重放由B01验证，不用重复输入相同文本代替。

### A06 同步知识库提问

1. 进入知识库，若有“后台研究”则不勾选。
2. 输入：“Battery试验线的良率、样本量和适用范围是什么？请引用原文。手测01”。
3. 点“提问”，观察执行状态。
4. 查看“本次回答”和下方历史问答；刷新页面。

**通过：** 参考main时关键事实为97%、120片、仅试验线；有可验证引用；没有凭空补全全面量产结论；保存一条该run的note，刷新后可读。同步请求不要求出现job地址。

### A07 内部引用与历史引用

1. 点击A06的材料引用。
2. 对照源文逐字检查引句，核对标题和来源。
3. 返回知识库刷新，展开/查看历史问答中的引用。

**通过：** 链接打开真实条目；quote是材料中的连续原文，不是模型改写；历史结果仍保留引句和来源，不显示伪造itemId标题或默认rss占位。没有引用不自动算通过，结合结果的insufficient_evidence判断。

### A08 无答案问题

1. 提问：“zzxyqv-no-answer-314159 的出厂质量数字是多少？只根据已采集材料。”
2. 记录是否返回材料不足，以及是否产生模型请求。

**通过：** 没匹配材料时不给编造事实/引用；可能直接在模型前返回材料不足，不强制要求生成note。若已有材料碰巧包含该字符串，换一个新唯一字符串并记录，不能将相关材料误标为无答案。

### A09 今日简报与时间范围

1. 记录当前北京时间日期；确认main/second/long为今日，old为昨日。
2. 点“生成今日简报”，执行中应显示“正在编报”。
3. 查看简报与引用，刷新后检查历史记录。
4. 用附录B查看本run保存的range与sources。

**通过：** saved range为北京时间当天对应的区间，sources不包含昨日old；结果能持久保存。**当前页面没有任意日期范围选择器**，自定义范围由B类测试验证。若数据库存在其他今日材料，简报可以同时覆盖它们，不要求只出现手测材料。

### A10 长文末尾与覆盖范围

1. 对long材料点分析，查看覆盖范围文案。
2. 问：“MANUAL-TAIL-973 的末尾结论是什么？引用隔膜返工率原文。”
3. 对照源文尾部和本run的sources/verified evidence。

**通过：** 截断材料如实标partial，不宣称读完未提供的全文；选材证据包含关键尾部时可答3%；不应伪造未见内容。真实模型没有采用正确证据时，记录“答案质量失败/未采用”，与检索是否命中分开；B11检查确定性的SQL和尾部选材。

### A11 空正文与未完成OCR

1. 分别打开empty和pending，点“LLM 分析”。
2. 核对错误与模型请求计数。
3. 不要为完成此项去调用收费OCR。

**通过：** 空正文提示无可分析材料；未完成提取提示材料未就绪；不产生分析成功行，不应发送模型请求。图片尚未建立extract_jobs也不能绕过ingested未就绪检查。真实OCR/ASR成功链另行按其服务权限测试。

### A12 正文变化、旧分析与新材料

**准备：** A04已成功；只在独立库修改main。

1. 记录原analysis_id、run_id、material_hash。
2. 将正文中的97%改为96%，保持其他信息；刷新详情确认新正文。
3. 再次分析，记录新run与结果；请求研究比较当前材料。
4. 对照新run材料指纹、get_analysis freshness结果或B04测试。

**通过：** 新run按96%当前材料分析，不能复用旧97%指纹作为当前有效分析。历史分析仍可保留，**不要求自动删除旧记录，也不要求页面每个旧记录显示stale徽标**。在分析执行中修改正文的可靠竞争由B04验证，不能仅靠手动点击时机。

### A13 async能力开关

1. 默认/legacy状态打开知识库：不应有后台研究选项。
2. 仅在测试环境启用Eino，配置服务URL、service/data token，令应用和Go的worker配置一致；再启用async。
3. 重启对应测试进程并刷新页面，观察“后台研究（刷新后继续）”。
4. 关闭async或切回legacy，再刷新。

**通过：** 选项与有效配置一致；服务端显式async在不可用时返回capability_unavailable，不应偷偷当同步执行。**该能力检查是配置门禁，不是实时探活**；Agent宕机不保证复选框立即消失，宕机行为看C02。不要只设前端环境变量。

### A14 异步提问、刷新与重新打开

1. 勾选“后台研究”，提问与main相关的问题。
2. 在出现 `?job=…` 后复制完整地址，记录job_id。
3. 刷新一次；另开标签页打开同一地址。
4. 等待完成，再查看知识库历史。

**通过：** 同一job身份恢复，约每2秒查询进度，不重新排一个任务；成功后停止轮询、清理地址中的job，历史结果只保存一份。若模型过快未赶上刷新，记录未覆盖刷新窗口，并用B10/harness补证，不盲目连续付费重试。

### A15 临时断网与“重试查看”

**准备：** 一个仍queued/running的异步任务。

1. 先保存job地址，然后在浏览器开发者工具Network切换Offline。
2. 等待查询重试结束，观察提示。
3. 恢复Online，点“重试查看”。

**通过：** 网络错误后job地址仍保留，出现暂时无法读取进度提示和“重试查看”；重试读取同一job，不重新调用提问；随后可显示完成结果。浏览器离线不等于服务器取消模型，不能据此断言零花费。捕获不到运行窗口时记未覆盖，由可控慢测试服务辅助。

### A16 不存在的任务

1. 在测试站点打开 `/knowledge?job=manual-v3-not-exist`。
2. 观察提示、地址和提问按钮，停留10秒。

**通过：** 提示找不到/无法读取任务，清理job地址，停止该任务轮询；输入新问题后能提交，不永久卡“任务进行中”。不要把任务缺失与A15瞬时网络错误混为一谈。

### A17 失败后重新提问

1. 使用测试服务提供的确定性错误情景，或对**测试Agent**制造不可用；记录发生在发送前还是发送后。
2. 发起一次提问并等待明确失败/unknown。
3. 恢复测试服务，输入一个新问题，重新提交。

**通过：** 原失败任务不会变成成功或留下半份note；新问题可提交并产生新的request/run身份。unknown不可自动重复执行不确定远端调用。真实模型故意格式失败不稳定，格式修复与失败保留预算请做B05/B07，勿用反复付费碰运气。

### A18 MCP外部引用

**准备：** 已批准的只读MCP工具，Go端工具allowlist与应用端 `AGENT_MCP_ALLOWED_TOOLS` 同时匹配；见附录A。

1. 提问一个明确需要该工具数据的问题，要求给出来源与原文。
2. 在服务端事件/测试网关确认确实发生initialize/list/call，而非模型凭记忆回答。
3. 检查外部quote、标题、URL；刷新查看历史引用。

**通过：** 有持久收据且最终引用匹配其原文；合法URL能打开；没有URL时如实显示服务来源，不编造链接。无实际工具调用则记“未触发”，用B09补协议核验。鉴权失败/空allowlist时不能成功使用受限工具。

### A19 Skills与内部工具的可见结果

1. 令测试服务加载一个有明确说明的只读Skill。
2. 发起需要该Skill/内部get_item的研究问题。
3. 从runtime events、tool_calls、skill_versions确认实际调用和版本，核对工具所得引用。

**通过：** 实际Skill Get有计数，有版本记录；内部工具取得的片段能形成有效引用。**仅加载目录、模型提到Skill名称或目录列表成功不算实际调用。** 页面没有逐次budget编辑器；正额度每次扣减必须同时做B05。

### A20 手机与结果可读性

1. 将浏览器切为390×844，或用手机访问同一可达测试站点。
2. 检查知识库输入、后台选项、生成按钮、历史引用、长文本、底部导航。
3. 打开内容详情，执行一次已获额度允许的操作，或查看已保存结果。

**通过：** 无横向滚动，文字/按钮不重叠，底部导航不阻止滚动访问正文；链接可点、操作状态可读。保留普通视口截图和长页截图各一张。仅桌面缩放不替代手机视口检查。

## 4. 无页面入口的辅助核验

以下为“你手动发起命令、查看证据”的测试，不伪称纯点选测试。所有命令从仓库根目录执行。推荐PowerShell 7；每条命令后检查 `$LASTEXITCODE`，非0即失败。正式Go测试不使用旧overlay。不要为让断言通过修改测试标签或期待值。

### B01 同请求重放与身份冲突（V1/V2）

运行：

```powershell
node --experimental-strip-types --test src/lib/server/analyze.test.ts src/lib/server/agent-runs.test.ts
```

查看同request只调用一次、同保存ID重放、材料变化后已完成请求重放、provider/意图冲突。接受条件：同身份重放不多存结果；不同身份不能借原request拿到另一模式结果。完整三终态并发继续B03。留完整输出，不只截图最后一行。

### B02 严格信封与第三轮TSP01—06（V2/V3/V6）

```powershell
node --experimental-strip-types --test validation/agent/review-third-2026-09-08/spec-repro.test.ts
```

接受条件：6项全通过；缺失字段、内外run不一致、矛盾完成信封、旧所有权、checkpoint和预算等原探针仍被拒绝/正确处理。不要向生产内部接口手工发送伪造complete。

### B03 全终态、claim撤销与双complete（V1）

**准备：** 附录A的专用PG或另建同凭据的review库，设置真实专用端口：

```powershell
$env:REVIEW_PG_PORT='57894'
npm run agent:pg
```

接受条件：当前18项全通过、0 skipped，包括PG-T03/T04及succeeded/failed/outcome_unknown各自竞争；输出有锁等待诊断。测试用不同连接持锁并确认提交者确实等待，然后撤销claim/放锁。旧持有者无业务写入；两个相同完成均得到一致结果，成功只一条note。仅看到一个200不够。

### B04 旧材料、OCR和提交期间变更（V1/V7）

运行B03并确认PG-F02；再运行：

```powershell
node --experimental-strip-types --test validation/agent/review-followup-2026-09-08/material-repro.test.ts src/lib/server/agent-context.test.ts src/lib/server/agent-data.test.ts
```

接受条件：旧正文/来源/发布时间/OCR版本不能被新成功结果覆盖；非零offset为partial，旧analysis不被当当前有效；完整材料指纹使用同一Item映射。保留测试输出及A12人工比对结果。

### B05 正额度、Skill每次扣减和修复用量（V4）

```powershell
$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
go -C workers/agent test ./internal/agent -run 'TestFollowup|TestThirdPositiveSkillBudget|TestInvariantSkill|TestInvariantRepair|TestInvariantUnknownUsage' -count=1 -v
```

接受条件：0/1/3/9预算下并发40次调用不超额；每次实际Get/资源读取都扣同一工具预算，超过正额度后拒绝；模型修复请求带实际错误输出和约束；多次usage累计，任何未知usage不能伪装为完整已知总数。不能只验0额度拒绝。

### B06 Stream完整生命周期（V4）

```powershell
go -C workers/agent test ./internal/agent -run 'TestThirdStreamLateErrorAudit|TestInvariantStreamCloseAndCancel' -count=1 -v
```

接受条件：开始成功后晚到错误仍记失败；消费者Close/取消会终止上游，最终事件只写一次，持续时间涵盖整个流。当前页面不是逐token流控制台，不能通过“关网页后没动画”验证这项。

### B07 invalid_output与unknown费用（V3）

```powershell
node --experimental-strip-types --test src/lib/server/agent-budget.test.ts
```

接受条件：invalid_output分别搭配无回执、started、unknown、completed无usage时保留unknown预占；完整可信usage才结算实际费；只有可信未发送事实才释放；重复处理不重复扣/退。附录B给出明细与日汇总核对SQL。

### B08 最后额度、跨日、跨价格版本及SQL故障（V3）

运行B03和B07。逐项查看：最后额度两个调度者只准入一个；job/reservation插入失败时日预占一起回滚；双释放/结算只更新一次；跨日首发重新检查/转移；换price_version不重置同一天额度。不要修改系统时间或等待到午夜来替代确定性跨日测试。

### B09 MCP安全与Skills路径边界（V5）

```powershell
go -C workers/agent test ./internal/agent -run 'TestMCP|TestSkill|TestFollowup|TestInvariantSkillResource' -count=1 -v
node --experimental-strip-types --test src/lib/server/agent-data.test.ts src/lib/server/agent-jobs.test.ts
```

接受条件：真实fake协议初始化/列表/调用/认证、空名单、重定向、尺寸限制通过；收据先有可信调用事实，quote/metadata不可篡改，跨run/假URL拒绝；合法资源可读，盘符、父目录与junction逃逸拒绝。Go测试中未运行到某个平台特有案例时单独记录，不把skip当pass。

### B10 进程kill、Resume和complete丢响应（V6/V9）

```powershell
npm run agent:e2e -- --dev
```

命令会自动编译当前Go，创建专用PG、假模型/MCP及应用，驱动浏览器，再自行清理。查看 `validation/agent/implementation-v3-2026-09-08/harness-dev.json`：`ok=true`；checks包含持久checkpoint后kill/new worker Resume、complete丢响应重传；请求序列无已完成模型调用重发；每run最多一个结果。

固定当前脚本的参考计数：17次假模型请求、1次MCP工具调用、6条note、1条analysis、2次checkpoint。最终仍以脚本的业务断言为准，脚本升级需记录新版本，不能盲目改参考计数。该命令会覆盖同名本轮输出，执行前按附录C备份上轮证据。

### B11 实际SQL检索与尾部证据（V8）

```powershell
$env:REVIEW_PG_PORT='57894'
npm run agent:retrieval
```

查看 `retrieval-sql.json` 与 `retrieval-corpus.json`：实际生产SQL路径，98条语料、24例；范围越界0、无答案误取0、关键尾部候选召回1且quote覆盖；旧/新窗口字符预算相同；有大小、耗时、partial比例和hash。当前c11召回0.5是已知限制，不能写“全部召回100%”。模型答案质量另按A06/A10判定。

### B12 旧库迁移、built与统一门禁（V9）

1. B03包含旧run_id=null数据升级、失败DDL/迁移账本回滚、重跑与重复迁移。
2. 确认DATABASE_URL是专用测试库后执行：

```powershell
npm test
npm run typecheck
go -C workers/agent test ./... -count=1
go -C workers/agent vet ./...
npm run build
npm run agent:e2e
```

每条退出码均需0。`npm run build`会执行数据库迁移，不能带生产DATABASE_URL。built harness用独立 `npm run preview`，对dev smoke做baseline比较；必须先有本轮dev基线。查看built JSON和桌面/手机截图，不能只验HTTP200。

race须在支持CGO的64位环境运行 `go test -race ./... -count=1`；本Windows已验证可用Linux Docker方案，完整命令见[上轮验收报告](../../validation/agent/implementation-v3-2026-09-08/acceptance.md)。不要在race不可用时把其他检查都跳过，也不要把普通Go test当race。

## 5. 集成、自动分析和回滚

### C01 liveness/readiness、配置与零费用（V10）

1. 对测试Agent分别请求 `/healthz` 和 `/readyz`，记录HTTP状态。
2. 记录前后模型调用数；健康检查不得请求模型。
3. 在单独测试进程中移除必需service/model配置，尝试启动；应明确失败。
4. 用不合法Skill目录/metadata测试readiness，记录具体结果。

**通过：** 存活与配置就绪有区别；缺必要配置不假装可用；计数不增加。readyz成功仅表示本地配置就绪，不证明真实供应商凭证、余额或网络可用。

### C02 Agent不可用时业务仍可浏览（V7/V10）

1. 确保无重要运行中任务，仅停止专用测试Agent（其终端Ctrl+C）。
2. 浏览内容及已有知识库记录；刷新。
3. 在Eino配置下发起一次测试操作，记录错误。
4. 重启测试Agent，重新发起**新请求**。

**通过：** 浏览/历史可读；AI操作明确不可用，不静默回退到legacy再付费；恢复后新请求可工作。后台能力复选框按配置判断，不要求Agent一停就立即隐藏。

### C03 自动分析就绪、准入和账本（V3/V7，最后测试）

优先先完成B07/B08，它们不花真实模型额度。需要手动观察自动链时：

1. 仅在独立测试库保留本轮目标条目可参与自动分析；禁用测试库所有外部信源/关键词扫描，关闭其他采集/提取服务凭证，防止“扫描到期”顺带调用真实外部服务。
2. 应用配置Eino，模型名与Go端一致，配置有来源的正数人民币输入/输出单价与price_version；缺单价时应不开放自动准入。先设AUTO=false，点一次总览“扫描到期”，核对无自动job。
3. 在专用环境将AUTO=true，但daily limit=0，重启测试应用，再扫描一次；应零入队。
4. 将daily limit设1，daily budget至少覆盖计算的上界。上界为 `(2×128000×输入每百万价格 + 2×1200×输出每百万价格) / 1000000`。不要填写已经废弃的WORST_COST环境量来冒充实际边界。
5. 扫描一次，观察 `ai_jobs`、reservation及day表；当前调度每tick最多执行一个自动分析job，不要求一次完成所有条目。
6. 同一天再扫描：不得超出“已结算次数＋仍占用次数”的限额；空正文、待OCR、同材料已有效分析应跳过。
7. 检查实际usage、费用和守恒；缺usage时unknown仍占用，不是免费失败。
8. 测毕立即将AUTO=false并重启专用应用；不要在生产上试日额度。

**通过：** 零额度/缺单价零准入；正额度真实消耗且不超额；当前材料分析；预算明细与汇总一致。若本轮日前已消耗额度，使用新专用库，不清生产账本来“重置”。

### C04 legacy→eino→legacy与在途任务（V10）

1. 先运行B01中的三操作引擎往返用例，或完整B12；这是可重复的离线传输证据。
2. 人工集成测试先启用legacy，分别做A04/A06/A09；再切Eino做同样三项；最后切回legacy。每次新请求核对run.provider，已有结果仍能读。legacy使用XAI_API_KEY，与Go模型key不同配置入口，真实执行也会付费。
3. 有queued研究任务时关闭async/切legacy；刷新其job地址，应明确取消未开始的研究job，停止新claim，不换provider重跑。
4. 已running任务允许按已存provider/policy收敛；无法安全确认远端结果时应unknown，不自动新发同一调用。不要把“所有在途必须成功”当回滚要求。
5. 真实队列可能过快，queued窗口无法人工捕捉时用B10/built harness，它会控制领取时序；不要伪改生产job状态。
6. 恢复测试环境默认配置：legacy、async=false、worker=false、AUTO=false。

**通过：** 新请求用当前引擎；已存任务不切引擎重执行；历史结果保留；新async领取关闭。真实生产切换仍需独立发布授权，本文不授权部署。

### C05 真实供应商专项记录（V10）

按已批准额度各执行最小样本，并填写：

| 真实检查 | 必留证据 | 本轮结果 |
|---|---|---|
| analyze_item / briefing / research | 三个run_id、实际模型名、结构化输出/成功保存 | |
| tool calling | 实际工具事件、参数、响应摘要及引用 | |
| 输出上限 | 已发max_tokens、供应商实际响应/截断状态 | |
| usage | 每次调用输入/输出usage、总计、缺失字段处理 | |
| MCP认证与allowlist | 合法调用与拒绝调用，脱敏来源/quote | |
| Skill | 实际Get计数与skill_versions | |
| 实际计费 | 供应商用量页与本轮run时间/费用对照 | |
| 真实部署/回滚 | 环境、变更批准、切换与回退证据 | |

真实回答不能要求与fake脚本逐字相同。供应商没有返回usage时记“计费核验阻塞/unknown保留”，不要填0。未经批准不执行生产数据库迁移或生产开关切换。

## 附录A：可选的Windows独立手测环境

已有测试站点可跳过本节。以下命令仅供你之后在本机搭建；本次写指南**没有启动、切换或付费调用任何服务**。所有终端先进入本仓库；不新建.env，不修改restart.bat。

### A.1 新建专用数据库与准备构建

需要本机Node/npm、Go、Docker可用。端口57894/18080/18791只是本指南的例子；若已占用，统一换成自己的空闲端口，不能杀占用者。以下在PowerShell终端A执行：

```powershell
Set-Location 'F:\AI-TG-PINGTAI-0826\GIG5cYRBa5yN3Tsi-grok-workspace'
$manualContainer='loom-agent-manual-'+(Get-Date -Format 'yyyyMMddHHmmss')
$manualPgPort=57894
if (Get-NetTCPConnection -State Listen -LocalPort $manualPgPort,18080,18791 -ErrorAction SilentlyContinue) { throw '示例端口已占用，请先统一换端口' }
docker run --detach --name $manualContainer --label loom.agent.validation=manual -e POSTGRES_PASSWORD=review-only-local -e POSTGRES_DB=review -p "127.0.0.1:${manualPgPort}:5432" postgres:16-alpine
docker exec $manualContainer pg_isready -U postgres -d review
```

记下`$manualContainer`实际值，pg_isready未ready时等几秒再执行该检查；不要反复创建容器。准备迁移、同时保持收费入口关闭：

```powershell
$env:DATABASE_URL="postgres://postgres:review-only-local@127.0.0.1:${manualPgPort}/review"
$env:AI_ENGINE='legacy'
$env:AGENT_ASYNC_RESEARCH_ENABLED='false'
$env:AGENT_WORKER_ENABLED='false'
$env:AUTO_ANALYZE='false'
$env:EXTRACT_AUTO='false'
$env:XAI_API_KEY=''
npm run db:migrate
```

### A.2 导入这6条测试材料

仅在刚建的review库执行，`ON CONFLICT DO NOTHING`允许重新运行而不覆盖你已改过的材料：

```powershell
$OutputEncoding=[System.Text.UTF8Encoding]::new($false)
@'
insert into sources(id,platform,name,enabled) values('manual-v3-source','rss','MANUAL V3 测试来源',false) on conflict do nothing;
insert into items(id,source_id,platform,external_id,title,body,published_at,pipeline_status,media_type) values
('manual-v3-main','manual-v3-source','rss','main','MANUAL V3 Battery 主材料','Battery 试验线良率为97%。验证样本为120片。结论仅针对试验线，不代表全面量产。',clock_timestamp(),'extracted','article'),
('manual-v3-second','manual-v3-source','rss','second','MANUAL V3 Battery 寿命','Battery 试验线循环寿命为800次，测试温度为25摄氏度。',clock_timestamp(),'extracted','article'),
('manual-v3-old','manual-v3-source','rss','old','MANUAL V3 Battery 昨日','旧试验线良率为81%，此记录只代表昨日状态。',clock_timestamp()-interval '1 day','extracted','article'),
('manual-v3-long','manual-v3-source','rss','long','MANUAL V3 Battery 长文',repeat('Battery背景说明。',2000)||'MANUAL-TAIL-973：末尾结论为隔膜返工率3%。',clock_timestamp(),'extracted','article'),
('manual-v3-empty','manual-v3-source','rss','empty','MANUAL V3 空正文','',clock_timestamp(),'ingested','text'),
('manual-v3-pending','manual-v3-source','rss','pending','MANUAL V3 待OCR','尚未完成图片提取的占位正文',clock_timestamp(),'ingested','image')
on conflict do nothing;
'@ | docker exec -i $manualContainer psql -v ON_ERROR_STOP=1 -U postgres -d review
```

跨日继续测试前，重新核对“今日/昨日”日期；不要在已有正在执行的run期间批量改时间。

### A.3 启动纯浏览测试应用

在终端A沿用上面的环境：

```powershell
npm run dev -- --host 127.0.0.1 --port 18080 --strictPort
```

同一台电脑浏览器打开 `http://127.0.0.1:18080` 开始A01—A03、A11等无模型测试。这里是你在自己电脑启动的独立测试站点，不是上一轮Agent临时地址。手机上的127.0.0.1指手机自己；无局域网测试部署时请用桌面浏览器390×844模拟，不要为测试把内部Agent端口暴露公网。

### A.4 配置允许使用的模型，启动Eino

仅在你决定使用已授权的测试模型后执行。可以是组织提供的常驻fake OpenAI兼容服务，也可以是已批准额度的真实服务；当前自动harness不提供常驻fake模式。服务URL、模型名必须由该测试服务提供，示例占位符不能直接运行。

在终端B进入仓库，设置Go端：

```powershell
$env:AGENT_LISTEN_ADDR='127.0.0.1:18791'
$env:AGENT_SERVICE_TOKEN='manual-local-service-only'
$env:AGENT_DATA_TOKEN='manual-local-data-only'
$env:AGENT_DATA_URL='http://127.0.0.1:18080/api/internal/agent-data'
$env:AGENT_MODEL_BASE_URL='<已授权模型的OpenAI兼容base URL>'
$env:AGENT_MODEL_NAME='<模型名>'
$manualModelSecret=Read-Host '模型API Key（不回显）' -AsSecureString
$env:AGENT_MODEL_API_KEY=[System.Net.NetworkCredential]::new('', $manualModelSecret).Password
$env:AGENT_SKILLS_DIR=(Resolve-Path workers/agent/skills).Path
$env:AGENT_WORKER_ENABLED='false'
$env:AGENT_MCP_CONFIG=''
$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
go -C workers/agent run ./cmd/agent
```

上述两个固定token仅用于本机回环的临时实验，不用于共享环境；共享测试环境应使用独立随机密钥。Key仅在进程环境中使用，不贴入报告。

终端A用Ctrl+C停止**这一个测试应用**，保持DATABASE_URL不变，设置：

```powershell
$env:AI_ENGINE='eino'
$env:AGENT_SERVICE_URL='http://127.0.0.1:18791'
$env:AGENT_SERVICE_TOKEN='manual-local-service-only'
$env:AGENT_DATA_TOKEN='manual-local-data-only'
$env:AGENT_MODEL_NAME='<与Go端完全相同的模型名>'
$env:AGENT_WORKER_ENABLED='false'
$env:AGENT_ASYNC_RESEARCH_ENABLED='false'
$env:AUTO_ANALYZE='false'
npm run dev -- --host 127.0.0.1 --port 18080 --strictPort
```

现在可做同步三模式。开启异步时，终端A、B各自Ctrl+C停止自身进程，在两个终端均设 `AGENT_WORKER_ENABLED='true'`，在A另设 `AGENT_ASYNC_RESEARCH_ENABLED='true'`，分别按原命令重启，刷新知识库。AUTO仍保持false。

### A.5 MCP双端配置

复制 `workers/agent/config/mcp.example.json` 到自己的测试配置路径；保持配置里只有环境变量名，没有token值。将id设为例如research，填写已授权URL，transport保留streamable_http，enabled=true，allowed_tools填写该服务器真实工具名。例如服务器的 `search` 对应包装名 `mcp_research_search`。

Go端设置 `AGENT_MCP_CONFIG` 为这个文件的绝对路径，并通过进程环境设置其 `token_env` 对应的密钥；应用端设置 `AGENT_MCP_ALLOWED_TOOLS='mcp_research_search'`。两边重启自己的测试进程。仅改一边会出现工具未暴露或收据被拒绝；示例mcp.example.com不是可用服务。

### A.6 built手测与退出

先保存截图与结果。在终端A停止自己的dev；DATABASE_URL仍指向专用库时运行 `npm run build`，再 `npm run preview -- --host 127.0.0.1 --port 18080 --strictPort`，按原页面步骤复测。Go保持相同测试配置。不要直接运行旧built产物来验证新源码。

结束时：分别Ctrl+C停止A/B自己的前台进程；导出本轮证据。数据库可保留以便你逐项继续，**不必每次测完删除**。确定不再需要时，先 `docker inspect` 核对之前记录的专用容器名称和manual标签，再删除这一容器；不要按端口批量杀进程或清理其他容器。退出终端清除本轮环境中的临时密钥。

## 附录B：只读证据查询与材料修改

使用自己专用数据库的查询工具，或在保留`$manualContainer`变量的终端运行 `docker exec -it $manualContainer psql -U postgres -d review` 后粘贴SQL。以下查询不读取token字段。

```sql
-- 1. 最近run：按本轮时间、mode和provider定位，不靠标题猜测。
select id,request_id,mode,provider,status,error_code,model,model_calls,tool_calls,
       input_tokens,output_tokens,material_hash,created_at,finished_at
from ai_runs order by created_at desc limit 30;

-- 2. job：同步操作可能没有job；queued任务尚未领取时run_id可为空。
select id,item_id,run_id,status,error_code,attempts,lease_until,created_at
from ai_jobs order by created_at desc limit 30;

-- 3. 每个run的保存条数：单个run的analysis/note均不应出现多份。
select r.id,r.mode,r.status,
 (select count(*) from analyses a where a.run_id=r.id) as analysis_count,
 (select count(*) from knowledge_notes n where n.run_id=r.id) as note_count
from ai_runs r order by r.created_at desc limit 30;

-- 4. 请求范围、材料数量和Skill版本；不要直接导出整个request_json中的凭证。
select id,request_json->'range' as range,
 jsonb_array_length(coalesce(request_json->'sources','[]'::jsonb)) as source_count,
 skill_versions,response_json->'result'->>'coverage' as coverage
from ai_runs order by created_at desc limit 30;

-- 5. 真实调用事实：started/completed/unknown，不是错误标签推测。
select run_id,call_id,model,policy_version,execution_day,state,input_tokens,output_tokens
from ai_model_calls order by started_at desc limit 50;

-- 6. 成本明细及日汇总，注意unknown仍属于占用。
select job_id,day,price_version,status,dispatch_state,reserved_rmb,actual_rmb,pricing
from ai_budget_reservations order by created_at desc limit 50;
select * from ai_budget_days order by day desc,price_version;

-- 7. 守恒：差异项应为0；检查每个价格版本，再合计同一天总量。
with detail as (
 select day,price_version,
 count(*) filter(where status in ('reserved','unknown')) as reserved_count,
 coalesce(sum(reserved_rmb) filter(where status in ('reserved','unknown')),0) as reserved_rmb,
 count(*) filter(where status='settled') as settled_count,
 coalesce(sum(actual_rmb) filter(where status='settled'),0) as settled_rmb
 from ai_budget_reservations group by day,price_version
)
select coalesce(d.day,r.day) as day,coalesce(d.price_version,r.price_version) as price_version,
 coalesce(d.reserved_count,0)-coalesce(r.reserved_count,0) as reserved_count_diff,
 coalesce(d.reserved_rmb,0)-coalesce(r.reserved_rmb,0) as reserved_rmb_diff,
 coalesce(d.settled_count,0)-coalesce(r.settled_count,0) as settled_count_diff,
 coalesce(d.settled_rmb,0)-coalesce(r.settled_rmb,0) as settled_rmb_diff
from ai_budget_days d full join detail r using(day,price_version);

-- 8. 迁移账本：本版本应含0016至0020；旧结果run_id=null允许保留。
select name,applied_at from _migrations order by name;
```

A12仅在专用测试库执行的修改：

```sql
update items set body=replace(body,'97%','96%') where id='manual-v3-main';
select id,body,material_version from items where id='manual-v3-main';
```

对失败run，允许保留历史旧analysis，但不能新增该失败run的成功业务行。reservation=unknown不代表已确定扣费，而是“无法证明零费用或确定金额”，仍保留额度是预期行为。

## 附录C：证据保存、故障反馈与勾选表

辅助命令会更新同名输出。首次复跑前备份上一轮证据，避免丢失历史；PowerShell例子：

```powershell
$manualEvidence='validation/agent/manual-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $manualEvidence
Copy-Item -LiteralPath 'validation/agent/implementation-v3-2026-09-08' -Destination (Join-Path $manualEvidence 'before') -Recurse
```

复跑后把新输出复制到同一轮after目录；截图建议命名 `A06-desktop-result.png`、`A14-refresh.png`、`B03-pg-output.txt`。命令可使用 `*> <本轮日志文件>` 保存输出，随后记录 `$LASTEXITCODE`。没有日志输出的成功vet/typecheck也要记录命令和退出码。

### 可复制的单项反馈模板

```text
用例：A__/B__/C__
状态：通过 / 失败 / 阻塞 / 未测
环境：dev/built；浏览器；engine/async/worker/AUTO；fake或真实模型
时间与源码版本：
输入与操作（含发生顺序）：
预期：
实际：
run_id / job_id / analysis_id / note_id（能取得的部分）：
页面截图、脱敏错误或命令日志：
模型请求数/usage/预算变化（适用时）：
能否重复：
```

若失败，请保留原记录，再单独记录修复后复测，别直接把“失败”改成“通过”。可以分批把用例编号和实际结果发回，不必等全部测完。

### 完整执行清单

- [ ] A01 默认浏览零调用
- [ ] A02 内容详情与返回
- [ ] A03 输入校验
- [ ] A04 单条分析
- [ ] A05 防连点与历史持久化
- [ ] A06 同步提问
- [ ] A07 内部及历史引用
- [ ] A08 无答案
- [ ] A09 今日简报
- [ ] A10 尾部与partial
- [ ] A11 空正文/待OCR
- [ ] A12 新鲜度与旧分析
- [ ] A13 async能力
- [ ] A14 异步刷新恢复
- [ ] A15 断网重试
- [ ] A16 缺失job
- [ ] A17 失败后新问题
- [ ] A18 MCP引用
- [ ] A19 Skills/内部工具
- [ ] A20 手机
- [ ] B01 身份与重放
- [ ] B02 TSP01—06
- [ ] B03 全终态PG竞争
- [ ] B04 材料/OCR竞争
- [ ] B05 正额度与修复
- [ ] B06 流生命周期
- [ ] B07 费用事实
- [ ] B08 额度/跨日/回滚
- [ ] B09 MCP/Skill边界
- [ ] B10 进程恢复/ACK
- [ ] B11 SQL检索
- [ ] B12 迁移/built/全门禁
- [ ] C01 健康与配置
- [ ] C02 Agent不可用
- [ ] C03 自动分析
- [ ] C04 引擎往返与回滚
- [ ] C05 真实供应商记录

## 附录D：计划覆盖映射

| V项 | 对应用例 | 原任务 |
|---|---|---|
| V1 | A04—A07、A12、B01/B03/B04/B07 | 3、8、16 |
| V2 | A05/A13、B01/B02、C04 | 2、3、7、9 |
| V3 | B07/B08、C03/C05 | 18 |
| V4 | A19、B05/B06 | 6、11、13、14 |
| V5 | A18/A19、B09 | 12、13 |
| V6 | A14—A17、B03/B10 | 19 |
| V7 | A02/A07—A20、B04 | 4、9、10、14、18 |
| V8 | A08/A10、B11 | 20 |
| V9 | B01—B12、A20 | 1、5、16 |
| V10 | C01—C05、B12 | 7、15、17 |

旧C1—C12继续有效：C1→B03，C2→B01/B02，C3→A13—A17/B10，C4→B05/B06，C5→A18/B09，C6→A19/B09，C7→B07/B08/C03，C8→B10，C9→A09—A12/B04，C10→B11，C11→B12，C12→C01—C05。

原20任务逐项索引：1基线B12；2契约B02；3账本B01/B03；4材料A10—A12/B04；5服务C01/B10；6固定流程A04/A09/B05；7引擎C02/C04；8保存A04/A06/A09/B03；9页面A01—A20；10内部工具A07/A19/B04；11研究预算B05；12 MCP A18/B09；13 Skills A19/B05/B09；14事件B05/B06/B10；15部署B12/C01；16统一验收B12；17真实集成C04/C05；18自动分析B07/B08/C03；19长任务A14/B10；20检索A08/A10/B11。
