# 实时发布、每日精选与复盘架构

本轮目标是把“采集成功”和“页面已经发布”拆成两个可观察状态，并将每日 2 串 1 / 3 串 1 做成服务端冻结账本，而不是浏览器临时计算。

## 一、运行链路

```text
竞彩/公开数据源
    |
原有 sync:data / free-football / prematch
    |
历史赛果复盘对齐
    |-- scripts/reconcileFastResultGenerationCompat.cjs
    |     仅在复盘子进程内处理 teamId/name 表示不一致
    |     sourceMatchId / eventVersion / kickoff 继续严格校验
    |
validate:data
    |
datastore:generation
    |
PostgreSQL / SQLite projection
    |
writeRealtimePublicationHealth.cjs
    |-- realtime-health.json
    |
前端 current API 10~30 秒轮询 + OperationalStatusDock 15 秒状态刷新
```

生产 systemd 入口改为 `scripts/runSyncWorkerOperational.cjs`。该文件不复制巨型 Worker，而是在加载原 Worker 前组合少量运行时策略：

- `reconcile:fast-results-generation` 走表示感知的兼容对齐入口；
- `sync:prematch` 走原 prematch 后的每日精选派生任务；
- projection 成功后刷新实时发布健康快照。

原 Worker 的全局写锁、正式赛果、数据校验、generation、projection、候选心跳、签名发布边界都保持不变。

## 二、同步身份修复边界

旧 `sameEvent()` 会从 `TeamId → TeamCode → TeamName` 取第一个字段并直接比较。如果历史记录一边有内部 ID、另一边只有显示名，即使 provider match id 与事件时间完全相同，也可能被误判为不同事件。

兼容对齐的规则：

1. provider `sourceMatchId` 同时存在时必须相同；
2. explicit `eventVersion` 同时存在时必须相同；
3. kickoff 同时存在时必须相同；
4. 球队双方都有 ID 时比较 ID；否则双方都有 code 时比较 code；否则双方都有 name 时比较 name；
5. 只有在 provider event identity 已完全绑定时，`ID vs name` 这种不可直接比较的表示差异才不会单独造成冲突；
6. 双方都有强 ID 且不同、主客 ID 互换、比赛 ID 不同、事件时间不同仍然 fail-closed；
7. 没有 provider match id 时，主客双方都必须存在可比较且一致的球队身份。

这个兼容行为只安装在独立复盘子进程内，不改变正式结果准入和冻结推荐的全局 `matchLifecycle` 合同。

## 三、实时数据显示

前端 `AppContext` 已经对 `/matches/current?view=list` 做 10~30 秒轮询（正常默认约 15 秒），切换期缩短到 3 秒，因此浏览器侧不是主要瓶颈。真正需要区分的是：

- **source freshness**：源站数据何时被观察到；
- **publication freshness**：最新 generation / projection 何时真正成为页面可读版本。

`public/data/realtime-health.json` 有三种状态：

- `live`：源数据和页面发布都在新鲜窗口；
- `publication-delayed`：源数据已更新，但页面 generation 没有及时推进；
- `source-stale`：源数据本身已经滞后。

这样“采集成功但网站还是昨天的数据”不会再被显示成普通的“数据在线”。

## 四、每日精选策略

服务端脚本：`scripts/buildDailyFeaturedCombos.cjs`。

固定要求：

| 类型 | 精确场数 | 最低组合 SP |
| --- | ---: | ---: |
| 2串1 | 2 | 2.50 |
| 3串1 | 3 | 5.00 |

候选必须同时满足：

- 当前竞彩业务日、未开赛且未过停售；
- 已发布 `BEST` 正式推荐，`recommendationAction= recommend`；
- 方向只能是 HAD / HHAD 的 1/X/2；
- 当前价格必须来自官方竞彩来源；
- 通过原 `isOfficialRecommendationEligible()` 正式资格门；
- 证据分至少 62；
- 单腿 SP 在合理边界 1.20~4.00；
- reference / model-only / watch / 明确市场冲突等硬风险不参与。

