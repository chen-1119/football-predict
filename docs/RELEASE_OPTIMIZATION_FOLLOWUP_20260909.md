# 发布提速后续实施与验收

本轮目标沿用四项方案，不能以“r718 上线成功”替代“部署提速完成”。r718 完整发布耗时 58 分 45 秒。

## 完成条件与当前进度

| 工作项 | 必须具备的证据 | 当前进度 |
| --- | --- | --- |
| 打通前端快速通道 | 精确受审安装代码、真实运行环境绑定、公开 accepted 前端身份 | 2026-09-09 15:46 北京时间独立回查通过；通道已初始化 |
| UI、后端、模型/数据分流 | 实际 UI 签名请求走独立索引事务；后端与模型更新兼容性、失败分流测试 | 16:36 的 r719 真实 UI 发布及独立验收通过；后台仍为 r718，其他分流继续实施 |
| 完整发布缩短 | 写锁协调、数据库准备、模型更新解耦的代码、风险测试及线上耗时证据 | 既有静态缓存、早拒绝、分步计时已上线；剩余重流程未完成 |
| 实际提速和回滚验收 | 新序号、精确前端/运行版本、阶段耗时、回滚证据、数据和服务未被误改 | r719 UI 发布实测 179.411 秒，单次构建、未重启服务；完整发布实测和回滚演练仍待完成 |

## 已定位并处理的快速通道问题

1. 备份脚本末尾多一个换行：仅在完整文件哈希及“末尾一个 LF”关系均匹配时恢复已接受 r718 的原字节。原文件和恢复凭证留在 root 私有目录。未修改脚本行为、定时器、数据库或服务配置。
2. GNU awk 的系统 alternatives 链：只支持 `/usr/bin/awk -> /etc/alternatives/awk -> /usr/bin/gawk`，包含已有 merged-usr `/bin` 别名。逐跳身份、root 归属、祖先权限、可执行目标及重查仍必须通过。不是放行任意 `/etc/alternatives`。
3. systemctl 省略空命令/环境文件数组：只对明确列出的数组读取 D-Bus 类型和零长度；非空、错误类型、失败或其他缺字段仍拒绝。
4. systemctl 将多个 EnvironmentFiles 分行输出：按原顺序合并，仅允许该字段重复；重复路径、空项和其他重复字段继续拒绝。
5. 未配置的条件式 COS 上传：仅对指定 COS unit、inactive/无 PID 状态和精确 `ConditionPathExists` 证据记录配置缺失；将缺失状态纳入运行绑定，重查配置出现、条件变化和服务状态。不会生成空密钥，也不宣称 COS 备份已启用。其他缺失环境文件仍拒绝。
6. 锁文件的 CRLF/LF 缓存身份差异：原依赖物料对应 a466c631… 的 CRLF 锁文件，r718 为 6b24452c… 的 LF 字节。重新导入必须核验完整旧物料哈希、完整锁文件 LF 字节相等及完整 JSON 相等；保留原安装来源，明确未执行新的 npm 安装。签名包与新存储仍绑定精确原始字节，不改成模糊匹配。package.json/package-lock.json 新增 LF 属性，避免未来工作区差异。

## 验证与安全边界

- 完整 Linux 安装运行时文件系统夹具 13 项通过；systemd 传输/解析 VM 合约 5 项通过；实际 Linux alternatives、权限、链接变更、配置缺失重查 7 项通过。证明范围不同，不合并成上线验收总数。
- 同一已测试运行时模块 SHA-256：`d695688b192fa024192c5d734c44bfd423fac6c5fc6c72a5c1a769f98fce799f`。
- 对已签名 r718 原始归档进行真实运行捕获通过：181 个运行源文件、6,587 个安装依赖成员、2,793 个 npm 成员、8,700 个已读文件；两个主服务真实 PID 均核验。此捕获本身不授权发布。
- 原安装脚本 `52a2bef8…` 已私有备份后替换为上述受审模块。所有修改使用发布内核锁；没有重启网站/采集服务，没有重放发布序号，没有触碰推荐冻结对象。
- 新增路径诊断仅包含受限路径和错误代码；不输出环境文件内容、凭据或任意异常信息。

