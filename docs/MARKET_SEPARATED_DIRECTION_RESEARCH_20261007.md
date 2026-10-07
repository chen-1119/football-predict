# 分市场方向与价格研究接口

本次仅新增纯研究模块、合成测试和本文档。模块不接正常 publisher、生产 PG、模型 registry、旧 selector 或串关生成器，也不改变已封存预测。它复用 `zeroMarketResearchBaseline.cjs` 的已审核拟合制品校验；本模块作者没有读取真实277条拟合输入、重训实际模型或生成实际比赛预测。

## 按 PRD 的执行顺序

`原件及可用时钟 → 研究拟合 → 新目标身份/时间审核 → 独立预测冻结 → 后取得的分市场价格诊断 → 前瞻结果与校准验证 → 正式准入 → 唯一主方向`

| PRD 阶段 | 本次新增内容 | 当前验收状态 |
| --- | --- | --- |
| P0 数据地基 | 严格绑定已有来源、研究实体、目标事件和报价知识时钟 | 原件/许可/覆盖/官方 SP 与五时点的完整性仍须逐项补齐；本接口不代替采集 |
| P1 基线模型 | 完整重放既有拟合制品，并核参数到同一比分 grid 的预测冻结 | 已有277条、20个源内实体的受限研究拟合；没有样本外/市场增益证据，不代表 P1 验证通过 |
| P2 因子与价值筛选 | HAD 球队倾向、HHAD 单市场分布、严格双阈值价格诊断 | 阵容/伤病/xG/体能仍为空；没有分市场校准适配器或正式价值推荐 |
| P3 纸面实盘 | 支持新的只追加研究报告，等待后来同事件赛果配对 | 前瞻窗口、CLV、正式500同场/6窗口/3残差 fold 等准入未完成 |
| P4 迭代 | 保留模型/来源/预测/报价 hash，供后续独立复盘 | 未自动调权重、未晋级正式模型；每次改动仍需样本外验证 |

40/35/25 或球队因子初值不能冒充已学习、已校准参数。本接口不会将它们混入纯研究概率，也没有改变原线上模型的10%/15%市场先验。当前阶段未完成，继续按 PRD 补证据及验证。

## 分开市场，保留一个预测

`assessMarketSeparatedDirectionResearch({ artifact, forecast, quotes })` 使用实际运行时钟，不能传入过去的 `asOf`、`calibrated=true` 或自称通过的校准统计。

`artifact` 必须通过原模块完整确定性 optimizer 重放，包括标签、来源审核、参数、目标函数和收敛报告。`forecast` 必须是对应制品生成的完整研究冻结；新接口重验事件/有序球队/来源实体/时间审核、模型可用时刻、预测开始与完成时刻、截止/开赛、训练污染、双 hash，再从参数重算 λ 和完整同一 grid。重封修改过的概率、λ、球队因子或正式状态不能通过。

- `teamBaselineTilt` 仅为 HAD 自身最大概率的球队基线倾向；并列时 `code=null`，保留并列代码。
- `markets.HAD` 和 `markets.HHAD` 分别保留自身完整 H/D/A 分布、各自让球数与市场内概率排序。
- HHAD 按 `主队进球 + 整数让球` 与客队比较，是合法的比分事件聚合。宽事件概率高是数学结果，不等于跨市场选它的依据。
- 不执行跨 HAD/HHAD 裸概率排序，不人为配正路/下盘比例。全局比分 Top3、原始质量和尾部误差原样显示。
- `formalEligible=false`、`productionEligible=false`，`primary/companion=null`；没有为满足展示凑出唯一主方向或串关。

这里的整数 HHAD 不等于亚洲半球、半一等盘口。亚洲盘口及走势需要另行明确来源、历史序列和结算合同，不能填入此整数接口。HAD 与 HHAD 的方向是否同时成立，应按实际让球数和比分集合判断；本接口不产生两个同时下注的方向。

## 冻结后的价格元数据

`quotes=null` 或 `{ HAD:null, HHAD:null }` 时仍可查看已验球队倾向。缺价不能借另一市场的 SP。价格对象版本为 `market-separated-price-metadata-v1`，必须包含下表所有字段并使用原基线稳定 hash 生成 `contentHash`。

