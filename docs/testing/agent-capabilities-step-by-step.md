# 智能体新能力：手把手测试指南

适用版本：2026-10-07，功能提交 `3012325`。操作环境：Windows PowerShell、Docker Desktop 的 Linux 容器。

本指南先让你用**不调用真实供应商的实验环境**亲手验证界面与治理，再验证真正的 OpenCode 运行时，最后说明有明确预算的真实质量评测。代码集成通过不等于模型更聪明；默认关闭 OpenCode、真实采用状态为 `live_accepted=false`。

## 1. 从哪里开始

| 你想确认什么 | 执行章节 | 是否付费 | 成功依据 |
| --- | --- | --- | --- |
| 新的审核合同、费用和发布规则能否跑通 | §2 | 否 | 测试通过；离线评测标记不评估模型质量 |
| 自己点击研究、看草稿、刷新、取消 | §4–5 | 否 | 假模型实验室界面和 SQL 账本一致 |
| PostgreSQL 的并发、迁移、失联是否安全 | §3、§6 | 否 | 10 项真实 PG 检查通过，没有跳过 |
| 开发版和构建版是否都可用 | §7 | 否 | 实际浏览器、截图和 `ok:true` |
| OpenCode 能否在受限网络中执行 | §8 | 否 | 真实二进制、真实隔离与宿主账本通过 |
| 独立审核 / OpenCode 是否提高真实质量 | §9 | **可能** | 真实观察、双人盲标和冻结门槛；不能用夹具替代 |
| 停止实验、保留证据 | §10 | 否 | 只清理自己创建的资源 |

建议顺序：§2 → §3 → §4–5 → §6–8。首次不要直接打开生产开关或运行仓库主 Compose。主 Compose 引用了工作树外的生产配置，不是本指南的测试环境。

### 1.1 工具与终端约定

在新 PowerShell 中执行。以下命令都以仓库根目录为当前目录：

```powershell
Set-Location F:\AI_WeaveSence_Things\WeaveSense
node --version
npm --version
go version
docker version
docker info --format '{{.OSType}}'
git log -1 --oneline
```

已验证 Node 22.22.3、Go 1.25.7、Docker 28.5.2。Go 模块最低为 1.24.1；浏览器 harness 使用本机工具链，不替你自动下载 Go。OpenCode 隔离实验要求 Docker 28+ 支持 isolated bridge gateway，`OSType` 应为 `linux`。

依赖已经在本工作树安装时无需再安装；缺少 `node_modules` 时运行 `npm ci`。首次下载 npm 包、Docker 基础镜像或 OpenCode 二进制需要网络，但本指南的假模型阶段不会产生供应商模型费用。

PowerShell 的环境变量只影响当前终端及其子进程；在另一个终端启动服务时必须再次加载配置。每条重要命令完成后检查 `$LASTEXITCODE`。文中的 `0` 才代表成功；不能因为有 JSON 输出就忽略非零退出码。

不要在继承生产 `DATABASE_URL` 的终端随手运行 `npm run build` 或 `db:migrate`：两者会执行迁移。§7 的 harness 自动限定为独立测试 schema，§4 也明确指定测试 DSN。

## 2. 第一轮：不启动真实模型的快速检查

```powershell
npm run test:research
if ($LASTEXITCODE -ne 0) { throw '研究能力回归失败' }
npm run agent:quality -- --offline
if ($LASTEXITCODE -ne 0) { throw '离线审核夹具失败' }
node validation/agent/opencode/e2e.mjs --check
if ($LASTEXITCODE -ne 0) { throw '端到端夹具合同失败' }
```

当前 `test:research` 两组共 72 项（31 + 41）通过；测试数量随之后新增回归变化，重点是没有失败或意外跳过。离线评测有 30 个人工编写的缺陷/合理候选案例，输出应包含 `model_quality_evaluated:false`、模型调用为 0。`e2e --check` 应输出 `ok:true`、`checks:5`、`browser:"not_run"`。这些是合同和计分器测试，不是实际模型成绩。

若要复跑交付时的完整检查：

```powershell
npm test
npm run typecheck
npm run lint
go -C workers/agent test ./... -count=1
go -C workers/agent vet ./...
```

交付记录为 Node/TS 489 项通过、typecheck 通过、lint 0 错误/14 警告。Go 的竞态检查可在支持 CGO/race 的环境执行 `go -C workers/agent test -race ./internal/agent ./internal/opencode`；Windows 缺少 C 编译器不等于业务测试失败，Linux 实测记录在 [race.fixture.json](../../validation/agent/opencode/race.fixture.json)。不要在 Windows 直接宣称重跑了 Linux race。

## 3. 准备独立 PostgreSQL

### 3.1 已有测试描述文件时

```powershell
Test-Path .repo/opencode-validation-pg.json
```

若为 `True`，先检查它指向的仍是测试容器，不要覆盖已有描述文件：

```powershell
$testDatabase = Get-Content .repo/opencode-validation-pg.json -Raw | ConvertFrom-Json
$pgInspect = docker inspect $testDatabase.container | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '测试容器不存在；先核查旧记录，再按3.2创建新实例' }
if ($pgInspect[0].Config.Labels.'weavesense.validation' -ne 'agent-opencode') { throw '不是本指南允许的测试容器' }
if ($pgInspect[0].State.Running -ne $true) { throw '测试容器未运行' }
docker exec $testDatabase.container pg_isready -U postgres -d review
```

### 3.2 首次创建时

仅当上面的文件不存在，或你已经确认旧实验结束并把旧描述文件另存后，执行以下步骤。它自动分配回环端口，不占用生产数据库端口。

```powershell
if (Test-Path .repo/opencode-validation-pg.json) { throw '描述文件已存在，先完成3.1核查，不覆盖' }
$testContainer = 'loom-opencode-validation-' + [guid]::NewGuid().ToString('N')
docker run -d --name $testContainer `
  --label weavesense.validation=agent-opencode `
  -p 127.0.0.1::5432 `
  -e POSTGRES_PASSWORD=review-only-local `
  -e POSTGRES_DB=review postgres:16-alpine
if ($LASTEXITCODE -ne 0) { throw '测试 PostgreSQL 启动失败' }
$testReady = $false
for ($i = 0; $i -lt 30; $i++) {
  docker exec $testContainer pg_isready -U postgres -d review *> $null
  if ($LASTEXITCODE -eq 0) { $testReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $testReady) { throw '测试 PostgreSQL 未就绪' }
$inspection = docker inspect $testContainer | ConvertFrom-Json
$testPort = [int]$inspection[0].NetworkSettings.Ports.'5432/tcp'[0].HostPort
$testDatabase = @{
  container=$testContainer; host='127.0.0.1'; port=$testPort
  user='postgres'; password='review-only-local'; database='review'
}
New-Item -ItemType Directory -Force .repo | Out-Null
[IO.File]::WriteAllText(
  (Join-Path $PWD '.repo/opencode-validation-pg.json'),
  ($testDatabase | ConvertTo-Json), [Text.UTF8Encoding]::new($false)
)
```

这里的密码仅用于自己创建的、只在本机可达的假数据实例。测试描述文件在 Git 忽略目录，仍不要把真实生产密码填进去。

## 4. 亲手操作用的 Eino 假模型实验室

这一节专门解决“自动脚本跑完，页面就关了”的问题。它复用已测试的 `fakeReply`，创建独立 schema，只监听回环地址；不启动生产 Compose，不修改三个批准 Skill 文件。

准备四个 PowerShell 终端：A 配置/SQL、B 假模型、C Go 执行与审核服务、D 应用。B/C/D 会一直运行，手动测试结束后按 `Ctrl+C` 停止。

### 4.1 终端 A：检查端口并生成实验配置

先完成 §3。下面三个固定端口只用于本节；有占用时停止，不能杀掉占用端口的不明进程。

```powershell
Set-Location F:\AI_WeaveSence_Things\WeaveSense
foreach ($port in @(18880,18891,18900)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "端口 $port 已被占用，请核查，不要强杀现有服务"
  }
}
$manualDir = Join-Path $PWD ('.repo/agent-manual-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $manualDir | Out-Null
$env:AGENT_MANUAL_DIR = $manualDir

$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
const local = JSON.parse(readFileSync('.repo/opencode-validation-pg.json','utf8'));
const [info] = JSON.parse(execFileSync('docker',['inspect',local.container],{encoding:'utf8',windowsHide:true}));
if(local.host!=='127.0.0.1'||local.database!=='review'||local.user!=='postgres'||
   !/^loom-opencode-validation-/.test(local.container)||
   info.Config.Labels?.['weavesense.validation']!=='agent-opencode'||
   JSON.stringify(info.NetworkSettings.Ports['5432/tcp'])!==JSON.stringify([{HostIp:'127.0.0.1',HostPort:String(local.port)}])) throw Error('not_isolated_test_pg');
const schema='oc_manual_'+randomUUID().replaceAll('-','');
const dir=resolve(process.env.AGENT_MANUAL_DIR);
const url=new URL(`postgresql://127.0.0.1:${local.port}/review`);
url.username=local.user;url.password=local.password;url.searchParams.set('options','-c search_path='+schema);
const db=new pg.Client({host:local.host,port:local.port,user:local.user,password:local.password,database:local.database});
await db.connect();await db.query(`create schema ${schema}`);await db.end();
execFileSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DATABASE_URL:url.href,LOOM_RUNTIME_MODE:'test'},stdio:'inherit',windowsHide:true});
const seeded=new pg.Client({connectionString:url.href});await seeded.connect();
await seeded.query("insert into sources(id,platform,name) values('s','rss','离线验证材料')");
await seeded.query("insert into items(id,source_id,platform,external_id,title,body,published_at) values('battery','s','rss','battery','Battery 良率材料','Battery 证据：量产良率为 97%。',clock_timestamp())");
await seeded.end();
const service='fake-service-'+randomUUID(),data='fake-data-'+randomUUID(),model='fake-model-'+randomUUID();
const config=resolve(dir,'model.local.json');
writeFileSync(config,JSON.stringify({baseURL:'http://127.0.0.1:18900/v1',model:'offline-model',apiKey:model}));
const env={DATABASE_URL:url.href,LOOM_RUNTIME_MODE:'test',VERCEL:'',XAI_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',
 VITE_AUTH_ENABLED:'false',AUTO_ANALYZE:'false',EXTRACT_AUTO:'false',AI_ENGINE:'eino',
 LOOM_MODEL_CONFIG:config,LOOM_MODEL_LOOPBACK_ONLY:'true',LOOM_MODEL_MANAGE_ALLOWED:'false',
 AGENT_ASYNC_RESEARCH_ENABLED:'true',AGENT_WORKER_ENABLED:'true',AGENT_RESEARCH_RUNTIME:'eino',AGENT_RESEARCH_REVIEW:'enforce',
 AGENT_OPENCODE_WORKER_ENABLED:'false',OPENCODE_WORKER_TOKEN:'',
 AGENT_LISTEN_ADDR:'127.0.0.1:18891',AGENT_SERVICE_URL:'http://127.0.0.1:18891',AGENT_SERVICE_TOKEN:service,
 AGENT_DATA_URL:'http://127.0.0.1:18880/api/internal/agent-data',AGENT_DATA_TOKEN:data,
 AGENT_MODEL_BASE_URL:'http://127.0.0.1:18900/v1',AGENT_MODEL_NAME:'offline-model',AGENT_MODEL_API_KEY:model,
 AGENT_SKILLS_DIR:resolve('workers/agent/skills'),AGENT_MCP_CONFIG:'',AGENT_MAX_CONCURRENT_RUNS:'1',
 AGENT_EXECUTE_TIMEOUT_MS:'120000',AGENT_HTTP_TIMEOUT_MS:'130000',AGENT_MODEL_TIMEOUT_MS:'30000',
 AGENT_RESEARCH_QUEUE_TTL_MS:'600000',AGENT_RESEARCH_DAILY_LIMIT:'50',AGENT_RESEARCH_DAILY_BUDGET_RMB:'20',
 AGENT_PRICE_INPUT_RMB_PER_MILLION:'0.01',AGENT_PRICE_OUTPUT_RMB_PER_MILLION:'0.02',AGENT_RESEARCH_PRICE_VERSION:'manual-fake-v1'};
