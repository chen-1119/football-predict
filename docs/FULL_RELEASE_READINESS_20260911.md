# 整版发布与 PostgreSQL-only 接续记录

## 已完成

- 受控修复源码提交 `df8946ace925de3d16d91973124e96dcc6d76cd8`，主分支合并 `9f9562036ed3a185a6993a3dfac83a1432354060`。只纳入 13 个修复通道源码及文档文件，未提交 outputs、数据种子或原始工作区的改动。
- 2026-09-11 16:51:36 北京时间只读复核：线上 12 个修复文件摘要一致，签名修复已接受；服务、数据新鲜度、双可信采集器、快速赛果和推荐投影一致性通过，普通 Worker 早期预检通过，recoveryPending=false。模型风控和推荐可靠性继续为 false。
- 重跑 22 项签名策略检查和 11 项 Linux 隔离恢复故障注入，全部通过，生产业务写入为 0。

## 整包流程为何暂停

16:55:13 以固定 Node 22.22.1、已合并的精确源码和原始模型种子调用正常整包入口。Worker 预检通过，但比赛状态窗口预检拒绝：

- `transition-window-closed`；下一次状态变化为 17:50。
- 当次所需完整安全时长为 9,440 秒，含原有 7,620 秒发布预算、构建/上传各 900 秒及观察时间余量。
- 预检提示下一次候选准备时间为 **18:00 北京时间**。这是建议复查时间，不是预约、预授权或保证届时可以发布；必须用当时的比赛、Worker 和 generation 重新检查。
- 18,301 ms 内退出，在归档扫描、构建、打包、签名和序号预留之前结束。未生成新包，未上传，未触发服务器发布事务；共享最高预留序号仍为 725。没有复用旧失败包。

证据：`outputs/reviewed-full-df8946ace925de3d16d91973124e96dcc6d76cd8-20260911T085513802Z-1b13539c-result.json` 及同名 `.log`。

## 本地签名前校验修复

在不调用发布入口的本地完整校验中发现，`verifyReleaseWindowPreflight` 的真实构建前缀测试尚未模拟新加入的 `runReleaseWorkerPreflight`，导致在可用窗口中也会被签名前校验拒绝。

补齐模拟，并验证调用次序为序号结构检查、Worker、窗口、归档、签名前校验、序号预留、构建。新增 Worker 明确失败或观察不可用时的停止证明，后续窗口、归档、签名及构建均不得执行。没有更改任何生产窗口时长、失败门槛或发布入口。

验证：32 项窗口检查通过；340 项完整签名前校验通过，`productionDataTouched=false`。结果分别保存在 `outputs/release-window-contract-result.json`、`outputs/release-verifier-contracts-result.json`。这不是新整包签名或线上验收凭据。

## PostgreSQL-only 的真实剩余条件

16:57:36 通过应用服务身份执行 REPEATABLE READ / READ ONLY 核查，未修改配置、模式或业务库。

- 应用和 Worker 仍为 PostgreSQL primary 读取，`ENABLE_SQLITE_EXPORT=1`，尚未启用 `FOOTBALL_STORAGE_MODE=postgres-only`。
- 生产已安装 001–004 迁移，摘要与源码一致；仍缺 005_learning_ledger、006_research_observations，原生 learning/research 表尚不存在。
- 主 SQLite、学习账本、研究观察 SQLite 都仍存在。数据库约 7.71 GB，存储卷约 81.32 GB 可用。本次没有再次进行全库镜像压测，也没有删除备份。
- 观察发生在自然 publication 更新中，PG 元数据与最新 generation 指针属于相邻周期；该只读清单不冒充冻结屏障内的完整退役一致性证明。

证据：`outputs/postgres-cutover-readiness-1789117056701.json`。

下一步顺序保持：窗口重新通过后正常签名整包发布；核验新运行 SHA、正式 Worker 周期和原始冻结/推荐对象连续性；以真正接受的完整版本绑定原生恢复基线；完成原生发布执行入口、数据及两个账本的受保护迁移、恢复/回滚验证；最后才能关闭 SQLite 并验证完整原生周期。当前 `nativeReleaseJournal.BOOTSTRAP_SHA=null` 保持拒绝首次切换。

当前线上仍是 **r718 + 签名修复 46a94ee2…，前端 r719**。整包部署和 PostgreSQL-only 均未完成，模型继续参考/影子；未启动自动重试、预约发布或清理任务。
