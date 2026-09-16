# 每日独立串关：不依赖正式单场推荐

## 已实现的规则

- 每轮从当天 PostgreSQL current 比赛读取完整模型胜/平/负概率与真实在售 Sporttery HAD SP，不使用 `recommendationAction`、正式推荐数量或模型晋级状态作串关前置条件。
- 每场只取概率最高的唯一 HAD 方向。不从最低赔率反推方向；平手不随机选；无完整概率不编造概率；不混入 HHAD。
- 枚举不同场次的2串1与3串1。组合原始 SP 精确达到2.50/5.00才合格；不先四舍五入过线。不再限制单腿SP<=2.60，也不要求66/70/74的正式证据分。
- 满足 SP 后按模型概率乘积对应的对数和排序。该排序采用独立性近似，**不宣称得到已校准的组合命中率**。新算法并未证明能提高未来命中率。
- 同场、共享球队不重复；冲突身份、过期报价、已开赛、已停售和错误竞彩日不进入新组合。
- 原有正式单场推荐资格和正式成绩不改动。新的组合使用 `independent-combo` 独立统计，旧冻结组合仍保留原内容。

## 页面与运行路径

`independentComboSelection.cjs -> dailyFeaturedComboLedger.cjs -> PostgreSQL daily_featured_combo_state -> 已有带访问权限的 /api/v1/daily-featured-combos -> DailyFeaturedCombos`

`/best` 与 `/betslip` 都使用同一个服务端结果，不在浏览器重复挑选。兼容 `enabled` prop，但它不再参与串关显示判断。2串1与3串1分别选择自己的冻结记录或即时方案，避免其中一个已冻结就隐藏另一个预览。

白天展示即时方案，不等正式推荐。原有冻结时点不变：工作日21:00、周末22:00，北京时间。每个竞彩日每种组合只冻结一次；按工作日22:00/周末23:00以及更早的开赛、实际停售时间停止新增。跨零点不重置旧日截止。原有每5分钟任务继续执行，无新定时任务或新迁移。

冻结中保存源比赛ID、eventVersion、每腿方向/完整概率向量/概率生成时间、完整报价、报价来源与时间、quoteHash、原始SP、策略版本及publication身份。重跑不改旧腿；赛果结算沿用官方结果及VOID规则，只更新settlement列。

## 验证记录与边界

本轮本地运行：

```
node --test scripts/verifyIndependentCombos.cjs
node --test scripts/verifyIndependentComboView.cjs
```

32项筛选/冻结/写入调用契约测试通过，6项显示策略测试通过。写入调用契约使用数据库适配器桩，**不是真实PostgreSQL集成验证**。显示辅助模块完成独立严格TypeScript检查，三个TSX文件完成转译语法检查，**不等于完整应用构建或浏览器验收**。

原 `verifyDailyFeaturedComboLedger.cjs` 已更新模型排序输入与“影子模型仍可独立组串”期望，保留官方结算/冻结/VOID回归。`verifyDailyFeaturedComboPostgres.cjs` 保持原有真实数据库回滚验证路径；这两项未在本轮本地执行。发布前仍需在完整仓库执行原回归与 `npm run build`。

此次不修改采集器、Worker生命周期、数据库迁移、既有单场晋级规则或线上历史数据。提交代码不是已经部署到生产。
