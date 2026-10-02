# 2026-10-02 发布质量首批交付

## 方案与范围

基线 `6fce1805d0d8db0410c71231d6df6ce72ec766cb`，包含 `b79a97c44affbc416d40b2ae72fe38ff30e32062`。
工程 `.codex/worktrees/04-quality-release`，分支 `codex/football-release-quality`。

首批增加补充验收，不修改 UI、算法、采集逻辑、服务入口、数据库或发布门槛：

1. 将线上导出与指定回执的字节数、SHA-256、manifest entry 和同一 generation 绑定；输入缺失、重复条目或导出期间 publication 变化直接失败。
2. 补充只读连续性检查：显式决策时钟、15 分钟观察窗口、首页身份、内部/公开健康投影、运行时 marker、服务 PID/启动时间/进程身份和 PostgreSQL publication。
3. 复用既有方向/赔率/冻结选择比较，增加选中预测的公开概率与 frozenVersion 比较；冻结版本复用现有内容校验器。双方同时缺失报告 unavailable，不计入覆盖。
4. 以匿名 HTTPS GET 观察当前公开身份、首页、引用资源和受保护路径；保留独立的签名验收、登录验收和全量预检。

## 已改代码

- `scripts/releaseQualityEvidence.cjs`：可导入的补充验收函数；CLI 只检查线上导出目录。
- `scripts/verifyReleaseQualityEvidence.cjs`：定向测试，包含旧缓存、跨上海零点、真实输入缺失、身份漂移、匿名/登录分支、冻结记录不变。
- `scripts/observeReleaseQualityPublic.cjs`：匿名 GET 观察器。使用 curl 默认 TLS 验证、不跟随重定向、不携带认证信息、不创建测试账号、不触发服务操作。

所有结果都标记 `deploymentAuthorized:false`。导出检查证明与给定回执匹配，不独立证明回执真实性；连续性检查不替代签名验收；公开资源 200 不证明其字节与签名 manifest 一致。

## 已测及证据

`outputs/quality-release-20261002/` 保存定向测试、回归回执、历史证据过期检查、线上导出检查和新公开观察。

直接执行，无需修改 package.json：

```powershell
node --test scripts/verifyReleaseQualityEvidence.cjs
node scripts/verifyFrontendWorkerPreflight.cjs
node scripts/verifyRemoteRecommendationParityContract.cjs
node scripts/verifyCurrentListPayloadCompaction.cjs
node scripts/verifyFrontendReleaseIdentity.cjs
node scripts/releaseQualityEvidence.cjs <总控的线上导出目录>
node scripts/observeReleaseQualityPublic.cjs https://134.175.132.183
```

新增定向测试 42 项、既有路由回归 83 项、远端列表/详情契约 30 项、前端身份 19 项及列表压缩契约本次通过。Linux controller 的 41 项复用总控 `frontend-minimal-20261002/linux-controller-fixture-receipt.json`，时间为 20:26:49；本任务没有重新执行 Linux controller，也没有改它。

线上业务输入仅采用总控 `online-validation-20261002/` 中三份原始文件。实际 SHA 和 generation 绑定均通过；publication 提交时间是 **9 月 30 日 23:52:07 北京时间**，其中赛程文件只有一条 FINISHED 记录。这是历史发布批次，不能证明今日新赛程、模型效果或当前列表/详情一致。没有使用仓库旧业务数据证明线上效果。

20:40 历史连续性回执在 21:23 本次检查中被明确拒绝：before/after 均超过 15 分钟窗口。该拒绝是预期结果。

21:23:19 新公开观察：前端 r787 / 运行时 r785；首页 SHA 与健康投影一致，引用资源可读取，公开 publication 在观察前后稳定。四个受保护 API 返回 401；`/data/matches-current.json` 返回既有路由规定的 410 + `large static payload disabled`。只允许这个明确退役路径使用 410，API 的认证拒绝要求未放宽。

新观察仍为 `serviceOk=true`、`dataFresh=false`、`sourceHealthOk=false`、`recommendationReliable=false`。`publicObservationOk=true` 只表示这些有限公开检查通过，不表示可全量发布。