## 复现命令

Windows 只运行真实适用的解析合约，不冒充 Linux 文件系统证明：

```text
node scripts/verifyFrontendInstalledRuntime.cjs --systemd-contracts-only
```

Linux 的完整夹具入口会同时执行 alternatives 和缺失状态重查：

```text
node scripts/verifyFrontendInstalledRuntime.cjs
node scripts/verifyFrontendRuntimeAlternatives.cjs
```

修改后的签包合约要求 Windows 5 个解析合约，Linux 至少 13 个完整夹具、5 个解析合约及 7 个文件系统专项。业务一致性、运行版本、签名、序号、恢复和公开接口检查均保留。

## 证据索引

当前工作区 outputs 中：

- `r718-runtime-repair-1788938508781.json`：备份脚本精确恢复及原文件备份路径。
- `installed-runtime-linux-1788939564147.json`：最终版本 Linux 夹具，源文件哈希及完整结果。
- `runtime-alternatives-linux-1788939469533.json`：实际 Linux 链接与缺失文件专项。
- `patched-runtime-probe-r718-1788939508335.json`：真实运行环境完整捕获通过。
- `fast-runtime-activation-r718-1788939636295.json`：受审模块安装通过，后续发现依赖存储编号不匹配；不是初始化成功证明。
- `fast-dependencies-r718-1788939928606.json`：完整依赖物料重新验证/导入与初始化成功，`frontendOnlyReady=true`，耗时 72.271 秒（一次性准备耗时，不是 UI 发布耗时）。
- `fast-runtime-live-state-1788939976198.json`：独立公开身份回查 `available=true`、`consistent=true`、`phase=accepted`；运行/前端基线仍为 r718，`recoveryPending=false`；主服务 PID 1774853、采集 PID 1697787 均未变化，健康、数据新鲜度与来源检查通过。

已接受前端状态 SHA：`654f6f0408f24853bea2d37829739787e1f7e7f12237b079126cfde56b98aca5`。本次没有修改 dist/index，也没有新的前端发布序号。新依赖存储承诺 `aa4a294ae726b7e0625392956883cf106bcd126f844fbcd5c5f7ca2502799ac3`，对应 11,882 项物料、176,335,485 字节；网络请求和包执行均为 0。

后续每一项应补充真实结果；不得将“待验收”改写为已完成或声称分钟级目标已经达成。

## 第二阶段：实测淘汰无收益方案，修正发布工具分类

2026-09-09 16:12（北京时间）完成以下工作，尚未部署新版本：

- 在独立 PostgreSQL 16.15 数据库验证了“先比较实际 JSON 文本指纹、仅传输变化快照”的实验：513 项正确性检查通过，包括全量清单/哈希、旧时间戳、空值、删除核对、冻结引用、真实 API 和行锁竞争。特别保留数据库微秒精度，不能用 JavaScript Date 的毫秒截断证明相等。
- 性能实验没有通过。200 条未变化 source 快照，交替执行、预热后的三次中位数如下；只代表本地批次，不代表完整发布：

| 单条测试内容字符数 | 原 upsert 批次 | 指纹比较批次 | 少传的内容字节/批次 |
| --- | ---: | ---: | ---: |
| 256 | 1.8056 ms | 3.0374 ms | 54,200 |
| 4,096 | 4.7507 ms | 6.1163 ms | 822,200 |
| 32,768 | 24.0759 ms | 30.0882 ms | 6,556,600 |

因此已撤回生产同步及集成测试中的实验接入，`postgresProjectionSync.cjs` 和 `verifyPredictionEvidenceRoundtrip.cjs` 与本轮开始前版本相同。实验代码仅留在未发布的 outputs 目录，不以传输减少冒充提速，也不新增数据库迁移。

