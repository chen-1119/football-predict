# 候选特征准入修复（独立于旧历史交付）

本次修复以 `2d20938a13463294977696cc2fcef92bc746c902` 为基线，只修候选输入与时钟校验。旧 `outputs/history-regression-20261002/delivery-receipt.json`、历史输入和报告均保留原始字节；旧回执不代表验收了本次修复。新回执位于 `outputs/history-feature-admission-20261002/verification-receipt.json`，分别绑定新代码、测试、旧回执和原输入 SHA。

## 原问题与契约

旧接口只检查 `availableAt`，可能接受先填早期可用时间、但观测/接收发生于决策后的字段。禁止词正则也漏过 `finalScoreHome` 等命名，可在合成样本中泄露结果并得到虚假的零 Brier。这不是原 154 场冻结评分被污染的证据。

`prematch-scalar-features-v2` 的规则：

- `features.candidateEligible` 必须严格等于 `true`。逐字段仍需通过以下全部检查；上游资格不能替代字段校验。
- 只开放已经列入代码契约的标量 `elo`、`form`、`weather`；未知名称和任意命名形式的赛后字段均拒绝。新增名称必须先审阅语义与来源；不能由候选自己扩展白名单。
- 值只允许有限数或布尔值；必须具备非空来源、64 位小写十六进制 payload SHA。字段或分组明确缺失、不可用、排除或字段声明 `candidateEligible:false` 时拒绝。
- 必须提供原始 `providerObservedAt`、`receivedAt`、`availableAt`。`observedAt` 为可选的原始观测钟；声明时必须校验，未声明时保持缺失。任何缺失时钟都不回填。
- 每个时钟使用共享 `strictInstant` 检查带时区格式及真实日历日期。顺序为 `providerObservedAt <= observedAt（若声明）<= receivedAt <= availableAt <= decision.at`；每个时钟还独立检查不晚于决策，并用纳秒整数比较以避免毫秒截断。等时合法，不改写原时区与精度文本。
- 在 JSON 复制前审核原对象，防止 `undefined` 被删掉或 `Date` 对象被自动转成合法字符串。全局 replay 时钟同样使用严格日期解析；原有效数据的概率与评分公式不变。
- `fit`、`calibrate`、验证预测、最终测试预测均只接收通过本行审计的字段。`report.featureAdmission.rows` 按比赛和决策保留原输入 hash、候选资格、合法字段的原始钟，或拒绝原因与声明钟；协议 hash 包含特征契约。

来源和 payload SHA 只是审计绑定，不独立证明供应商授权或数值真实性。接口继续要求调用方先完成上游准入，候选代码仍是受审阅的可信纯函数。历史生产字段仍为 `candidateEligible:false`，本次没有让任何实际历史字段取得新的训练资格。

## 本地验证

新验证器从本地既有输入重新做签名、时钟准入和完整冻结报告比较，核对 432 场导出、180 场原预测可评分、154 场同决策市场配对；模型/市场 Brier、LogLoss、准确率、逐场集合与置信区间均须与旧报告完全一致。原训练可用数 `[0, 2]` 与最终测试 47 场保持不变，仍不能选出合格候选。

```powershell
node scripts/historyRegressionFeatureVerification.cjs outputs/history-feature-admission-20261002
```

首次生成新回执使用 `--write-receipt`（只允许创建新文件），同时运行本地 Node 合成测试；后续默认只验证回执文件 hash 和重新核验真实冻结证据。回执不覆盖旧文件。Python 导出器未改，本轮不重跑其测试、不重采生产数据。

04 的独立测试通过其既有两个环境变量运行：`QUALITY_HISTORY_EVIDENCE_ROOT` 指向新输出目录内固定旧 commit 的本地基线，`QUALITY_HISTORY_IMPLEMENTATION_ROOT` 指向本次 05 代码。最终对比使用两个源文件的原字节快照 `external-snapshot-1e0d549176a9/`，记录原路径和 SHA；同一快照分别运行原版与修复版，结果为 `before-final3.json`（38/50）/ `after-final3.json`（50/50）。测试 SHA 为 `6d3de620d836f5ccfe1bb6552f417d8c074f081a9952a4ad7d898763f823ac5b`，验证器 SHA 为 `d52b3f01b86f681347146ac18373d4e946b17b159bfd3bcd711a3b19828ab859`。没有修改 04 的任何文件，旧基线副本和中间运行不纳入提交。

所有合成正反例仅证明软件边界；不证明模型精度提升。`productionEligible=false`，没有生产写入、部署或新一轮线上数据采集。
