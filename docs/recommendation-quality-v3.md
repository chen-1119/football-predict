# 推荐质量 V3

目标不是提高显示信心分，而是降低低质量正式推荐的进入率，并让每日精选组合可以被冻结、结算和长期统计。

## 正式推荐收紧

历史策略样本显示 HHAD 与高 SP 区间表现明显弱于低 SP 区间，因此新增单向降温层：

- SP > 2.60：暂不进入正式推荐，只保留参考。
- SP 2.06–2.60：要求更高模型概率、模型分离度、市场边际、数据质量和市场确认。
- HHAD：额外要求更高模型概率、分离度、数据质量和市场确认。
- SP 1.71–2.05：提高模型分离度与数据质量门槛。
- 趋势与方向矛盾时，高 SP 方向继续阻断。

该层只会收紧，不会因为小样本自动放宽，也不会修改模型原始概率或赛后重建方向。

## 模型反馈刷新

生产 Worker 开启 `ENABLE_MODEL_BACKTEST_ON_SYNC=1` 与 `ENABLE_MODEL_STRATEGY_ON_SYNC=1`，沿用 120 分钟最小回测间隔。这样模型评估/策略不再依赖人工环境变量才能推进。

## 每日精选

前端每天展示两档只读精选分析：

- 2 场组合：总 SP >= 2.50
- 3 场组合：总 SP >= 5.00

只使用正式、在售、SCHEDULED 的 BEST 方向。单腿 SP > 2.60 不进入精选；HHAD 与较高 SP 需要更高证据评分。组合排序优先平均证据评分，并倾向选择刚超过目标 SP 的组合，而不是追求更高 SP。

候选不足时明确显示没有满足条件的组合，不强行补位。

## 冻结与复盘

`dailyFeaturedComboLedger.cjs` 在北京时间工作日 21:00、周末 22:00 后冻结当日首次满足条件的 2 场/3 场组合。冻结记录保存 sourceMatchId、eventVersion、玩法、方向、让球线、原始 SP 与证据评分。

赛后只用最终赛果结算：

- 单腿 WON / LOST / PENDING
- 组合只有全部腿 WON 才记 WON
- 方向和原始 SP 不允许赛后改写

公开汇总分别统计 2 场与 3 场的 published / settled / won / lost / hitRate，不能与单场正式 BEST 命中率混算。

## 运维

`football-sync-worker.service` 改为持续守护，并启用周期回测/策略刷新。

新增：

- `football-featured-combo.service`
- `football-featured-combo.timer`

Timer 每 5 分钟执行一次，负责冻结满足时点的组合与补充已完成比赛的结算。

## 验证

合并前至少执行：

```bash
node scripts/verifyRecommendationHistoricalGuard.cjs
node scripts/verifyDailyFeaturedComboLedger.cjs
node scripts/auditRecentRecommendationQuality.cjs
npm run validate:data
npm run build
```

部署后需要观察新的 prospective 样本。历史弱区只能支持“为什么要收紧”，不能证明未来命中率一定提高；是否进一步调门槛必须依据冻结后的新样本，而不是事后挑选比赛。
