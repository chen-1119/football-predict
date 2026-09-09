# PostgreSQL-only 迁移及发布减负

## 目标（尚未完成）

用户要求生产停用 SQLite，消除大库导出、候选库复制、二次导入及发布恢复的资源负担。不是仅关闭开关，不是继续优化 SQLite，也不是把同步数据完整性检查删掉。

最新基线：线上进程配置 PostgreSQL primary，同时 ENABLE_SQLITE_EXPORT=1，SQLite 为 3,765,624,832 字节。现有代码包排除 server-data，未携带该大库；此前完整包约 25 MB，不能把本机上传包与服务器内部复制混为一谈。实际依赖是 canonical generation -> SQLite -> PostgreSQL，并保留 SQLite 备用读取、模型审计、训练读取、快赛果回执和恢复。

证据：outputs/database-runtime-role-1788967433614.json；scripts/createReleaseBundle.cjs 的 excludes；scripts/postgresProjectionSync.cjs 的 syncPostgresProjectionFromSqlite；scripts/runSyncWorker.cjs 的官方/补充阶段导出。

## 实施顺序与验收

1. **模型审计原生 PostgreSQL：代码已加入，生产未启用。** runtimePrivateModelArtifactStore 统一异步入口；显式 PRIVATE_MODEL_ARTIFACT_STORAGE=postgres 时读写 PostgreSQL，连接/内容校验失败不回退 SQLite。原始 JSON 使用 json 而非 jsonb，读取 payload::text 并核对 SHA-256、UTF-8 字节数及原始时间戳。一次性导入只接受空记录或七字段完全一致，不能覆盖不同版本；原生写入与旧投影共享事务锁，原生模式不再从旧 SQLite 覆盖该表。模型回测输出和晋级校验已接入；隔离回测不能误写配置中的运行 PostgreSQL。默认仍是 SQLite，保留现有生产及隔离回测路径，切换必须随完整迁移验收进行。
2. **主同步去中转：写入器解耦已实现，真实 generation 数据源待接入。** syncPostgresProjectionFromSource 接收完整数据源接口，复用已有 SERIALIZABLE 事务、互斥锁、冻结推荐处理及原始 JSON 写入；SQLite 仅在遗留 source 工厂中延迟加载，原生 source 不需要该模块。来源代际/元数据必须一致，来源变化会回滚 PostgreSQL 事务。接下来从已签定的 immutable generation 直接构建投影，复用推荐冻结和回执规则。涵盖 current/history、source/reference 索引、odds、prediction、私有审计、AI 账本及语义记录；覆盖快赛果单调更新和源代际一致性。禁止临时内存 SQLite 冒充去依赖。原写入事务必须保持原子、快照来源可追溯，失败不替换 current 发布。
3. **生产读路径和采集/训练去 SQLite：待实施。** 显式 PostgreSQL-only 模式下接口、诊断、快赛果、训练/模型读取不再打开 SQLite；健康状态区分“已退役”和“数据异常”。PostgreSQL 故障明确拒绝或使用经核验的不可变发布回退，不悄悄读取旧库。开发/遗留兼容代码可保留，但不得成为生产依赖。
4. **发布与恢复去大库流程：待实施。** 删除 PostgreSQL-only 发布的 SQLite 候选复制、export、prebuild、seal、WAL 快照、parity 及恢复重建；替换为 PostgreSQL 发布事务、数据库独立版本化迁移及已验证的备份/恢复策略。应用回滚不得把冻结推荐或已结算结果倒退。候选数据/模型工作必须在独立环境，不得拿线上 PostgreSQL 当候选库。按真实剩余阶段重算时间预算，不只下调常量强行放行。
5. **一次性迁移、切换和实测：待实施。** 先核验 PostgreSQL 原始记录/哈希/时钟与旧库、原始归档的一致性；在写屏障内切换 worker、runtime、release 配置，证明不再访问 SQLite。旧库只保留一次性只读回退备份，验证通过前不删除。新版本成功签包部署后比较冷/热部署各阶段、传输字节、磁盘峰值、服务停机时间、采集延迟及冻结推荐连续性。未通过不能声称目标完成。

## 当前验证

- outputs/native-private-audit-result.json：独立 PostgreSQL 16.15，10 个真实数据库场景通过。包括原生写读、原始中文/空白 JSON 导入、重复导入、冲突拒绝、缺记录、哈希/大小篡改、非法字段、连接失败无 SQLite 回退、触发器篡改导致事务回滚。原生路径 SQLite 尝试次数为 0；生产写入为 0；独立集群已停止并清理。
- 原 SQLite 审计 12 项通过，现存兼容路径未删除。
- 原生数据源另有六个真实 PostgreSQL 场景通过：直接写入原始 JSON、记录 sourceKind/SQLite 字节数为零、未变化来源跳过并关闭、旧时间戳 reference 增量更新、来源变化回滚数据及发布记录、未知来源拒绝。使用合成原生行提供器，尚非线上 generation 转换器。报告同上，整个原生测试期间 SQLite 尝试次数为零。
- 原有证据往返 285 项通过（SQLite 文件和 HTTP 为实际执行，PostgreSQL 是 query-capture 模拟传输）；不将其与上述真实 PostgreSQL 证明混淆。
- 生产计划的 73 个源码约束及回归通过，模型 shadow/晋级门槛不变；发布包两个成员门槛要求携带新入口和原生模块。
- ESLint / git diff 检查通过。

这仅证明第一阶段代码及原生审计存储行为，尚未证明所有模型输入、主同步或完整部署不使用 SQLite。此分支没有修改线上环境、没有关闭导出、没有删除旧库、没有进行新生产部署。
