# GitHub 发布动态：单渠道试点（C03）

2026-10-13：用户已选择 GitHub 开源项目与发布动态。离线实现与验证完成；真实 Feed 可用性、参考发布集及连续 72 小时验收仍为 **pending**，观察时长 **0 小时**。三份配置始终 `enabled:false`，没有写入应用数据库、启动持续观察或部署。

## 固定范围

| 信源 ID | 仓库 | 提议 Feed（真实内容待验证） |
| --- | --- | --- |
| `src_github_agent_reach_releases` | `Panniantong/Agent-Reach` | `https://github.com/Panniantong/Agent-Reach/releases.atom` |
| `src_github_obscura_releases` | `h4ckf0r0day/obscura` | `https://github.com/h4ckf0r0day/obscura/releases.atom` |
| `src_github_jina_reader_releases` | `jina-ai/reader` | `https://github.com/jina-ai/reader/releases.atom` |

配置在 `validation/collection/github-release-sources.json`：`platform:rss`、`adapter:rss`、间隔 180 分钟、全部停用。它是试点输入清单，应用启动和 seed 不会导入它。

直接复用现有 RSS adapter 的 Atom 支持，沿用 `fetchRss -> publicFetch` 的 URL/DNS/固定地址连接/逐跳重定向/流式体积保护，再经真实 `runSourceJob` 完成 claim、落库、去重、覆盖记录与游标更新。选择 rss 可避免 rsshub 失败后对同一 URL 再次尝试 RSS 的回退路径。

固定 Feed 返回统一 `CollectorBatch`：`meta={provider:'',attempts:['rss'],paid_call:false}`；覆盖为 `complete:false,window_only:true`，按窗口记录 `initial_window/empty_window/window_overlap/window_gap`。条目的 `source_id`、Atom `external_id`、发布 URL 和现有 `extra.platform=rss` 保留来源。没有新增 GitHub 或微信 provider；配置备注不会自动成为 item.extra。

能力仅为这三个仓库的发布窗口。没有关键词搜索/KeywordBatch、仓库发现、issues、commits、附件下载、纯 tag 更新或完整历史回补；A03 的关键词公平合并不变。窗口外漏项不可观测，不能把当前窗口匹配宣称为全量历史覆盖。网站 Atom 的具体配额未验证，不套用 GitHub REST API 配额。

## 默认停用与隔离运行

无需安装 Agent-Reach、增加原生 adapter 或新依赖。原先目标工具检查仅记录 gh 2.95.0 存在、Agent-Reach CLI 不在 PATH；doctor 为 `not_run_missing_tool`，gh 登录状态未检查。工具存在与真实读取结果分别记录。

验证入口为 `validation/collection/github-release-observation.mjs`，在仓库根目录运行。无参数/未知参数/多个模式会直接拒绝；导入模块不执行。没有注册 npm 启动任务、后台服务或定时自动重启。

```powershell
node validation/collection/github-release-observation.mjs --self-check
```

入口使用已有 `offlineEnv` 白名单建立子进程，移除继承的数据库、代理、提供商与出网配置，指定 test runtime、不存在的模型配置路径、禁用分析/媒体提取/各 worker。Vite 仅用于加载已有服务模块，数据库是该子进程内新建的内存 PGLite；要求初始 sources 表为空。三个副本先显式停用，仅在这个一次性数据库内按模式启用，进程结束关闭 PGLite 和 Vite。生产信源不受影响。

**不要把清单加入 seed。** `SeedSource.live` 不是停用开关，当前 `insertSource()` 写死 `enabled=true`。后续安装必须另行评审一个保留 `enabled:false` 的导入步骤，检查固定目标和 ID 冲突，再在真实验收通过后单独启用。本次没有提供生产导入/启用入口。

## 已取得的离线证据

本次最终 self-check：**44 次合成 transport 调用，0 次真实 HTTP 请求**，清单仍为 `[false,false,false]`。它通过实际 collector/scheduler，而非重写落库逻辑，验证：

- 三个停用副本零传输；首次插入、重复读取零新增、新发布恰好新增一次；真实 `source_id+external_id` 去重、发布 URL、正文、有限窗口覆盖。
- 有效空 Atom；401/403/429/503 单次失败；超时、体积上限、错误 XML、HTML/challenge；基准网段 DNS 与私有重定向拒绝。
- 成功 observer snapshot 验证三个参考窗口、正文文件 SHA256、原始发布 ID/URL、元数据和前后游标；实际 observer 在 HTTP429 或 HTML 失败后只尝试第一个信源，保存上游/采集/捕获/比较错误的独立字段后停止；429 保留 Retry-After 与 RSS 元数据，不安排重试。
- Atom 原始 ID 与截断后的 320 字符 ID分别保留；缺失 ID、截断碰撞标为不可比较。
- 合成 preflight 拒绝时零源任务、零 HTTP、观察时长 0；成功数与遗漏数为未知，不从无响应推导零遗漏。