writeFileSync(resolve(dir,'session.json'),JSON.stringify({schema,container:local.container,env},null,2)+'\n');
console.log('实验目录：'+dir+'\n独立schema：'+schema);
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw '实验配置准备失败，不继续启动' }
$manualDir
```

复制最后输出的**实验目录完整路径**。B/C/D 后续的 `<实验目录>` 均替换为它。本节固定的 `offline-model` 和价格只是假的用量算术，不能拿去做真实费用评测。

### 4.2 终端 B：启动仅本机的假模型

```powershell
Set-Location F:\AI_WeaveSence_Things\WeaveSense
$env:AGENT_MANUAL_DIR = '<实验目录>'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fakeReply } from './validation/agent/opencode/e2e.mjs';
const {env}=JSON.parse(readFileSync(resolve(process.env.AGENT_MANUAL_DIR,'session.json'),'utf8'));
const counts={producer:0,reviewer:0,paid_calls:0};
http.createServer(async(req,res)=>{
 const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(req.url==='/counts'||req.url==='/health'){json(counts);return;}
 if(req.url!=='/v1/chat/completions'){json({error:'fixture_route_only'},404);return;}
 if(req.headers.authorization!=='Bearer '+env.AGENT_MODEL_API_KEY){json({error:'unauthorized'},401);return;}
 try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(body.stream)throw Error('manual_eino_fixture_does_not_support_stream');
  const answer=fakeReply(body);counts[answer.role]++;console.log(JSON.stringify(counts));
  await delay(answer.hold?60000:1500);
  if(res.destroyed)return;
  json({id:'manual-fake',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(answer.content)}}],
   usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});
 }catch(error){console.error(error.message);if(!res.destroyed)json({error:'fixture_rejected'},500);}
}).listen(18900,'127.0.0.1',()=>console.log('假模型已启动；仅本机；付费调用0'));
'@ | node --input-type=module
```

这个假模型按固定测试词返回已知候选，不具备自由回答能力；遇到不符合夹具合同的请求会失败，不会转发到真实供应商。不要把它改成任意转发代理。

### 4.3 终端 C：启动 Eino Worker 与独立审核服务

```powershell
Set-Location F:\AI_WeaveSence_Things\WeaveSense
$manualDir = '<实验目录>'
$session = Get-Content (Join-Path $manualDir 'session.json') -Raw | ConvertFrom-Json
foreach ($p in $session.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name,[string]$p.Value,'Process') }
go -C workers/agent build -o (Join-Path $manualDir 'agent.exe') ./cmd/agent
if ($LASTEXITCODE -ne 0) { throw 'Go 构建失败' }
& (Join-Path $manualDir 'agent.exe')
```

服务先启动、应用未启动时，Worker 的领取可能暂时连接失败；继续启动 D。若 `/readyz` 不通过或 Skills 缺失，不继续提问。

### 4.4 终端 D：读取批准 Skills 摘要并启动应用

```powershell
Set-Location F:\AI_WeaveSence_Things\WeaveSense
$manualDir = '<实验目录>'
$session = Get-Content (Join-Path $manualDir 'session.json') -Raw | ConvertFrom-Json
foreach ($p in $session.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name,[string]$p.Value,'Process') }
$ready = Invoke-RestMethod http://127.0.0.1:18891/readyz
if ($ready.skill_snapshot_digest -notmatch '^[a-f0-9]{64}$') { throw '未取得有效批准Skill摘要' }
$env:AGENT_SKILL_SNAPSHOT_DIGEST = $ready.skill_snapshot_digest
npm run dev -- --host 127.0.0.1 --port 18880 --strictPort
```

用浏览器打开 `http://127.0.0.1:18880/knowledge`。这条地址是**你本机**刚启动的实验应用，与你平时可能使用的 8080 服务不同。默认本地版本未开启深入研究是正常状态；本节只在 D 的进程中启用，不改生产配置。

## 5. 逐项亲手验证

### 5.1 正常研究与发布

1. 在知识库的“向矩阵提问”输入 `Battery 发布`。
2. 点击“深入研究”，再点“提问”。
3. 观察“已排队 / 正在研究 / 正在审核 / 已发布”。速度较快时可能看不到每个中间状态，不要求每个都停留。
4. 结果应是 `Battery 材料记载量产良率为 97%。`，引用真实测试条目文本。
5. 下方“简报与笔记”出现本次发布笔记，审核记录的五项检查应全部通过。

这里验证固定假模型输出如何经宿主审核发布，不证明真实模型会得出正确答案。

### 5.2 审核阻断，保留草稿

输入 `Battery 审核阻断`，选择深入研究并提交。

预期草稿会故意声称“本材料证明所有产线良率均为 100%”，审核指出材料只支持 97%。页面应显示“未发布”“研究草稿（尚未发布）”，引用支撑为“未通过”，列出阻断原因和建议。**本次任务**不应新增已发布 note；之前正常测试产生的笔记仍应保留。

不要仅凭页面上存在任何笔记判断阻断失败；按任务地址中的 job UUID 和 §5.7 的 `run_id` 核对。

### 5.3 刷新后继续查看

再次提交 `Battery 发布`，提交后复制地址栏中的 `/knowledge?job=<UUID>`，立即按 F5。应继续查询同一个任务，不能重新创建任务；终态后再次刷新仍显示原候选/审核。

若暂时无法读取进度，地址应保留，并有“重试查看”；点击它仅重新查询，不应增加假模型调用。任务结束后输入相同问题重新点击“提问”则是**新的工作**，不是旧任务的重试。

### 5.4 排队取消

1. 暂停 **C 终端中的本次测试 Worker**（`Ctrl+C`），保持 B/D 运行。
2. 在 D 的应用提交 `Battery 排队取消`；它应停留“已排队”。
3. 点击“取消研究”，预期“已取消排队任务”。
4. 再次执行 C 的启动命令恢复 Worker。旧任务不能后来发布，也不应有模型调用。

这是专门为本实验室验证排队取消；不要用该步骤停止生产 Worker。

如果窗口太多、无法辨认C，可以在任意空闲PowerShell按端口定位，并核对本轮可执行文件路径后停止。把 `<实验目录>` 换成本轮目录；路径不符或监听不唯一时脚本会停止，不会按进程名批量结束。

```powershell
$manualDir = '<实验目录>'
$expectedAgent = Join-Path $manualDir 'agent.exe'
$listeners = @(Get-NetTCPConnection -LocalPort 18891 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -ne 1) { throw '18891未找到唯一监听，请把输出反馈给助手' }
$testAgent = Get-Process -Id $listeners[0].OwningProcess -ErrorAction Stop
if ($testAgent.Path -ne $expectedAgent) { throw '监听进程路径与本轮agent.exe不符，未停止任何进程' }
"停止本轮测试Worker：PID=$($testAgent.Id)"
Stop-Process -Id $testAgent.Id -ErrorAction Stop
Wait-Process -Id $testAgent.Id -Timeout 5 -ErrorAction SilentlyContinue
if (Get-NetTCPConnection -LocalPort 18891 -State Listen -ErrorAction SilentlyContinue) {
  throw '18891仍有监听，请把输出反馈给助手'
}
'测试Worker已停止，18891已释放'
```

### 5.5 运行中取消

提交 `Battery 运行取消`。B 的 `/counts` 会记录 Producer 已收到请求，夹具故意延迟 60 秒。

```powershell
Invoke-RestMethod http://127.0.0.1:18900/counts
```

确认 Producer 已增加、任务正在运行后点击“取消研究”。预期先显示“正在请求取消”和已发出调用仍可能产生费用的提示，随后收敛终态；本次不发布笔记。取消可能留下 `started/unknown` 或未知费用预留；**已经发出请求不等于免费**，即使本实验室实际付费始终为 0。

不能要求瞬间变成“已取消”。若 Worker 未确认停止，停留请求取消比伪造停止成功更安全。

### 5.6 off / shadow / enforce 的区别

在 D 中 `Ctrl+C` 停止本次测试应用。保留 C/B。重新加载 §4.4 的环境和摘要后，在 `npm run dev` 前改一项：

```powershell
$env:AGENT_RESEARCH_REVIEW = 'shadow'  # 第二轮可换成 off；完成后恢复 enforce
npm run dev -- --host 127.0.0.1 --port 18880 --strictPort
```

| 模式 | 使用同一个 `Battery 审核阻断` 新提问 | 预期与解释 |
| --- | --- | --- |
| off | 不调用独立 Reviewer | 页面明确未启用审核；只经确定性安全校验，语义错误可能发布 |
| shadow | 会保存 Reviewer 结果 | 审核仅观察，不作为发布依据；固定的语义缺陷可能仍发布，不可称为审核通过 |
| enforce | 独立有效审核成为发布条件 | 固定缺陷阻断，保留草稿；无有效审核也不能发布 |

“故意错误可能发布”的两个模式只能在本节假数据环境实验。改配置只影响**新作业**；已创建任务仍按自己的冻结策略执行。无需也不得修改旧作业的 `review_policy` 来强行通过。

### 5.7 用只读 SQL 核对界面与账本

终端 A 设置当前实验 DSN。下面脚本只执行查询，不改候选/审核或费用状态：

```powershell
$manualDir = '<实验目录>'
$session = Get-Content (Join-Path $manualDir 'session.json') -Raw | ConvertFrom-Json
$env:DATABASE_URL = $session.env.DATABASE_URL
@'
import pg from 'pg';
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
for(const [name,sql] of [
 ['jobs',`select j.id as job_id,j.run_id,j.runtime_provider,j.status,r.error_code,v.state as review_state,n.id as note_id
 from ai_jobs j left join ai_runs r on r.id=j.run_id left join ai_research_reviews v on v.run_id=j.run_id
 left join knowledge_notes n on n.run_id=j.run_id order by j.created_at`],
 ['model_calls',`select run_id,role,state,input_tokens,output_tokens from ai_model_calls order by started_at`],
 ['budgets',`select job_id,status,reserved_rmb,actual_rmb from ai_budget_reservations`],
 ['duplicate_notes',`select run_id,count(*) as notes from knowledge_notes where run_id is not null group by run_id having count(*)>1`]
]){console.log(name);console.table((await db.query(sql)).rows);}await db.end();
'@ | node --input-type=module
```

核对同一个 job/run：正常任务有一个候选、匹配审核和一条 note；阻断/取消没有本次 note；`duplicate_notes` 为空。完整 Producer/Reviewer 回执通常是 `completed`，包含假用量 100 输入/20 输出 token；缺用量/取消时不得擅自填 0。最终金额是使用冻结单价的算术，不是供应商账单。

## 6. 期限、预算、Skill、证据与重复请求：使用定向回归

这些边界不是全部都有 UI 按钮。不要在生产数据库改 claim/grant、审核状态或把未知费用清零来“模拟通过”；用已经留下的可运行检查验证。

```powershell
$testDatabase = Get-Content .repo/opencode-validation-pg.json -Raw | ConvertFrom-Json
$env:REVIEW_PG_CONTAINER = $testDatabase.container
$env:REVIEW_PG_PORT = [string]$testDatabase.port
npm run agent:research:pg
if ($LASTEXITCODE -ne 0) { throw '真实数据库验收未通过' }
```

预期当前 10 项通过：真实 PG 故障/并发 8 项、迁移 2 项。脚本创建并删除自己的 `oc_fault_*` / `oc_migrate_*` schema，保留测试 PG。没有正确测试配置会报告 `postgres_not_covered`，这不是可接受的跳过。

| 新能力 | 最小复跑入口 | 重点核对 |
| --- | --- | --- |
| 排队与执行期限分离、恢复不续命 | `go -C workers/agent test ./internal/agent -run 'Deadline|Skill' -count=1` 与 `npm run test:research` | 首次 claim 定绝对期限；缺失或不匹配 Skill 在模型前失败 |
| 角色预算、started 后不重发 | `node --experimental-strip-types --test src/lib/server/agent-research-budget.test.ts` | Producer/Reviewer 各自上限，未知仍保留预留 |
| 引用、版本与不可变候选 | `node --experimental-strip-types --test src/lib/server/agent-candidates.test.ts src/lib/server/agent-review-publication.test.ts` | 旧来源/假引用/候选A审核候选B不能发布 |
| 断联和队列收敛 | `node --experimental-strip-types --test src/lib/server/agent-admission-expiry.test.ts src/lib/server/agent-research-status.test.ts` | 期限/租约失效终止，状态查询不无限等待 |
| 同一 request_id 冻结与 provider 隔离 | `node --experimental-strip-types --test src/lib/server/agent-queue.test.ts src/lib/server/agent-opencode-jobs.test.ts` | 内容变化冲突；Eino/OpenCode 不抢对方工作 |
| 工具事实从宿主账本统计 | `node --experimental-strip-types --test src/lib/server/agent-tool-ledger.test.ts src/lib/server/agent-research-stages.test.ts` | 不能以运行时自报的 0 隐藏工具调用 |
| 错 token、过大请求先拒绝 | `node --experimental-strip-types --test src/lib/server/agent-internal-http.test.ts` | 鉴权先于读取正文/数据库操作 |

Go `-run` 是名称过滤；如果显示 `[no tests to run]`，不能当作边界已验证。运行全套 `go test ./...` 和 `test:research` 可以避免过滤名称随版本变化漏测。

## 7. 实际开发版 / 构建版浏览器验收