未做线上登录读取：没有使用已有账号或创建临时账号。列表/详情的概率与决策版本新增验收目前由契约测试验证，不能宣称已完成线上登录验收。公开观察也无法证明服务 PID、完整冻结 ledger 不变或签名资源完整性。

## 已上线状态及具体阻塞

本任务没有上线任何新增代码，没有生产写入、部署、重启、数据库查询或配置变化。

前端 r787 / 运行时 r785 的身份在本次公开观察中仍匹配总控历史接受状态，但新签名回执/完整资源验收和新进程连续性尚未采集。官方休市导致当前源为空是已核实的上下文；不能将其默认归为 567，也不能以休市说明替代既有 full lane 来源就绪门槛。

全量发布当前的明确阻塞是数据不新鲜、来源健康未通过；模型可靠性也未达到可靠推荐状态。模型状态单独报告：继续遵循既有模型/发布策略，不把“代码测试通过”或“发布接受”升级为模型可靠。所有既有 full lane 必需检查必须通过；本补充验收不取代、不绕开它们。

其他待补证据：登录列表/详情完整一致性、跨日与缓存下的 UI/API 联动、冻结 ledger 的发布前后精确哈希、新的 server/worker 进程连续性、签名回执/index/每个资源精确绑定、受保护路径完整矩阵。匿名采样 5 个路径不是完整安全审计。

## 统一集成顺序与冲突清单

1. 总控保持指定基线，先整合来源/worker 与算法领域提交，再整合 UI 领域提交和共享 schema/入口改动。
2. 最后合入本质量提交，先运行上述验证器，再执行既有完整代码检查和 required full lane 预检。
3. 用新的哈希绑定线上输入验证候选；通过新账号/既有会话的授权方式取得只读登录证据，避免使用验收器的 admin 自动建码路径。
4. 来源就绪、代码验证、模型可靠性与发布结果分别记录。等待官方来源恢复并通过原有来源门槛后，由总控准备签名候选和统一执行部署。
5. 发布后对照精确 candidate SHA、签名接受回执/index/资源、publication/冻结 ledger 和服务身份；完成后才报告“已上线”。

本提交只新增领域专用文件，无共享文件补丁。预计文本合并冲突为空。语义冲突点是未来 `confidence.publicMetrics.modelProbability`、`frozenVersion`、公开健康形状或退役路由改变；这些变化必须同步更新验收契约，不能删除失败检查来通过。`package.json`、`package-lock.json`、server/index、syncData、runSyncWorker、schema 与 deploy 配置均未修改。

## 发布前清单与回滚

- 确认集成候选 SHA、签名 releaseKind 与全量/UI lane 路由；保留 83 项路由及 Linux controller 验证。
- 确认官方源、freshness、publication、quorum 和所有原有 full lane 门槛；不把旧批次当新数据。
- 对新会话采集匿名/登录列表、详情、方向、概率、赔率、版本及冻结记录；unavailable 不能算覆盖完成。
- 获取新的签名回执/index/资源精确绑定，以及前后进程/数据库/ledger 证据。前端 lane 不得改变数据库或服务进程。
- 总控保留当前已接受 r787 前端与 r785 运行时的签名回执、manifest、恢复资料及数据库 publication 标识。不要仅备份首页，也不要清理恢复文件。
- 若 UI 发布失败，使用既有 controller 的 recovery/rollback 流程恢复先前已接受前端及其 receipt/identity，不重启运行时、不修改数据库；重新验收首页、完整资源及进程连续性。
- 若全量发布失败，使用原有签名全量 recovery 流程处理事务与服务恢复；不手工写 release marker，不通过数据库回滚删除发布后合法新增冻结记录。恢复后重新验证 runtime/frontend 身份、服务、publication 和受保护 API；生产操作仅由总控执行。
- 仅此测试提交需要撤销时，在总控集成分支 revert 本提交即可；它不改变生产行为或数据，避免对脏主目录执行 reset/clean。
