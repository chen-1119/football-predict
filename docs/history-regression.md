# 生产历史证据与回放验收

本分支只建设离线研究工具。生产采集通道固定 SSH 主机公钥；不写数据库、部署、重启、改正式推荐或晋升模型。只在 `codex/football-history-regression` 的指定工作树内写文件。

## 方案与范围

1. 从生产同一不可变 generation 读取历史比赛和预测快照，核验 manifest、原始文件 SHA、文件前后身份、generation 指针前后内容。首批为上海时间 2026-09-01 至 2026-10-01 的已结算比赛，按开赛时间降序及比赛 ID 排序，最多 500 场；不按输赢选样。服务器内部流式读取，输出 50 场一页的受限字段投影，每场只选最后一条截止前决策，保留遗漏和选择计数。
2. 把“冻结概率可评分”“同决策官方 SP 可配对”“候选特征可回放”分开。比赛、决策、结果和官方赔率的时钟/签名/事件归属分别复验。后补时钟、当下阵容、未来赛果、收盘价不能填进原预测。
3. 原发布预测复盘和新候选实验分别出报告。训练、校准、验证及最终测试使用显式上海比赛日半开窗口；同日不拆分。训练和校准标签须在下一阶段最早决策之前实际观察到，不能用开赛时间加固定小时数替代结果回执。
4. 新候选只能通过纯适配器进入回放。验证集选择候选，最后只评选中候选的保留测试集。结果按比赛日整块计算配对 bootstrap；少于 10 个比赛日或 30 场不生成区间。本次是已知线上聚合结果后的回顾性研究，不能当作未触碰的前瞻验证。

时间序列拆分必须避免用未来数据训练；scikit-learn 的等间隔样本比较条件不能机械用于不等间隔比赛。这里用明确的比赛日窗口。[TimeSeriesSplit 文档](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)。校准数据与拟合数据分离，并同时报告 Brier、LogLoss 和可靠性曲线，避免仅凭单一综合分数判断校准。[概率校准文档](https://scikit-learn.org/stable/modules/calibration.html)。

## 可执行接口

```powershell
node scripts/captureHistoryRegression.cjs scripts/historyRegressionRemote.py outputs/history-regression-20261002/online-sample-v3.json
node scripts/historyRegressionAdmission.cjs outputs/history-regression-20261002/online-sample-v3.json C:/Users/86188/.codex/worktrees/football-release-oct02/football/outputs/online-validation-20261002/online-validation-inputs-receipt.json outputs/history-regression-20261002/admission-v3.json
node scripts/reportHistoryRegression.cjs outputs/history-regression-20261002/admission-v3.json docs/history-regression-protocol.json outputs/history-regression-20261002/report
```

输出使用独占创建，已有证据文件不会被覆盖。重跑时换一个输出文件/目录。远程导出器固定本次 generation、时间窗及主机指纹；新批次须明确更新这些参数并保存新的代码哈希。失败回执只保留白名单错误码。原 SSH 响应字节另存 `.remote-response.json`，准入器核对其 SHA 并逐值核对捕获对象；不把 Python 数字编码的 canonical hash 当成 JS `JSON.stringify` 可重算的哈希。

`historyRegressionAdmission.cjs` 接受显式线上捕获及旧线上回执，不读取 `public/data`、SQLite 或本地训练种子。纯库 `analyzeCapture` 要求原响应字节及 generation 证明。原始文件哈希、投影对象哈希、原始响应哈希与离线报告哈希有各自含义，不能互相替代。

`historyRegressionReplay.cjs` 导出 `summarizePublishedHistory(records, options)` 和 `runHistoryRegressionReplay(records, options)`。默认对照包含同决策去水市场、原冻结模型和仅训练窗内拟合的类别频率基线。插件接口为 `id/version/implementationHash/fit/calibrate/predict`；声明所需特征后，只有具有数值、来源、payload SHA、且 `availableAt <= decision.at` 的审计特征可以传入。预测接口不传赛果及未知顶层字段，插件必须是审查过的纯代码，不是任意外部程序的沙箱。

类别频率只是透明的控制基线。已有 `dynamicGoalStrengthModel.cjs` 的动态 Elo、Poisson、Dixon-Coles 与 `historicalAsOfFeatureBuilder.cjs` 可复用；本批缺少合格训练输入时不构造替代历史。其 UTC 日初边界须与原决策时钟核对，再接入上海比赛日回放。`runModelBacktest.cjs` 顶层会读取业务路径并写 ledger，本工具不导入或执行它。

## 数据契约及下一步接口

每条记录保留比赛 ID/市场、联赛、球队实体 ID、开赛/截止时钟、冻结决策 ID/版本/概率/源周期、同决策 SP、provider/receipt 时钟、签名与 payload 绑定、实际结果及观察时间、源文件行号、原对象哈希。每场同时记录排除原因和特征缺失。

01 数据源分支需补：每个原始特征的事件 ID、field/value、providerObservedAt、receivedAt、availableAt、来源授权/使用范围、payload SHA、当时缺失状态；确认阵容与预计阵容分别标记，真实 xG 与赔率推导 λ 分开。结果首次可信观察时间不能被后来同步覆盖。

02 推荐分支可提供固定版本/实现 SHA 的候选适配器，在训练窗拟合、独立校准窗校准，验证窗选型。逐个加入近期强度、主客表现、赛程密度、确认阵容、伤停、天气、真实 xG，保持同一事件交集和缺失分组做样本外消融；只有验证增益和不确定性支持时保留。LLM 只总结带来源的证据，不自行输出无审计数值概率。

03 展示分支读取 summary、逐场清单和拒绝原因，标明样本窗、事件数量、比赛日数、覆盖率、原预测复盘/候选回放身份。04 验收分支复算 SHA、源 generation、签名/时钟准入、相同事件集合及配对指标。shared 入口、公共类型和部署配置本分支均未修改。

## 后续推荐如何形成

先过数据门槛：本场官方 SP 和回执可信，事件/时钟一致，必需特征在决策时可得。再过模型门槛：跨独立比赛日和联赛的样本外概率表现、校准、稳定性及风险验证均合格。最后过单场门槛：方向概率、市场差异、证据完整性与风险约束共同决定推荐、分析或等待。任何一层不足均保留具体等待原因，不能降低门槛凑推荐。

冻结历史不回写。新的研究结果不得冒充线上 r785/r787 的效果。本批不计算 ROI/回撤，因为完整冻结投注账本及结算规则还没有逐项核验；不声称收益保证或模型已达晋升条件。

## 验证

```powershell
python -B tests/history-regression-remote.test.py
node --test tests/history-regression-admission.test.cjs tests/history-regression-replay.test.cjs
```

这些是**合成测试**，验证输出限额、JSON 完整性、签名/事件/时钟拒绝、概率口径、分组、防泄漏和保留测试集隔离。真实效果只能来自已绑定生产输入的逐场报告；测试通过不算线上效果。
