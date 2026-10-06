# P1 历史数据地基：真实线上影子采集

## 已实现的调用路径

既有 `augmentHistoricalTrainingFromOpenFootball.cjs` 新增显式 `--shadow-foundation` 分支。它调用有界采集器，保留原 JSON 和规范化 CSV，然后实际调用既有 `historicalEventStore`、`historicalTrainingWarehouse`、`openFootballObservationStore` 以及 `historicalAsOfFeatureBuilder`/verifier。不是只生成方案；本次已经跑完真实网络采集、SQLite 导入、时序审计和离线字节核对。

该分支不读取旧训练 index、旧球队 recent、旧本地比赛或 PG，不执行 PG migrations。旧的葡萄牙补队路线保留；其 `applyEvent` 依赖移入原填队函数，影子路径不再因顶层依赖加载生产 PG 客户端。

```powershell
& '<固定 Node22 的完整路径>' scripts/augmentHistoricalTrainingFromOpenFootball.cjs `
  --shadow-foundation `
  --source-commit e6744429ee395bc86f247348c6184bb08d4eb361 `
  --output '<本工作树>/.codex-tmp/history-foundation/<全新运行目录>'
```

要求显式 40 位来源 commit；固定三项联赛、2021/22 至 2025/26 五季；最多两个并发、每响应最多 3 MiB、20 秒总时限；不跟随跳转、不重试、不借镜像、不读取缓存回填。输出必须是本工作树 `.codex-tmp/history-foundation` 下的全新目录，拒绝链接祖先和覆盖旧运行。

## 来源使用范围

2026-10-06 核验 [Football-Data 的官方使用说明](https://football-data.co.uk/contact.php)：它限制自动化的数据训练用途。本轮取消该站的 15 CSV 计划，也不通过镜像取得同一数据。[下载页](https://football-data.co.uk/downloadm.php) 的免费说明不能替代使用范围许可。原 HTML 已私有留证，SHA256 `61f3299a0042a7f3a5d171ab263f590b819292fc936f3b99c2fef31ff8c71d34`。

实际来源改为 [OpenFootball 官方仓库](https://github.com/openfootball/football.json) 的 [CC0 声明](https://github.com/openfootball/football.json/blob/master/LICENSE.md)。采集地址使用固定 commit，而非浮动 master，原 LICENSE 同 commit 下载并核验 SHA。社区赛果不是竞彩网官方赛果、官方 SP 或正式结算证据；`sourceVerified=false`、`officialSettlementAllowed=false`、`productionEligible=false` 始终保持。

## 本次真实覆盖

| 俱乐部联赛 | 季数 | 社区全场赛果标签 | 其中原数组格式 | 严格 FT 对象观察候选 |
| --- | ---: | ---: | ---: | ---: |
| 英超 | 5 | 1,900 | 27 | 1,873 |
| 德甲 | 5 | 1,530 | 12 | 1,518 |
| 西甲 | 5 | 1,890 | 15 | 1,875 |
| 合计 | 15 文件 | 5,320 | 54 | 5,266 |

2024/25 西甲为 370/380，源内有 10 场未提供全场比分；没有补为 0-0。其余 14 个联赛季的赛果数量符合对应完整联赛数量。这仅是数量覆盖，不证明社区结果已由官方校正或球队映射已核验。

固定来源实际同时存在 `score.ft: [h,a]` 和旧 `score: [h,a]`。后者仅作为显式社区标签保存，必须恰为两个非负整数；不会使用加时、点球或半场分数代替 FT。既有观察仓的严格 FT 候选规则不变，因此 54 个旧数组标签没有进入其 FT 候选统计，全部数据也都未正式准入。

15 个独立 dataset 以 league + season 命名，当前全部为俱乐部来源。国家队行数为 0；没有混入俱乐部 Elo 或国家队模型。时序 auditAdapter 只输出已观察历史行数，`probabilities=null`，没有训练、预测或改变现有模型权重。后续模型需在各队型和赛事层分别校准，不能把本轮“无跨队型样本”当成已完成分层训练。

## 双时钟及赛前保护

- `requestedAt` 是开始请求；`acquiredAt` 是实际完整响应取得时间；`localAvailableAt` 是源解析及 raw/CSV fsync 后的本地可用时间。三者顺序和文件 SHA 绑定。
- 原观察仓的 append-only 链保存真实完整响应时刻、原字节和本仓内 `firstObservedAt`。新增可选 `sourceCommit`；原 master 回执字段、序列化顺序和 hash 不变。先前运行另行留存，本运行的 firstObservedAt 不冒充过去几年或全局最早的公布时间。
- `providerAvailableAt=null`、`historicalAvailabilityProven=false`。Git commit、HTTP Last-Modified、比赛日期以及今天取得文件的时间均不当作过去的赛前公布时刻。
- 既有 CSV 仓仍标记它的 derived availability 为研究代理；默认严格 asOf 查询排除所有 5,320 行。没有把仓库的日期延迟代理改为已证来源时钟。
- 单独的已观察事件 sidecar 使用今天实际 localAvailableAt 调用既有 asOf builder。5,320 个历史预测时点的 priorObservedResultRows 全为 0，这是正确的历史可用性缺口；不得将其输出用于宣称有效历史预测优势。标签与特征保持分开封存。

原 CSV 适配器历史赔率路径存在 closing 优先、逐 outcome fallback 可能混入不同 book/阶段的问题。本轮仅输出六个比分字段，不输出任何赔率或赛后统计作为同场赛前输入。closing 只能在后续有许可和真实报价时钟的独立研究流程作为 CLV 目标，不能成为赛前特征。

## 仍未覆盖的数据

HAD、HHAD、亚洲盘、大小球、closing、五时点完整事件、报价观测时刻覆盖均为 **0**；不能把亚洲盘两项结算冒充 HHAD 三项。国家队、准确 UTC 开球、阵容、伤停、xG、天气及过去的来源可用时刻均缺。`zero-market-data-inventory.json` 明确可用字段及缺口，`modelTrained=false`、`existingModelWeightsChanged=false`、`trainingPromotionEligible=false`。

## 验收与交付边界

固定 Node22.22.1：新增 34 项 tests 全通过、0 跳过；既有观察仓 51 checks、只读来源审计 46 checks、旧葡萄牙补队 12 assertions 和历史仓 16 个命名合同检查通过。最初草稿 27/29 的失败日志保留；修复测试长度误计和 shadow 顶层 PG 依赖后再验，不改历史通过记录。

最终真实运行：`.codex-tmp/history-foundation/online-20261006-final`。15 active imports、5,320 events、0 conflicts、0 rejected、0 staging；15 观察回执完整审计通过。独立只读回放核对 raw SHA → 原观察链 → 规范 CSV SHA → canonical root → sidecar → asOf artifact；另以显式 exploratory 查询仅核对仓库压缩内容完整性，不用于特征或训练准入。

最终 manifest SHA256 `35fd840c4bf679c250a44a35bb2a0a9ef0fdad55aef2d55e4745b0733b80e704`，contentHash `21f6ffbe6bd9faf11daaf8d285909d8534d53de487f8ec3ec3d3a8867590e87a`。私有回执 `.codex-tmp/openfootball-shadow-artifact-verification-final.json` 保留来源和当前执行源码 SHA。

仅本地影子数据地基交付。没有生产写入、push、部署、训练或命中率提升结论。原文件及私有仓不入 Git；后续整合和正常发布由主任务处理，并须正常 source inventory 包含新增 CLI 依赖后才可宣称安装了采集能力。
