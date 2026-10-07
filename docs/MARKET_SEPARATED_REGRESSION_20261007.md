# 按市场分开评估冻结推荐

`scripts/marketSeparatedRegression.cjs` 只读取新取得的线上只读导出，产生本地研究报告。没有采集、SQL、网络、训练、写推荐或改旧记录的入口。

## 输入与运行

输入为正常 `readMarketSeparatedRegression.cjs` 的 `market-separated-production-readonly-export-v1`：同一 PostgreSQL `REPEATABLE READ / READ ONLY` 事务的原决策、完整结果头、当前或历史 provider 行、运行标记、PG 代际及两市场分页投影。最多 500 个源事件、1,000 个 provider 行、20 页、32 MiB。报告校验这些绑定，保留输入内容哈希；生产只读来源由 reader 的固定 SSH 与原响应回执证明，JSON 自称 `readOnly` 不等于外部验签。

```powershell
& '<固定 Node22 路径>' scripts/marketSeparatedRegression.cjs --input '<本轮线上导出.json>' --output '<新的研究报告.json>'
& '<固定 Node22 路径>' --test tests/market-separated-regression.test.cjs
```

CLI 输出必须为新文件，保留原输入字节与原冻结 `recordHash`。业务日期来自冻结记录；7/30 日窗口以导出的实际观察时刻在北京时间的日期为锚。窗口超出导出范围会明确标记覆盖不完整。

## 四条统计线

1. **原冻结 HAD**：原 `tipCode`，即使它是旧主方向的条件分支也不改写。
2. **HAD argmax 研究**：对原冻结胜平负向量取唯一最大值；完全相同的最高值不强行选边。它是对旧概率的事后研究，不是新模型预测。
3. **原冻结 HHAD**：保留原政策对应的方向，按整数让球数与政策版本分层。缺 HHAD 不借 HAD；缺本市场 SP 不参与市场基线与价值筛选。概率评分仅用完整无条件向量，旧条件概率向量不能混入无条件 Brier/log loss。
4. **原唯一主方向**：只读取旧 `coherentPrimary` 明确封存的 anchor。未存唯一 anchor 的旧独立市场版本报告缺失，不通过概率比较补造。

本工具不跨 HAD/HHAD 比较裸概率，也不把“胜+平”或“平+负”的集合当成新的胜平负首选。内部 `validDecision` 仍按原政策重放旧冻结完整性，不表示新策略延用该选择方式。

每个相同源比赛/准确开球事件只保留截止前已发布、最新且无歧义的一条有效冻结。重复页、两市场行、反复报价和不同发布批次不能扩充独立比赛分母。同一时刻不同冻结内容或有序球队身份冲突单列排除。冻结、模型、报价和实际观察时间均校验；纳秒比较保留 PG 微秒知识边界，旧毫秒事件身份不能借舍入合并伪造的子毫秒事件。

## 结果与评分边界

`admittedLedgerMetrics` 沿用完整、有效、同事件/有序球队/修订/观察时刻绑定的生产准入结果账本。Sporttery 来源仅允许 `sporttery:official-api`、`sporttery:official-correction` 与 `sporttery:sqlite-fast-result-receipt` 三个现有发布路径；没有泛 `sporttery:*` 或 generic/null 来源回退。VOID 仅接受正式 API 来源。内部结果哈希证明留存完整性，不等于这轮重新向站方取证。

UEFA、官方俱乐部、K League 的完整 regular-time 证据沿现有准入验证器重验，并精确校验其观察时刻不晚于结果账本观察时刻，始终为结算补充、不作训练准入。`verified90Metrics` 单独报告具有可重验留存 regular-time 补充证据的子样本；不会把仅有 Sporttery 账本的样本混入该分母。全局 `provider90Reverified=false`。同事件、有序双方、显式同修订的可信 FINAL provider 行有比分冲突时列 DISPUTED；明确加时或点球比分时拒绝。未知来源、未知修订或当前行缺失不能否定正式账本，也不冒充再次取证。

只将可信 FINAL 纳入命中、Brier 和 log loss。PENDING、VOID、DISPUTED、UNVERIFIED_RESULT 分别计数，不算失误或 0-0。FINAL 观察不能早于开球；官方 VOID 可在开球前取消。Brier 是三分类平方误差之和的均值（范围 0–2）；log loss 用自然对数，真实结果概率为零时明确记 `logLossInfinite=true`，不裁剪成好看的分数。

模型与同冻报价去水基线的正式比较使用同市场、同整数 line、相同有完整概率/报价且报价时间合格的 FINAL 子样本。报价与冻结间隔超过原 15 分钟，或报价在冻结后，不能参与市场基线。模型年龄单列，并沿旧冻结模型合同验证，不凭空给所有旧版本添加新的模型 TTL。跨政策和旧条件分支的命中汇总需要查看分层，不能直接当新版本成绩。

## PRD 价值诊断

每条候选只在自身市场内计算：

- `expectedReturn = p × SP > 1.05`；
- `edge = p - 去水同市场概率 > 0.05`（5 个百分点）；
- 两项均满足，且有同冻、有效的本市场报价，才列为研究价值候选。

未校准概率与市场偏差不能直接变正式推荐。价值候选数量及其中已结算的分子分母另列；该事后筛选子样本没有独立 OOS 资格，也不能宣布模型优于市场或命中率提升。下一阶段仍需严格历史知识时钟、零市场训练基线、时序样本外验证与前瞻冻结。