已实际保留的代码修复：

1. 将四个明确的发布运行环境/验证工具加入模型兼容性分类的精确发布工具清单：`frontendInstalledRuntime.cjs`、`verifyFrontendInstalledRuntime.cjs`、`verifyFrontendRuntimeAlternatives.cjs`、`verifyReleaseVerifierContracts.cjs`。不是放行 `verify*` 通配符，也不跳过未知后端、模型、依赖、缺失产物及新鲜度检查；不改推荐资格。
2. 将 Linux alternatives 验证模块加入创建包和验包的真实必需成员数组，并加入签名前依赖检查。测试直接执行两个数组表达式，分别删除成员时均不能通过成员核对。
3. `verifyReleaseSpeedFix.cjs` 的 15 项专项通过；新覆盖精确工具变更可保留模型、近似文件名仍重算、模型产物字节不变、两个归档门槛均要求 Linux 新模块。没有为这一专项重复运行全套线上就绪检查。
4. 16:12 的只读线上对照使用新分类器在内存中执行，未安装/替换远程文件。当前候选与 r718 纳入模型兼容性核对的 636 个文件均一致，清单哈希 `9f8a9573911a1c523faa58e3a73bed0a6d383f6fb8d2f8ea2535e83f216de069`，差异清单为空；实际线上模型产物满足 `preserve` 条件。只是当前条件探测，真正发布时必须重查，不缓存成发布许可。

本轮读取 r718 原始分步证据得到：候选构建 828.491 秒，候选就绪检查 324.961 秒，SQLite 预构建 355.212 秒，PostgreSQL 阶段 220.460 秒，官方采集等待 311.617 秒，补充采集等待 535.494 秒，上线后就绪检查 301.912 秒。停止窗口 247.956 秒包含 PostgreSQL 阶段，不可重复相加。候选模型重算及对应归档/代次/SQLite 重建步骤合计 216 秒；这是旧发布阶段耗时，不是新版本实测节省值。r718 补充数据复用被 `enrichment-code-changed` 正确拒绝，不应绕过该检查。

后续仍需完成真实 UI 快速发布/回滚验收、完整发布耗时改善及合并上线。优先处理上述实际关键阶段，不能将模型回测自身的 23 秒误认成整个 58 分钟的主因。

新增证据（均在当前工作区 outputs）：

- `q1-native-postgres-evidence-result.json`：已淘汰的指纹传输实验，513 项检查和三档实测；独立数据库已停止并清理。
- `postgresSnapshotDelta.cjs`、`verifyPostgresSnapshotDelta.cjs`：仅保留实验实现，不在生产代码路径。
- `r718-stage-inspection-1788941325084.json`：固定发布 SHA 的原始历史阶段、子步骤和补充复用拒绝原因，远程只读。
- `model-release-classification-1788941545881.json`：新分类策略与线上真实源文件/产物的只读对照。

## 第三阶段：首个真实 UI 快速发布已完成

2026-09-09 16:36（北京时间），正常签名入口完成 r719，16:36:37 和 16:39:10 分别独立回查服务/身份及精确回执/构建证据。