本节是自动驾驶浏览器，不保留可手工操作的页面；手动体验使用 §4。脚本没有 `--headed`、`--pause`、`--keep-alive` 参数。

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'  # 要求本机已安装 Edge；也可以用 chrome
npm run agent:research:e2e
if ($LASTEXITCODE -ne 0) { throw 'Eino开发版未通过，先修复，不继续构建版' }
npm run agent:research:e2e -- --built
if ($LASTEXITCODE -ne 0) { throw 'Eino构建版未通过' }
```

未设置 channel 时使用 Playwright 管理的 Chromium；缺少浏览器可以 `npx playwright install chromium`。显式 channel 只允许 `msedge` / `chrome`。

`--built` 自动使用**本轮独立 schema**执行完整 `npm run build`，再启动 preview，不需要你另跑一个可能迁移生产数据库的 build。两次测试自动选临时回环端口，不占用 8080。

预期最后 JSON 有 `ok:true`、`browser:"passed"`；构建版的 smoke 有 `divergesFromBaseline:false`。它覆盖正常发布、阻断草稿、排队取消、运行取消、桌面/手机渲染及控制台。必须先跑 Eino dev：目前所有 built 模式都比较 `screenshots/opencode-dev-smoke.json`。

查看结果与图片：

```powershell
Get-ChildItem .repo -Directory -Filter 'opencode-e2e-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 4
Get-ChildItem screenshots -Filter 'opencode-*-*.png' | Sort-Object LastWriteTime -Descending | Select-Object -First 12
```

在最新本轮目录打开 `verdict.json`、日志，再查看 `screenshots/opencode-dev-*` / `opencode-built-*` 的桌面和手机图。除自动 JSON 检查外，自己确认文字可读、草稿/笔记不混淆、无横向溢出；图片不是运行中页面。

脚本正常完成或捕获异常后会清理本轮应用/Go/假模型/schema；强制杀进程不保证执行清理。先保留日志，再按 §10 核查本轮残留。

## 8. 真正的 OpenCode：协议、隔离和宿主全链路

### 8.1 协议探针（仍无付费调用）

```powershell
npm run agent:opencode:probe -- --offline
```

探针使用固定 1.3.13 二进制和本地假供应商。没有现成二进制时会解析/下载固定包；有本地二进制可设置 `OPENCODE_PROBE_BINARY` 为完整路径。只接受 `--offline`，不会连接真实模型。

它会更新 `validation/agent/opencode/` 中协议、OpenAPI、Skill 和版本观测文件；测试后的 Git 差异是证据更新，不应不经审阅覆盖旧证据。宿主 loopback 探针本身**不证明 OS 网络隔离**；继续 8.2。

### 8.2 构建固定运行时并实测隔离

```powershell
docker build --platform linux/amd64 -f workers/opencode-runtime/Dockerfile --target production -t weavesense-opencode-runtime:1.3.13 .
if ($LASTEXITCODE -ne 0) { throw '生产形状运行时镜像构建失败' }
docker build --platform linux/amd64 -f workers/opencode-runtime/Dockerfile --target probe -t weavesense-opencode-probe:1.3.13 .
if ($LASTEXITCODE -ne 0) { throw '探针镜像构建失败' }
docker build --platform linux/amd64 -f workers/agent/Dockerfile.bridge -t weavesense-agent-bridge:offline-proxy-test workers/agent
if ($LASTEXITCODE -ne 0) { throw '可信桥接镜像构建失败' }
node --test validation/agent/opencode/isolation.test.mjs
if ($LASTEXITCODE -ne 0) { throw '隔离未通过，不继续C组测试' }
node --test validation/agent/opencode/model-proxy-isolation.test.mjs
if ($LASTEXITCODE -ne 0) { throw '模型代理隔离未通过' }
```

预期批准 bridge 可达；直接供应商、宿主 app、公共 IPv4/IPv6、宿主旁路不可达；禁止文件路由、旧 epoch、跨任务历史被拒绝；进程树停止得到确认。不能用“DNS 查不到”代替数字 IP 的实际不可达。`isolation.fixture.json`、`model-proxy-isolation.fixture.json` 和 `runtime-lock.json` 记录实际测试，隔离脚本会刷新证据。

这里构建的是本地镜像，不代表镜像已发布到 registry。不要把 Docker image ID 写成已发布的 registry digest。

### 8.3 原生 OpenCode + 实际应用 + PG

先完成 §3、§7 的 Eino dev 基线和 8.2 镜像准备，再执行：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run agent:opencode:integration
if ($LASTEXITCODE -ne 0) { throw 'OpenCode开发版未通过' }
npm run agent:opencode:integration -- --built
if ($LASTEXITCODE -ne 0) { throw 'OpenCode构建版未通过' }
```

预期 `ok:true`、`runtime:"opencode"`、`browser:"passed"`。正常场景实际宿主账本有 3 个 Producer 调用、1 个 Reviewer 调用、2 个语料工具调用，一份候选和一条 note。Producer 的请求经过真实 Go ModelProxy，返回 SSE usage 与 `[DONE]`；供应商依旧是假服务。

查看 `.repo/opencode-e2e-<UUID>/verdict.json` 和 `screenshots/opencode-native-{dev|built}-*`。整个测试会出现取消后 403 等**预期拒绝**，不能把这些和浏览器 uncaught error 混为一谈。脚本应主动断言哪些拒绝是预期。

### 8.4 真实评测适配器的假 A/B 烟测

这一步证明评测工具能调用真正的应用队列、数据库和 Eino，而不是只计算静态 JSON。先完成 Eino `--built`，确保当前源码有构建产物。

```powershell
docker pull postgres:16-alpine
docker pull public.ecr.aws/docker/library/node:22.22.3-bookworm-slim
npm run agent:quality:smoke
```

它自动创建新的独立 PG/app/Eino 容器，并复用 `.vercel/output/functions/__server.func/index.mjs`；**不会自动 build**。成功输出应包含 `passed:true`、`cleaned:true`、`fake_calls:3`、`paid_calls:0`。日志位于 `.repo/live-adapter-smoke-<UUID>/`。

它结束后删除自己的测试容器/卷/网络；不能把留下的配置描述直接接真实 `--live`。一题假 A/B 不构成质量收益证据，也没有执行真实 C 质量实验。

## 9. 真实模型质量评测（会产生费用）

本节的执行不属于前面假模型步骤。先通过无付费链路，再人工准备独立验证部署、正式留出题和已验证的模型/人民币价格。不要修改默认采用开关。准备和 `/readyz` 不调用模型；**9.5 的 `--live` 才会提交可能付费的任务**。

### 9.1 建立专用 A/B 部署，不复用手工实验室

§4 的宿主进程实验室不能直接用于 CLI live：评测器核对实际 Docker 容器配置、服务绑定和数据库。当前没有一键真实环境准备脚本；以下是独立 QA 部署模板，须自行提供真实供应商参数与语料，不操作主 Compose。

检查本机 15432、18080、18791 未被占用。将下面内容保存为 `.repo/quality-compose.yml`。镜像构建用本仓库；所有数据和端口属于单独 QA 项目。

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: quality-postgres
    labels: {weavesense.validation: agent-quality-live}
    environment:
      POSTGRES_DB: review
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${QA_DB_PASSWORD:?required}
    ports: ["127.0.0.1:15432:5432"]
    volumes: ["quality-pg:/var/lib/postgresql/data"]
    networks:
      qa: {aliases: [quality-db]}
  eino:
    build: {context: ../workers/agent, dockerfile: Dockerfile}
    image: weavesense-quality-eino:pilot
    container_name: quality-eino
    labels: {weavesense.validation: agent-quality-live}
    environment:
      AGENT_LISTEN_ADDR: 0.0.0.0:8791
      AGENT_SERVICE_TOKEN: ${QA_SERVICE_TOKEN:?required}
      AGENT_DATA_TOKEN: ${QA_DATA_TOKEN:?required}
      AGENT_DATA_URL: http://quality-app:8080/api/internal/agent-data
      AGENT_WORKER_ENABLED: "true"
      AGENT_SKILLS_DIR: /app/skills
      AGENT_MCP_CONFIG: ""
      AGENT_MAX_CONCURRENT_RUNS: "1"
      AGENT_EXECUTE_TIMEOUT_MS: "120000"
      AGENT_MODEL_TIMEOUT_MS: "30000"
      AGENT_MODEL_BASE_URL: ${QA_MODEL_BASE_URL:?required}
      AGENT_MODEL_NAME: ${QA_MODEL_NAME:?required}
      AGENT_MODEL_API_KEY: ${QA_MODEL_API_KEY:?required}
    ports: ["127.0.0.1:18791:8791"]
    networks:
      qa: {aliases: [quality-eino]}
  app:
    build: {context: .., dockerfile: Dockerfile}
    image: weavesense-quality-app:pilot
    container_name: quality-app
    labels: {weavesense.validation: agent-quality-live}
    environment:
      DATABASE_URL: ${QA_DATABASE_URL:?required}
      LOOM_RUNTIME_MODE: production
      AUTO_ANALYZE: "false"
      EXTRACT_AUTO: "false"
      AI_ENGINE: legacy
      VITE_AUTH_ENABLED: "false"
      AGENT_WORKER_ENABLED: "true"
      AGENT_ASYNC_RESEARCH_ENABLED: "false"
      AGENT_OPENCODE_WORKER_ENABLED: "false"
      AGENT_SERVICE_URL: http://quality-eino:8791
      AGENT_SERVICE_TOKEN: ${QA_SERVICE_TOKEN:?required}
      AGENT_DATA_TOKEN: ${QA_DATA_TOKEN:?required}
      AGENT_MODEL_NAME: ${QA_MODEL_NAME:?required}
      AGENT_EXECUTE_TIMEOUT_MS: "120000"
      AGENT_HTTP_TIMEOUT_MS: "130000"
      AGENT_RESEARCH_QUEUE_TTL_MS: "10000"
      AGENT_RESEARCH_RUNTIME: eino
      AGENT_RESEARCH_REVIEW: "off"
      AGENT_SKILL_SNAPSHOT_DIGEST: ${QA_SKILL_DIGEST:?required}
      AGENT_PRICE_INPUT_RMB_PER_MILLION: ${QA_INPUT_PRICE:?required}
      AGENT_PRICE_OUTPUT_RMB_PER_MILLION: ${QA_OUTPUT_PRICE:?required}
      AGENT_RESEARCH_PRICE_VERSION: ${QA_PRICE_VERSION:?required}
    ports: ["127.0.0.1:18080:8080"]
    networks:
      qa: {aliases: [quality-app]}
networks:
  qa: {}
volumes:
  quality-pg: {}
```

在**工作树外**创建如 `F:\loom-qa\agent-quality\qa-vars.env`。不要使用已有生产 env_file，不把 key 写入指南/仓库。下面所有 `<...>` 必须替换；token 必须不同。使用字符集简单的随机 token/密码可以避免 Compose/DSN 转义歧义。

```text
QA_DB_PASSWORD=<本次独立PG随机密码>
QA_SERVICE_TOKEN=<随机服务token>
QA_DATA_TOKEN=<另一个随机数据token>
QA_MODEL_BASE_URL=<已验证兼容接口baseURL，通常以/v1结尾>
QA_MODEL_NAME=<固定供应商模型名或revision>
QA_MODEL_API_KEY=<真实供应商key，只进入可信Eino>
QA_INPUT_PRICE=<实际人民币每百万输入token价格，严格正数>
QA_OUTPUT_PRICE=<实际人民币每百万输出token价格，严格正数>
QA_PRICE_VERSION=<价格核查日期/版本>
QA_DATABASE_URL=<下一步计算的容器内DSN>
QA_SKILL_DIGEST=<启动Eino后取得的64位摘要>
```

生成随机 token 的例子：`node --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(32).toString("hex"))'`。多运行几次生成不同值，仅保存到专用配置。

选择新 schema，例如 `oc_live_quality_20261007_<8位随机hex>`。生成正确转义的容器内 DSN，打印结果仅限自己的测试账号：

```powershell
$env:QA_SCHEMA = 'oc_live_quality_20261007_<替换为8位随机hex>'
$env:QA_DB_PASSWORD = '<与qa-vars.env相同的测试PG密码>'
@'
if(!/^oc_live_[a-z0-9_]{8,60}$/.test(process.env.QA_SCHEMA))throw Error('invalid_schema');
const u=new URL('postgresql://quality-db:5432/review');
u.username='postgres';u.password=process.env.QA_DB_PASSWORD;
u.searchParams.set('options','-c search_path='+process.env.QA_SCHEMA);console.log(u.href);
'@ | node --input-type=module
```

将结果填入 `QA_DATABASE_URL`。在未启动 app 前，`QA_SKILL_DIGEST` 暂写 64 个小写 `0`，**只用于让 Compose 解析通过**；实际 app 启动前必须替换成真实 `/readyz` 摘要，不能用于发送任务。

```powershell
$qaEnv = 'F:\loom-qa\agent-quality\qa-vars.env'
docker compose -p weavesense-quality -f .repo/quality-compose.yml --env-file $qaEnv config --quiet
if ($LASTEXITCODE -ne 0) { throw 'QA配置无效' }
docker compose -p weavesense-quality -f .repo/quality-compose.yml --env-file $qaEnv build eino app
if ($LASTEXITCODE -ne 0) { throw 'QA镜像构建失败' }
docker compose -p weavesense-quality -f .repo/quality-compose.yml --env-file $qaEnv up -d postgres eino
if ($LASTEXITCODE -ne 0) { throw 'QA服务启动失败' }
docker exec quality-postgres pg_isready -U postgres -d review
$evalReady = Invoke-RestMethod http://127.0.0.1:18791/readyz
$evalReady.skill_snapshot_digest
```

容器刚启动时 PG/Go 可能尚未就绪，等待后重查；不能把 `up -d` 当作 ready。Eino 启动时 app 尚未启动，领取错误应在 app 启动后消失。把真实摘要填入外部配置的 `QA_SKILL_DIGEST`。

