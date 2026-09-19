# 2026-09-16 B类后台与C类隔离验收

范围：当前业务工作树 `.worktrees/local-model-settings`。B01—B12与C01—C04的本地离线/隔离核验完成；C05真实供应商、账单及生产部署未执行，不包含在通过结论内。用户已通过的手测不重复。所有新增生成仅发生在自动创建的临时库与本机假服务中。

## 本轮证据

工作树下 `artifacts/validation-2026-09-16/`：完整命令日志、dev/built JSON、SQL检索结果、截图、修改文件哈希。`prior-evidence/`保存运行前的旧验收目录，避免覆盖历史证据。

| 指南项 | 本轮结果及证据 |
| --- | --- |
| B01 请求幂等与冲突 | 通过，`npm-test-final.txt`含analyze/agent-runs身份、重放与三操作引擎往返。 |
| B02 严格信封 | 通过，正式TSP01—06及其余review探针纳入同一npm日志。 |
| B03 三终态竞争 | 通过，`postgres.txt` 18/18、零skip，包含真实行锁等待、撤销所有权、双complete。 |
| B04 材料变化与OCR | 通过，Node材料/context/data探针及PG-F02；不调用真实OCR。 |
| B05 正额度与Skill扣减 | 通过，`go-test-final.txt`正式Followup/Third/Invariant及检查点预算测试。 |
| B06 Stream生命周期 | 通过，同一Go日志包含晚到错误、Close和取消；不是页面动画判断。 |
| B07 unknown费用 | 通过，Node预算测试覆盖无回执/started/unknown/完整与缺失usage，未知费用不释放为0。 |
| B08 并发/跨日/价格/SQL故障 | 通过，预算测试及18项PG竞争测试，含最后额度、事务回滚和一次结算。 |
| B09 MCP与Skills边界 | 通过，正式Go及Node安全测试，fake协议实际调用与引用落库亦由dev/built验证。 |
| B10 进程恢复及ACK丢失 | 通过，dev/built均实际终止专属worker并新建进程Resume，已完成模型调用未重发；complete丢响应仍一份note。 |
| B11 实际SQL检索 | 通过预设门槛，`retrieval-final.txt`及`retrieval-sql.json`，98条/24例，范围越界0、无答案误取0、关键尾部命中1。c11召回0.5仍为已知限制，未宣称全面满分。 |
| B12 统一门禁与迁移 | 最终npm 234/234（25+1+183+25）、零skip；typecheck、build、Go test/vet/Linux race、PG18项、dev/built均退出0。build明确空DATABASE_URL，迁移跳过；旧库迁移另在临时PG验证。 |
| C01 健康与配置 | 通过，健康检查零模型调用；新增Go用例验证缺service/model配置时LoadConfig拒绝，缺/非法Skill目录ready503而health200，均不执行模型。 |
| C02 停机与恢复 | 通过，dev/built保持Eino时停专属worker，历史可读；新操作失败、零新增模型/笔记、不fallback。重启worker后新的请求成功。 |
| C03 自动分析准入及账本 | 隔离服务流程通过：新增C03测试串联环境配置→enqueue→claim→analyzeItemWith→可信调用回执→业务保存/预算结算。AUTO关闭、缺价格、额度0均零入队；限额1时1次假执行、1analysis，结算0.00028测试人民币单位，reserved归零；增加第二个合格材料再调度仍不能入队。原测试补充empty/pending/有效分析跳过、unknown保留与并发守恒。未启用55192的AUTO，也未点真实“扫描到期”；网页扫描按钮及真实采集不是本次验证对象。 |
| C04 引擎切换及回滚 | 通过本地范围，Node三操作legacy→eino→legacy传输核验；dev/built回滚取消未领取研究、claim503、不换供应商重发，历史仍可读。running所有权及终态由B03/B10验证。没有生产切换。 |
| C05 真实供应商 | 未执行：真实工具兼容性、usage/输出限制、账单、生产迁移及部署回滚均需独立服务/额度/发布授权。fake证据不能替代。 |

## 补充与修复

- `scripts/agent-e2e.mjs`每轮编译到独立临时worker路径，harness接收该路径；避免Windows下覆盖55192正在使用的agent.exe。手动模式默认路径保持。
- 检索评测原来硬编码`.repo`，在标准Git工作树失败；改为存在`.git`时走标准仓库，否则保留原`.repo`方式。本轮safe.directory仅由进程环境注入，没有写全局配置。
- 新增 `readiness_regression_test.go`，补配置就绪失败证据；`analyze.test.ts`补C03准入至结算；harness补C02停机后重新发起新请求。
- 首轮检索因上述路径错误失败，旧失败日志保留。新增C03最初缺TypeScript运行结果runtime的类型收窄，类型检查失败；增加断言后最终typecheck及完整npm通过。没有通过改业务期待值掩盖失败。

dev/built最终各18次假模型、1次MCP、7条note、1条analysis、2个持久检查点记录；相比旧指南17/6参考数，多出的1次模型/1note来自C02恢复验证。检查点记录数是该harness情景计数，不能混同A18/A19多轮工具任务的sequence=4。dev首次旧流程通过后，为加入C02新增断言又运行一次；两次均只在独立临时库。没有向55192重复生成。

桌面与390×844手机的dev/built冒烟截图已实际查看：正文和按钮可见，无横向溢出、console/page errors，built与dev基线无差异。保留平台默认分享图提示（BRAND NOTE）；本轮为业务后台验收，未新增品牌资产，不将该提示写成运行错误或宣称定制分享卡已完成。

## 资源与下一步

本轮PG为`loom-bc-20260916`/54176；专属dev/built容器由harness退出时自行移除，PG专项结束后亦移除。旧手测`loom-agent-harness-b7e5daa3`/55191与应用55192保留，核对仍11个run、Battery仅1条analysis，未改用户Key、AUTO或生产服务。

当前无需再让用户重复A类生成。可以继续后续产品工作；若下一步是正式接入/上线，应另行安排C05真实供应商及生产验收，不据本报告自动部署。
