# 快速赛果：按需读取归档证据

后续 2026-09-08 02:37–02:57 已补充独立真实 PostgreSQL 投影、全量正文/冻结记录一致性，并修复投影中大正文临时排序开销，详见 [PostgreSQL 小清单分批读取](postgres-match-id-batches.md)。新赛果发布和线上新版验收仍未完成，以下早期时间点的状态不代表当前持续状态。

## 本轮定位的事实

2026-09-08 02:01 北京时间，线上 `/api/v1/health` 仍主读、dataFresh=true、recommendationReliable=false。快速赛果监视器处于实际运行状态，上一子进程报 `PUBLISHER_TIMEOUT`，lastLatencyMs=8042，之前 lastDeferredReason 为 `sync lock held`；并非主服务离线。此前监控文件中 `trusted-fast-result-endpoints-unavailable` 是旧阶段错误，不能当作一直未变化的根因。

01:59:48 的只读端点审计：实际快通道文件哈希 `a38952c3c510e4bc3fc3548a036fe5bcb7030fb650eeef2b779382a9241ec785`，calculator/current/result:1 三项签名和时间均合格，blockers=[]，两项市场端点、一个可信采集器。结果凭据时间为 01:49:30；这只证明当时合格，不保证随后持续新鲜，也不等于官方双采集器完成。

02:02:42 的 SQLite 只读采样：文件 3,765,624,832 字节，按 source_match_id 的索引查询存在，但每场 368–370 份完整预测快照，首五场读取各约 22–32 MB，排序还用临时 B-tree。旧 `attachStoredPreMatchArchive` 无论已有有效冻结归档与否，都先读取并解析完整快照，再进入会提前返回的归档算法。这是已证实可减少的开销；没有声称它是整个子进程超时的唯一原因。

## 实现

- `resultEventClockRecovery` 抽出原有的 `needsResultEventClockEvidence` 条件：只在结果阶段、官方遗漏时间且本地午夜占位时读取时间恢复证据，条件与旧函数逐项相同。
- `attachArchivedPreMatchPredictions` 增加内部同步惰性读取形式。普通调用保持原构建索引路径；快速发布只在原归档算法真正调用 `get` 时构建完整索引。签名恢复或原有有效归档的提前返回不读快照。
- 快速发布每次归档操作最多加载一次完整行集，时间恢复和归档重建共用这一行集；不跨调用/事务缓存，不过滤、不截断快照、不补造证据、不改变排序或选择规则。
- 缺失/无效归档、合法公开方向纠正和含糊比赛时间仍走完整验证；读取失败继续抛出。不改八秒超时、锁规则、签名/时效门槛、历史方向、概率公式或 UI。

## 真实 Linux 对照

02:07:24，在服务器隔离模块环境中加载本次三个候选实现，使用 `DatabaseSync(readOnly:true)`、query_only、100ms busy timeout、低优先级、512 MiB 堆和 45 秒总超时，对实际 result:1 对应的十场历史记录比较同一候选归档逻辑的立即读取与按需读取。

| 项目 | 原立即读取 | 新按需读取 |
| --- | ---: | ---: |
| 快照 payload 读取量 | 296,207,615 字节 | 31,218,934 字节 |
| 归档阶段合计耗时 | 4,863.57 ms | 460.38 ms |
| 十场完整归档输出 | 对照基准 | 10/10 精确一致 |

九场零快照查询；2041313 仍需要官方遗漏时间的恢复，保留完整 370 行、31,218,934 字节读取，结果也一致。入参不变，生产写入 0。约 89.5% 读取量/90.5% 本次阶段时间下降，不外推成整个发布流程、部署时间或所有比赛固定提速。该读取不是整库原子代际克隆，也没有执行生产写事务。

私有报告 `outputs/live-lazy-archive-comparison-20260908.json`，SHA-256 `a2b6c0508648babc7a5bb049e01463f56ec60bb6eae22a9c4f43f186625b79e2`。三个候选文件实际哈希保存在报告内。第一次误用线上旧模块目录导致缺少尚未部署的 execution-clock 模块，未运行对照；随后明确使用上一轮隔离源码目录加本次内存实现才得到上述结果，没有向线上补装模块。

## 回归与发布边界

- `verifyFastResultPublication` 新增六项按需行为检查，总计 104 项；Windows 和新 Linux 隔离目录 `/var/tmp/football-replay-qCvdSiHE` 的 Node22.22.1 均全部通过。覆盖无 SQL 读取保留冻结档案、缺失档案仅建一次索引、截止后证据拒绝、必要读失败和无效档案不能跳过校验；原时间恢复/重复发布/回滚/时钟/签名等用例继续通过。
- Linux 隔离包 502 个白名单文件，SHA-256 `91579706a1cee66b7a2e9071135ef102dff3ffbd542dcde5ffe7abbab51ac50c`，保留当时工作树实际字节（基线 19f16c9 加本次未提交补丁），不是签名发布包，也未运行其中的旧 Windows 捕获重放脚本。只运行合成数据库测试；生产文件未改。
- Windows Node22 下额外通过 14 时钟、13 重放、20 输入算术、截止归档、22 冻结版本、10 归档权限、85 发布合同检查；定向 ESLint、diff 检查通过。首轮测试编排误写了归档权限验证器文件名，原失败记录保留；正确文件重新执行和完整编排复跑均通过，结果在 `outputs/fast-lazy-regressions-corrected-20260908.json`。
- 本改动改变 syncData 文件身份；上一轮 798fd28a 的 34 条捕获证据不能冒充当前补丁的全量重放或生产集成证明。既有截止与候选版本转换规则不豁免。