### 9.2 新建 schema、迁移并导入冻结语料

继续同一终端中的 `$env:QA_SCHEMA` / `$env:QA_DB_PASSWORD`。本步骤不读取生产 DSN。

```powershell
if ($env:QA_SCHEMA -notmatch '^oc_live_[a-z0-9_]{8,60}$') { throw '先设置有效测试schema' }
docker exec quality-postgres psql -U postgres -d review -v ON_ERROR_STOP=1 -c "create schema $env:QA_SCHEMA"
if ($LASTEXITCODE -ne 0) { throw 'schema已存在或创建失败，不复用旧实验' }
$env:DATABASE_URL = (@'
const u=new URL('postgresql://127.0.0.1:15432/review');u.username='postgres';u.password=process.env.QA_DB_PASSWORD;
u.searchParams.set('options','-c search_path='+process.env.QA_SCHEMA);console.log(u.href);
'@ | node --input-type=module).Trim()
npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw 'QA迁移失败' }
```

将自己允许用于评测的材料保存为 UTF-8 无 BOM 的 `.repo/quality-corpus.local.json`，格式如下。下面两份短文只是导入格式演示，不足以正式验收；正式语料应覆盖正常、冲突、日期、截断、转述同源和确定性夸大等情况。不要把候选答案、审核结论或题目标签混进材料。

```json
{
  "sources": [{"id":"qa-source","platform":"rss","name":"冻结测试资料"}],
  "items": [
    {"id":"qa-item-01","source_id":"qa-source","platform":"rss","external_id":"qa-01","title":"量产记录一","body":"2026年一季度，该试验线的量产良率为97%。","author":"测试资料","url":"","published_at":"2026-04-01T00:00:00Z"},
    {"id":"qa-item-02","source_id":"qa-source","platform":"rss","external_id":"qa-02","title":"量产记录二","body":"2026年二季度，该试验线良率降至95%；其他产线尚无数据。","author":"测试资料","url":"","published_at":"2026-07-01T00:00:00Z"}
  ]
}
```

执行参数化导入；ID 必须是本次新 schema 内唯一的字符串：

```powershell
@'
import {readFileSync,writeFileSync} from 'node:fs';import pg from 'pg';
const input=JSON.parse(readFileSync('.repo/quality-corpus.local.json','utf8'));
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{await db.query('begin');
for(const s of input.sources)await db.query('insert into sources(id,platform,name) values($1,$2,$3)',[s.id,s.platform,s.name]);
for(const i of input.items)await db.query(`insert into items(id,source_id,platform,external_id,title,body,author,url,published_at)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[i.id,i.source_id,i.platform,i.external_id,i.title,i.body,i.author??'',i.url??'',i.published_at??null]);
await db.query('commit');}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
writeFileSync('.repo/quality-database.local.json',JSON.stringify({host:'127.0.0.1',port:15432,user:'postgres',
 password:process.env.QA_DB_PASSWORD,database:'review',container:'quality-postgres'},null,2)+'\n');
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw '冻结语料导入失败' }
docker compose -p weavesense-quality -f .repo/quality-compose.yml --env-file $qaEnv up -d --no-deps app
if ($LASTEXITCODE -ne 0) { throw 'QA应用启动失败' }
```

浏览器访问 `http://127.0.0.1:18080/knowledge` 确认应用渲染。这个部署专门供 CLI 使用，深入研究 UI 保持关闭；**CLI 直接入队，UI 关闭不是 CLI 的付费开关**。评测期间不要在页面或 SQL 中修改冻结材料；适配器拒绝已有 queued/running 工作或绑定不一致。

### 9.3 留出题与严格配置

保存 `.repo/quality-holdout.local.json`。`source_ids` 这里实际是 **items.id**，不是 `sources.id`：

```json
{
  "schema_version": 1,
  "cases": [
    {"id":"question-01","question":"这两份材料是否支持所有产线良率一直提升？","source_ids":["qa-item-01","qa-item-02"]}
  ]
}
```

每题 2–400 个 JS 字符（UTF-16 code units），1–8 个唯一 item ID，最多 100 题，题目 ID 不重复。正式采用至少 30 个独立留出题、每题重复 2 次；不能复制一道题换 ID 冒充 30 题。文件不能有 `expected_blocked`、rationale、候选报告、人工标签或 Reviewer 结果。仓库的 `quality-cases.json` 是公开夹具，不能当正式 holdout。

保存 `.repo/quality-live.local.json`。**模型、单价、schema、摘要必须替换成刚准备环境中的实际值**；1/4 元仅为格式示例，不能以假价格跑真实模型。

```json
{
  "schema_version": 1,
  "experiment_id": "c82ba5a8-8b35-4b17-9a12-8f44bfe6a780",
  "arms": ["A","B"],
  "holdout_file": "quality-holdout.local.json",
  "holdout_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "database_file": "quality-database.local.json",
  "schema": "oc_live_quality_20261007_REPLACE",
  "model_profile": {
    "model": "REPLACE_WITH_FIXED_MODEL_REVISION",
    "model_revision": "REPLACE_WITH_FIXED_MODEL_REVISION",
    "input_per_million": 1,
    "output_per_million": 4,
    "price_version": "REPLACE_WITH_VERIFIED_CNY_PRICE_VERSION"
  },
  "skill_snapshot_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "repetitions": 2,
  "execution_timeout_ms": 120000,
  "queue_ttl_ms": 10000,
  "services": {"app_url":"http://127.0.0.1:18080/","eino_ready_url":"http://127.0.0.1:18791/readyz"},
  "containers": {"database":"quality-postgres","app":"quality-app","eino":"quality-eino"}
}
```

配置 strict：不能加 `api_key`、`labels`、`validation_only` 或 `experiment_budget_cny`。供应商 key 留在可信服务的外部配置，driver 不接收它。相对文件路径按配置文件所在目录解析。

`model_revision` 必须与 model 相同；这只冻结请求名，不能独立证明供应商内部版本不变。重复次数为 1–3；执行期限 10,000–900,000 ms；队列 TTL 1,000–60,000 ms；摘要必须是 64 位小写 hex。

更新 UUID / holdout 摘要 / Skills 摘要，使用 UTF-8 无 BOM：

```powershell
$evalConfigPath = [IO.Path]::GetFullPath('.repo/quality-live.local.json')
$evalConfig = Get-Content $evalConfigPath -Raw | ConvertFrom-Json
$evalReady = Invoke-RestMethod http://127.0.0.1:18791/readyz
$evalConfig.experiment_id = [guid]::NewGuid().ToString()
$evalConfig.holdout_sha256 = (Get-FileHash .repo/quality-holdout.local.json -Algorithm SHA256).Hash.ToLower()
$evalConfig.skill_snapshot_digest = $evalReady.skill_snapshot_digest
[IO.File]::WriteAllText($evalConfigPath,($evalConfig | ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
```

### 9.4 无付费检查计划与预算

这段只解析文件、计算计划，不创建 adapter、不发任务：

```powershell
@'
import {loadLiveConfig,livePlan} from './scripts/agent-quality-live.mjs';
const {config,cases}=loadLiveConfig('.repo/quality-live.local.json');
const plan=livePlan(config,cases,30);
console.log(JSON.stringify({arms:config.arms,selected_cases:Math.min(cases.length,30),planned_jobs:plan.length,
 maximum_model_calls:plan.reduce((n,t)=>n+t.total_model_calls,0),
 worst_reserved_cny:plan.reduce((n,t)=>n+t.worst_cost_cny,0)},null,2));
'@ | node --experimental-strip-types --input-type=module
```

计划同时运行两种比较：同 Producer 预算 A=6+0、B/C=6+1；同总调用数 A=6+0、B/C=5+1。审核组的 Producer 时间窗口也更短，不能说内部执行条件完全相同。

30 题 × 2 次重复：A/B 是 240 个任务、最多 1,500 次模型调用；A/B/C 是 360 个任务、最多 2,280 次调用。每个调用按 512 KiB 输入上限和 1,800 输出 token 预留，**最坏金额可能明显高于实际使用**。这是保守预算，不应通过降低真实价格或输入上限让它“通过”。

### 9.5 显式付费执行

确认你愿意承担本次金额上限，且来源/语料/价格/配置核查无误后，才执行以下命令。输入金额必须为正数，≤10,000；没有默认付费预算。

```powershell
$budgetCny = [double](Read-Host '输入本次明确允许的人民币上限（本步骤会调用真实模型）')
if ([double]::IsNaN($budgetCny) -or [double]::IsInfinity($budgetCny) -or $budgetCny -le 0 -or $budgetCny -gt 10000) { throw '预算须为0至10000之间的有限正数' }
npm run agent:quality -- --live --max-cases=30 "--budget-cny=$budgetCny" --config=.repo/quality-live.local.json
```

首次可改 `--max-cases=1` 做有预算的链路试验，但不能达到正式 30 题门槛。全部配对计划的最坏预留超预算时，在发送前拒绝；不要删昂贵组伪装完整实验。

输出位于 `.repo/agent-quality-live/<experiment_id>/`：`preregistered.json`、逐次 `observation-0001.json` 等、`observations.json`、`blind-candidates.json`、`blind-review-findings.json`。出现 unknown、缺 usage、条件变化或异常费用时停止后续发送、保留预留；未发送槽位仍在汇总中。

同一个 experiment ID 的文件使用独占创建。不要删结果后重跑未知付费工作；新的尝试必须明确是新工作并使用新 ID/新预算。运行结束只得到观察，未盲评时 `live_accepted=false`，不会自动开生产功能。

### 9.6 双人独立盲标与评分

1. 给两位独立人工评判者 `blind-candidates.json`，不要给组别、manifest、费用或 fixture 答案。
2. 先冻结候选正确性/任务可用性的标签，再给 `blind-review-findings.json`，补缺陷定位判断。
3. 每个 blind ID 至少有两个不同 `grader_id`；缺标或两人不一致保留为未决，不能由模型自评分顶替。

标签保存为 `.repo/quality-human-labels.local.json`。下面字段值仅说明格式，UUID/摘要必须来自实际 blind 文件，布尔值必须由人工决定：

```json
{
  "schema_version": 1,
  "experiment_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "blinded": true,
  "independent": true,
  "annotations": [
    {"blind_id":"00000000-0000-4000-8000-000000000001","candidate_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","grader_id":"human-01","defective":false,"hard_error":false,"task_accepted":false,"evidence_support":false,"conflict_handling":false,"defect_localized":null,"defect_class":"normal"},
    {"blind_id":"00000000-0000-4000-8000-000000000001","candidate_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","grader_id":"human-02","defective":false,"hard_error":false,"task_accepted":false,"evidence_support":false,"conflict_handling":false,"defect_localized":null,"defect_class":"normal"}
  ]
}
```

`defect_class` 允许 `reverse_support`、`source_independence`、`date_scope`、`conflict_omission`、`truncated_coverage`、`unsupported_certainty`、`normal`；未测定位填 `defect_localized:null`。顶层的盲评/独立声明需要真实执行流程支持，软件无法替你证明人是独立的。

`candidate:null` 的失败/未发送槽位也必须保留并由两人标注，使用原 blind ID 与 digest，填 `task_accepted:false`；不存在的报告不能编造语义缺陷，未测定位仍为 null。不能删掉这些槽位让完成率或费用看起来更好。

```powershell
$evalExperimentId = (Get-Content .repo/quality-live.local.json -Raw | ConvertFrom-Json).experiment_id
npm run agent:quality -- "--score-live=.repo/agent-quality-live/$evalExperimentId/observations.json" --labels=.repo/quality-human-labels.local.json
```

A/B 退出成功看 `reviewer_accepted`；未评 C 时 `opencode_evaluated=false`、C门槛为 null、`live_accepted=false`。A/B/C 成功看 `live_accepted`。缺标签、争议、观察错配、未知费用或门槛未达会失败；评分失败不能解释成脚本出错后人工盖章通过。

冻结门槛包括：硬错误发布0、缺陷阻断召回≥90%、合理候选误阻断≤10%；B 相对 A 的缺陷发布率下降≥30%、正常接受率下降≤5个百分点、每份接受报告成本≤1.5倍；C 相对 B 完成率提高≥10个百分点、接受报告成本≤1.3倍。两种预算比较均须满足。不存在可计算分母时记未知，不编造比例；报告区间不等于证明统计显著。

### 9.7 增加 C 的额外前提

先证明 B−A，再考虑 C−B。需要另外部署与实际核对三类带 `weavesense.validation=agent-quality-live` 标签的容器：`quality-opencode-worker`、`quality-bridge`、`quality-runtime`。安全拓扑和 build 入口参照 [运行手册](../operations/opencode-research.md)；不能直接连接生产主 Compose。

