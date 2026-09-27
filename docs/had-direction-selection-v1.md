# HAD价值方向选择 v1

## 为什么最近全部变成正路

统一发布链路此前固定将 `probabilityModel.oneXTwo.final` 的绝对最高概率作为HAD正式方向。即使平局或非热门方向相对同场竞彩SP的去水市场概率存在明显优势，只要它不是模型绝对第一，就没有进入正式推荐的路径。

已有 `outcomeCategoryResearch` 能识别 balanced-draw / upset-signal，但它是 research-only，不能改变正式方向。因此它只能提示冷门和平局，无法真正进入发布和串关。

## 新规则

默认仍取模型概率第一，不设置每天几个冷门、几个平局的配额。

每个方向用同一冻结时点的完整HAD SP去水后计算：

- 模型概率
- 去水市场概率
- 概率优势 = 模型概率 - 去水市场概率
- 模型EV = 模型概率 × SP - 1
- 与模型第一方向的概率差
- 与模型第一方向相比的概率优势增量
- 与模型第一方向相比的EV增量

只有满足全部条件，非第一方向才允许覆盖默认方向。

### 平局覆盖

- 模型平局概率 >= 27%
- 距模型第一 <= 9个百分点
- 相对市场概率优势 >= 3.5个百分点
- 模型EV >= 4%
- 概率优势比模型第一至少高2个百分点
- EV比模型第一至少高3个百分点
- SP <= 4.20
- 同场市场最高去水概率 <= 56%

### 非热门胜负覆盖

- 模型概率 >= 28%
- 距模型第一 <= 10个百分点
- 必须不是市场热门
- 相对市场概率优势 >= 4个百分点
- 模型EV >= 5.5%
- 概率优势比模型第一至少高2.5个百分点
- EV比模型第一至少高4个百分点
- SP <= 4.20

## 明确不做

- 不因为当天全是热门就强行制造一个冷门。
- 不按照高SP直接选冷门。
- 不允许极端长赔仅因为算术EV大就进入正式方向。
- 不用赛后结果修改已经冻结的方向。
- 不声称加入冷门后未来命中率一定提高。

## 单场和串关一致

正式单场一旦通过该规则选择平局或非热门，HAD串关直接引用该冻结方向，不能重新按概率最大项改回热门。

让球HHAD继续使用自己的完整净胜球分布，不套用本HAD规则。

## 审计与复盘

新决策冻结：

- directionPolicyVersion
- mode: model-leader / market-edge-override
- category
- modelLeaderCode
- marketFavoriteCodes
- marketRole
- selected probability / market probability / edge / EV
- leader deficit
- edge advantage / EV advantage
- 完整三项结果及阈值版本

赛后质量报告新增：

- model-leader vs market-edge-override
- favorite vs draw vs nonfavorite

每组分别记录样本、命中率、Brier、LogLoss和冻结SP的一单位回报。历史旧记录没有该字段时继续按原模型第一方向规则验证。

这套分组是前瞻验证入口，而不是冷门配额。只有真实冻结样本持续证明某类方向有帮助，后续才考虑调整阈值。
