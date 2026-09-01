# 微信公众号采集试运行与迁移手册

本手册用于第三方公开公众号采集的真实验收。`validation/fixtures/` 只证明报告程序可重复运行；其中全部是虚构工程数据，**不等于真实账号、真实供应商或生产迁移已通过验证**。

## 角色与开始条件

- 运行负责人：维护 Compose、调度、备份、日报和故障记录。
- 数据复核人：每天人工核对文章，并与供应商当天结果合并成参考集。
- 采购/迁移批准人：签署试用停止、100+ 账号扩容和长期服务器迁移决定。运行负责人和数据复核人不能自行降低门槛。

试运行开始前必须同时具备：已批准的 10–20 个第三方公开公众号 CSV、极致了试用凭证、每个账号的合法样例文章与主 Feed、可写的 PostgreSQL 与网关 SQLite 持久卷、每日预算配置和证据目录。缺少批准清单或试用凭证时不得开始真实 pilot；自动 fixture、UI 和离线报告可继续开发，但不能替代这些外部输入。

真实参考集固定使用以下精确表头：

```csv
canonical_id,account_id,account_name,title,published_at,original_url,provider_known
```

`provider_known` 只能是 `true` 或 `false`。时间必须是带时区的 ISO 8601；链接必须是 `https://mp.weixin.qq.com/...`。参考集路径为 `validation/wechat-reference.csv`，由人工复核结果与供应商每日结果取并集后维护，不复制工程 fixture。

报告窗口统一为半开区间 `[--from, --to)`。预算按窗口触及的上海自然日逐日判定：若 `--to` 恰为上海零点，该日不计入；否则计入 `--to` 所在日。网关日查询同样使用 `from` 包含、`to` 不包含的半开日期范围，单次最多 31 天。

## 八道不可跳过的门

1. 导入 10–20 个已批准公开账号，启用供应商试用并连续运行 72 小时。
2. 每天维护 `validation/wechat-reference.csv`：人工检查结果与供应商当天结果取并集，保留变更记录和复核人签名。
3. 每个连续 24 小时窗口生成一份报告；72 小时结束后再生成一份覆盖完整 pilot 的聚合报告。
4. **仅当**必须字段有效率低于 99%，或供应商已知的当日文章在对账后仍有缺失时，停止极致了采购并改测清博。其他指标失败先修复工程或运行问题，不擅自更换供应商。
5. 72 小时 pilot 全部通过后，才导入 100+ 个已批准账号并连续运行 7 天。
6. 一周内分别重启一次 `wechat-gateway`、`scheduler` 和 `app`；每次重启后验证网关 SQLite、主 PostgreSQL 数据仍在，并比较重启前后重复率，确认没有 duplicate spike。
7. 出现任一日调用或金额预算超限、任一连续 24 小时故障未进入告警，或 7 天聚合报告失败，均拒绝生产迁移。
8. 仅在七日门槛和证据复核通过后，把**原有未改动的 Compose 服务与持久卷**迁到具备固定公网出口、可长期运行 Docker 的服务器；迁移时不临时替换采集实现。

## 每日执行与报告

令牌只由 Docker secret、CI secret 或批准的秘密管理器预注入网关和当前报告进程；本手册不提供令牌值或设置令牌值的命令。不得把令牌值写入命令行、CSV、JSON 报告、shell 历史、工单或聊天记录。报告命令只接收环境变量的名字。每日、72 小时和 7 日报告都必须在对应窗口结束后的 2 小时内执行并立即保存 JSON。健康指标是 `as_of` 时刻保存的实时快照状态，不是伪造的 `window.to` 历史状态；快照允许包含窗口关闭后、`as_of` 之前的 primary/paid 成功，24 小时故障也以 `as_of` 为截止时间。实时网关健康状态不能用于更早历史窗口的重算；历史复算只能使用当时保存的 fixture/snapshot 和对应参考 CSV。

每日窗口（Bash）：

```sh
npm run wechat:report -- \
  --reference validation/wechat-reference.csv \
  --database-url "$DATABASE_URL" \
  --gateway-url http://wechat-gateway:8790 \
  --gateway-token-env WECHAT_GATEWAY_TOKEN \
  --from 2026-09-01T00:00:00.000+08:00 \
  --to 2026-09-02T00:00:00.000+08:00 \
  --out validation/evidence/pilot/day-01/report.json
```

每日窗口（PowerShell）：

```powershell
npm run wechat:report -- `
  --reference validation/wechat-reference.csv `
  --database-url $env:DATABASE_URL `
  --gateway-url http://wechat-gateway:8790 `
  --gateway-token-env WECHAT_GATEWAY_TOKEN `
  --from 2026-09-01T00:00:00.000+08:00 `
  --to 2026-09-02T00:00:00.000+08:00 `
  --out validation/evidence/pilot/day-01/report.json
```

