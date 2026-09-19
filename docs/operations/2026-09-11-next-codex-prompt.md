# 新Codex会话提示词

请接续织识 Loom 项目，先读取以下文件，再直接推进实现与验证，不要停留在总结或重复指导旧手测。

项目根目录：`F:/AI-TG-PINGTAI-0826/GIG5cYRBa5yN3Tsi-grok-workspace`。
实际业务工作树：`.worktrees/local-model-settings`，分支 `comet/local-model-settings`，用户实例 `http://127.0.0.1:8182`。这是Windows/PowerShell环境。

必读：
1. 适用的AGENTS.md和AGENTS.project.md（若存在）。
2. 根目录 `docs/operations/2026-09-11-handoff.md`（最新交接，优先于旧handoff正文）。
3. 根目录 `docs/operations/2026-09-09-manual-test-record.md` 的最新记录。
4. 工作树 `docs/operations/local-model-settings.md`，以及与本次修改有关的源码和现有测试。

已通过：模型草稿重新读取；关键词/平台/文章形态在多种返回路径保留；短文章移动基础显示；同步分析和问答的既有复测；今日简报真实生成、F5保留、五组引用正文一致性。不要要求用户重复生成这些结果。末三条引用只获文字确认，不补造逐条截图和目标ID。

首要任务是修复搜索输入与返回状态：用户输入“下一块电池”进入详情后返回，文字丢失，截图URL没有q。交接时源码发现 `src/routes/inbox.tsx` 使用defaultValue，仅按Enter才navigate写q，而旧测试指引没要求Enter。请自行复现“未提交草稿”和“已按Enter提交”两种流程，追踪查询、导航、详情返回及前后退的全部状态同步，选择最小一致交互修复；不要直接假定详情返回丢掉已提交q，也不要只告诉用户按Enter就结束。

在现有工作树修复并留下真实输入流程回归，覆盖中文输入法、清空、平台/形态切换、浏览器前后退、详情刷新、新标签及无参数默认返回，按实际风险取必要覆盖。完成相关测试、typecheck、build及dev/built浏览器验证；build会迁移数据库，先确认只使用隔离测试库或空DATABASE_URL。通过后逐步更新主验收文档，区分代码已修、离线通过、用户待复测，最后给我简短复测步骤。

完成首要任务后，按交接清单准备长正文/长external_id、empty/pending OCR、日期边界等隔离样本，补A20及A09—A12缺口；然后处理开发数据持久化与Eino/工具/费用验证。不要在8182通过真实采集制造测试夹具。常规已通过项不重做。

保护约束：
- 先检查8182存活；不要强杀、重复启动或为QA重启。当前是进程内存PGLite，重启会清空本次简报。任何持久化切换先准备保留现有数据的方案。
- 保留全部已有未提交改动，不reset/clean、整树覆盖、擅自commit/push或改restart.bat；不自动归档Comet任务。
- 不读取/输出/归档 `config/model.local.json` 的私有Key，不新建.env。模型设置自动QA必须使用隔离假配置，不能改用户真实配置。
- 保持legacy、AUTO=false、async=false、worker=false；不擅自切生产Eino或发真实模型、OCR/ASR、外部采集请求。需要额外服务或真实费用时列出具体范围，先完成可独立执行的本地工作。
- 每一步验证结果都写进根目录 `docs/operations/2026-09-09-manual-test-record.md`；不要把截图、刷新保留、历史测试报告当成费用、重启持久化或新代码门禁通过的证据。

请先简述你确认的当前状态和首个修复点，随后开始检查、实现和验证。