02:11:00 复核原 r702 队列 PID3577920 仍 alive、waiting-not-before、attempted=false，03:31/03:36 与安全门禁不变；app/live-complete 仍 r699。没有热改生产、重启、重签、重包或重排 r702；本补丁不在冻结的 6f86 签名包内，需后续独立受控发布。仍须验证完整快速发布/PG投影耗时、新 worker 周期及源时效；不能宣称线上超时已经修复或命中率提高。完整 Q1–Q5 继续进行。

## 2026-09-08 02:23–02:29：真实副本的完整 SQLite CLI 对照

本轮进一步执行实际 `publishOfficialResultsFast.cjs` CLI，而不是仅调用归档函数。服务器预检可用内存约 4621 MiB、磁盘空闲约 116 GiB、主服务与 worker active。在已有隔离代码目录下建立新的 `publisher-clone-L9bwnS`，从只读连接使用 Node SQLite online backup 获得含已提交 WAL 的一致 SQLite 副本；没有直接拼接复制运行中的 db/wal/shm，也没有停止服务或占用生产同步锁。

最初准备脚本在最终汇总完成前退出，未生成完成报告，没有把它直接当成功。保留并检查现有副本，随后在运行器中重新执行 `PRAGMA quick_check` 得到唯一 `ok`，用时 21.595 秒；数据库 919342 × 4096 页、3,765,624,832 字节，回执 valid=true、并非缺失，source_cycle_id 为 `sporttery-full-sync:2026-09-07T18:10:23.377Z`。先后计算整文件摘要一致：`976ee983d71a8051cbac7764809b37ac86057ccecd0a66a80227302d314fa230`。

配套 sync-meta 与快通道分别复制，**不是跨文件原子代际捕获**。sync-meta 为 420714 字节，SHA `167bf486bdea19e146f5572cc6ae1b2ffde1e86c72eef622c1bc46f428c540d6`；快通道为 294868 字节，SHA `8b24994083581017072e4be0697f3b190afaa0671667b79326772ade0e5d2e86`，三个端点当时均可信、result:1 观察时间 02:09:32。正式 publication ledger 在副本缺失，测试保留 missing=true，没有合成账本或借用正式统计。

两个真实子进程均使用同一副本、512 MiB 堆、非 root、低优先级、清空后的专用环境；文件写入限定在副本目录，SQLite 打开目标也限定在该目录，网络调用禁止。PostgreSQL 明确 disabled，因此 **没有验证 PG 投影**。诊断允许运行最多 55 秒以测得旧入口耗时，没有改线上八秒 watchdog。

| 项目 | 旧立即读取 CLI | 新按需读取 CLI |
| --- | ---: | ---: |
| 含子进程启动的耗时 | 12,626 ms | 1,822 ms |
| 预测快照 SQL 调用 | 20 次 | 2 次 |
| 预测快照 SQL 合计时间 | 7,897.33 ms | 740.46 ms |
| 退出码 / 发布条数 | 0 / 0 | 0 / 0 |
| 旧修订拒绝数 | 10 | 10 |

新入口先在 02:23 运行，旧入口随后在 02:24 运行；这是同机一次实际观测，不是随机化多轮性能基准。两个入口均返回 `no-result-state-change`，scannedRows=trustedFinishedRows=10、correctionRejected=10、writeTransactionStarted=true，实际执行 `BEGIN IMMEDIATE` 后 `ROLLBACK`。去掉明确的 startedAt/finishedAt 两个计时字段后，其余完整业务返回对象逐项相等；原始输出全部保留。这不是先前要求零字段排除的严格模型重放证据，不可混用。

该样本证明旧官方结果重放路径的实际开销能超过线上八秒，而候选优化在同一场景下低于八秒；它**没有产生新的赛果写入或触发 PG 复制**，不能说“整个线上发布问题已解决”。两次执行后副本 DB 整文件摘要、sync-meta 和快通道摘要均不变，WAL 已正常关闭移除；生产写入 0、网络请求 0。临时 3.7 GB 副本保留作证据，未清理。

02:29:33 又核对旧、新两份隔离包全部各 502 个文件哈希未变；旧包基线798fd28a与19f16c9的 scripts/src-services/server源码没有差异，新包三份实际实现哈希与已提交 d8383fe9 中的优化一致。未向生产目录补装新模块。

私有汇总 `outputs/full-publisher-comparison-20260908.json`，SHA `de7e7dc87a980358f21bacd1a942948b6493d78b44caff0f7c4d5b965cc70809`；原始 `full-publisher-{run,baseline-run,profile,baseline-profile}-20260908.json` 的哈希在汇总中列明。工件不上传 Git，仅提交本说明。

02:29:00 原 r702 队列同 PID3577920 仍存活、waiting-not-before、attempted=false，app/live-complete 仍 r699，计划与门禁不变。下一步仍须取得新赛果写入与 PG 投影证据，再进行新版受控发布、双库同代及新 worker 周期验收；没有改动签名包、部署、提升模型权限或证明命中率改善。