系统不会为了满足“每天都有”而制造低质量组合。若当天没有足够正式候选，会明确输出 `insufficient-qualified-pool`，页面显示“今日无满足质量和 SP 门槛的组合”。这比强制凑单更符合可复盘性。

### 冻结时间

- 工作日默认 21:00 形成每日精选；
- 周末默认 22:00；
- 如果最早合格比赛更早开赛，则冻结点提前到其开赛前 60 分钟；
- 工作日 22:00 / 周末 23:00 为 no-pick 最终截止；
- 截止前如果之前候选不足，可随着新官方数据到达重新评估；
- 一旦组合正式发布，比赛、方向、盘口和 SP 不再改写。

## 五、赛果结算与复盘统计

私有冻结账本：`server-data/daily-featured-combos-ledger.json`。

公开投影：`public/data/daily-featured-combos.json`。

结算使用：

- canonical `sourceMatchId + eventVersion`；
- 只接受 `FINISHED` 且比分完整的比赛；
- HAD 按 90 分钟主/平/客结算；
- HHAD 按冻结的整数让球线结算；
- 作废单独记为 `VOID`；
- 单腿记录 WON / LOST / VOID / PENDING；
- 组合记录 WON / LOST / VOID / UNSETTLED。

统计包含：

- 2串1、3串1各自发布次数；
- 已结算次数；
- 命中 / 未命中 / 作废；
- 正式组合命中率（只用 WON/LOST 分母）；
- 平均冻结组合 SP。

不根据赛后赔率重写当日组合，也不把未结算和作废计入命中率。

## 六、故障隔离

每日精选属于派生展示面，不是当天赛程发布的前置条件：

```text
prematch 正常失败 -> 正常阻断对应上游流程
prematch 成功 + combo 构建失败 -> 记录 combo failure，但不阻断当天赛程 generation
历史复盘身份真正冲突 -> 仍严格失败
仅身份表示不可比较（ID vs 名称）且 provider event 完全一致 -> 允许复盘对齐
projection 成功 -> 刷新 publication health
```

因此不会再出现“精选模块的小错误把整个当天赛程卡死”的新耦合。

## 七、UI 结构

`OperationalStatusDock` 为所有页面提供统一入口：

- 实时状态：源数据年龄、页面发布年龄、当前场次数；
- 2串1 / 3串1：比赛、方向、冻结 SP、组合 SP；
- 赛后：每腿结果和累计命中率。

视觉规范调整为：

- 深海军蓝/灰作为主背景；
- 青色只表达 realtime / healthy；
- 金色只表达正式精选；
- 蓝色表达参考/分析；
- 红色用于失败、未命中和异常；
- 减少高饱和绿色和重复边框。

样式集中在 `src/styles/operational-refresh.css`，避免继续扩大历史全局 CSS。

## 八、合并与上线门槛

分支代码进入仓库不等于生产已经恢复。合并前至少执行：

```bash
node scripts/verifyReconcileIdentityCompatibility.cjs
node scripts/verifyDailyFeaturedCombos.cjs
node scripts/verifyRealtimePublicationHealth.cjs
npm run verify:match-lifecycle
npm run verify:fast-results-generation
npm run build
```

上线后还必须验证：

1. Worker service 已使用 `runSyncWorkerOperational.cjs --loop`；
2. 当天 `matches-current` 的 businessDate 与场次数正确；
3. 源数据刷新后 generation / projection 在预期周期推进；
4. `realtime-health.json` 正确区分 source stale 与 publication delayed；
5. 当天组合若发布，其 SP 和比赛在后续赔率刷新中保持冻结；
6. 完场后自动结算并更新统计；
7. 历史那批 team ID/name 异常不会误绑，但真正的 ID/时间冲突仍被拒绝。

本轮不自动下注，不绕过源站访问控制，也不以“保证每天有单”为理由降低正式推荐门槛。