每天按实际日期替换 `--from`、`--to` 和证据目录。72 小时 pilot 结束后，使用完整窗口和明确证据路径运行。

72 小时窗口（Bash）：

```sh
npm run wechat:report -- \
  --reference validation/wechat-reference.csv \
  --database-url "$DATABASE_URL" \
  --gateway-url http://wechat-gateway:8790 \
  --gateway-token-env WECHAT_GATEWAY_TOKEN \
  --from 2026-09-01T00:00:00.000+08:00 \
  --to 2026-09-04T00:00:00.000+08:00 \
  --out validation/evidence/pilot/72h/report.json
```

72 小时窗口（PowerShell）：

```powershell
npm run wechat:report -- `
  --reference validation/wechat-reference.csv `
  --database-url $env:DATABASE_URL `
  --gateway-url http://wechat-gateway:8790 `
  --gateway-token-env WECHAT_GATEWAY_TOKEN `
  --from 2026-09-01T00:00:00.000+08:00 `
  --to 2026-09-04T00:00:00.000+08:00 `
  --out validation/evidence/pilot/72h/report.json
```

100+ 账号连续运行七天后，使用完整七日窗口生成迁移门槛证据。

七日窗口（Bash）：

```sh
npm run wechat:report -- \
  --reference validation/wechat-reference.csv \
  --database-url "$DATABASE_URL" \
  --gateway-url http://wechat-gateway:8790 \
  --gateway-token-env WECHAT_GATEWAY_TOKEN \
  --from 2026-09-08T00:00:00.000+08:00 \
  --to 2026-09-15T00:00:00.000+08:00 \
  --out validation/evidence/scale/7d/report.json
```

七日窗口（PowerShell）：

```powershell
npm run wechat:report -- `
  --reference validation/wechat-reference.csv `
  --database-url $env:DATABASE_URL `
  --gateway-url http://wechat-gateway:8790 `
  --gateway-token-env WECHAT_GATEWAY_TOKEN `
  --from 2026-09-08T00:00:00.000+08:00 `
  --to 2026-09-15T00:00:00.000+08:00 `
  --out validation/evidence/scale/7d/report.json
```

三种报告的参考 CSV 都必须覆盖与命令相同的窗口。退出码 `0` 表示所有指标通过，`1` 表示报告已完整写出但至少一项失败，`2` 表示输入、数据库或网关不可用且该窗口没有可采信结论。任何 `1` 或 `2` 都必须进入当天记录，不能用工程 fixture 报告覆盖。

每份报告必须保留这些证据：参考 CSV 快照、生成的 JSON、Compose 镜像摘要、运行配置的非秘密摘要、人工抽查记录、供应商当日导出、告警截图或事件记录，以及预算账单摘要。建议目录：

```text
validation/evidence/
  pilot/day-01/ ... day-03/
  pilot/72h/
  scale/day-01/ ... day-07/
  scale/7d/
  restarts/wechat-gateway|scheduler|app/
```

数据复核人确认参考集；运行负责人确认报告和运行证据；采购/迁移批准人根据八道门签署“继续”“停止采购并试清博”或“拒绝迁移”。

## 重启、备份与回滚

首次导入、100+ 扩容、每次服务重启和最终迁移前：

1. 对 PostgreSQL 做带时间戳的 `pg_dump`，并校验备份可读取。
2. 暂停网关写入后备份 SQLite 持久卷；记录 Compose 配置、镜像摘要和卷名。
3. 记录重启前文章总数、唯一 canonical/规范化 URL 数、任务数、付费调用与金额。
4. 分别重启目标服务，等待健康检查，再生成相同窗口报告；核对 PostgreSQL 与 SQLite 记录未回退，重复率没有突增。

回滚优先恢复上一已验证镜像和 Compose 配置，同时保留当前失败现场供调查。若确认持久数据损坏，停止调度和网关写入，再成对恢复对应的 PostgreSQL 备份与 SQLite 卷快照；不得只恢复一侧，也不得通过删除迁移或清空文章来“修复”重复率。恢复后重新跑受影响的 24 小时报告，未通过前保持停止扩容/迁移状态。

## 验收判定

报告固定检查：必须字段至少 99%、两小时发现至少 95%、供应商已知缺失为 0、重复率严格低于 0.1%、正文至少 80%、HTTPS 封面至少 90%、24 小时无成功的源全部告警、付费调用数和金额均不超过当日配置。百分比判定使用未舍入值；JSON 中的显示舍入不能改变通过结果。

工程 fixture 可用以下离线命令检查报告工具本身，输出应放到临时或专门 QA 目录，不提交为真实证据：

```sh
npm run wechat:report -- \
  --reference validation/fixtures/reference.csv \
  --collected-fixture validation/fixtures/collected.json \
  --out validation/evidence/fixture-smoke/report.json
```
