# 市场实际链路与jointGoalFit审计

基线6fce180及本分支读取，不改共享scripts/syncData.cjs。

## 确认的文本不一致

syncData:249的基础混合描述正确；:269/:276的“官方SP只作为市场校验”与数值链路冲突。附件market-role-wording.patch仅改中英文说明，供总控合入，不调系数、不改发布门槛。

补丁为零上下文格式；定向检查使用 `git apply --check --unidiff-zero outputs/model-calibration-20261002/market-role-wording.patch`，已通过。普通git apply --check不接受此格式；总控应用时需显式--unidiff-zero并复核两句内容。本分支未应用补丁。

## 每阶段实际系数

1. 无官方赔率路径：syncData:11441标记model-only-no-official-sp；不应将此局部路径含义推广为全部模型。
2. 有赔率路径：syncData:11696对HAD（或HHAD锚点）去水；进球lambda起点来自evidenceAwareIndependentProbabilities/independentBaseLambdas，再经联赛、近期状态、比分反馈、上下文与可选jointGoalFit。变量marketHomeLambda在此实际接independentLambda，不能按变量名认定其来源。
3. 基础概率：syncData:2174/2863直接将市场概率混入。baselineEnsemblePolicy:16-24的[市场,球队强度,Elo,Poisson]为：Elo+form=[.10,.15,.30,.45]；仅Elo=[.12,.18,.35,.35]；仅form=[.12,.24,0,.64]；cold=[.15,.35,0,.50]。世界杯先验可用时各项乘.82再保留3位小数，先验=.18；最终按总量归一化。权重是heuristic-baseline/unvalidated，不是本次学习结果。
4. syncData:2873-2876：基础混合继续经比分反馈和命中率降温。此处不是恒定线性系数，应保留before/after与调整原因。
5. 胜平负统一后验：syncData:7972-8068。辅助内部后验为final/scoreImplied/Poisson=.5/.3/.2；实际主后验稀疏时final=.44、score=.27/.29/.31、Poisson=.20、market=.07；资料足时final=.50、score=.27/.29/.31、Poisson=.15、market=.08。score取决于比分形态。weightedLogPosterior:7918以总系数除加权log概率（含bias），再exp并归一化。这些不是线性概率份额，不能把market=.07写成最终赔率贡献7%，也不能把其余93%称为已验证独立模型贡献，因为final内已含市场。
6. HHAD后验：syncData:8101用scoreImplied=.45、Poisson=.34与偏置，函数未直接使用传入hhadProbabilities；之后市场仍参与候选支持、冲突降级与价值比较（8720起）。无直接后验系数不代表完整链路从不受市场影响。

## 证据独立性

syncData:7983已有注释明确final、scoreImplied、Poisson共享输入；:8068将independentComponentCount设为1。Elo/球队强度/派生大小球标签不能累加成独立模型数或独立证据数。总控若调整8991/8994的“独立模型占比”说明，应说明它是后验内部系数、不是端到端贡献；本次只提供最小两句事实修复patch。

## jointGoalFit：已有能力及待证据

src/services/jointGoalFit.cjs:16-32区分历史实测stats来源，排除不合格结果及api-football xG；:49-94筛选早于当前截止的历史比赛，结果/stats观察时钟均不得晚于cutoff，同队至少8场结果且5场实测xG；:118起核验身份、asOf、内容哈希和重新汇总样本。门控存在，不新增同功能。

fit:155附近固定总量权重base=.60/xG=.18/历史over25=.22，主队份额base=.72/xG=.28；总量变化限±.35，份额限±.08。历史over25与历史xG同属历史进球输入，不能视为两个独立模型。syncData:11390与11770将其接入有/无赔率两条路径。

验证：node scripts/verifyJointGoalFit.cjs通过，验证实测、时钟、身份、哈希及双路径算术/派生输出。此为构造样本测试，不证明线上覆盖或收益。哈希已验证的9月30日matches-current导出仅1场sporttery_2041790，goalFitEvidence/jointGoalFit均不存在（0/1），不能外推历史覆盖。model-evaluation中未找到jointGoalFit覆盖/消融指标。

05字段补充：冻结goalFitEvidence内容与哈希、样本计数/观察时钟、jointGoalFit before/inputs/weights/output、对应无拟合基础lambda及各阶段概率；对同一合格冻结事件集合比较开启/关闭拟合的影子概率损失，主分析限制在证据可用集合，另报全体覆盖与排除原因。未获得该数据前不拟合新权重、不宣称消融收益。
