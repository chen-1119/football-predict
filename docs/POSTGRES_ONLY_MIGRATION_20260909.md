# PostgreSQL-only 迁移及发布减负

## 目标（尚未完成）

用户要求生产停用 SQLite，消除大库导出、候选库复制、二次导入及发布恢复的资源负担。不是仅关闭开关，不是继续优化 SQLite，也不是把同步数据完整性检查删掉。

最新基线：线上进程配置 PostgreSQL primary，同时 ENABLE_SQLITE_EXPORT=1，SQLite 为 3,765,624,832 字节。现有代码包排除 server-data，未携带该大库；此前完整包约 25 MB，不能把本机上传包与服务器内部复制混为一谈。实际依赖是 canonical generation -> SQLite -> PostgreSQL，并保留 SQLite 备用读取、模型审计、训练读取、快赛果回执和恢复。

证据：outputs/database-runtime-role-1788967433614.json；scripts/createReleaseBundle.cjs 的 excludes；scripts/postgresProjectionSync.cjs 的 syncPostgresProjectionFromSqlite；scripts/runSyncWorker.cjs 的官方/补充阶段导出。

## 实施顺序与验收

1. **模型审计原生 PostgreSQL：代码已加入，生产未启用。** runtimePrivateModelArtifactStore 统一异步入口；显式 PRIVATE_MODEL_ARTIFACT_STORAGE=postgres 时读写 PostgreSQL，连接/内容校验失败不回退 SQLite。原始 JSON 使用 json 而非 jsonb，读取 payload::text 并核对 SHA-256、UTF-8 字节数及原始时间戳。一次性导入只接受空记录或七字段完全一致，不能覆盖不同版本；原生写入与旧投影共享事务锁，原生模式不再从旧 SQLite 覆盖该表。模型回测输出和晋级校验已接入；隔离回测不能误写配置中的运行 PostgreSQL。默认仍是 SQLite，保留现有生产及隔离回测路径，切换必须随完整迁移验收进行。
2. **主同步去中转：真实 generation 数据源和原生快速赛果已实现，生产未切换。** `postgresGenerationSource.cjs` 读取真实不可变版本及哈希校验文件，直接构建 current/history、source/reference 索引、odds、prediction 投影，复用原冻结/归档和语义写入器。PostgreSQL 保留历史状态，仅加载小字段清单和按需原始载荷，不把整库搬进内存。重复预测保留最早捕获时间；保留期变化不清空历史。同步期间持有 generation 读租约，最终同一 pointer 锁贯穿异步 COMMIT/ROLLBACK，避免检查后被另一发布替换。原生快速赛果使用 PostgreSQL 命名操作接口和共用的发布算法，不模拟 SQLite SQL；原始回执格式、比分修订和 authority high-water 不改写。CLI/worker 快赛果入口按 `POSTGRES_PROJECTION_SOURCE` 选择存储；原生发布已经原子提交，不再次从 SQLite 复制。默认仍为 sqlite；禁止在下述剩余读路径、采集编排和发布恢复迁完前开启生产开关。
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

## 2026-09-10 继续执行记录

- 原生审计/数据源/快速赛果共 28 项真实 PostgreSQL 场景通过，SQLite 加载尝试为 0。含真实 generation 文件、同时间戳冲突保持原始预测、保留历史、pointer 变化回滚、异步 COMMIT 锁、签名赛果直接发布、旧 base 不复活已完赛比赛、同比分重放、较新纠错与较旧重放拒绝。证据：`outputs/native-private-audit-result.json`。
- 真实 PostgreSQL 证据往返 405 项通过，新增“原 SQLite 投影切为 generation 直接投影”后所有快照原始 JSON 及 tuple 版本保持不变；包含冻结平局、公开推荐证据、归档复盘、真实 PostgreSQL-primary HTTP 授权读取。证据：`outputs/q1-native-postgres-evidence-result.json`。该兼容性套件有意创建 SQLite 作对照，不与原生路径的零 SQLite 测试混淆。
- 旧导出 198 项、快速赛果发布 104 项、普通证据往返 285 项及生产计划 73 个源码约束通过。两个辅助模块改为真正使用遗留功能时才加载 SQLite，单纯导入原生数据源不再隐式加载旧后端。
- 00:04（北京时间）线上只读核验：r718 后端 / r719 前端，服务正常、数据新鲜、采集 2/2、recoveryPending=false。模型可靠性仍按证据门槛关闭，不因数据库迁移放宽推荐。证据：`outputs/fast-runtime-live-state-1788969871205.json`。
- 00:13 发布预检仍为 `transition-window-closed`，下一次候选准备时间 2026-09-10 08:30（北京时间），非预授权、非预约。证据：`outputs/reviewed-release-window-1788970435539.json`。

剩余工作不只是等待窗口：worker 的完整同步/模型诊断仍使用 SQLite；生产 API 的双库配对及回退、模型训练读取、部署候选隔离与恢复链路还需迁移。不得把当前代码验收或主分支合并当成完整退役或上线完成。没有改线上配置、没有关闭导出、没有删除旧库。用户要求的本地清理位于成功上线之后，当前不删除工作树、未提交输出、回退库或旧发布证据。