| 检查 | 必须满足 |
| --- | --- |
| 可信网络 | worker/bridge 与 QA app 有共享可信网络，真实 Docker aliases 匹配服务 URL |
| runtime 网络 | 仅一个 internal、isolated gateway 网络，bridge/worker 同时接入；不能把runtime加入qa公共网络 |
| 模型 | Eino/bridge的baseURL/key/model相同；worker/runtime只持模型名，不得持供应商key |
| 作业权限 | app/worker的 `OPENCODE_WORKER_TOKEN` 相同；worker的Reviewer token与Eino一致；app开启OpenCode领取能力 |
| 控制权限 | worker/bridge的bridge-control token相同；worker/runtime的runtime token相同；两种token必须不同 |
| 路由 | worker的jobs指向QA app，review指向QA Eino，runtime指向4097、bridge指向8792；bridge数据接口也指向QA app |
| 沙箱 | 固定1.3.13镜像与真实binary/wrapper hash；非root、init、read-only、cap-drop、no-new-privileges、受限PID/内存/tmpfs；无host bind/公开端口/数据库或master token |

不要用单纯的模板标记代替上述实测。**C 的部署涉及这三项额外服务，目前没有专用一键真实 QA 生成命令**；准备不完整时继续只做 A/B，不能为凑全比较放宽验证器。§8 的原生全链路已经提供无需真实供应商的 C 集成验证。

在实际运行 C 的同一 Docker host 重新执行 8.2 的隔离测试。证明必须小于24小时，并绑定当前 Docker ID/version/`OSType/Architecture`；不是拿历史桌面证明跨主机使用。成功后：

```powershell
Copy-Item validation/agent/opencode/isolation.fixture.json .repo/isolation-proof.local.json
$evalProof = Get-Content .repo/isolation-proof.local.json -Raw | ConvertFrom-Json
$evalConfigPath = [IO.Path]::GetFullPath('.repo/quality-live.local.json')
$evalConfig = Get-Content $evalConfigPath -Raw | ConvertFrom-Json
$evalConfig.arms = @('A','B','C')
$evalConfig.experiment_id = [guid]::NewGuid().ToString()
$evalConfig.containers | Add-Member -Force NoteProperty opencode_worker 'quality-opencode-worker'
$evalConfig.containers | Add-Member -Force NoteProperty bridge 'quality-bridge'
$evalConfig.containers | Add-Member -Force NoteProperty runtime 'quality-runtime'
$evalConfig | Add-Member -Force NoteProperty isolation_evidence_file 'isolation-proof.local.json'
$evalConfig | Add-Member -Force NoteProperty isolation_evidence_sha256 (Get-FileHash .repo/isolation-proof.local.json -Algorithm SHA256).Hash.ToLower()
$evalConfig | Add-Member -Force NoteProperty isolation_host $evalProof.deployment_host
[IO.File]::WriteAllText($evalConfigPath,($evalConfig | ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
```

实际容器名不同就替换。再执行9.4，无付费核算新预算，确认完整准备后才执行9.5。C 的结果仍需双人盲评、费用和冻结门槛；通过协议和隔离本身不代表更聪明。

## 10. 停止、清理与常见故障

### 10.1 手工实验室停止

1. 已发出模型调用的任务先在页面请求取消并确认终态；未知账本仍保留。
2. 在 D、C、B 各自测试终端按 `Ctrl+C` 停止应用、Go 服务和假模型；不要停止平时使用的其他服务。
3. 保留 `<实验目录>/session.json`、SQL 查询结果和必要截图。只删除自己的 `oc_manual_<UUID>` schema。

以下清理会删除**本节独立 schema 中的全部假数据**；只有确认实验结束才执行：

```powershell
$manualDir = '<实验目录>'
$session = Get-Content (Join-Path $manualDir 'session.json') -Raw | ConvertFrom-Json
if ($session.schema -notmatch '^oc_manual_[a-f0-9]{32}$') { throw '不是手工测试schema，拒绝删除' }
docker exec $session.container psql -U postgres -d review -v ON_ERROR_STOP=1 -c "drop schema if exists $($session.schema) cascade"
```

测试 PG 可能被其他实验继续使用，默认保留。需要删除时，先核对 §3 标签/端口、确认没有任何实验使用它，再精确执行 `docker rm -f <自己的测试容器名>`；不要执行主 Compose `down`、`docker system prune` 或批量删数据库。

手工测试改变的环境变量留在对应 PowerShell 中；关闭这些测试终端即可。不要把 `.repo` 的假配置复制到正式环境。

§9 的 QA 部署须单独收尾：停止新的实验，等待已发出工作结束或按运行手册收敛 unknown，再用相同 `-p weavesense-quality -f .repo/quality-compose.yml --env-file <QA配置>` 执行 `stop app eino`。保留 PG/卷、manifest、观察和标签用于对账。确认不再需要、且只涉及本次 QA 项目后才删除自己的容器/卷；不 down-migrate，不清理生产环境，不把真实 key 放入测试报告。

### 10.2 排查表

| 现象 | 核查与处理 |
| --- | --- |
| 深入研究按钮灰色 | 确认打开的是18880实验室；D是否加载配置；Go服务是否启动；开关仅新进程生效 |
| `trusted_access_required` | 必须本机回环地址、已配置 `LOOM_MODEL_CONFIG`、同 origin；勿用局域网IP或通过改鉴权绕过 |
| 缺 Skill / 摘要不一致 | C的 `AGENT_SKILLS_DIR` 指向 `workers/agent/skills`；D读取同一次 `/readyz` 摘要；不要随意修改包内容 |
| 队列一直排队 | C是否运行、`AGENT_WORKER_ENABLED`是否为true、Data URL/token是否和D一致；不要改旧job的provider抢救 |
| 超时、unknown或缺usage | 保留预留和日志，核对请求是否已发出；不要自动重发旧prompt或手工填免费 |
| `postgres_not_covered` | 设置 `REVIEW_PG_CONTAINER` / `REVIEW_PG_PORT`，不是仅设置 `DATABASE_URL` |
| 浏览器找不到 | 使用本机已安装的msedge/chrome，或安装Playwright Chromium |
| built找不到基线 | 先跑Eino dev，生成 `screenshots/opencode-dev-smoke.json` |
| built空白 / MIME / SSR异常 | 看本轮app日志和浏览器console；检查实际build是否成功，不能只看HTTP200 |
| isolation不支持网络选项 | 使用支持isolated gateway的Docker Linux环境；普通internal网不算等价通过 |
| 质量适配器报binding mismatch | 按§9逐一核对容器label、network aliases、schema DSN、服务token/model/Skill/期限；不能删掉preflight断言 |
| live预算不足 | 整个配对计划会先计算最坏预留；调整样本规模或明确预算，不降低真实价格/输入上限欺骗计费 |

### 10.3 手工测试记录模板

另存一份不含秘密的记录，逐项填写：

```text
日期 / 操作者：
Git提交 / Node / Go / Docker：
测试模式：假模型 / 有预算真实模型
独立PG容器 / schema / 实验目录：
正常发布：job_id、run_id、note_id、引用是否匹配
审核阻断：job_id、发现、该run无note
刷新恢复：原job_id未变、没有新模型调用
排队取消：零模型调用、终态
运行取消：停止是否确认、未知费用是否保留、没有发布
off/shadow/enforce：新任务策略、旧任务冻结策略
真实PG/隔离/dev/built：命令、退出码、verdict路径
真实质量：manifest/观察/双人标签/费用/未测项
最终判定：通过 / 未通过 / 尚未验证（不能把未知写成通过）
```

更多合同和限额见 [运行手册](../operations/opencode-research.md)、[质量政策](../../validation/agent/opencode/quality-policy.md)、[实现记录](../../validation/agent/opencode/implementation-status.md) 和 [完整验收证据](../../validation/agent/opencode/baseline.md)。

## 11. 本指南自身的验证范围

本次撰写时，实际按§4创建了新的测试schema、迁移/导入、假模型、Go与应用；用本机Edge验证了正常发布、刷新同一任务、审核阻断草稿、运行取消及排队取消。只读SQL例子实跑通过。运行取消得到 `outcome_unknown` 且无该run发布笔记，排队取消零模型发送，均符合指南预期；付费调用为0。本次专用进程/schema已清理，共享测试PG保留。

PowerShell代码块、Node片段、JSON格式、Markdown链接和QA Compose语法另行检查。§9真实供应商部署/评分步骤是依据当前源码核对的操作模板，本次没有启动真实供应商评测或取得人工质量标签；不能把文档校验写成真实A/B/C通过。off/shadow/enforce边界的既有自动化证据见完整验收记录，本次交互实验没有重新逐一操作off/shadow。

## 12. 用户手工测试备忘

### 12.1 2026-10-07 本轮协作测试

开始时间：2026-10-07 14:41（Asia/Shanghai）。方式：用户实际操作，助手逐步指引、依据反馈记录结果；16:04起，按用户授权由助手接手后续操作，分别标注执行者。先走无付费的假模型路线。本节只记录本轮结果，不把§11助手先前的验收当作用户已测通过。

当前步骤：**M01–M09已完成，本轮无付费验收结束**。Eino/OpenCode的dev/built、协议与隔离以及假A/B适配器验收通过；结果已归档。手工实验室三个进程已停止，18880/18891/18900释放，唯一指定schema已删除；共享测试PG及其他schema/容器保留。清理前计数9/6/0、10job/15回执/5note，两条unknown预算原样存入脱敏快照。五条笔记中的两条100%错误笔记属于off/shadow故意放行的假案例，enforce没有新增错误笔记。真实付费质量评测L01仍未执行，本轮结果不能证明真实模型质量收益。

期间用户先尝试了常规部署入口 `restart.bat`，出现R01。助手已定位原因；这不是手工实验室§4的启动方式，不把部署启动失败等同于研究能力失败。当前按§3–4准备独立测试环境。

| 编号 | 测试内容 / 指南位置 | 本轮实际结果 | 判定 |
| --- | --- | --- | --- |
| M01 | Node/npm/Go/Docker 与源码版本（§1.1） | 用户反馈Node22.22.3、npm10.9.8、Go1.25.7 windows/amd64、Docker28.5.2/Linux、提交3012325 | 通过 |
| R01 | 用户尝试常规 `restart.bat` 部署启动 | 报“Compose不再发布8080”；助手确认实际为外置env_file缺失，启动器吞掉配置错误 | 已定位；常规部署尚未恢复 |
| M02 | 无付费合同与离线夹具（§2） | 72项回归、离线30案例、e2e纯合同5项均通过，退出码均0 | 通过 |
| M03 | 独立测试 PostgreSQL（§3） | 验证容器运行中、标签agent-opencode、127.0.0.1:53085映射5432、pg_isready退出0 | 通过 |
| M04 | 四终端手工实验室与界面（§4） | B/C/D启动、页面入口、有效Skill摘要及假模型初始计数0均获用户确认 | 通过 |
| M05 | 正常发布、审核阻断、刷新（§5.1–5.3） | 用户已测正常发布、阻断及终态刷新；助手补测运行中刷新，同一job恢复、无重复请求 | 通过 |
| M06 | 排队与运行取消、账本核对（§5.4–5.7） | 用户排队取消及恢复检查通过；助手复测运行取消及全量账本通过：无重复note，阻断/取消未发布，未知用量及费用保留 | 通过 |
| M07 | 策略、期限、预算、Skill、证据和PG（§5.6、§6） | 助手实测三种策略及旧策略冻结；Go18项及12子案例、数据库10项全部通过；配合M02的72项合同回归覆盖其余边界 | 通过 |
| M08 | Eino dev/built 与原生OpenCode/隔离（§7–8） | 助手执行四组CUA界面全链路均通过；固定1.3.13协议探针11项、Linux隔离和ModelProxy隔离各1/1通过；假A/B适配器3次调用、付费0、清理完成 | 通过（本机假模型验收） |
| M09 | 实验清理、证据归档（§10） | 助手归档并逐文件验包、补齐grant nonce脱敏；停止三个测试进程、释放三端口、仅删除指定schema；共享PG、其他schema及40个容器保持不变 | 完成 |
| L01 | 有预算真实A/B/C与人工盲评（§9） | 尚未进入；未确定真实调用预算 | 未验证 |

记录规则：每次反馈补充时间、用户看到的输出/界面、退出码或job/run ID及判定；若助手另外执行核对，会明确标注“助手核查”。只保留版本、测试标识与必要错误，不记录供应商key、服务token或完整含密码DSN。遇到失败先记录原始现象与修复，再保留复测结果，不覆盖失败历史。

#### M01 操作记录

2026-10-07 14:41：开始环境检查。预期Node为22系列、本机Go至少1.24.1；Docker Server可用且Linux模式，隔离测试需Docker28+。实际版本、Git提交及依赖目录状态待用户反馈；当前未判定通过。

2026-10-07 14:46：用户贴回实际PowerShell输出：Node `v22.22.3`、npm `10.9.8`、Go `go1.25.7 windows/amd64`、Docker `28.5.2`、容器模式 `linux`；HEAD为 `3012325`，分支 `codex/agent-capability-opencode`。版本与源码检查通过。依赖目录未单独检查，下一步用研究回归命令验证依赖及合同。

#### M02 操作记录

2026-10-07 14:46：指引用户在当前仓库PowerShell执行 `npm run test:research`，随后输出 `$LASTEXITCODE`。预期两组共72项（31+41）通过，失败/跳过为0、退出码0；当前等待实际结果。本步骤不发送真实供应商模型请求。离线30案例评测与 `e2e --check` 暂未执行。

