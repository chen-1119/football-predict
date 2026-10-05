# 第二批：采集原证据的 shadow 接入

基线为首批提交 `5ee205fc2bea2dcca4f49b3dcd467503d760f326`。本批新增来源专用适配器和验证器，不编辑 `runSyncWorker.cjs`、`syncData.cjs`、公共 schema 或 deploy，不改变线上计时器，也不关闭旧采集。

## 接口与证据范围

`scripts/sourceCollectorShadowAdapter.cjs` 导出：

- `adaptSourceCollectorAttempt(entry, options)`：读取现有 `collectSportterySnapshot.cjs` 的 endpoint 或 collectorErrorRecord；成功时复用既有 Ed25519 验证器，核对 payload 规范哈希，以及签名绑定的源 URL／角色、HTTP、原文哈希、字节数、请求／接收时钟和周期。可传原始 Buffer 再验原文哈希与 JSON；不重建原文。
- `adaptSourceCollectorFailure(error, options)`：在真实 `fetchEndpoint` catch 内消费 `error.collectorAudit` 与 `error.response.rawBody`。HTTP 200 的解析失败可据原始字节分类；存档只留下错误文本且没有原文／签名时保持 unknown-evidence。
- `adaptSourceCollectorSnapshot(snapshot, options)`：仅选 current 端点的最新尝试；最近的失败不能被旧成功掩盖，all／result／calculator 不能冒充 current。相同时钟的冲突、周期不匹配保持未知。
- `readSourceCollectorShadowFiles(paths, options)`：显式读取最多四个、各不超过 20 MB 的快照文件；记录文件 SHA-256，只读比较 full 与 last-failed 原证据。缺文件、无效 JSON、时钟缺失、同刻冲突不回落到“正常”。

options 必须带 `asOf`；默认证据年龄上限 15 分钟，可显式配置。`closure` 传已核实的首批官方公告凭证；`trustRegistry` 可明确指定现有可信公钥库；`previous` 是上一份 shadow 状态，仅复用失败计数与 attemptKey；`sourceDataUpdatedAt` 只能传已有业务时钟，未知为 null。`retryAfterSeconds` 仅由可信响应头适配器显式传入，本批不猜测未保存的响应头。

成功响应需要签名及 payload 校验，或者调用方提供匹配原哈希的真实字节；后者仅证明原文完整性，不证明采集者授权。所有结果固定 `shadowOnly=true`、`schedulingApplied=false`、`publicationAction=none`，任何成功都不能升格正式推荐或生产接收资格。

| 输入证据 | shadow 状态 | 用途 |
| --- | --- | --- |
| 已验证原响应，HTTP 200／success=true／errorCode=0，严格 current schema 零行，公告有效 | closed | 输出休市低频观察建议；不改业务更新时间，不生成比赛 |
| 同样证据，真实非空列表 | available | 仅记录来源状态；行数从 payload 重新计算，不信 endpoint.rows 摘要 |
| 正确完整 HTTP／时钟／哈希，403／429／567 | blocked | 保留状态、哈希与周期，至少六小时退避；不绕过访问限制 |
| HTTP 200，原字节匹配哈希且 JSON 解析失败 | failed／raw-response-json-parse-failed | 与 567 区分；错误文本不输出 |
| 已核实原 JSON，但 schema 或业务成功标志失败 | failed | 原因固定且有界；不借休市遮盖故障 |
| 缺 HTTP／哈希／时钟／签名，证据过期或未来、来源范围不符 | unknown-evidence | 不从文字猜测 HTTP 或解析故障，不套用旧成功；无可执行退避建议 |

退避建议依原响应 receivedAt 计算，不能用新的观察时刻延后同一次失败。重复 attemptKey 不递增失败次数，nextAttemptAt 也不漂移。本批返回的建议不会传给实际计时器。

## 总控 worker 的精确补丁提案

`outputs/source-cloud-shadow-20261002/worker-shadow-integration.patch` 仅给失败状态增添可选 `sourceCollectionShadow`。总控可先应用并验证；默认 `SYNC_WORKER_SOURCE_SHADOW` 不等于 1 时不读取新状态。开启后只读现有 relay 与存在的 last-failed 文件，并使用已有 worker 状态保存 shadow 计数。无修改 loopDelayMs、relayWakeEligible、发布错误判定或恢复门槛。

