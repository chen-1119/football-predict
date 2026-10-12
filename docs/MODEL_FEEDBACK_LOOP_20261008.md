# 参数反馈链路修复（2026-10-08）

## 交付范围

本提交接通 **训练产物 → 留出验证 → PostgreSQL 成对注册 → 自然发布周期读取 → 后续球队影子预测采用回执**。

**尚未完成正式推荐模型替换。** 本链路继续使用 V3 研究边界；`formalEligible=false`。旧正式准入条件、原冻结推荐、比分与各市场结算不变。没有把固定权重或人工风险扣减称为训练权重。

## 已修复的断点

1. `runPrematchV3Learning` 对实际拟合结果生成可部署的参数包。包保留独立测试日的原记录，加载时重算 Brier 与 log loss；两指标均严格优于同比赛的零市场基线和市场基线才通过。训练日、校准日、测试日不能交叉。
2. `registerPrematchV3Parameters` 用原输入、执行代码哈希、拟合时钟重放训练，拒绝改系数后重算外层哈希的伪造产物。准备阶段不写生产。
3. 显式执行注册时，在同一 PostgreSQL 事务内比较两个旧值的 SHA，写入匹配的基线与参数包；历史版本按内容地址保留。并发变化拒绝，未知 COMMIT 结果要求先读回，不能盲重试。
4. COMMIT 后在第二个只读一致性事务中核对两个实际存储值。注册成功只表示数据库保存，不表示已被推荐采用。
5. 自然 `syncData` 周期读取两个固定私有键，重新验证参数包与留出指标。参数与基线哈希必须匹配，缺少验证回执的旧裸参数不能在该线上路径产生球队影子概率。
6. 后续 `prematchV3Assessment.parameterAdoption` 记录参数哈希、验证包哈希、特征快照、调整前后进球率、输出概率哈希和比赛身份。记录 `applied` 才证明该次影子预测确实使用参数；不将其冒称为正式推荐采用。

推理读取不拟合参数；训练重放只在显式训练/管理命令执行。缺输入不补零，不从 SP 倒推出球队概率，也不跨市场比较裸概率。

## 操作入口

固定 Node 22。所有输入来自已验证线上读取及赛前冻结记录。以下为接口说明，不表示已对生产执行注册。

```text
node scripts/runPrematchV3Learning.cjs --input REQUEST.json --output NEW_REPORT.json
node scripts/registerPrematchV3Parameters.cjs --prepare --input REQUEST.json --report NEW_REPORT.json --baseline BASELINE.json --output NEW_PREPARE.json
node scripts/registerPrematchV3Parameters.cjs --apply --input REQUEST.json --report NEW_REPORT.json --baseline BASELINE.json --expected-previous-sha PREVIOUS_PARAMETER_SHA --expected-baseline-sha PREVIOUS_BASELINE_SHA --output NEW_REGISTRATION.json
```

只有查询确认对应键不存在时，期望值才可用 `absent`。输出文件必须新建。数据库连接走既有 PostgreSQL 配置，不增加公开写接口、不强制 worker。原输入和注册回执属于私有业务材料，不提交 Git。

## 本次真实线上输入核查

2026-10-08 北京时间 **12:27:57.631716**，正式固定 SSH 指纹只读脚本取得生产 PG 输入；12:34:42 对该原响应做绑定重放：

- 6 场、6 场有市场参考报价。
- 两个固定模型注册项均缺失，零市场基线 0、已训练参数 0。
- 两队同时具备 V3 阵容、伤病、体能、历史、xG 输入的比赛，各为 0。
- 本批可冻结的 V3 学习记录 0，球队候选概率 0。
- 生产写入 0；没有将本地旧比赛或测试样本注册到线上。

因此当前缺口不只是加载函数：真实训练数据和正式准入证据尚未具备。该提交不能报告模型已上线、推荐方向已更换或命中率已提高。

## 验证及下一步

目标回归覆盖实际训练 CLI、留出重算、伪造指标/系数、并发 CAS、未知提交结果、真实 loader 接口与后续推理（数据库为隔离替身）。测试数据全部合成，只证明实现行为；没有把它们算作线上样本或效果提升。

上线前仍须最终源码构建、正式签名发布及真实运行验收。当前 r810 是独立的 11 点开售策略发布，不包含本提交，不与其并行发布。

正式闭环剩余工作：补真实赛前球队证据与可信历史基线；形成不泄漏的冻结训练/留出数据；验证分市场、分让球线校准及既有 500 配对 / 6 窗口 / 3 折准入；完成真实前瞻 CLV，再将获准版本接入正式发布器并核对自然生成的新推荐。上述正式激活适配器尚未在本提交实现，不能用研究注册代替它。