- Git 主分支已接受 `d37713f9a7c9ad33d482f0dc0c3c9c3a965fb404`。这次原始字节差异仅 `src/styles/predictions.css`；构造器保留 r718 的全部非 UI 成员与旧 dist，不包含主分支新后端工具。
- r719 前端请求 SHA：`46e362242529fa768205fed31583ff1e97b66a31e5cc5963b49012d4ddc0021c`。后台仍为 r718，SHA `8c28ca0f4a5b6094b633c4ac5418becee18b05c2d9937a583b3479405b5353b8`。
- 接受状态：`kind=frontend-only`、`phase=accepted`、`available=true`、`consistent=true`；新 index SHA `48ba15f148df7039550beb43230cac4a0d427aafacdc6341ba0ce65d1f83f9a7`。
- 精确验收回执 SHA `8bb2b40bf537e06fe4b6195d23b3c5e12d72dfd4ca23386177d87e3c326faeea`，已核对请求、授权、构建证据、实际 index/dist 及 public state；回执检查包括 index、assets、health、protected、services。
- 单次打包及包装器核对 13.294 秒；正常部署入口到返回 179.411 秒，服务器控制器 157.671 秒。实际隔离构建为 64.016 秒，其中 tsc 14.380 秒、Vite 5.671 秒、静态清理 0.316 秒，其余为隔离准备/检查/清理。阶段有包含关系，不相加制造总耗时。
- `buildExecutions=1`、`repeatedBusinessVerification=false`、`servicesRestarted=false`、`databaseOrModelWrites=false`。网站 PID 1774853、采集 PID 1697787 与发布前一致；无待恢复事务，采集通道 2/2。
- 新 dist 保留旧内容哈希资源，共 87 个文件；构建输出本身 63 个文件。保留旧资源是旧客户端兼容要求，不是重复构建。
- 桌面真实浏览器加载 `PredictionsList-BAAEASsa.css`，三个摘要卡片加独立证据缺口行。缺口全文显示，`white-space: normal`；1474px 窗口内文字宽度/滚动宽度均为 1046px。窄屏实际 innerWidth=434px，文字宽度/滚动宽度均为 326px，段高 85px，无横向文字截断。手机截图捕获超时，只报告 DOM 证明；临时视口设置已恢复。
- 这次没有提升正式推荐资格。`recommendationReliable=false` 与 `modelRiskStable=false` 仍按真实证据保留；不能用 UI 成功声称命中率或正式推荐已达标。

准备阶段发现并修复的是本地旧输出目录观察脚本的问题，不是线上故障：最小 Windows OpenSSH 环境必须保留 `ProgramData`（本机 `ssh -V` 独立复现）；状态键正则必须允许 `bundleSha256` 中的数字，并继续使用精确字段白名单。六个解析正/负例和本地 OpenSSH 启动检查通过。失败观察没有签包、占用序号或改变服务器。正式部署只调用一次，r719 不重放。

本阶段证据位于当前工作区 outputs：

- `reviewed-frontend-d37713f9a7c9-r718-build-result.json`：单一 CSS 覆盖、非 UI 保留及 r719 签名身份。
- `reviewed-frontend-46e362242529fa768205fed31583ff1e97b66a31e5cc5963b49012d4ddc0021c-deploy-result.json` 与同名前缀 `.log`：一次正常部署，远端完成与双身份验收。
- `fast-runtime-live-state-1788942997353.json`：16:36:37 独立状态、健康、双采集和原服务 PID。
- `ui719-acceptance-1788943150033.json`：精确回执、授权、隔离构建证据及实际 dist 承诺；不是业务重验。
- `verify-observer-preparation.cjs`：针对旧本地观察脚本的六个实际解析片段正/负例与 OpenSSH 启动检查，不连接生产。

### 下一步及边界

1. 将当前依赖输出目录人工准备的 UI 基线读取/签包流程整理为可重复使用的正式入口，支持“后台 r718 + 当前前端 r719”而非只接受 full/full，避免下次再次改写一次性脚本。
2. 继续缩短完整发布中数据库预构建和采集等待等真实关键阶段，完成后再做一次新完整发布实测。16:16 的完整构建已在约 6 秒被切换窗口提前拒绝，未打包/未占序号/未部署；当时下一候选窗口 18:30，仅供重新观察，不是预约或发布许可。
3. 回滚验收仍未完成。现有 Linux 事务夹具证明与本次生产接受证明分别保留；不能为了制造回滚证据直接删除新资源、改写 accepted 状态或重放旧序号。

本次 179.411 秒只证明纯 UI 通道，不能与 r718 的 58 分 45 秒完整发布混用为“所有发布已提速约 95%”。四项整体目标仍未全部完成。
