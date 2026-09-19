# 交给实现Agent的提示词

把下面代码块内的内容完整复制到另一个Agent。无需另建新项目；使用既有业务工作树。此提示词授权工程实现与隔离验证，不自动授权真实费用、生产切换或扩大采集。

```text
请接续织识 Loom，执行完整实现计划，不要重新写一份计划或只总结建议。

环境：Windows / PowerShell。
项目根目录 R：F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace
实际业务工作树 B：F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace/.worktrees/local-model-settings
业务分支：comet/local-model-settings

请先依次读取：
1. R和B的适用AGENTS.md、AGENTS.project.md（若存在）。
2. R/.agents/skills/ponytail/SKILL.md。
3. C:/Users/Administrator/.agents/skills/executing-plans/SKILL.md（若缺失先查找；不可用则按计划检查点执行并说明，不虚构技能调用）。
4. R/docs/plans/2026-09-16-loom-production-readiness-implementation.md（本次完整执行计划，T01—T25）。
5. R/docs/operations/2026-09-16-prd-gap-and-next-plan.md。
6. R/docs/operations/2026-09-11-handoff.md，最新章节优先于旧正文。
7. R/docs/operations/2026-09-09-manual-test-record.md、2026-09-16-bc-validation.md、2026-09-11-persistence-protection.md。
8. B/src/routes/prd.tsx，以及每个任务列明的源码与测试。

目标：修复PRD差距，形成数据可保护、采集与关键词正确、可观测且可回滚的候选版本；再按明确授权完成真实服务与发布验收。不要把整个产品重新搭建，不引入无必要的新依赖、框架、向量库或多租户。

执行方式：
- 从T01核对真实基线、修改与运行资源开始，随后按依赖完成T02—T20适用离线任务，同时完成T25指南草稿。
- 对每个非平凡修复先留下能复现问题的最小测试，再修共享根因，定向回归通过后继续；检查同一函数全部caller。
- 计划是已定位的实施设计，不是对每个候选改动都要求照抄。若源码已经实现或计划假设不成立，先留下验证证据，复用现有实现并记录必要调整，不重复开发；影响产品范围、费用或数据安全的变化不得擅改。
- 不因某个真实服务/授权门未开放而停止其他可独立执行的工作。不要每完成一个任务就询问“继续吗”；逐步记录并持续推进。
- 不自动启动其他Agent。保留工作树所有已有修改；不要从干净HEAD另起工作树而丢掉当前未提交修复。
- 业务代码改B；主执行记录、指南与交接写R/docs。每项将状态、文件、命令、退出码、数量、证据和限制写入R/docs/operations/2026-09-16-production-readiness-execution.md。
- 使用唯一批次的临时库、假模型、假MCP和隔离端口。构建会运行db:migrate，必须清空DATABASE_URL或明确指向本批隔离库；不能继承真实配置。测试日志要真实，失败尝试保留。
- 新前端行为须做dev及built桌面/390×844浏览器验证，实际查看截图和console/pageerror；HTTP200不等于渲染通过。

必须保护的边界：
- 55192是有历史记录的假模型手测环境；8182此前使用进程内存库。不要重启、强杀、清空或迁移这两个实例；先只读核对它们当前是否存活。不要将新启动的空库冒充旧数据恢复。
- 不读取/打印/归档config/model.local.json里的私人Key、容器全量环境或Telethon会话秘密；不要新建.env。测试只用独立假配置，不更改真实模型设置。
- 不改restart.bat，不reset/clean/stash，不整树覆盖，不擅自commit/push/merge。技能里的“频繁提交”在这里替换为diff/哈希/证据检查点。
- 不执行生产compose up/down/rebuild，不删除任何既有数据卷，不切生产引擎，不启用真实AUTO/OCR/付费兜底，不重新启动过期微信试点。
- 不重复已经通过的简报、问答、条目分析和工具手测。A类现有证据、B01—B12/C01—C04本地通过可复用；C05真实服务与全产品采集验收尚未完成。

真实服务和生产门：
T21真实采集/模型/MCP/OCR，T22业务迁移，T23长期试点，T24正式发布，必须先完成可独立完成的代码、隔离验证与具体执行清单，再请求该门所需授权。请求必须明确唯一环境、源/服务列表、操作、次数/金额上限、时间窗、停止条件及回滚资源；已有测试请求不构成费用/发布批准。没有授权时记录awaiting_authorization，继续其他离线工作。
未经明确请求不要创建定时自动化、主动发送外部通知或重启宿主机器。

结束时交付：
1. T01—T25状态表，区分offline_pass、real_pass、awaiting_authorization和按范围后置项。
2. 实际改动、测试命令/数量/退出码、浏览器与数据证据链接。
3. 候选版本清单、支持平台和规模、备份恢复与发布回滚方案。
4. 与当前就绪级别一致的使用指南；fake结果不能当实际研究结论。
5. 尚需用户提供/批准的最小清单，以及下一具体操作。

只有满足计划对应L2全部条件才能说“生产就绪”；L0离线候选完成或L1受控试用不等于全平台上线。请先简述核对到的基线和首个动作，然后立即开始T01，不停在口头承诺。
```