2026-10-07 14:52：收到用户附件 `c2c68fbe-bb2d-4d0b-b4a9-0e677e08fa5d/已粘贴的文本.txt`。核对实际 `test:research` 输出：第一组tests/pass为31/31，fail/cancelled/skipped均0，耗时1.610秒；第二组41/41，fail/cancelled/skipped均0，耗时28.557秒；用户紧接命令查询退出码为0。合计72项通过。用户已实测本阶段合同/假端点回归，不据此宣称真实模型质量或真实Docker隔离通过。下一项为离线30案例评测，仍无真实供应商调用。

2026-10-07 14:54：收到用户附件 `dead13b9-a8ff-4a52-b41b-262176afd5aa/已粘贴的文本.txt`，核对 `npm run agent:quality -- --offline`：30案例（18缺陷、12合理），true_positives=18、true_negatives=12，false_negatives/false_positives/invalid_reports/unsafe_acceptances均0，六类各5案例；`fixture_mismatches=[]`，`model_calls=0`，`model_quality_evaluated=false`，退出码0。固定夹具合同与计分检查通过；召回1、误阻断0仅描述这些预编写夹具。下一步执行 `e2e.mjs --check`，尚未启动实际浏览器或运行时。

2026-10-07 14:57：用户反馈 `node validation/agent/opencode/e2e.mjs --check` 输出 `ok:true`、`checks:5`、`browser:"not_run"`、`runtime:"not_run"`、`model:"local authored fixtures only"`，退出码0。纯夹具合同检查通过，M02三项完成；没有把这次检查当成实际浏览器/运行时验证。

#### M03 操作记录

2026-10-07 14:57：指引用户只读检查 `.repo/opencode-validation-pg.json` 及其测试容器，输出容器名、验证标签、运行状态和5432回环映射，再执行 `pg_isready`。不输出描述文件密码、不创建或重启容器。实际状态待反馈。

2026-10-07 15:02：用户反馈描述文件存在；容器 `loom-opencode-validation-20261007-audit` 的 `Running=true`，验证标签为 `agent-opencode`，5432/tcp仅映射 `127.0.0.1:53085`。容器内 `pg_isready -U postgres -d review` 返回 `accepting connections`，退出码0。M03通过。本结果证明测试容器身份、端口及数据库就绪；本轮新schema、宿主连接和迁移尚待M04验证。

#### M04 操作记录

2026-10-07 15:02：指引用户保留当前PowerShell作为终端A，先检查18880（应用）、18891（Go服务）、18900（假模型）是否空闲；全部空闲后在仓库 `.repo/agent-manual-<随机GUID>` 创建本轮目录，并设置当前进程的 `AGENT_MANUAL_DIR`。等待实际端口与目录输出；尚未创建schema或启动服务。

2026-10-07 15:06：用户反馈18880、18891、18900全部空闲；已创建 `F:\AI_WeaveSence_Things\WeaveSense\.repo\agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0`，并在终端A设置 `AGENT_MANUAL_DIR`。再次执行 `pg_isready` 仍为accepting connections、退出码0。本轮端口/目录准备通过；接下来执行§4.1剩余Node配置片段，创建新schema、迁移、导入Battery材料并生成session/model配置，实际结果待反馈。指南的终端A/B管道显式使用UTF-8，避免Windows PowerShell默认编码损坏中文测试材料。

2026-10-07 15:09：收到用户附件 `f6d364f5-7695-4700-ba2e-0f0d5283df3b/已粘贴的文本.txt`。§4.1实际输出确认0002–0025共24项迁移全部应用，独立schema为 `oc_manual_92db30a64afa49f08f281f66b75a8798`，实验目录仍为 `F:\AI_WeaveSence_Things\WeaveSense\.repo\agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0`，退出码0。脚本在迁移、Battery材料导入、session/model配置写入后才输出成功信息，因此本轮配置准备通过；B/C/D服务与界面尚未验证。下一步指引用户新开终端B启动§4.2仅回环地址的假模型，等待启动输出。

2026-10-07 15:11：收到用户附件 `a7235ed7-b8f9-4d3e-b284-47e0b522deab/已粘贴的文本.txt`，末尾确认§4.2输出“假模型已启动；仅本机；付费调用0”，没有返回PowerShell提示符，符合长期运行服务预期。将该运行窗口作为终端B并保持打开；目前只确认监听启动，尚未发出Producer/Reviewer测试请求。下一步指引新开终端C读取本轮session配置、构建并启动Go服务；应用D尚未启动，暂时领取连接失败可待D启动后再核对。

2026-10-07 15:15：用户反馈终端C的Go构建完成，紧随其后的退出码检查未抛异常；`agent.exe` 在15:15:07输出 `agent listening on 127.0.0.1:18891`。随后每两秒领取 `http://127.0.0.1:18880/api/internal/agent-jobs` 遇到连接拒绝，至15:15:23仍有日志。应用D尚未启动，符合§4.3预期，暂不判为功能失败；D启动后需确认恢复。下一步指引新开终端D加载本轮session、检查 `/readyz` 的64位十六进制Skill摘要并启动18880应用；就绪与实际页面尚未验证。

2026-10-07 15:18：用户贴回终端D的Vite输出，15:17:21就绪，耗时14728ms，实际Local地址为 `http://127.0.0.1:18880/`；15:17:23 SSR连接、15:17:35依赖优化完成。npm脚本的默认8080与追加18880参数同时显示，实际监听地址已确认采用18880，此输出没有端口冲突。用户本次未贴readyz/Skill摘要或页面结果，不能据此判定M04完整通过。下一步保持B/C/D运行，在空闲终端读取readyz摘要和假模型计数，浏览器检查知识库、“向矩阵提问”和“深入研究”入口，并反馈C是否还持续出现连接拒绝；暂不提交研究任务。

2026-10-07 15:20：用户确认浏览器知识库可见“向矩阵提问”和“深入研究”；空闲PowerShell的 `/readyz` 返回有效摘要 `e45cee48b81f4eafbf49b478d2b52a3eb7663ee8425c9bcf3ef5f0d2b13e1105`，64位格式检查未报错。`/counts` 返回producer=0、reviewer=0、paid_calls=0。M04启动与页面准备通过。用户未单独反馈C连接拒绝是否停止；不据此宣称Worker已成功领取任务，下一步用一次实际测试任务验证。

#### M05 操作记录

2026-10-07 15:20：指引用户在知识库输入 `Battery 发布`，选择深入研究后提交一次，等待终态；预期显示已发布、材料量产良率97%的结论、五项审核通过和一条本次发布笔记。要求反馈任务URL/job ID、结果/审核页面及随后 `/counts`，暂不重复提交。实际研究、审核及发布尚待反馈；固定假模型流程不能代表真实模型质量提升。

2026-10-07 15:22：用户反馈两张浏览器截图（`codex-clipboard-38fc2763-4f12-4759-bdd9-782e27229eb1.png`、`codex-clipboard-5a67ea5c-b469-4edf-931b-f3eaa8c3b31d.png`）和假模型计数。第一张显示输入 `Battery 发布`、选择深入研究；第二张任务地址为 `http://127.0.0.1:18880/knowledge?job=73b05b61-0463-4b9b-a9d6-eb578119125f`，显示“正在审核”“研究草稿（尚未发布）”，内容为“Battery 材料记载量产良率为97%。”，引用测试证据97%；截图中的简报与笔记尚为空。计数producer=1、reviewer=1、paid_calls=0，确认本任务被领取、Producer与Reviewer均已收到请求。此时仅是中间状态，尚未看到最终审核报告或发布笔记，不能判定发布通过或失败。指引用户继续查看同一任务，若仍在审核则再等待约15秒，反馈终态截图；超过一分钟仍无变化时提供C最新日志，不重复提交任务。

2026-10-07 15:23：用户反馈终态截图 `codex-clipboard-2a595b30-7312-4311-b5e1-02aa780c02c1.png`，任务地址仍为 `http://127.0.0.1:18880/knowledge?job=73b05b61-0463-4b9b-a9d6-eb578119125f`。页面显示“已发布”“已发布回答”，结论为Battery材料记载量产良率97%，引用Battery证据97%；审核记录的引用支撑、范围与覆盖、材料冲突、信源独立性、不确定性五项均通过。“简报与笔记”新增标题 `Battery 发布` 的问答笔记，正文和引用与该任务一致。§5.1正常研究、独立审核与界面发布通过；此前计数为producer=1、reviewer=1、paid_calls=0，终态后尚未再次读取。未因截图中输入框清空推断用户已按指南进行刷新测试，也不据此宣称数据库唯一性已核对。

2026-10-07 15:23：下一步指引用户输入 `Battery 审核阻断`，重新选择深入研究后仅提交一次，观察终态“未发布”、100%错误草稿及引用支撑未通过的发现。原 `Battery 发布` 笔记应保留，本次阻断任务不应新增发布笔记；要求反馈新job地址、终态/审核截图和 `/counts`。实际阻断结果待反馈。

2026-10-07 15:25：用户反馈三张截图（`codex-clipboard-269d1a03-3180-4f86-99cd-b03e9e0f50bc.png`、`codex-clipboard-d59fdcf6-e4cf-496c-98c8-6eb020b2457e.png`、`codex-clipboard-e476cd65-1e52-43f7-b563-148da470afb0.png`）。第一张在旧job下输入 `Battery 审核阻断` 并选深入研究；第二张进入新job `9c79d693-5fb5-4d86-aecf-c13b7679ceb3`，状态正在研究；第三张同一新job最终“未发布”，保留“本材料证明所有产线良率均为100%。”的草稿及97%引用。引用支撑未通过，其他四项通过；阻断发现明确“材料只记载97%，不支持所有产线达到100%”，建议限制结论到材料中的数值与范围。截图中简报与笔记仍只有原 `Battery 发布` 的97%笔记，未出现本次阻断任务的发布笔记。§5.2界面阻断通过；本次未附新的计数输出，数据库按run的无note核对仍留待§5.7，不推断累计计数。

2026-10-07 15:25：指引下一项§5.3：先在空闲PowerShell读取并保存 `/counts` 基线；浏览器再次深入研究提交一次 `Battery 发布`，记录新的job URL，在任务运行中按F5，确认job不变；终态后再按F5，确认同一任务的回答、审核和笔记恢复。最后在同一个PowerShell读取计数并比较增量，预期Producer/Reviewer各仅增加1、paid_calls仍0，且本次只新增一条笔记（加上最初的笔记共两条）。实际刷新与增量结果待反馈。

2026-10-07 15:27：用户反馈刷新前 `/counts` 基线producer=2、reviewer=2、paid_calls=0，及三张截图（`codex-clipboard-ba7ee0d5-2593-4eed-ac8e-6f9b07ee35f7.png`、`codex-clipboard-5e172008-cd1a-4766-81f7-fcc4318377f8.png`、`codex-clipboard-1ca629a4-656e-4a1f-815e-2007d4835c76.png`）。新发布任务为 `834296ee-9781-45b2-aa08-ac00629d9866`，中间截图显示正在研究，最终同一job显示已发布、97%结论、五项审核通过；简报与笔记可见两条 `Battery 发布`。用户尚未说明是否在运行中/终态按F5，且未贴最终计数；截图不能单独证明刷新操作或无重复调用，因此§5.3仍待验证。指引用户在现有任务页面按F5核对恢复，然后在原基线PowerShell读取最终计数及增量，同时说明运行中是否已刷新；不要求再次提交任务。

2026-10-07 15:30：用户明确反馈刷新后地址仍为 `http://127.0.0.1:18880/knowledge?job=834296ee-9781-45b2-aa08-ac00629d9866`，并提供截图 `codex-clipboard-f9adf773-7856-41a0-9746-5af12f9e6509.png`：同一任务的已发布97%回答、五项审核通过与两条发布笔记均恢复。计数基线2/2/0、最终3/3/0，producer_delta=1、reviewer_delta=1、paid_calls=0，符合一次新任务及刷新不重复模型调用的预期。§5.3终态刷新通过。用户仍未明确说明运行中是否按过F5，因此该子项不写成已通过，安排与后续60秒延迟的运行取消任务一起补测，无需现在重复提交发布任务。

#### M06 操作记录

2026-10-07 15:30：指引§5.4排队取消：只在本轮C按Ctrl+C并确认返回PowerShell提示符，B/D保持运行；浏览器深入研究提交一次 `Battery 排队取消`，截图记录已排队后点击取消研究，预期“已取消排队任务”、发布笔记仍两条。随后读取 `/counts`，预期保持3/3/0；反馈任务地址、取消前后截图及计数后再恢复C并检查取消任务不会被领取/发布。实际暂停、取消与计数尚待反馈。

2026-10-07 15:33：用户反馈PowerShell窗口较多，无法辨认终端C。尚未确认测试Worker已停止，不能继续把提交任务当作排队取消实验。提供§5.4替代方法：在空闲窗口只定位18891监听进程，核对其可执行路径等于本轮目录中的 `agent.exe` 后停止该PID，并确认端口释放；不停止B/D、不按进程名批量结束。当前本轮任务均已终态，没有在途研究任务。停止操作及后续排队取消结果待用户反馈。

