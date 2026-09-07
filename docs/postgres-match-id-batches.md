# PostgreSQL 比赛投影：小清单排序、正文分批读取

## 问题与修改

2026-09-08 02:49，在既有真实 SQLite online backup 副本上检查执行计划，原 `WHERE dataset IN ('current','history') ORDER BY id` 使用 dataset 索引，并将完整比赛正文送入 `TEMP B-TREE`。本副本共有 2,270 场、76,629,659 字节正文。只读连接仍会产生 SQLite 临时排序磁盘写入；它不是生产数据库写入。

`postgresProjectionSync.cjs` 新增 `iterateMatchSnapshotRows`：在原有 SQLite 读事务内先按原 SQL 二进制顺序遍历全部 ID，每批最多 200 个参数化主键查询读取原七列。保持完整清单、原 JSON 字节、哈希算法、PG 事务、归档/复盘算法和清理规则，不是只同步变更行，不改模型公式、冻结方向、时效或八秒 watchdog。缺行、ID/顺序或 dataset 不符、必要读取失败均抛错，外层回滚。

第一次实现仍在正文查询附加 dataset 条件，新的执行计划断言发现优化器仍选 dataset 索引并排序。保留失败事实；修正为主键限定查询，在返回行上验证 dataset，随后该断言与全部行为检查通过。没有改索引、强迫内部索引名、增加 SQLite 内存上限或写入生产库。

## 实际 Linux PostgreSQL 验证

使用服务器自带 PostgreSQL 16.14，无安装/云资源购买。独立目录 `/var/tmp/football-replay-qCvdSiHE/pg-shadow-0yeFNW`，ubuntu 用户、私有 Unix socket、TCP listen 为空、低优先级、32 MB shared buffers。每次写前核对 data_directory 和地址；每轮结束 `pg_ctl status=3` 确认停止。未使用生产连接凭据，生产写入 0，副本不复制回生产。

源为先前已 quick_check/整文件哈希验证的 3.7 GB SQLite online backup，活动代际 `g-377fb2e8249b04cfc50d87faa8d33da65d2bcde289d756558b009fc3c88914a7`。配套文件先前独立复制，不冒充跨文件原子捕获；缺失 AI arena 保留缺失。本次仅 `fast-result` 投影，不是 source/odds/prediction/private-artifact 全表 backfill 或新的官方赛果发布。

02:37 原实现空库首次投影成功，耗时 27,843 ms；相同指纹再次调用 16 ms，正确跳过。02:40 原实现 `force:true` 刷新已有库 12,947 ms。另一次 SQL 计时 13,792 ms，其中 194 次 PG query 共 3,640 ms；CPU 采样那轮总耗时 7,372 ms。环境负载/缓存影响明显，不能把任一数字当线上稳态保证，也不能把非 SQL 时间全部归因于 CPU 或排序。

02:53 候选实际源码 SHA-256 `9977f91f5176b0bb75963369537771dd6dd8f95020e34199bce3eeaf514c6d4e`，以新文件加入隔离目录，原 502 文件基线未被替换。完整强制投影成功，12,412 ms；194 次 PG query 共 3,207 ms。它仍高于八秒，不能宣称整条发布链路已解决。

原实现和候选均得到：2,270 场比赛、601 条冻结推荐、2,227 条结果观察和复盘，correctedFrozenRecommendations=0。候选投影后将 PG 每一场 payload::text 与 SQLite 全部原文精确比较：76,629,659 字节、2,270/2,270、忽略字段 0，哈希 `782983d48238cb9b828a1686c712f6e312ec7d36e15c9f96887df17870a89882`。601 条冻结推荐完整行（不仅方向）投影前后摘要均 `974a4b8f752fa0d5594cc6d0bd1b8601f02b79480ee6311dbfec7f11201563b4`。

初次 PG parity 测试脚本误用了不存在的 recommendation_id 排序列，在强制投影前失败并停止测试库；改成真实 decision_id 后完整复跑，原失败报告保留。本条是验证脚本修正，不是业务数据修正。

