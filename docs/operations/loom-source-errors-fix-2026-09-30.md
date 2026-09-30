# 信源大面积 error 修复记录 — 2026-09-30

> 现象：信源页 26 个信源中 19 个显示 error。
> 结果：**19 error / 7 ok → 2 error / 19 ok / 6 idle（停用）**，全程零代码改动。
> 本文按执行顺序记录根因与修复，供新环境排障复用。

## 一、error 状态的机制（为什么看起来很严重其实不是）

信源页的 error 是"最近一次扫描失败"的**粘性状态**：
`failSourceClaim()`（`src/lib/server/scheduler-atomic.ts:77`）把 `sources.status` 写为
`error` 并记录 `last_error`；只有下一次扫描成功才会翻回 ok。cron 调度本身一直是活的，
所以修好根因后状态会在下一轮 tick 自愈，无需手工改库。

## 二、逐类根因与修复（按执行顺序）

### 1. 微信网关 allowlist（wechat ×5，根因：测试值混入生产 env）

- 现象：`wechat_gateway_http_503`，网关实际返回 `paid_fallback_unavailable`。
- 根因：`F:\loom-backups\env\wechat-gateway.env` 里
  `WECHAT_PRIMARY_ALLOWED_HOSTS=wechat-fixture`（**测试夹具值**），不含
  `host.docker.internal`；而 gateway_sources 里 5 个公众号的
  `primary_feed_url` 全是 `http://host.docker.internal:4000/feeds/N.xml`
  （wewe-rss 容器，宿主端口 4000）。`allowedUrl()` 校验直接抛错，
  连续失败 223 次（自 09-07 起）。同时生产 env 无 `DAJIALA_KEY` →
  paid 兜底为 null → 503。
- 修复：`WECHAT_PRIMARY_ALLOWED_HOSTS=host.docker.internal`，
  `docker compose up -d --force-recreate wechat-gateway`。
  验证：`GET /v1/feeds/<id>.atom` → 200，`x-loom-provider: primary`，
  连续失败计数清零。
- 备注：`F:\loom-backups\loom-prod.env` 里的同名变量是**另一个文件**，
  网关服务实际读的是 `F:/loom-backups/env/wechat-gateway.env`
  （compose `env_file` 指向后者）。

### 2. Telethon 会话（telegram ×1）

- 现象：`authorized:false`，"需要登录会话"。
- 根因：不是会话丢失——`/data/loom.session` 一直在 volume 里；
  是容器启动时连 Telegram DC 连续超时（`telegram connect skipped`）。
- 修复：`docker restart telethon` 后自动恢复 `authorized:true`。
  chqq888888 走 GetHistory 拉到新消息，扫描 ok。
- 注意（跨机器重建时的坑）：root compose 的
  `TELEGRAM_API_ID/HASH/SESSION: ${…:-}` 会**覆盖** env_file；这些值在
  gitignored 的项目根 `.env` 里，`loom-prod.env` 不含 TELEGRAM_*。
  重建 telethon 必须同时带
  `--env-file F:/loom-backups/loom-prod.env --env-file .env`，
  否则 API_ID/HASH 被清空 → authorized=false。

### 3. YouTube channel_id 错误（youtube ×2）

- 现象：`HTTP 404`。库里两个 channel_id 实测都是 404——**填错/失效**。
- 修复：通过 YouTube 搜索页解析出真实 ID：
  - Two Minute Papers → `UCbfYPyITQ-7l4upoX8nvctg`
  - Y Combinator → `UCcefcZRL2oaA_uBNeo5UOWg`
  更新 `sources.handle/url` 后各拉到 15 条视频，状态 ok。

### 4. 网络出口：Clash global 模式 + 失效节点（rss ×4 + BBC + HN，根因最深）

- 现象：qbitai/36kr/solidot/sspai/latepost/jiqizhixin/dajiala/bbci
  全部 `ECONNRESET`（宿主机与容器一致）。
- 排障过程：
  1. 容器 DNS 返回 198.18.x.x —— Clash TUN fake-IP 段，DNS 被代理接管；
  2. 对真实 CDN IP 直连 raw TLS：TCP 通、TLS 握手被重置；
     同 IP 换假 SNI → 握手成功 → **SNI 级阻断**；
  3. 规则文件里这些域名明明是"全球直连"，但 **Clash 处于 global 模式**，
     所有规则被旁路，全走 GLOBAL 选择器单节点；
  4. GLOBAL 此前指向的美国 Z01 节点对这些域名失效。