2026-10-07 15:37：用户贴回按端口定位的实际PowerShell操作。18891监听唯一，进程完整路径核对未抛异常；本轮Worker PID为44828，`Stop-Process` 已执行，随后等待退出和端口释放检查均未报告错误。用户粘贴末尾包含成功提示的命令，但未包含该提示的打印行；以上判定依据路径核验、停止及端口检查的实际执行输出。停止准备通过，接下来指引浏览器深入研究提交一次 `Battery 排队取消`，记录已排队后取消，保持Worker停止并读取计数，预期仍3/3/0。本轮取消任务与恢复Worker后的不重跑结果尚未验证。

2026-10-07 15:40：用户反馈三张截图（`codex-clipboard-20c39014-c303-4e95-ab0a-1f12246fb2a8.png`、`codex-clipboard-32103442-5849-4fb8-8900-fdac41a79fca.png`、`codex-clipboard-d34f020e-24cd-4f62-affe-af88196a264b.png`）及 `/counts`。本次排队取消job为 `3be425fc-9b3a-4413-8aeb-e145e99be531`，中间截图显示已排队，最终同一job显示“已取消排队任务”、提示“排队任务已取消”；两条原 `Battery 发布` 笔记仍在，未出现取消任务的笔记。计数producer=3、reviewer=3、paid_calls=0，与取消前相同，排队取消未触发模型请求。该子项通过；Worker尚未恢复，因此不把恢复后无重跑写成已验证。

2026-10-07 15:40：指引用户新开或使用空闲PowerShell作为C，并设置窗口标题为“C - 测试Worker 18891”；加载本轮session，直接运行已构建的agent.exe，不重复构建。监听成功后等待约10秒，在原取消任务页面F5，确认同一job仍已取消、笔记仍两条；在另一个空闲窗口读取模型计数，预期仍3/3/0。恢复检查实际结果待反馈，暂不提交新任务。

2026-10-07 15:43：用户反馈恢复Worker的实际命令与15:41:39日志 `agent listening on 127.0.0.1:18891`；随后计数仍producer=3、reviewer=3、paid_calls=0。截图 `codex-clipboard-bb7c9484-8f9d-4eb5-bfd7-f99bc5aceddc.png` 的job仍为 `3be425fc-9b3a-4413-8aeb-e145e99be531`，显示已取消排队任务，两条原发布笔记保留。§5.4排队取消及Worker恢复后无重跑通过；数据库账本仍留待§5.7核对。

2026-10-07 15:43：指引下一项§5.5联合补测运行中刷新：B/C/D保持运行，准备好空闲PowerShell计数命令后，浏览器深入研究提交一次 `Battery 运行取消`；确认Producer计数由3增至4、Reviewer仍3后，立即F5确认同一job恢复正在研究，再尽快取消。假模型延迟60秒但服务模型请求超时30秒，故提交后前几步应连续操作，尽量在20秒内取消，不在中间等助手回复；随后等待终态并反馈job、刷新是否保持同一任务、取消提示/终态、计数及两条笔记仍在。预期无本次发布，最终可能为“结果待核实”，已发送请求的未知费用不能伪记为免费；实际取消与刷新尚待验证。

2026-10-07 16:04（助手执行，用户明确授权）：用户将§5.5运行中取消与刷新交给助手。接手时只读计数为producer=4、reviewer=4、paid_calls=0，页面已有三条笔记：两条 `Battery 发布` 和一条 `Battery 运行取`。这与上一轮用户反馈的3/3/0、两条笔记不同，因此改用本次实际接手基线，不把已存在的第三条笔记归因于取消测试。

第一次助手尝试保留为未完成取消的记录：15:59:16创建job `aa9b923d-f1ce-4b65-83a6-dcc507a4708e`、run `3451f589-fb00-4ef7-b7fe-96abd363941c`。完成模型发送确认后，操作间隔达到约30秒，15:59:47已超时，未能点击取消。数据库终态 `outcome_unknown`、error_code=`model_outcome_unknown`，该run无note；Producer回执unknown，用量null，预算unknown、actual_rmb=null。这验证超时未发布，但不能写成取消通过。助手据此重试同一假模型案例，不改服务超时或生产配置。

复测运行取消通过：16:01:42创建job `f6d71abb-7182-404c-b0fa-53d988cbccaf`、run `979d4d81-54a6-45e9-b9ee-df91aa5c0629`。等待界面正在研究后刷新；刷新前后URL均为 `http://127.0.0.1:18880/knowledge?job=f6d71abb-7182-404c-b0fa-53d988cbccaf`，刷新后重新显示正在研究和取消按钮。约15.6秒时通过按钮发出取消，界面显示“正在请求取消”“取消请求已提交，正在等待执行器确认停止”，随后收敛为“结果待核实”。运行中刷新子项补测通过。浏览器访问假模型计数页面被客户端阻止，未绕过浏览器限制，改用已授权的本机只读命令核对计数和数据库。

16:03:59助手只读数据库核查：复测job在16:01:58终态为 `outcome_unknown`，job/run error_code均为 `cancelled`；该run只有一条Producer回执，state=started、input/output_tokens=null，没有Reviewer调用，也没有发布note。预算保留status=unknown、reserved_rmb=`0.036952160000000005`、actual_rmb=null；这是冻结假价格下的预留算术，不是真实供应商费用。全局note数仍为接手时的3，计数最终producer=6、reviewer=4、paid_calls=0，两次助手尝试各增加一次Producer，刷新未重复发出请求。运行中取消、该run无发布及未知费用保留通过；未清零预算、补造用量或改写数据库。本轮其他任务的全量账本/重复note核对仍待§5.7。

助手执行证据已落盘：[运行中刷新与取消UI记录](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/running-cancel-ui.json)、[只读任务/调用/预算核查](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/running-cancel-ledger.json)、[最终页面截图](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/running-cancel-final.png)。助手打开的结果页保留供查看，B/C/D服务保持运行；本次只进行了假模型测试，真实模型质量没有验证。

2026-10-07 16:08（助手执行）：按§5.7对本轮schema执行只读、可重复读事务，全量核对7个job、10条模型回执及3条发布笔记。三个成功任务各一份候选、匹配候选/材料/策略摘要的completed审核和一条note；审核阻断任务completed审核但note=0。排队取消任务run为空、无模型回执及note；超时尝试和运行取消各只有一条Producer回执、无候选/审核/note。重复note查询为空。八条completed回执均为假用量100输入/20输出；两条不完整回执用量保持null。四个预算settled、实际金额各0.0000028（仅假单价算术）；排队取消预算released、actual=0；两个unknown预算actual=null且保留正数预留。全量账本核对通过，M06完成。

证据：[全量只读账本](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/full-ledger.json)、[账本断言结果](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/full-ledger-verdict.json)。没有改写数据库状态、补造用量或释放未知预留。

#### M07 操作记录

2026-10-07 16:08–16:11（助手执行）：运行§6的 `go -C workers/agent test ./internal/agent -run 'Deadline|Skill' -count=1 -v`，18项顶层测试及12个子案例全部PASS，退出码0，测试耗时2.279秒；不是“no tests to run”。覆盖必需Skill/摘要在Producer前校验、冻结Skill不随源文件变化、资源与路径/大小限制、期限不延长、期限到期前停止重试等边界。预算、证据、重复请求等其余合同边界沿用本轮M02用户已执行的72项回归，未把Go名称过滤结果夸大为Go全套通过。[Go定向测试日志](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/deadline-skill-tests.log)。

数据库首次 `npm run agent:research:pg` 在受限执行环境因子进程 `spawn EPERM` 失败，尚未实际运行测试；保留[首次失败日志](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/research-pg-tests-sandbox-failed.log)。相同命令经工具批准在可启动子进程的环境复跑，10/10通过，fail/cancelled/skipped均0、退出码0、耗时15.485秒：8项真实PG故障/并发与2项迁移（其中1项PGlite实际应用迁移、1项真实PG部署迁移）。覆盖候选不可变、并发审核单次发送、发布ACK丢失不重复note、来源变更与claim/取消拒绝、发布事务回滚、每日准入单次预留及迁移冲突回滚/重跑保持旧数据。脚本只操作其自建测试schema，共享PG及手工实验schema保留。[数据库复测日志](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/research-pg-tests.log)。

2026-10-07 16:16–16:27（助手执行）：按§5.6只重启18880实验应用并设置其进程环境；每次按端口核对唯一监听及仓库Vite命令后才停止应用，B假模型和C Worker保持运行。配置读取原session并确认test模式、假模型回环地址及Skill摘要；session.json仍保留enforce，未改生产配置或真实供应商key。每种模式均只提交一次 `Battery 审核阻断`：

| 新任务策略 | job / run | 界面和数据库结果 | 累计Producer/Reviewer/付费调用 |
| --- | --- | --- | --- |
| off | `626e77f6-6e4f-491d-a546-783849bc5afa` / `89dbcba1-2875-4c3e-8232-714c7a9ef5ba` | 显示“本任务未启用独立审核”，100%错误草稿发布；Producer=1、Reviewer=0，审核占位pending但无报告，note=1 | 7/4/0 |
| shadow | `576cdfd9-e59f-4b29-9f1a-305cd57bb015` / `df6231a2-a2af-4e6f-9a3e-638e4afdae4f` | 显示“审核仅用于观察，不作为发布依据”，引用支撑未通过及阻断发现保留，但100%草稿仍发布；匹配completed审核、note=1 | 8/5/0 |
| enforce（恢复） | `c5588043-d0eb-47f1-9974-7022dea2b130` / `2c24a236-ddee-486f-aeab-e94dd5ef2cf8` | 未发布，100%草稿保留、引用支撑未通过；job为failed/review_blocked，匹配completed审核、note=0 | 9/6/0 |

在全局off和shadow期间回看旧enforce阻断job `9c79d693-5fb5-4d86-aecf-c13b7679ceb3`，仍“未发布”，不会因环境切换变成放行；恢复enforce后回看旧shadow任务，仍显示其冻结的观察提示。16:26:42只读数据库断言确认原7个任务的run/status/note数不变，已运行任务的request_policy仍enforce；新三任务request_policy与candidate_policy分别为off/shadow/enforce。合计10个job、15条回执、5条note、重复note=0；完整回执假用量100/20，不完整回执仍null，两个unknown预算仍actual=null且保留预留。策略冻结与三种模式通过。

最终18880应用已恢复enforce并正常呈现阻断结果，18891的Skill摘要仍为 `e45cee48b81f4eafbf49b478d2b52a3eb7663ee8425c9bcf3ef5f0d2b13e1105`，18900计数9/6/0。原D的应用进程已由助手启动的enforce进程替代，日志在本轮evidence目录；B/C继续运行。五条笔记中的两条100%错误笔记属于off/shadow故意放行的测试，不能当作当前enforce绕过或真实材料结论。未调用付费供应商，未评估真实模型质量，未执行§7–8的dev/built/原生OpenCode/隔离验收。

策略证据：[off界面](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/policy-off-ui.json)、[shadow界面](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/policy-shadow-ui.json)、[enforce界面](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/policy-enforce-ui.json)、[最终截图](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/policy-enforce.png)、[策略账本](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/policy-ledger.json)、[可复跑只读断言](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/check-policy-ledger.mjs)、[策略断言结果](../../.repo/agent-manual-33ba2b9af6a24a2e8a2da931deecf7b0/evidence/policy-ledger-verdict.json)。证据位于本机忽略目录，M09清理schema前需保留归档；归档不得包含session/model配置中的秘密。

#### M08 操作记录

2026-10-07（助手执行，接续M07）：按用户授权执行§7–8。继续使用独立测试PG；每次全链路新建一个`oc_browser_<UUID>` schema，构建命令的迁移DSN只指向该schema。假模型和应用选临时回环端口；原18880/18891/18900手工实验室保持运行。真实供应商未参与，付费调用0。

**界面执行方式与证据边界。** 本轮实际浏览器操作通过Codex Computer Use（CUA）完成。助手在忽略目录生成[适配准备脚本](../../.repo/m08-cua/prepare-harness.mjs)及[本轮适配后的harness](../../.repo/m08-cua/harness.mjs)，复用`e2e.mjs`中的真实服务、PG、Go/OpenCode、模型/工具账本、准入与清理断言；把外部Playwright浏览器驱动替换成文件RPC，由CUA操作真实页面。没有运行§7/8.3原命令的外部Playwright驱动或`browser-smoke.mjs`，不能把本轮记录称为那些脚本的原样输出。CUA的桌面/手机检查保存可见文本、标题、横向溢出、控制台错误与截图；built/dev比较的是标题序列、发布内容可见性及溢出状态，不是逐字正文、像素差异或完整全站审计。所有截图为实际视口截图，已逐对目视检查文字/布局。

