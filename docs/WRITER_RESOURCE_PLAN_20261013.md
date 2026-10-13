# 独立任务的写入资源计划

`services/tasks/writerResourcePlan.cjs` 提供纯函数 `writerResourcePlan(roles, { observedResourceIds })`，列出源码可确认的写入资源、共享锁、读写依赖及旧 unit 的停机影响。它不连接数据库、不读取现场状态、不启动进程；输出始终为 `activationEligible=false`、`executionPermit=false`、`sqlFenceImplemented=false`。已列资源不等于全部写入闭包，未列资源进入 `unresolved`。

## 本次核实的边界

- official 入口仍是整段 `scripts/runSyncWorker.cjs`，包含不可变代际、PG 投影及模型/后处理职责。`roles.cjs` 的关闭标志不能证明后处理全部移除；自治学习、学习注册、能力审计及策略恢复仍有独立条件。team 当前也属于旧 sync worker，停止该 unit 会影响两类职责。
- market、recommendation、settlement 的旧配置已有各自的 unit：`football-market-collector.service`、`football-featured-combo.service`、`football-recommendation-settlement.service`。旧交接 owner 校验只接 sync worker 或新 writer 名称，尚需准确的角色映射，不能把这些原服务当成 sync worker。
- official、team、训练发布与组合视图归档使用同一 `private_model_artifacts` 表及 `football-postgres-projection-sync-v1` 锁。不同 key 空间仍需完整写入清单；计划不把表重叠解释成相同业务内容。
- publishingCycle 和 settlementCycle 都调用 view，写入同一个 `daily_featured_combo_state.recommendationCenter`，由 `recommendation-center:view` 锁串行化。
- 人工审核入口 `publishReviewedAnalysis.cjs` 在六类任务以外，还包含第二事务 ACK。直接模型脚本及可配置的文件路径也必须进入交接审查。
- 默认模型文件路径可确认；本轮候选已合并 r853，原 A 锁等关键源码经 Git 比较保持一致。计划器本身不读取 Git 或生产身份，因此仍把集成基线核验列为现场交接前的独立条件，不能凭计划输出推定已安装。

## 后续实施顺序

1. 以 r853 已验收代码为运行基线，逐项集成服务拆分增量，保留 120 秒写入预算、普通 30 秒读预算、模型共享 A 锁及已安装读 API 的生命周期校验。
2. 完成 official 来源/后处理分离，核对每个文件及 PG key/table 的全部 writer、旧 unit、子进程、数据库会话和锁顺序。
3. 实现域隔离签名的 root writer 控制器与 PG fence 存储；所有旧、新写事务均核对 epoch。只在 SQL COMMIT 与读回一致后启动候选；未知 COMMIT 先读，不重发。
4. 在独立 Linux 环境验证残留消费者、旧 epoch、并行交接、签名/身份篡改、COMMIT 响应丢失及回退更高 epoch；通过后走正常签名发布。
5. 线上验证自然完整周期、实际新 PG 提交、原冻结方向/SP/比分/ACK/结算连续性和页面可见内容。

没有列出冲突也不代表可并行启动。现有任务 runner 的 `WRITER_HANDOVER_UNIMPLEMENTED` 保持有效；本文件不提供任何启动许可或生产 SQL fence。