公告凭证的建议独立路径为 `SERVER_STORE_DIR/sporttery-sales-closure-verified.json`，由总控管理，包含首批 closure 的明确字段。它不是自动生成的节假日日历；本批未创建生产文件或变更环境变量。未提供公告时只能输出 unknown-empty，不能默认休市。以后若把建议用于真实退避，须单独检查与既有更长退避取 max、适用来源范围及失效期限，不能直接把 shadow 输出当调度授权。

回退方式：不开启／取消该可选开关即恢复原路径；若补丁撤回，独立模块和回执仍可离线使用。旧快照、计数之外的业务数据、发布代次及旧采集通道均未改。

## 真实验证与未验证部分

定向测试调用真正的 `fetchEndpoint`、`collectorErrorRecord` 和既有签名验证器，以注入的 request 返回合成 HTTP／原字节，使用测试专用密钥。不是互联网取数或真实官方数据恢复证明，不使用生产密钥。覆盖签名与原文篡改、响应时钟、角色／周期、正常休市空响应、567、解析错误、重复观察、较新失败、并行文件冲突和读取预算。

本轮另核对总控已保存的线上 diagnostics 原文件哈希，读取其中 current 摘要作离线回放。它缺完整 HTTP、原文和逐响应时钟，适配结果必须为 unknown-evidence；不会补写 HTTP 200 或借 relay.capturedAt 作响应接收时间。历史 10 月 2 日“官方成功空响应”结论仍是总控历史回执结论，不能变成一次新的实时健康证明。

运行：`node --test scripts/verifySourceCollectorShadowAdapter.cjs scripts/verifySourceCloudDiagnostics.cjs`。兼容性验证：`node scripts/verifySyncWorkerCurrentSourceCooldown.cjs`。本机 Node 为 v25.8.1／Windows；未在云端目标 Node 22 或生产 worker 上执行。补丁须在总控当前 worker 上重新检查上下文和既有测试后集成。

## 已有 dot／云交接的再次核查

材料在主目录 `outputs/dot-football`，本分支仅只读访问并记录文件哈希。

- `migration-receipts-20260930.json`：记载浏览器／云电脑接入曾确认、离线执行曾回读，但 official-live 的 cloudExecutionVerified、productionEligible、websiteMigrationCompleted 和 cloudSchedulesConfirmed 均为 false；legacyCollectorsDisabled=false。
- `cloud-offline-readback-receipt-20260930.json`：本轮重新计算四个本地回读结果文件的 SHA-256，都与保存回执一致；范围是云端离线包完整性及 305 场历史回放，不能证明官方实时来源恢复。
- `cloud-terminal-execution-20260930.json`：保存的工作目录是 `/workspace/scratch/6211c9389618/football-dot/bootstrap/offline-20260930/extracted/bootstrap-20260930-0955`；记录校验空模板 exit 1、历史回放 exit 0，属于 9 月 30 日历史环境。未把这个临时 scratch 目录当作今天仍存活的云电脑或守护进程。
- 已归档的 `deploy/dot-football` 中有 run-template、source-registry、migration-state、dot-instructions 和 README。本轮只读重验 source-registry 与空模板合同；空模板必须失败，不能把模板视为成功采集。归档 migration-state 的 awaiting-cloud-access 是早期状态，不能覆盖后来的有限离线接入回执。
- `football-coordination-setup-receipt-20261002.json` 保存两项北京时间 08:00／16:00 协调巡检计划及待验收项目；toolNextRunTime 为 null，首个计划执行与持续采集没有本轮实时运行证明。协调任务不是五分钟采集守护进程。

当前仍缺：可确认存活且持久化的云运行环境与版本、真实源访问许可和 HTTP 原文留证、可信公钥／接收角色、连续定时执行凭证、实际订单费用／预算、七天包含恢复销售的双跑及回滚验收。本轮未购买、创建或启动收费资源，未更改 dot 计划，未发送跨会话消息；旧采集继续由总控保留。
