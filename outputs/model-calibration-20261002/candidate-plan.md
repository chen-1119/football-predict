# 第二批：模型证据、候选隔离及输出资格

## 当前结构与不足（基线6fce180，只读证据）

- scripts/syncData.cjs:1394、1574：Poisson进球/胜平负；1860、1927、1966：近期状态、联赛先验、独立lambda。2174：市场、球队强度、Elo、Poisson及世界杯先验按baselineEnsemblePolicy混合，记录算术输入凭据。
- scripts/syncData.cjs:2263：胜平负校准是按历史命中率分桶降温及联赛规则修正；2345附近保留校准前领先方向。它不是已证明有效的统计概率校准器，方向保留可能约束重新校准效果；不能仅凭代码断言主胜偏差或删除规则。
- scripts/syncData.cjs:194、6360、6698：自动放宽已有50场/4比赛日保护；冷桶降温与放宽不同。保持所有门槛不变。
- scripts/syncData.cjs:9306：统一Poisson/Bayes后验；候选选择、风控及展示是不同阶段。推荐置信度与概率、价格分离，见src/services/recommendationConfidence.cjs:97附近。
- src/services/handicapCalibration.cjs:37-59：按比赛日最后25%（至少2日）留出，训练只用留出开始前观察到的结果；同一留出集又决定active，因此这是选择/校准验证，不能充当独立最终测试。样本是冻结HAD命中条件下的让球分布（66-96），不能推广为全体胜平负校准。
- 已提交diagnostic.json的严格145场模型Brier/LogLoss较市场差，仅7场高置信度分箱；不能调参数或声称提升。

## 候选比较方案

预注册协议、候选列表与实现哈希，固定训练/校准/最终测试时间窗及比赛日块。训练阶段拟合模型或比较预定义候选；校准阶段只拟合概率校准并锁定候选/校准器；最后独立时间窗只评估，不能据其结果选择候选。若最终测试失败，新的候选应等待新的未来测试窗，不能重复使用已看过的测试窗。历史探索只能标记research，不能伪造过去的预注册时间。

对照组：冻结生产概率、同决策官方去水市场；候选先用身份校准与现有已注册温度/残差候选，复用candidateProspectiveLedger.cjs和现有challenger suite，避免重复注册。任何新温度/联赛参数只在训练与校准窗拟合，本批不拟合。

05统一完成去重、缺失及时钟准入；所有对照使用同一个事件集合和赔率时点。概率评分使用三分类Brier/LogLoss，选择事件评分复用recommendationPairedEventScoring.cjs，二者不能混比。主平客/联赛报告样本、均值预测减实际比例、校准分箱及比赛日分块区间；低样本保持未知，不以全中率替代收益或可信度。资格提升继续走既有全部门槛，不由本接口授予。

## 纯函数接口（尚未接入生产）

- scripts/recommendationCandidateProtocol.cjs：检查训练/校准/最终测试manifest的非重叠时间、比赛日块、结果观察与锁定时钟、哈希及已有准入验证器结果。返回blocked或ready-for-shadow-evaluation，永远promotionEligible=false；不做历史导出/回放。
- src/services/recommendationOutputQualification.cjs：等待资料=概率/同决策/输入证据缺失或严重缺失数未知；分析参考=资料完整但任一既有策略、风险、晋级、鲜度、源健康、可靠性或开放截止门槛未过；可发布推荐=全部既有验证结果显式true。已截止归为分析参考，不能被等待新资料恢复为可发布。该适配器只消费可信验证器结果，布尔值不是验证凭据，不直接写展示/发布/冻结记录。

## 交给总控和05的字段需求

使用05导出既有冻结逐场数据，不新增共享schema：事件/sourceMatchId、联赛、比赛日块、decision/captured/model/feature/odds observed/received/cutoff/kickoff时钟；冻结三分类概率（原始/现有校准/统一后验）与同决策HAD赔率；输入证据、严重缺失数及未知标识；可信结果与结果观察时钟；快照、结果、来源及事件集哈希。评价manifest另附各时间窗rows/eventSetHash/calendarBlocks/latestResultObservedAt，以及注册/候选锁定/校准锁定时间和实现哈希。

需要可信导出校验器证明commonCohortVerified/frozenInputsVerified；本接口仅检查声明，不独立校验逐场事实。没有共享文件集成补丁。尚缺逐场导出、实际预注册及最终测试证据；本批只交协议验证器与适配器提案，不称完成训练、样本外检验或性能改善。

定向验证：node scripts/verifyRecommendationCandidateProtocol.cjs。覆盖10种时序/污染/证据破坏与12个资格字段逐一缺失，输入不变。生产、UI及冻结决策均未修改。
