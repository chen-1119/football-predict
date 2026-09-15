# 实时数据与产品架构 V2

本轮基于当前 `main` 演进，不复用已落后数百提交的旧优化分支。目标是把“采集成功”“发布成功”“浏览器实时”“模型可正式展示”拆成可独立观测的状态，避免任一层失败时所有页面都只显示一个模糊的“同步异常”。

## 1. 数据链路

```text
Sporttery / 500 / 其他公开或授权来源
        |
        v
采集与 relay / fast-result lanes
        |
        v
sync:data + enrichment
        |
        +----> 当前赛程/赔率候选
        |
        +----> 赛果/历史候选
                  |
                  v
       result/review reconciliation
                  |
                  v
            validate:data
                  |
                  v
datastore:generation (immutable publication)
                  |
          +-------+--------+
          |                |
          v                v
      PostgreSQL        SQLite legacy
          |
          v
       /api/v1
          |
          +---- SSE /events
          |
          +---- 15s safety poll
          |
          +---- 3s transient recovery poll
          v
       React UI
```

### 状态不能混用

| 状态 | 含义 | 页面允许做什么 |
| --- | --- | --- |
| source fresh | 源站/relay 有新数据 | 只能说明采集层正常 |
| reconciliation healthy | 赛果与历史身份可以安全合并 | 可以继续生成 publication |
| publication current | 新 generation 已提交 | API 可以切换到新版本 |
| API current healthy | `/matches/current` 返回当前 generation | 页面可显示最新赛程 |
| realtime transport healthy | SSE 或安全轮询在工作 | 页面可及时感知 publication 变化 |
| recommendation reliable | 模型治理门槛通过 | 才能展示正式方向；否则保持参考/影子 |

模型是否晋级不能阻止基本赛程展示；反过来，采集成功也不能冒充 publication 已成功。

## 2. 历史球队身份修复边界

历史结果存在一类旧数据：`teamId` 并非 provider team id，而是由展示名称计算出的 `derivedTeamId(name)`。简称变成全称时，这个展示 ID 也会改变。

`scripts/storedResultTeamIdentity.cjs` 只在**赛果/复盘归档对齐**中识别这种可证明的展示型 ID：

- 必须存在相同 canonical sourceMatchId；
- 必须存在完全一致的 eventVersion / kickoff event；
- 只有 `teamId === derivedTeamId(teamName)` 时才视为 synthetic presentation id；
- synthetic id 可以在同一 immutable event 中重绑定；
- 真实 provider-owned team id 永不改写；
- 不修改全局 `matchLifecycle.sameEvent` 的严格规则；
- 不允许相同 source id 在不同 eventVersion 之间合并。

该规则用于消除“米堡/米德尔斯堡”一类展示名称变化造成的假冲突，而不是放松真实比赛身份校验。

## 3. 实时页面

前端继续复用现有单一数据通道，不新增第二套轮询：

- SSE 正常时显示 `SSE`；
- SSE 中断后仍由 safety poll 保底；
- 普通 current poll 为 15 秒；
- transient outage 期间为 3 秒恢复探测；
- 页面重新获得焦点/visibility 时立即刷新 current 和 history；
- 历史分页慢时不能阻塞 current 首屏；
- retained snapshot 只能作为短期连续性展示，不能被标记成“实时在线”。

顶部状态条现在同时暴露：数据状态、transport、当前场次数、最近活动时间。这样可以区分“浏览器没刷新”和“后端 generation 没推进”。

## 4. 同步诊断

部署后优先运行：

```bash
node scripts/diagnoseLiveDataSync.cjs
```

输出包括：

- 上海竞彩业务日；
- current source freshness；
- publication generationId/sourceCycleId/committedAt；
- current 总数/今日/未来/进行中/待赛果数量；
- Worker 最近成功与最近错误；
- 历史 event identity 冲突；
- quarantine 复盘数量。

诊断脚本只读，不执行 repair，不写生产数据库。

## 5. 精选场次与组合分析

产品层可以展示每日 2 场/3 场的“精选分析组合”，但应保持以下边界：

- 只消费已经存在且满足治理规则的赛前方向；
- 不允许参考/影子方向冒充正式方向；
- SP 阈值只是筛选/展示条件，不是模型置信度；
- 候选不足时明确显示“今日没有满足条件的组合”，不能为凑数量降低硬质量门槛；
- 历史复盘只能读取冻结的赛前记录，不能用赛后赔率重建方向；
- 不接自动下注或账户执行逻辑。

用户当前希望的展示门槛为：2 场组合总 SP 至少 2.5，3 场组合总 SP 至少 5.0。该口径应与模型正式资格、单场证据质量、同场去重和停售时间共同使用，而不是仅按 SP 排序。

## 6. 复盘与统计

现有 Review Center 的 server scorecard 继续作为统计权威：

- 每日正式 BEST；
- 每日参考 BEST；
- 累计正式/参考命中率；
- 系统赛后复盘；
- 无冻结赛前方向的比赛仅展示赛果归档。

浏览器已加载的有限 history 不得用于替代服务端完整统计。后续组合分析统计同样必须使用冻结记录 + 官方终场赛果，且单场和组合统计分开。

## 7. UI 架构

视觉层现在分为：

```text
styles/tokens.css            产品级颜色/圆角/字体/阴影 token
styles/shell.css             基础导航壳
styles/matchday-shell.css    比赛页信息层级与布局
styles/matchday-cards.css    比赛卡片和报价卡
styles/product-v3.css        最终视觉覆盖与统一交互状态
```

本轮主色从大面积绿色调整为深海军蓝 + 冷蓝，绿色仅表示健康/命中等正向状态，青色表示实时同步，金色保留精选/正式语义，红色只用于错误/未命中。

禁止继续把页面级新样式堆到历史 `index.css`。

## 8. 发布前验证

至少执行：

```bash
node scripts/verifyStoredResultTeamIdentity.cjs
node scripts/diagnoseLiveDataSync.cjs
npm run verify:fast-results-generation
npm run validate:data
npm run build
```

生产环境还需要验证：

1. Worker 能从历史简称/全称变化中继续生成新 publication；
2. 不同 provider team ID 冲突仍然 fail closed；
3. source id 复用但 eventVersion 不同仍然 fail closed；
4. publication committedAt 推进后 SSE 能触发页面 current 更新；
5. SSE 断开时 safety poll 能在预期窗口内恢复；
6. 模型仍为 shadow/reference 时，赛程和赛果照常更新；
7. 正式方向与冻结 SP 不被后续赔率/结果重写。
