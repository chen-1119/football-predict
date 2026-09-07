# r704 源码的真实 PostgreSQL / HTTP 回归

2026-09-08 05:02:49，北京时间。源码冻结于 `c546247ac6d134bea1f92eca1d83915ebd70190a`，对应已签名 r704；本记录不改变签名源码。

复用现有 `verifyEvidenceNativePostgres.cjs` 与 PostgreSQL 16.15 免安装运行时，不安装服务、不连接生产数据库。创建新的临时数据库目录、随机 SCRAM 口令与回环端口65055；实际 SQL 核验数据目录和127.0.0.1监听地址后，运行最新 `verifyPredictionEvidenceRoundtrip.cjs`。

结果为 **390 项通过**。不同于14组预检中默认的278项（PG transport替身），本次启用真实 PostgreSQL 驱动、迁移、全量/增量投影、实际读取，并分别启动SQLite/PG主读的真实HTTP服务。原query-capture回归仍保留。

覆盖包括：源构造器生成的独立公开参考记录、同决策签名市场证据、私有特征绑定、PG迁移与upsert不改写未变行、旧时间/新增版本/空与缺失账本处理、完整代际绑定、管理员鉴权、按原hash取回证据、no-store、非法输入拒绝、静态整档禁用。测试仍以原公开“平局”对照当时市场第一名“主胜”，不从后来结果重新选方向。

这是**合成数据 + 真实本机数据库/HTTP**，不是生产上游证据、Ubuntu生产worker周期或390条正式预测；不能将签名合成测试当作独立来源见证，也不能由此宣称命中率提升。生产Q1–Q5验收仍需继续。

报告为新发布工作树 `outputs/q1-native-postgres-evidence-result.json`，1120字节，SHA256 `1c191f90e0a72107f2621f6eda6c4dcc510b13dc2af2a3041328147e75bac09d`。结果cleanup=true；pg_ctl确认停止后仅清理本次临时测试库，05:03额外查询端口65055无监听。

实际被测Windows源码字节（本地换行也计入hash，不冒充之前Linux隔离包字节）：

- verifyPredictionEvidenceRoundtrip.cjs：`fff0a27b02c7604a19c339fad87d830cf3d56f501bfefb3f259ea4a4d0a34aa8`
- postgresProjectionSync.cjs：`8310b4c3984cd140438299fd0d9f982d43b2facc0b73f05fd06ce7d78a9d50f7`
- postgresProjectionStore.cjs：`2d704595067279bdb1046c9f2e61be64f876090252a2d9e36a6fd2c2c3662571`

r704服务器单次队列SHA `589889b871c82b39d9d224a9ec7e9617c4493b1d65b50c8649e83ea61d2021f2` 已实际创建，05:03:58 PID1068317存活且waiting-not-before/attempted=false，计划07:01尝试，07:06以后不再开始。队列仅安排时间，未预授权窗口；根签名入口仍必须通过实时窗口及最终校验。不能称已上线。