- 修复：经 Clash API（`127.0.0.1:9097`，secret 在
  `%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/config.yaml`）
  逐节点测试，**日本Z01 唯一全绿**（国内站 + BBC + YouTube 全通），
  将 GLOBAL 固定到它。rss 全平台 200。
- 遗留风险：若日本 Z01 节点日后失效，同类 error 会重现；
  节点切换在 Clash 面板即可。若切回 rule 模式，
  "全球直连"规则生效，国内站不再依赖代理节点。

### 5. wewe-rss 微信读书风控（wechat 数据源的上游）

- 现象：wewe-rss 同步任务全部 `risk_control`（-2041 限频），
  文章停在 09-01/09-02；网关 7 天窗口无新文章 → atom 条目为 0。
  **条目 0 是上游停更，不是网关故障**——primary XML 只要拉得到，
  网关 503 即消除。
- 修复：微信读书侧对当前账号风控，只能等解封。同步间隔已调为
  720 分钟、调度器保持开启（wewe-rss 的 scheduler 会在遇到
  risk_control 时自动关闭，需在 `/app/data/wechat_mp.db` 的
  `app_settings.scheduler_enabled` 重新置 1 或走 Web 设置页）。
- 如急需新文章：在 wewe-rss Web 界面（宿主端口 4000）重新扫码换号。

### 6. 配置缺失类停用（douyin/xhs/xigua + 晚点/机器之心）

- douyin/xhs/xigua：平台仅支持 RSSHub/WeWe feed_url 方式接入；
  rsshub.app 公共实例对机房 IP 403，无自建实例 → 停用置 idle，
  notes 写明恢复路径（在信源页补 feed_url 后可重新启用）。
- 晚点 LatePost / 机器之心：网关流程上线前的旧 rss 格式行
  （adapter=rss、无 feed_url、handle 是裸词），官方站点无 RSS 端点
  （晚点 404、机器之心 302 跳数据页）→ 已停用置 idle。
  如需恢复：按 wechat CSV 格式重新导入，走 wechat_gateway 适配器。

### 7. bilibili 风控（×2，唯一遗留 error）

- 现象：`rate_limited (-799)` / `HTTP 412`——B 站对机房出口 IP 的风控；
  buvid cookie 流程也被拒。无 cookie 的
  `space/arc/search` 接口对 DC IP 基本不可用。
- 处理：扫描间隔拉长到 360 分钟降低撞墙频率，保留采集等风控松动。

### 8. 瞬态错误（自愈验证）

- Telegram News：`Telethon FloodWait 86s`，等 90 秒后重扫即 ok。
- Hacker News：一次 `ECONNRESET` 瞬态，重扫即 ok。

## 三、最终状态

| 状态 | 数量 | 明细 |
|---|---|---|
| ok | 19 | rss ×9（含 BBC/HN）、wechat ×5、telegram ×3、youtube ×2 |
| idle | 6 | 已停用 5 个无数据源 + 原有 idle 1 个 |
| error | 2 | 仅剩 bilibili ×2（B 站机房 IP 风控，外部因素，已降频） |

已停用源的 `status='idle'`、`last_error=''`（停用源不再被调度，
粘性 error 归位为 idle 以免 UI 误导）。

## 四、运维速查

```bash
# PG 快速访问
docker exec gig5cyrba5yn3tsi-grok-workspace-postgres-1 psql -U loom -d loom

# 状态分布
psql> select platform,status,count(*) from sources where id<>'radar' group by 1,2 order by 1,2;

# 手动触发一轮调度（绕过等 cron）
docker exec gig5cyrba5yn3tsi-grok-workspace-app-1 node -e "
fetch('http://127.0.0.1:8080/api/cron/tick',{method:'POST',
headers:{Authorization:'Bearer '+process.env.CRON_SECRET},
signal:AbortSignal.timeout(240000)}).then(r=>r.json()).then(j=>
console.log(JSON.stringify(j.collection)))"

# 网关健康
docker exec gig5cyrba5yn3tsi-grok-workspace-app-1 node -e "
fetch('http://wechat-gateway:8790/v1/health',{headers:{Authorization:
'Bearer '+process.env.WECHAT_GATEWAY_TOKEN}}).then(r=>r.json()).then(console.log)"

# Telethon 健康
docker exec gig5cyrba5yn3tsi-grok-workspace-app-1 node -e "
fetch('http://telethon:8787/health').then(r=>r.json()).then(console.log)"

# wewe-rss 健康（宿主）
curl http://localhost:4000/api/health
```

排障入口顺序：`sources.last_error` 分组 → 按上表对号 → 容器内
`fetch` 复现 → 修对应层（env / 网络 / 数据行）→ 触发 tick 验证自愈。
