# 优化方向1：正式发布与模型验证解耦

## 产品契约

正式发布表示服务端已在截止前持久保存本次唯一首选、完整概率、原始SP、数据时间与版本，之后可按该记录复盘。它不表示中国竞彩网为预测背书，也不表示模型已验证盈利或准确性。UI使用“正式发布的单场推荐 / 模型验证中”，并将新口径单独统计，不重命名旧的“已验证正式”历史成绩。

有完整有效赛前数据的当天场次可以发布，不依赖BEST标签、recommendationAction、全局模型晋级、历史样本数或66/70/74证据分。绝不为非空输出补造数据、赛后预测或平手的首选。

## 算法与发布

1. 对全量三项概率严格解析：null/空值不是0；百分比按实际总和归一化，不把99.9直接除100。唯一首选为模型概率最高的一项。
2. 竞彩HAD完整报价与其来源、时间、比赛ID整体选择。去水市场概率和模型概率分别保留，避免重复把市场加权后伪称校准概率。
3. 不按SP高低改方向；不因SP>2.60直接排除。期望值只记录为基于未验证模型的估计，不宣称真实收益。
4. 当前仅发布HAD。HHAD仍保持单独的整数让球与既有资格；不把大让球统一改成让胜，也不为了用户反馈把比分机械调大。
5. 每个来源事件/玩法一次发布：写入并读回核对记录哈希。原始payload受数据库UPDATE/DELETE触发器保护。新赛果和显式更正作为追加事件，重复执行幂等。
6. 保留停售、开赛、竞彩日、未来数据、模型和赔率时效检查。事务提交前再检查截止，不倒填发布时间。SERIALIZABLE失败重试整轮读取。

## 已接入代码

`dailyFeaturedComboLedger.run -> persistLedger -> persistPublishedForecasts -> PostgreSQL -> daily_featured_combo_state.publishedForecasts -> 现有受访问控制的/api/v1/daily-featured-combos -> 共享useDailyFeaturedCombos -> PublishedForecastPanel`

使用现有5分钟后台任务，不增加一个要手动启动的新定时器。单场与组合走独立资格，单场0条不阻止组串，组合0条也不阻止单场发布。数据读取/写入错误仍保持上一个已提交产品状态；数据库迁移必须在服务启用新版本前完成。

目前新发布记录与复盘放在现有精选/组合入口的上方，可切换“赛前推荐”和“发布记录与复盘”。**没有改写旧 `/review` 的已验证模型统计**。新面板明示统计口径，避免把“新发布”混同“旧已验证”。

## 新增数据表

迁移010只新增 `published_forecasts` 和 `published_forecast_results`，没有历史回填。

先使用现有项目迁移流程安装010，并按现有运行角色授权方案给这两个表SELECT/INSERT和结果序列USAGE权限。运行进程不执行DDL。旧正式推荐台账、旧冻结组合与历史比分不更新。

## 修正原正式资格误拒

原资格消费者仅接受 `multi-factor-market-evidence-v2`，生产者已输出dynamic-v4。CJS/TS现在兼容明确列出的v2、dynamic-v3、dynamic-v4，未知版本仍拒绝。旧已验证正式门槛中的来源、证据、盘口和全局验证检查不取消。该兼容修正不能把没有真实赛前凭证的旧参考升级。

## 前端

复用同一个API和轮询Hook，加入发布台账解析。单条显示编号、对阵、唯一首选、三项概率、原SP、发布时间与赛果。未结算不显示0%命中率，字符串赔率不冒充数值。失联保留上次冻结记录，并显示状态。原组合展示中的未校准排序分不再标成概率。两个串关门槛仍为2.50与5.00，不修改既有串关方向选择公式。

## 验证边界

本轮本地：50项Node测试通过，0失败/0跳过；4个纯TypeScript服务模块strict检查通过；两个TSX组件与Hook语法转译通过。

测试覆盖：全部为参考仍可发布、无BEST、动态证据版本、概率归一化、与最低赔率相反的首选、SP>2.60、唯一平局、停售与跨日、写入读回、不可变记录、同场去重、重复执行、官方赛果适配器、赛果冲突/更正、Brier和log loss、前端旧接口兼容、未知值、计数与结果一致性。

数据库调用测试使用内存适配器，赛果可信性使用显式测试验证器。这不等于真实PostgreSQL或整个既有生命周期模块集成通过。另提供 `scripts/verifyPublishedForecastPostgres.cjs`，必须显式指定本地测试数据库，使用独立schema和ROLLBACK；本轮未执行，因为环境没有pg依赖/数据库。

未执行完整React/Vite构建、生产数据库迁移、真实历史回放或生产部署。概率、排名和准入改动尚未通过新的时间前推检验，因此不声称命中率改善。

验证命令：

```bash
node --test tests/published-forecasts.test.cjs tests/published-forecast-view.test.cjs
FORECAST_TEST_DATABASE_URL=postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1/TEST_DATABASE node scripts/verifyPublishedForecastPostgres.cjs
npm run build
```

只使用已冻结记录作后续模型对照。命中率、Brier、log loss、可靠性分箱和同节点市场基准分别记录；任何单一指标改善都不能替代完整样本外检验。