| 字段 | 合同 |
| --- | --- |
| `forecastContentHash`, `predictionHash` | 精确绑定已冻结预测 |
| `market`, `handicapLine` | HAD 为0；HHAD 为该预测的整数让球数 |
| `sourceNamespace`, `sourceRole` | 分别为 `sporttery:HAD` / `sporttery:HHAD`，角色 `official-jc-market-price-metadata` |
| `rawEvidenceSha256` | 本次价格元数据取得的固定原响应 hash；可以绑定只读 PG 原响应，但不因此声称已验证官方原始采集载荷 |
| `sourceEventRef`, `sourceMatchId`, `eventVersion`, `sourceNominalDate` | 与该预测的目标记录严格相同 |
| `orderedTeamIds`, `orderedEntityRefs`, `eventEvidenceSha256` | 有序球队和来源实体、目标审核证据绑定 |
| `observedAt`, `requestedAt`, `receivedAt`, `knownAt` | 来源记录保留的观察时刻、本次价格元数据实际读请求、完整响应收到、研究可用时刻分列；使用严格纳秒时间比较 |
| `odds` | 该市场完整数值 `{H,D,A}`，各 SP 必须大于1且不超过1000 |
| `contentHash` | 以上全部字段的内容 hash，不是来源签名或权限证明 |

必须满足 `frozenAt ≤ requestedAt ≤ receivedAt ≤ knownAt ≤ 实际价格校验时刻`；知识时刻须早于截止及开赛。本次元数据请求和收到两个时钟均须处于15分钟预算内；价格检查后再核实际结束时刻和截止。来源 `observedAt` 可以更旧，但不能晚于真实收到时刻。保持原件中旧更新时间，禁止为了通过审核将其倒填为预测时刻。

若本次从 PG 取得已有冻结报价，`requestedAt/receivedAt` 仅表示本次真实只读取得元数据的时钟，不能改称官方接口新采集时钟，也不能证明原报价新鲜。原 provider 时钟、原 collector 请求/收到时钟须在原响应及另外的私有研究报告中各自保留；本接口尚未独立验这些原采集回执。没有真实本次请求开始或完整响应收到证据时，保持 `quotes=null`，不得由生成时间减几毫秒构造时钟。先对真实行的事件、有序球队、市场和 line 核对，再填写绑定字段，不能直接复制预测身份掩盖原行不匹配。

同价后来再次采集仍是新的观察；此接口不推断首次价格 episode。它分列 `predictionAsOf`、`priceMetadataCheckedAt`、`asOfPrice` 与采集时钟。后来取得的 SP 只作事后于预测冻结的价格比较，不能冒称预测当时已知的 EV、收盘价、CLV 或正式冻结价格。

单市场归一化隐含概率为 `(1/SP) / Σ(1/SP)`，只用于相同市场的价格诊断。基线概率本身不随 SP 变化。诊断屏严格要求 **`p×SP > 1.05` 且 `p−归一化隐含概率 > 0.05`**，另要求 grid 尾部不超过 `1e-6`；阈值尚未验证，不能当学习出的获利规则。截断概率的 `conditional-on-finite-grid-support` 含义和尾部上界均保留。

本版价格仅验证元数据内容及身份/时间绑定，`sourceVerified=false`。即使 `thresholdScreenPassed=true`，所有 `researchValueEligible` 和 `formalEligible` 仍为 false，因为真实签名载荷、价格提取原件与分市场校准适配器尚未接入。未知字段、错身份、错来源、错 line、缺价或过时价格仅使对应价格诊断不可用；不以零价或别的市场补齐。

## Root 的受限调用方式

先在私有 runner 中完成现有 `forecastZeroMarketResearch({artifact,event,approval})`。审批、来源映射、时区、未来开赛和销售状态必须是新的真实证据；没有审批时保持 blocked。此模块不能自动批准六场目标，也不能将旧纸面记录或最近取得的标签倒填为旧知识。

以下是 runner 的调用段；该段本身不读文件、不访问网络或写生产：

```js
const research = require('./src/services/marketSeparatedDirectionResearch.cjs');
const result = research.assessMarketSeparatedDirectionResearch({
  artifact: verifiedFitArtifact,
  forecast: newlyFrozenResearchForecast,
  quotes: null, // 或真实新观察的逐市场完整价格元数据
});
// Root 仅向全新私有文件以 wx 保存 result；不覆盖原 freeze/fit，不写线上。
```

文件中的 `H/D/A` 分别指该市场的主胜/平/客胜，HHAD 必须同时显示让球数。Node22 验证命令：

```text
node --test tests/market-separated-direction-research.test.cjs tests/zero-market-research-baseline.test.cjs
```

测试全部使用合成标签、事件和价格。源码安装、研究报告、纸面冻结、训练效果、正式模型激活和线上发布是不同状态。本次没有完成分市场校准、真实前瞻效果验证或线上策略切换。

## 独立审查重点

核完整 forecast 重放及完整制品 hash；核双方有序身份和实际截止钟；核 SP 换值不改变预测，HHAD 高概率不压 HAD；核双阈值 AND、缺签原件仍不可准入；核假校准声明/重封 grid/旧知识/未来钟/数组原型改写不能绕过；核三个新增文件没有任何正常 publisher、PG、registry 或旧 selector 的接入。