## 同一 SQLite 事务的四轮读取对照

02:55 按 old/new/new/old 顺序，在同一副本、同一只读事务中比较全部七列，包含原正文和空值。四轮均 2,270 行、全部原始列序列 SHA `3208a5c8bb29506b3537ee0179ca31889d91abbf9589453666464a050484c963` 相同，忽略字段 0。

| 观测 | 原读取两轮 | 新读取两轮 |
| --- | --- | --- |
| 读取与完整行摘要耗时 | 1,512 / 1,376 ms | 1,191 / 1,104 ms |
| 进程 write_bytes 增量 | 每轮 79,917,056 | 每轮 0 |
| 进程 wchar 增量 | 每轮 153,726,695 | 每轮 0 |
| 进程 rchar 增量 | 每轮约 236.9 MB | 每轮约 92.4 MB |

新 ID 清单仍排序，正文查询实际使用主键且无临时排序。上述 I/O 是该进程该读取阶段 `/proc/self/io` 差值，不是数据库体积缩减，也不是删除 80 MB 历史数据。约 20.5% 的本次平均读取阶段时间下降不外推为整条 PG 投影提速，更不能声称部署或命中率提高。初次读取比较因隔离环境未配置 pg 模块路径而在运行前失败；补上只读依赖路径后得到四轮结果，没有安装模块。

## 回归、证据与剩余边界

- 现有 `verifyPostgresSemanticReviewCleanup` 增加 23 项真实内存 SQLite 检查，共 86 项，Windows/Linux Node22.22.1 均通过；覆盖空库、跨批次/尾批、Unicode 二进制顺序、含引号 ID、原 JSON/空值、非法批量、提前结束、读失败/缺行/错序/错 dataset/非法 ID。既有 63 项复盘保护继续通过。
- 该验证器原本已在实际 production readiness 和签名包创建/验包必需列表内，本轮直接扩展该入口，没有添加一个不被发布流程调用的新测试。
- Windows Node22：272 项证据往返（PG 是 query-capture transport，不能当真实 PG）、冻结推荐校验、104 项快速赛果验证通过；两份修改源码的定向 ESLint 与 diff 检查通过。上文独立真实 PostgreSQL 测试另行补足真实驱动/存储证据。
- 私有证据只保存在 outputs 和服务器隔离目录，不提交真实数据：`isolated-pg-parity-20260908.json` SHA `04c7df588fed187b365994dc3e821ef3877eb1344b53faf8ed0d9b49e644fa8a`；`isolated-pg-cpu-20260908.json` SHA `ae30636726df18201ffbad0f8f038cdccf78cde529df28523fc2f889328afd86`；`isolated-pg-id-batches-20260908.json` SHA `815b5d3f06e23eec7b90d732c8f026edd28dde10764823750630f5bbc381908e`；`match-iterator-comparison-20260908.json` SHA `b4bcb5253699548a47fb4d9db5c5cb3df6563cdde84a3f75759c8a71c5126a64`。

02:57:34 只读复核原 r702 队列 PID3577920 仍存活、waiting-not-before、未尝试，原 03:31 启动/03:36 最晚和签名门禁不变；app/live-complete 仍 r699。02:57:37 实时 API 主读、dataFresh=true、recommendationReliable=false，快速监视器 02:51 最近成功耗时 7,277 ms、发布 0、lastError=null，当前等待 sync lock；可信结果证据年龄 66 秒。不能继续称它此刻持续 fetch failed 或 timeout，也不能把旧线上自行成功归因于未部署候选。

本轮不部署、不重签/重排冻结 6f86 的 r702；新源码不在该包中。仍需后续受控发布、新官方赛果真正写入、双库同代和新 worker 周期验收，以及 Q1–Q5 的剩余模型/长期证据/历史争议工作；没有宣称总体完成。
