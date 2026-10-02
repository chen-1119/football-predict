# 04 对 05 历史接口的独立验收

## 状态与范围

本轮只修改 04 的专用验收文件与证据目录，没有修改 05、00、共享入口、生产数据或发布配置。历史证据锚定 `2d20938a13463294977696cc2fcef92bc746c902`；后续修复只切换受测实现，不改旧真实输入或旧交付回执。

`scripts/qualityHistoryRegressionEvidence.cjs` 独立检查原回执的 Git 锚、23 个文件哈希、原始响应绑定、同 generation、逐行准入、配对事件集、同决策赔率时钟、排除漏斗、指标/可靠性分箱、比赛日配对 bootstrap、训练/校准/验证/测试归属和报告身份。它不拟合候选，不新增导出器，不计算 ROI。

`tests/quality-history-interface.test.cjs` 包含真实证据检查、真实记录的内存负例、报告篡改负例及明确标记为合成的适配器探针。探针直接返回原输入的冻结概率，仅检查接口能拿到什么字段；合成结果不用于效果判断或晋升。

## 真实证据复算

45 项真实检查通过。原 23 个文件与给定 SHA 均匹配。432 场中有 180 场冻结概率可评分、154 场同决策官方 SP 配对；互斥去向是 154 准入、199 决策时钟拒绝、53 缺少冻结决策、26 缺少同决策 SP，合计 432。

输入是 9 月 30 日发布 generation，不是今日业务数据。逐场文件原对象哈希由固定远端导出器测量；本机核对捕获/响应/回执字节，复验采集签名与提取承诺，没有重新下载提供方 payload，也未在本地重新流式读取完整 127 MB/766 MB 原库。

| 同一 154 场指标 | 冻结模型概率 | 同决策去水市场 |
| --- | ---: | ---: |
| 三分类 Brier | 0.624795145287 | 0.559585287206 |
| 自然对数 LogLoss | 1.040060923366 | 0.942898226210 |
| 最大概率方向命中率 | 50.64935065% | 53.89610390% |

具体全精度值以 `outputs/quality-history-20261002/independent-evidence.json` 为准。可靠性分箱和按 21 个上海比赛日、1,000 次固定种子重采样得到的配对区间独立复算一致，浮点比较容差为 1e-12。模型减市场的 Brier 区间为 `[0.029707188257, 0.117658245442]`，LogLoss 区间为 `[0.047743526830, 0.169974943032]`，方向命中率差区间为 `[-0.089171974522, 0.022471910112]`。

这里的方向命中率是冻结概率 argmax 评分，不是原正式推荐命中率。154 场是新窗口/新准入口径，`historicalPublished145Reproduced=false`；没有复现旧严格 145 场，也不能把两者相减后称为提升。

独立检查训练/校准/验证/测试不混事件：两折训练时钟有效样本分别为 0、2，最终 47 场测试不能补训或选型。所有候选特征仍为 `candidateEligible=false`，特征存在和哈希不授予 replay 权限。协议承认此前已知聚合结果，本批属于回顾研究，不能称未触碰的前瞻确认。回放、原冻结概率复盘、原发布实绩分别报告，样本不足不晋升。

## 原实现发现与复现

以下行号指 **2d20938 的** `scripts/historyRegressionReplay.cjs`。总控已安排 05 修复。本任务保留严格失败断言，不把“当前会接纳”改成“应该接纳”。旧版完整测试日志保留在 `interface-tests-original-2d20938.tap`。

| 问题 | 原实现位置 | 可复现输入与后果 |
| --- | --- | --- |
| P1：未来特征观察/接收时间被旧 availableAt 遮蔽 | 145–147 | `weather` 的 availableAt 为当天 09:00、decision 10:00、cutoff 11:00、kickoff 12:00；providerObservedAt/observedAt/receivedAt 改为结果时间 14:00。旧实现仍把 value 交给探针并选入候选。缺失观察/接收时钟也需拒绝 |
| P1：部分结果字段驼峰命名绕过 | 141 | requiredFeatures 为 `resultObservedAt`、`finalScoreHome`、`closingOdds` 或 `postMatchRating`，提供外观合格的数值/来源/hash/availableAt；旧实现仍接纳。精确 `finalScore` 被拒绝，不能据此认为所有结果派生名已隔离 |
| P2：缺少明确候选资格被视为允许 | 138 | 删除 `features.candidateEligible`，保留数值和其余时钟；旧实现因只检查 `!== false` 而接纳 |
| P2：不存在日期被 Date.parse 归一化 | 35–39 | 将已准入记录的 result.observedAt 改为 `2026-09-31T15:00:00Z`；原冻结概率评分接口不抛错。该例仅为内存变体，原真实标签没有改动 |

复现命令（在 04 工作树运行）：

```powershell
node --test --test-name-pattern="synthetic required rejection" tests/quality-history-interface.test.cjs
```

这些是候选接口/结构验收缺陷，**不能据此断言真实 154 场评分已被污染**：真实样本没有可用于候选回放的字段审计资格，候选训练也已停机。修复后须先让有效对照通过，再要求上述负例全部被拒绝；只剩接口报错、让所有候选都无法运行，不算负例修复成功。

## 复验方式和联合集成边界

```powershell
node scripts/qualityHistoryRegressionEvidence.cjs ../05-history-regression
node --test tests/quality-history-interface.test.cjs
node scripts/runQualityHistoryAcceptance.cjs ../05-history-regression ../05-history-regression outputs/quality-history-20261002/<新的复验目录>
```

可以使用 `QUALITY_HISTORY_IMPLEMENTATION_ROOT` 指向总控提供的集成工程，使用 `QUALITY_HISTORY_EVIDENCE_ROOT` 指向保留原证据的 05 工程；二者分开。加载器将旧回执绑定原提交，已改的源码/文档通过原提交 Git blob 验证旧字节，同时单独记录正在受测实现的 HEAD 与文件 SHA。旧输出不能因新源码修复而被重写成新原始回执。

等待 05 修复提交后再记录修复版完整测试与真实数据复验。本次原始负例日志及第一次 45 项真证据检查保留，后续复验写新文件。新增观察/接收时钟缺失、结果标签改动不影响选择、结果时间不进入预测输入、纳秒级晚到和跨时区相等时刻的独立边界测试。联合验收另需总控提供明确集成 HEAD；本任务未自行切换 04 或改 00。

runner 只有在完整测试、45 项真实检查、前后证据/实现哈希稳定且实现已提交时才给出 `ok=true`；未提交实现即使测试通过也只算预复验。输出目录必须位于 04 的 outputs，已有目录不覆盖。原始负例版为 42 项中的 35 通过/7 失败；扩展后的最终套件为 50 项，结果须以新回执为准。

总控确认的实际 UI 发布阻塞也须保留：`PublicBrowse.tsx` / `public-browse.css` 不在现有前端 lane 白名单，新 UI 不能直接用现有前端 lane 发布。本轮不放宽白名单。代码测试、官方源就绪、模型可靠性、签名发布身份与最终上线分别报告；本任务没有部署权限动作，报告中的 `productionEligible/deploymentAuthorized` 均为 false。
