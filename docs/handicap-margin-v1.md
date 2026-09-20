# 让球净胜球逻辑 v1

## 目标

胜平负唯一首选与让球玩法分开计算。主胜并不自动等于让胜或让平；让球结果由完整净胜球分布决定。

以主队让1球为例：
- 让胜：主队90分钟净胜至少2球。
- 让平：主队90分钟恰好净胜1球。
- 让负：主队90分钟净胜不足1球（含平局、客胜）。

主队让2球时：
- 让胜：净胜至少3球。
- 让平：恰好净胜2球。
- 让负：净胜不足2球。

客队为强势方向且主队受让时同理反向计算。

## 概率来源

优先使用本次赛前模型 calculationTrace.poisson.lambdas 的主客进球均值，回退到本次 expectedGoals.final，再回退到 lambdaBlend.market。使用 Poisson 全比分矩阵计算 goalDifference = homeGoals - awayGoals，再根据带符号 handicapLine 计算：

- 让胜：goalDifference + handicapLine > 0
- 让平：goalDifference + handicapLine = 0
- 让负：goalDifference + handicapLine < 0

只支持竞彩三项让球所需的非零整数让球线；半球/四分之一盘不套用三项让平逻辑。

## 发布与复盘

让球分析作为 unified decision 的不可变子记录保存。HHAD输入变化会生成新的统一decisionId，不覆盖旧版本。单场HAD与2串1/3串1仍使用原统一胜平负方向，串关规则不改变。

如果同节点存在新鲜完整 HHAD SP，则仅作为市场参考一起保存；没有新鲜HHAD SP时仍可展示模型净胜球分析，但不伪造让球SP。

赛后使用同一个官方90分钟赛果事件结算：
- HAD按原胜平负统计。
- HHAD按保存的让球线单独统计。
- 让球命中率与HAD、2串1、3串1分开，不混算。

## 边界

该逻辑修复“主胜后如何区分让平/让胜”的结构问题，不保证未来命中率提高。模型仍需用真实冻结样本做时间前推验证，尤其观察大让球（±2及以上）的概率校准与实际覆盖率。
