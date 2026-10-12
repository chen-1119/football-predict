# PRD 前瞻纸面流水

## 范围

本次增加独立纸面流水：已批准的零市场训练原件与冻结预测 → 决策时取得的完整签名官方报价 → 分市场双门筛选 → 首条纸面封存 → PostgreSQL 提交确认 → 独立公开投影。模型、球队、事件或报价证据缺一即等待，不回退旧混合概率。`formalEligible`、`productionEligible` 始终为 `false`，正式 `primary`、`companion` 仍为空；既有发布方向、结算、学习事件及 active model pointer 不变。

## 存储与调用

复用 migration 005 的 `football.learning_model_artifacts`，不建表，不改 schema。只读/只追加接口为：

- `buildPrdForwardInput({ artifact, forecast, businessDate })` 与 `forwardInputMetadata(input)`：生成 `prd-forward-input-v1` 原件及严格元数据。业务日须显式来自当时官方身份审核，`sourceNominalDate` 单独保存；不能用本地日、北京开赛日或来源名义日期推导业务日。
- `appendPrdForwardInput(pool, { input, approvedModelHashes })`：独立 SERIALIZABLE 事务只追加注册已批准模型及真实冻结预测，空名单拒绝。actual DB created 时钟不早于预测完成、严格早于销售截止及开赛，写入后和 COMMIT 前重查；另一次只读事务在 COMMIT 后核对原件及真实 DB clock。迟到或确认失败返回 `stored: true, admitted: false`，保留原件，不造额外 task ack；正常 reader 到该时刻已过截止也不会准入。重复 exact bytes 保留原 created 时刻，第三个同事件/模型/日 task 明确拒绝。注册不是模型正式激活。
- `readPrdForwardInputs(client, { approvedModelHashes, businessDate })`：仅加载精确批准模型 hash 的固定 task 类型，返回 `{ tasks, blockedCount, truncated: false }`。默认名单为空；零 task 不采集报价、不调用 writer。原件原始 SHA、完整 contentHash、metadata SHA、字节数、媒体类型、实际可用时钟及数学回放必须一致；坏 JSON/冲突显式失败，不吞成空数据。
- `appendPrdPaper(pool, { record, task, trustRegistry })`：在独立 pool 事务内重读 task，重验 maker 完整签名与数学回放，绑定精确模型/预测/官方业务日；写 `prd-paper-recommendation-v1`。复用 worker pool，不嵌入旧发布事务，不创建第二个并行 worker。
- `readPrdPaperProjection(client, { businessDate, trustRegistry, asOf })`：返回 `{ records, blockedCount, waitingCount, truncated: false }`，等待数仅用于内部诊断。仅成功确认提交的纸面记录进入公开投影；private artifact、完整源 payload、SQL 和秘密均不透出。

projection 可传严格 `asOf` 时钟，缺省实际 DB now；`asOf` 不得晚于实际 DB 观察。原 paper/ack 时钟实际晚于 DB now 仍属冲突，必须拒绝；已确认原件合法但刚好晚于本次旧 view `asOf` 时，只计内部 `waitingCount` 并暂不公开，下次观察可见。不能把等待当坏原件、改旧 view 时钟、重写原件或放松前端 commit 边界。内部等待数不新增到公共 envelope。

公开 reader 必须重新取得 `taskArtifactHash` 指向的 forward 原件并核验其 raw SHA、元数据及完整模型/预测。该原件须实际存在、存储时刻不早于预测完成且不晚于原决定、严格早于其截止/开赛，并与 paper 的有序球队、来源事件、来源名义日期、官方业务日、规范事件时钟和原模型/预测逐项一致。paper 内嵌输入及 ack 不能代替原 task 及其可用时序；缺失、篡改或迟到 task 拒绝公开，不重建原件。

writer 使用固定 advisory lock、savepoint、有界参数 SQL、`ON CONFLICT(artifact_hash) DO NOTHING` 及 exact readback；不执行 UPDATE/DELETE。不存在数据库 immutable trigger 的证明，本次只追加约束来自该固定写入接口及原件核验。

事件 metadata 与配额键采用同一 UTC 纳秒时刻表示，等价的 `+08:00`/`Z` 时钟不能拆成不同事件或配额；完整模型/预测 packet 仍保存原始表示与原 hash。首次合同审查发现原文本键与 maker UTC 键不兼容，已限定修正并保留负测。没有任何已验签市场报价时只报告阻断，不封存成首条观察；首条观察指已有真实签名价格但未通过价值双门的情形。

## 实际提交时钟

数据库以 `clock_timestamp()` 的 UTC 微秒原值补齐九位小数保存，不用 `Date.parse` 截断知识边界。写入前、写入后和 COMMIT 前均要求数据库时钟早于销售截止及开赛、晚于真实 maker 创建时钟，且距决定时刻不超过 30 秒。

COMMIT 前检查不证明 COMMIT 完成时刻。第一事务完成 COMMIT 后，在第二独立事务取得新的 DB 时钟，仍须满足同样截止/开赛/30 秒边界，才只追加 `prd-paper-commit-ack-v1`。ack 绑定 paper raw SHA、contentHash、task SHA 和第一原件实际存储时钟。晚完成或 ack 失败的 paper 原件可以保留，不能获得合资格 ack 或进入公开前瞻记录；不重写原 metadata、不把重试时钟伪装成原提交时钟。

公开投影的 `paperArtifactHash`、`acknowledgementHash`、`paperCommitObservedAt` 三字段进入 maker 公共 body 再计算完整 contentHash。这个 seal 是内容绑定，不是新的官方签名；真实存储资格来自 backend 对 PG ack 原件及其实际提交观察的核验，格式正确的假 commit context 不代表准入。

## 容量与版本

单条原件最多 8 MiB、一个读取批次合计最多 32 MiB、最多 32 task/事件、单条 metadata 最多 64 KiB；超量明确拒绝。每个事件/模型/官方业务日最多两个显式 task 和两个 paper 原件。同一 `taskHash + forecastHash + event` 只保留首条决定；更换 `receivedAt`、完整 snapshot、赔率或候选方向不产生第二份 paper，也不 restamp。首条没有候选的观察照样冻结。新的早盘/临场版本须有新的显式批准 forecast task，重复版本不得当作更多独立比赛。

本次未实现五时点共享 quote blob、完整收盘价/CLV 配对或八周评估，不把本地 synthetic SQL 协议测试当真实 PG、线上前瞻或命中率提升证明。后续须通过正常 intake 导入真实未截止原件、完整签名发布、自然 worker、PG readback 与页面验证；旧已截止预测和本地历史 clock 不可补造。

当前没有已准入 forward task 时保持 `awaiting-inputs`，不自动取旧研究文件、不把注册接口安装或名单配置当成正式策略/模型激活。