另已通过 `node --check`、仅该入口的 ESLint（零 warning）、五种拒绝模式与惰性导入检查；后两者没有创建观察目录。

夹具标题/正文/作者标为 synthetic/fixture，ID 为 `tag:github.com,2008:Repository/fixture-...`，URL 为 `/releases/tag/fixture-...`。即使 URL 使用 github.com，也不是实际公开发布证据。自检产生的报告明确标注 `evidence_kind:synthetic_fixture`，不计入真实观察时长。

## 待验证的真实证据与未来运行

先前一次 github.com DNS 检查返回 `198.18.0.114`、`2001:2::71`，策略在 HTTP 前拒绝为 `blocked_address`。三个 Feed 共用这个已知被拒绝的主机，因此本次没有重复 DNS/HTTP，也没有改用 API、其他 DNS、代理、Cookie 或出网豁免。真实 Atom 正文、发布 ID/URL、HTTP 状态、限流/暂时失败行为都未取得；不是三个失败的源任务，也不是空 Feed。真实成功数、遗漏数、实际费用和运维成本均未测量。

公开无认证 Feed 的登录过期项为 `not_applicable_public_unauthenticated_feed`；夹具 401/403 不代表验证过真实账号生命周期。正式首次读取、重复读取与新到达发布仍待验证。

以下是未来明确启动的入口，本次未执行；只有目标网络策略允许且获得启动该观察的授权后使用：

```powershell
node validation/collection/github-release-observation.mjs --snapshot
node validation/collection/github-release-observation.mjs --observe-72h
```

snapshot 最多顺序读取三个信源；它可以证明当次窗口可用，不能通过 72 小时验收。endurance 固定 25 轮，单调时钟偏移 0、3、…、72 小时，每轮三个信源，最多 75 源任务，重定向请求另计并受现有策略上限约束。首个采集/捕获/参考比较失败就保守停止；不重访失败源、不刷新登录、不自动重启、不追赶迟到轮次，迟到超过五分钟停止。

可输入 `stop` 或发 SIGINT/SIGTERM：父入口向子进程转发停止信号，取消等待和进行中的固定地址请求，移除监听器，关闭 Vite/PGLite。正常停止保留 pending 报告；强制杀进程/断电可能只有已写入的逐条证据，不能据此宣称通过。

证据写入被忽略的 `artifacts/collection-capability/github-pilot/` 独立运行目录：每次任务立即追加 `rounds.jsonl`，完整有界且 XML/Atom 根合法的正文单独保存并计算 SHA256，最终通过临时文件重命名原子写 `summary.json`。每条记录包含源、轮次、时间、请求尝试与返回状态/Retry-After、字节数、raw/normalized Atom IDs、原始 alternate 链接与发布元数据、存储 ID/URL/extra、新增/缺失/重复、前后游标、job 状态、coverage 和 provider/attempts/paid_call。alternate 链接仅作为 Feed 原始参考保存，不跟随读取。缺失 ID 或碰撞不可比较；HTML 不保存为合法 Atom。原始重定向查询、认证头、Cookie 不进入记录。

上游 transport、响应捕获、采集与参考比较错误分别记录；`error_code` 是验证脚本对实际消息的分类（如 `http_429`），生产 scheduler 本身仍返回原错误消息。summary 区分任务尝试数、实际成功数、完整轮次与可比较响应；无响应时统计未知，费用字段为 `unmeasured`。

正式通过条件：真实单调时长至少 72 小时、75 次源任务成功、参考集合可比较、缺失/重复可解释、没有中断/失败，且三个源各至少出现一次后续轮次的新发布。没有观察到新发布就保留该项 pending，不能制造新到达证据。即使通过，仍需明确记录实际运维/费用，再评审生产启用；默认停用清单不会自动变更。

语义参考：[GitHub releases 与 tags](https://docs.github.com/en/repositories/releasing-projects-on-github/viewing-your-repositorys-releases-and-tags)、[公开 releases API](https://docs.github.com/en/rest/releases/releases)。这些资料不证明上述三个具体 Atom Feed 当前可访问；本试点没有使用 API 抓取。