| 全链路 | 最终verdict / schema标识 | 正常发布账本 | 结果 |
| --- | --- | --- | --- |
| Eino dev | [f694fcd7-2589-4225-965f-2624f34be5c3](../../.repo/opencode-e2e-f694fcd7-2589-4225-965f-2624f34be5c3/verdict.json) | Producer1+Reviewer1；候选1、note1；settled实际0.0000028 | 退出0，`ok:true`、`browser:passed` |
| Eino built | [80c01231-d7f2-4cc8-8f89-ce30bfdfc1ed](../../.repo/opencode-e2e-80c01231-d7f2-4cc8-8f89-ce30bfdfc1ed/verdict.json) | 同上 | 独立schema完整build通过；退出0，语义基线不偏离 |
| 原生OpenCode dev | [f3c03510-d5ce-4368-9dc0-bf1706094258](../../.repo/opencode-e2e-f3c03510-d5ce-4368-9dc0-bf1706094258/verdict.json) | Producer3+Reviewer1、语料工具2；候选1、note1；settled实际0.0000056 | 退出0，原生1.3.13绑定断言通过 |
| 原生OpenCode built | [9d52302e-5eef-45a2-80f1-d98f196875b1](../../.repo/opencode-e2e-9d52302e-5eef-45a2-80f1-d98f196875b1/verdict.json) | 同上 | 独立schema完整build通过；退出0，语义基线不偏离 |

金额和用量仅为假单价/假回执的算术核对：每条completed回执100输入/20输出，不代表真实供应商账单。schema名称使用上述UUID去掉连字符并加`oc_browser_`前缀。

四组均实测正常发布、保留阻断草稿/发现且不发布、排队取消不调用模型、运行取消后撤销权限且不新增note，以及刷新恢复当前job。正常/阻断/运行取消三种场景合计：每组Eino收到5次假模型请求、每组OpenCode收到9次；这个合计包含取消中的未完成Producer，不应全计为已结算正常发布。取消后的`403 run_not_active`是预期权限拒绝，单独保留在`protocolFailures`，不算浏览器错误。四组CUA控制台错误数组均空、desktop/mobile均无横向溢出；两组built的`divergesFromBaseline:false`。

截图与操作记录：

- Eino dev：[桌面](../../screenshots/opencode-dev-cua-desktop.png)、[手机](../../screenshots/opencode-dev-cua-mobile.png)、[逐步CUA动作](../../.repo/m08-cua/eino-dev-r3/ui-actions.json)。
- Eino built：[桌面](../../screenshots/opencode-built-cua-desktop.png)、[手机](../../screenshots/opencode-built-cua-mobile.png)、[逐步CUA动作](../../.repo/m08-cua/eino-built-r2/ui-actions.json)。
- 原生OpenCode dev：[桌面](../../screenshots/opencode-native-dev-cua-desktop.png)、[手机](../../screenshots/opencode-native-dev-cua-mobile.png)、[逐步CUA动作](../../.repo/m08-cua/native-dev/ui-actions.json)。
- 原生OpenCode built：[桌面](../../screenshots/opencode-native-built-cua-desktop.png)、[手机](../../screenshots/opencode-native-built-cua-mobile.png)、[逐步CUA动作](../../.repo/m08-cua/native-built/ui-actions.json)。

**协议、网络与ModelProxy。** Windows固定OpenCode1.3.13离线探针11项通过，8次假模型请求、2次MCP工具调用，二进制SHA匹配固定记录。Linux真实隔离测试1/1、跳过0；生产/probe二进制与wrapper一致，生产镜像无probe夹具；批准bridge可达，公共IPv4/IPv6、宿主别名/数字IP、metadata旁路被阻止，禁止文件路由、旧epoch、跨任务历史被拒绝，进程树停止确认。最终ModelProxy隔离复跑1/1、退出0：模型3次、工具2次，各请求`max_tokens=1800`，usage/准入摘要匹配；直接供应商与公共网络旁路不可达。原生dev/built还分别确认批准bridge可达、vendor/app/public旁路不可达，runtime没有宿主bind/发布端口/供应商key。

更新的协议/隔离证据位于`validation/agent/opencode/`；[完整执行摘要与失败历史](../../.repo/m08-runtime-1dc19f373e1442a9b927d96405ad7197/summary.json)、[最终镜像一致性核对](../../.repo/m08-runtime-1dc19f373e1442a9b927d96405ad7197/final-consistency.json)及该目录日志保留。最终本地image ID为runtime `969fc1f4…`、probe `ffbd20aa…`、bridge `e5d21985…`（完整SHA在证据内）；bridge测试内部重建使历史ID变化，不能把复测前`f78fa43d…`当成最终ID。固定标签复跑前后的runtime ID一致。这些是本地Docker image ID，不是已发布registry manifest digest，部署主机仍须重新做隔离测试。

**首次失败、根因与复测。** ModelProxy原测试及原样重跑均因`actual body lacks admitted digest`失败；后续EAI_AGAIN出现在假端点断言崩溃后，不能只归因DNS。诊断确认假HTTP端点逐块把Buffer转字符串，中文UTF-8跨块时被替换字符破坏，收到的JSON摘要与准入摘要不一致；Go/JS对同一文本计算一致。采用Node原生`req.setEncoding('utf8')`流式解码，每个读端仅补一行，保留全部摘要、token上限和权限断言。修复7个相同模式的假HTTP读端：`scripts/agent-integration-harness.mjs`、`scripts/material-generation-ui.mjs`、`scripts/opencode-contract-probe.mjs`、`validation/agent/opencode/e2e.mjs`、`isolation.fixture.mjs`、`live-adapter-smoke.mjs`、`model-proxy-isolation.test.mjs`；无新依赖、无业务策略/生产服务变更。修复后原ModelProxy测试及最终镜像一致性复跑通过，协议/Linux隔离与原生UI链路也复测通过。诊断时一次ECR基础镜像TLS超时保留在日志，同命令重跑通过。

Eino dev前两次[37665ada…](../../.repo/opencode-e2e-37665ada-1dca-4736-8304-edda0b74e0aa/verdict.json)、[c781f229…](../../.repo/opencode-e2e-c781f229-63bf-4216-ac70-d79efae3b00e/verdict.json)在初次水合阶段使用过时AX控件状态失败，模型请求均0；改为依据DOM等待实际可操作的控件后复测通过。Eino built首次[61e01a10…](../../.repo/opencode-e2e-61e01a10-9862-480f-b693-b04f22be63ec/verdict.json)在排队取消刷新后开始下一场景时命中控件短暂禁用；CUA驱动补自动enabled等待后完整复跑通过。这些属于驱动时序修正，不据此修改业务启用条件；失败证据保留。

**假A/B评测适配器（§8.4）。** 执行原命令`npm run agent:quality:smoke`，使用当前源码的独立schema构建产物，实际创建独立PG/app/Eino容器。[verdict](../../.repo/live-adapter-smoke-c11b6284-b34d-4b49-929b-81b517a41c63/verdict.json)和[命令日志](../../.repo/m08-cua/quality-smoke.log)：退出0，`passed:true`、`cleaned:true`、`fake_calls:3`、`paid_calls:0`，A/B任务均成功、可信账本/冻结条件核对通过，`model_quality_evaluated:false`。一题假A/B不证明质量收益，也没有执行真实C质量实验。

**最终验证与保留状态。** 类型检查退出0；lint退出0、0错误/14条现有警告；研究回归31+41=72项全部通过；7个修改脚本`node --check`、e2e纯合同5项和`git diff --check`通过。[类型检查日志](../../.repo/m08-cua/typecheck.log)、[lint日志](../../.repo/m08-cua/lint.log)、[研究回归日志](../../.repo/m08-cua/research-tests.log)。[可复跑只读核查](../../.repo/m08-cua/final-check.mjs)及[最终汇总](../../.repo/m08-cua/final-verdict.json)确认本轮7次UI尝试的schema均已删除，原生测试容器/网络无残留，假A/B容器/网络已清理；原手工实验室10job/15回执/5note、两个unknown预留和9/6/0计数不变，Skill摘要不变。浏览器默认视口已恢复，原enforce阻断job刷新后仍未发布。没有运行真实付费评测、修改默认采用开关或恢复R01常规部署。未提交Git；源文件和证据差异保留供审阅。M09完整归档与原手工实验室清理尚未执行，清理前需先归档本轮证据且排除session/model秘密。

#### M09 操作记录

2026-10-07 17:34–17:37（助手执行）：按用户明确指示开始归档与清理。先在可重复读、只读事务中导出本轮23张表的脱敏JSON快照，并导出该schema的DDL；确认10个job均为终态，包含`succeeded`、`failed`及`outcome_unknown`，没有新建或重发任务。保留10job、15模型回执、5note及两条unknown预算；两者`actual_rmb=null`、`reserved_rmb=0.036952160000000005`，没有编造免费用量或将预留标记为released。保留M01–M08的成功、失败/诊断/复测日志、用户反馈附件/截图、CUA动作、协议/镜像/隔离证据、源码差异和版本信息。

归档位置：[完整ZIP](../../artifacts/test-archives/agent-capabilities-20261007/agent-capabilities-20261007.zip)、[文件清单/SHA-256](../../artifacts/test-archives/agent-capabilities-20261007/payload/manifest.json)、[归档说明](../../artifacts/test-archives/agent-capabilities-20261007/payload/README.md)、[数据库脱敏快照](../../artifacts/test-archives/agent-capabilities-20261007/payload/database/snapshot.redacted.json)、[schema DDL](../../artifacts/test-archives/agent-capabilities-20261007/payload/database/schema.sql)。这是本机审计归档，尚未复制到异地；不是含完整授权凭据的自动恢复包。归档保留了原工作区路径，审阅时可在解压后的`workspace/`中寻找对应文件。

初始267个内容文件约15.8MB，压缩后重新解压，所有文件SHA-256/大小均匹配；所引用用户截图全部找到。排除10份session/model.local/database.local配置、可执行文件和构建bundle；JSON授权token、API key、密码、完整DSN及日志Bearer值脱敏。独立只读核查91个JSON、109个内嵌JSON、344217个字段后发现6个审核`grant_nonce`漏项：nonce本身不是完整bearer凭据，仍应按归档说明隐藏。此时初始ZIP/完整表快照已验证并保留，schema清理已完成；助手从保留快照补齐grant/nonce脱敏，保留这一发现与修复记录，重新生成manifest/ZIP并再次逐文件验证，没有伪称首轮扫描已覆盖全部字段。[脱敏核查/修正记录](../../artifacts/test-archives/agent-capabilities-20261007/payload/metadata/m09/archive-audit.json)。文本秘密扫描不等于对57张知识库截图完成OCR审计。

17:37:24完成清理。先核对归档ZIP与已验证SHA一致，PG容器验证标签/运行状态和127.0.0.1:53085映射正确，计数仍9/6/0且没有非终态工作；按唯一监听、可执行路径、Vite命令和进程创建时间确认身份后，只停止本轮PID11080（应用18880）、16024（Go18891）、38016（假模型18900）。三个端口均不再监听。只删除`oc_manual_92db30a64afa49f08f281f66b75a8798`，删除后该schema查询为0；其余schema名称清单逐项一致，前后40个容器ID清单一致。共享PG `loom-opencode-validation-20261007-audit`保留，`pg_isready`仍通过。[清理结果](../../artifacts/test-archives/agent-capabilities-20261007/payload/metadata/m09/cleanup-verdict.json)、[精确清理脚本](../../artifacts/test-archives/agent-capabilities-20261007/payload/metadata/m09/cleanup.ps1)、[DDL清理日志](../../artifacts/test-archives/agent-capabilities-20261007/payload/metadata/m09/schema-drop.log)。没有运行主Compose down、system prune、批量删库或删除其他容器/卷。

最终ZIP另附[SHA256SUMS](../../artifacts/test-archives/agent-capabilities-20261007/SHA256SUMS.txt)和[解压验包结果](../../artifacts/test-archives/agent-capabilities-20261007/final-verification.json)。原`.repo`证据/私有配置及本地构建缓存保留，归档不包含私有配置；原session指向已删除schema，不能用它直接恢复这轮实验，重新测试应按§4创建新的独立schema。用户PowerShell窗口不强制关闭；测试进程已停止，空闲窗口可关闭。R01常规部署未恢复，L01真实付费评测/人工盲评未进入；没有把M09完成当成生产采用或质量收益结论。指南与归档均未提交Git。

#### R01 常规部署启动失败：并非端口冲突

用户反馈：运行 `restart.bat`，日志为 `FATAL compose no longer publishes 8080`，未进入正常启动流程。原始日志在 `artifacts/logs/restart.log`，记录时间2026-10-07 14:40:54。

助手只读核查：8080当时没有监听进程；`docker-compose.yml` 的app仍声明 `127.0.0.1:8080:8080`。执行 `docker compose config --quiet` 退出1，实际错误是 `F:/loom-backups/env/telethon.env` 不存在；另外确认 `app.env`、`minio.env`、`minio-init.env` 也不存在。没有读取或记录秘密内容。

误报原因：`restart.bat` 先执行Compose配置解析并丢弃stderr，没有检查解析退出码，然后从空的结果查端口，落入“没有发布8080”分支。这个报错不能证明端口冲突。尚未修改启动器、补造部署凭据或启动/停止生产栈；本轮继续走独立假模型测试。若后续需要恢复常规部署，应从真实部署配置/备份恢复工作树外文件，并单独验证启动器；不能用假模型实验室密码或随机占位值顶替。


---

## 后续：织识助手（Project Assistant）

2026-10-09 起的全局助手实现与验收另见 [project-assistant-step-by-step.md](project-assistant-step-by-step.md)（实现状态 + A01–A31 矩阵）。本文历史记录保持不变。
