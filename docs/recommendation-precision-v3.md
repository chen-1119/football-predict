# 推荐精度优先 V3

目标不是增加推荐数量，而是提高正式方向的筛选精度并保留可审计的参考样本。实时同步、赛果结算和冻结记录规则保持不变。

## 正式推荐策略

### HAD

- 正式 SP 上限：2.05
- 模型概率下限：48%
- 模型第一/第二方向差至少 8 个百分点
- 数据质量至少 0.55
- 多因素证据分至少 72
- 独立支持因素至少 5 项
- 严重数据缺口必须为 0
- EV 至少 +1%
- 市场概率差不得低于 -1 个百分点
- 市场走势明确反向或外部市场明确矛盾时不晋级

### HHAD

历史表现明显弱于 HAD，因此只允许强证据样本进入正式池：

- 正式 SP 上限：1.85
- 模型概率下限：55%
- 模型方向差至少 10 个百分点
- 数据质量至少 0.65
- 多因素证据分至少 78
- 独立支持因素至少 6 项
- 严重数据缺口必须为 0
- EV 至少 +2%
- 必须与官方市场首位及让球判断一致
- 市场走势或外部市场反向时不晋级

未通过 precision gate 的方向仍可进入参考/影子层，不删除研究样本，不回写历史冻结方向。

## 每日精选组合分析

`dailyFeaturedPlans.ts` 只消费 precision-qualified 正式 BEST：

- 精选 2 场：恰好 2 场，总 SP >= 2.50
- 精选 3 场：恰好 3 场，总 SP >= 5.00
- 同一比赛只能出现一次
- 候选不足或总 SP 未达门槛时不强行输出
- 组合优先级以证据分和模型概率为主，高 SP 只用于满足硬门槛，不作为提高排序的理由

这是一层赛前分析展示，不包含自动下注、账户连接或下注执行。

## 复盘

`buildHistoricalFeaturedPlanReview()` 只读取不可变的 `archivedPreMatchPrediction`：

- 不读取赛后盘口生成新方向
- HAD 按 90 分钟赛果结算
- HHAD 按冻结时的整数让球线结算
- 2 场和 3 场组合分别统计命中、未中、待结算和作废
- 组合统计与单场正式 BEST 命中率保持分离

## 验证

```bash
node scripts/verifyRecommendationPrecisionPolicy.cjs
node scripts/auditRecommendationPrecisionPolicy.cjs
npm run validate:data
npm run build
```

`auditRecommendationPrecisionPolicy.cjs` 对冻结历史做 baseline / precision cohort 对照。由于历史归档不保证保存所有瞬时运行字段（例如完整 modelGap 与 risk penalty），审计会明确标记 `exactPolicyReplay=false`；它用于验证方向和筛选幅度，不替代完整 as-of replay/backtest。

正式上线前，应继续使用现有 prediction replay / backtest 管线验证新 policy 的时间前推表现，不能因为同一批历史样本上的结果更好就直接认定未来命中率提高。
