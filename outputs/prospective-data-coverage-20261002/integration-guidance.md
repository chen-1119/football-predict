# 逐字段证据留存与覆盖：本轮结果和接入方案

## 实际交付

- `scripts/prospectiveDataCoverage.cjs`：独立 CLI，可生成经过原始线上响应和既有回执核验的覆盖报告，也可保存未来采集的逐字段原始 JSON 证据包。
- `scripts/prospectiveDataCoverage.test.cjs`：合成安全测试；不用于宣称线上覆盖或命中率提升。
- `coverage-final.json`：432 场线上历史导出逐场、逐字段报告。`coverage.json` 是被本文件取代的中间诊断，不纳入最终回执。
- `verification-receipt.json`：源文件前后 SHA-256、测试结果、代码及报告 SHA-256。

## 已确认的具体缺口

| 字段 | 值保留 | 导出省略 | 现存快照内缺失 | 整份特征快照缺失 |
|---|---:|---:|---:|---:|
| Elo、Poisson、联赛先验（分别） | 379 | 0 | 0 | 53 |
| 近期状态 form | 24 | 355 | 0 | 53 |
| 阵容、伤停、天气、xG、赛程密度（分别） | 0 | 0 | 379 | 53 |

355 场近期状态被 `field-over-byte-limit` 省略，应优先从**同一不可变线上 generation**恢复完整字段，记录原始对象哈希及分块哈希。不要将导出省略判断为供应商没有数据。53 场整份快照缺失，无法借当前数据补造旧赛前快照。

379 场已有数值也没有本入口所要求的逐字段原始 payload 哈希及 provider/received/available 时钟；冻结组哈希不能替代这些证据。可审计特征回放覆盖仍为 0，本轮没有提高或宣称提高推荐命中率。

## 最小接入位置

在现有采集器**收到合法来源原始响应之后、生成新冻结决策之前**调用留存入口。先作为影子证据包旁路保存，不改 `syncData`、worker 调度或候选准入规则。

```text
node scripts/prospectiveDataCoverage.cjs retain FIELD_METADATA.json RAW_RESPONSE.json outputs/prospective-field-evidence
```

元数据必须使用 `prospective-field-evidence-v1`，声明 field、valuePointer、valueSemantics、payloadSha256、source/providerEventId、授权依据与引用、sourceMatchId 映射及其证据哈希、sourceCycleId、kickoffAt/decisionAt/cutoffAt，以及 providerObservedAt/receivedAt/availableAt。

- 实际留存时间由入口记录；要求 `providerObservedAt <= receivedAt <= availableAt <= retainedAt <= decisionAt <= cutoffAt <= kickoffAt`，且 `decisionAt < kickoffAt`。时钟按纳秒比较，并验证真实日历日期和时区。
- **当前才上传的历史附件会被拒绝**，不能把调用者填的旧时钟当成已完成赛前留存。
- 同一内容重复提交返回原回执，不刷新原留存时间；更正需新内容哈希并声明 `supersedesEvidenceId`，原回执保持不变。
- 源授权和比赛映射仅保留显式声明；它们仍需独立审核。所有回执 `candidateEligible=false`，不因哈希、时间格式或数值存在而授予模型准入。
- xG 只接受 `provider-reported-historical-xg` 语义声明和历史覆盖截止；赔率反推 lambda 不可声明成观测 xG。真实语义仍由供应商适配器审核。
- 证据只可写在本工作树 `outputs` 下，禁止写进 `public/data`。JSON bytes 以 base64 原样保留，并附提取值哈希；原始响应不被重新格式化。

## 后续执行顺序

1. 给有界线上导出增加针对 form 的同 generation 分块取证能力，保持限量、只读及哈希核验；本轮未改线上导出器。
2. 选已有获准来源的单一字段，在新采集周期旁路留存；确认签名采集器、来源授权、比赛映射与真实字段语义。
3. 审核后只将证据引用写入**新的**冻结决策；留存入口自身不写生产、不回写历史、不放宽模型准入。
4. 每日按整体与同场配对样本分别跟踪覆盖；扩大有效样本后做预登记模型实验，同时报告命中率与推荐覆盖率。

本轮未连接实时采集器，未新增线上逐字段回执，未部署，不需要新增付费服务。
