# 发布阶段证据与耗时

`scripts/releaseStageEvidence.cjs` 为**同一个实际发布 run**保存有界、追加式阶段证据。它不调度发布、不自动重试、不清理恢复标记、不作为测试缓存，也不把阶段成功当成上线验收成功。

## 记录与信任边界

- 发布身份是完整包 SHA-256、发布序号和独立 `runId`。调度入口在实际派发时生成并持久保存 `runId`；观察和阶段重试沿用该值，不能根据“最近发布”猜测。
- 每个阶段有独立 `attemptId` 和递增 `attempt`。相同阶段再次执行保留历史；同阶段尚未结束时拒绝新尝试。同包不同 run 不互相借用证据。
- 每条事件有序号、前一条事件哈希和当前哈希。文件以排他创建和 `fsync` 写入，Linux 同步目录；不覆盖历史、不自动截断或修复。锁竞争、遗留锁、半写记录、哈希异常均要求检查原任务，不表示任务已失败，更不授权重新部署。
- Linux 日志根和 release 目录须属于运行记录器的 UID，权限 0700；事件和请求须为该 UID 的 0600 单链接普通文件。生产应由 root 在 `/var/lib/football-release/stages` 下创建，不能交给构建用户或放在 APP/NEXT 中。
- 哈希链检测意外损坏和错配，不防御拥有日志目录写权限的恶意用户。此模块没有签名证明，也**绝不授权复用测试或跳过现有安全检查**。
- Windows 用于本地功能测试：没有宣称 Windows ACL 认证、目录 `fsync` 或跨进程 PID 存活证明。Linux 才读取 boot ID、`/proc/<pid>/stat` 的启动 tick 并检查信号 0 和非僵尸状态。

## 两种不可混淆的证据

`runStage(options)` 执行一个直接子命令（不使用隐式 shell），记录开始、实际 child PID/启动身份、`close` 事件、退出码/信号、超时、输入前后指纹。只有真实关闭且退出 0、未超时/取消、输入仍完全一致，才记录 `succeeded`。输入变化为 `input-drift`；输入消失为 `input-unavailable`。失败和等待不是同一个状态。

本模块只证明**这个直接命令**已退出；命令是否覆盖全部验证项，仍由原验证器负责。主动放到后台然后提前退出的工作，不因其启动命令返回 0 就获得完成证明。调用方应沿用现有等待完整子任务的命令，不能包装 `... &` 来伪造阶段完成。

`recordCheckpoint(options)` 用于 `write_recovery_phase` 等 shell 边界观察，提供 `begin`/`end`。即使传入 `observedOutcome: "ok"`，报告也只有 `observed-closed`，`commandSucceeded=false`。它是测量边界跨度，不是前一个命令成功的证明；不能在进入下一阶段时自动补写上一阶段“成功”。

## API / shell 接入

先创建 private store（父目录已存在），再由可信脚本以原子私有文件传递请求。CLI 输入文件限 64 KiB。

```js
const { runStage, recordCheckpoint, reportStages } = require('./scripts/releaseStageEvidence.cjs');
const identity = {
  storeDir: '/var/lib/football-release/stages',
  release: { sha256: '<64 hex>', sequence: 712, runId: '<dispatch identity>' }
};
await runStage({ ...identity, phase: 'candidate-readiness', attemptId: '<unique attempt>',
  category: 'work', command: '/opt/node-v22.22.1/bin/node',
  args: ['scripts/verifyProductionReadiness.cjs'], cwd: '<trusted candidate worktree>',
  inputFiles: [{ name: 'bundle-manifest', file: '<sealed manifest>' },
    { name: 'generation-manifest', file: '<actual generation manifest>' }],
  timeoutMs: 900000 });
recordCheckpoint({ ...identity, phase: 'swap-boundary', attemptId: '<unique span>',
  eventId: '<unique observation>', boundary: 'begin',
  inputIdentity: { bundle: '<64 hex>', generation: '<64 hex>' } });
```

`inputFiles` 至少 1 项、最多 64 项。每项是安全标签和实际绝对文件路径，逐块计算 SHA-256 并核对读前/后 inode、尺寸和变更时间；单文件限 64 MiB。应传递已封存源/依赖/数据清单，而不是每次哈希整个多 GB 数据库。命令返回后再次核对。文件成员完整性仍由调用者决定；缺少依赖不会因这个模块自动得到覆盖证明。事件只保存组合哈希，不输出原始路径、环境或命令参数。

观察边界的 `inputIdentity` 是调用者提供的带名 SHA-256 集合，模块只检查一致性，不宣称已读取其底层输入。正式命令证明使用实际 `inputFiles`，两者在报告中明确区分。

CLI：

```text
node scripts/releaseStageEvidence.cjs run /absolute/private-request.json
node scripts/releaseStageEvidence.cjs checkpoint /absolute/private-request.json
node scripts/releaseStageEvidence.cjs report /absolute/private-request.json
```

`run` 保留子命令 stdout/stderr，自己的单行结构化结果写到 stderr；成功返回 0，超时 124，其他未成功返回 1。沿用现有 shell `|| abort_before_swap/rollback`，不能因为计时器接入改变恢复决策。wrapper 必须以可读取 root 日志的可信身份执行；需要降权的命令应通过既有安全入口执行，不能给予候选代码日志写权限。

库没有通用 `finish-success` API；不要新增接收任意“成功”字符串并写 command-end 的 shell 接口。`checkpoint` 的 begin/end event ID 可用于观察请求的幂等重试，语义不一致的同 ID 请求被拒绝；`run` 每次执行生成新的真实事件，不能通过重复 attemptId 再跑已完成命令。

## 查询、时间和上限

报告只读最多 512 个 8 KiB 事件（最大 4 MiB），目录读取最多 1030 个条目；超过上限直接报错，保留原始证据。最多 256 个阶段尝试。读取跨追加时返回观察异常，重查同一 run，不启动任务。

耗时优先使用相同单调时钟域的差值；跨重启/Windows 跨进程观察不编造耗时，返回 null。UTC 起止时间用于关联日志；若墙钟回拨，单调耗时仍可用，但 `wallClockConsistent=false`。未结束阶段的 elapsed 是截至观察时的跨度，不是最终耗时；没有假百分比。进程实际存活才返回 `running`/`waiting`；仅有开始记录为 `unconfirmed-running`。

所有报告始终 `reusable=false`、`liveAcceptanceProven=false`。`productionWrites=0` 只描述只读报告，不用于描述运行子命令。

## 接入顺序与 r711 的边界

1. 在调度入口创建独立 run 身份，并由 root 持久保存。
2. 首先包装现有 readiness 和数据库准备命令，保持原 timeout、cgroup、UID 和失败处理。
3. 对已存在的恢复阶段增加 observation begin/end，不改变恢复状态机。
4. 轻量进度查询读取本次 run 的报告；它不能再次调用命令或全量验证。

r711 的恢复 `phase` 文件只保留最后值；旧日志许多阶段没有精确起止时间。因此不能事后生成这套“当时已经记录”的事件，也不能从稀疏轮询推断精确停机时间。新模块只从实际接入之后生成证据；旧保留日志中的明确命令耗时可另行统计，但必须标为旧日志记录，不冒充本 journal。

## 验证

```text
<Node 22>/node scripts/verifyReleaseStageEvidence.cjs
```

测试实际创建私有文件系统 journal、启动成功/失败/超时/修改输入的子进程，覆盖同阶段并发、跨阶段并发、记录器崩溃、遗留锁、半写记录、重复请求、身份漂移、哈希篡改、有界读、CLI stdout、精确时钟及 Linux PID 启动身份/权限。不会部署或修改生产数据。

2026-09-08 验证结果：Windows Node 22.22.1 通过 25 项；隔离 Linux `/tmp`、Node 22.22.1、UID 1000 通过 27 项，套件耗时 1439 ms。无需 sudo，不读写应用或业务数据，临时目录均已移除。机器可读证据在 `outputs/release-stage-linux-1788857467789.json`，绑定实际执行的两个源码 SHA-256。

首次真实 Linux 并发验证发现“锁外读取下一个 attempt”可能撞上另一记录器尚未写完的事件，保留失败证据 `outputs/release-stage-linux-1788857405517.json`。修复为持有追加锁后才分配 attempt；同阶段两个真实记录器竞争时，一个记录开始，另一个明确拒绝，历史不会覆盖。该修复后重新验证的是受影响的阶段记录套件，不是重新执行完整发布。

## 已接入的 shell 观察接口

`scripts/releaseStageShellBridge.cjs` 是现有发布 shell 的观察接口，不运行子命令，不签发测试缓存。生产 CLI 固定使用 Linux/root、`/var/lib/football-release/stages` 和当前 Node 的真实父进程。源码文件及其直到 `/` 的所有祖先目录必须 root 所有、不可被组或其他用户写入；journal 祖先也必须受保护。只有库测试面允许显式隔离 fixture 边界，CLI 没有对应参数或环境开关。

初始化在同包 SHA 的排他锁内生成独立 UUID runId，并以 root 0600 文件原子写入 `identities/<sha>.json`；绑定发布序号、控制 shell 的 PID/boot/start tick，以及实际 bridge/module/release shell 文件哈希。后续 begin/end/recovery/finish 必须匹配同一来源和控制进程。重复 init 不创建新 run，已结束的 run 不允许重新开始；失败或半写 identity 不会被覆盖。

```text
node "$TRUSTED_SOURCE_DIR/scripts/releaseStageShellBridge.cjs" init "$BUNDLE_SHA256" "$RELEASE_SEQUENCE" "$TRUSTED_SOURCE_DIR"
node "$TRUSTED_SOURCE_DIR/scripts/releaseStageShellBridge.cjs" begin "$BUNDLE_SHA256" "$RELEASE_SEQUENCE" candidate-readiness
node "$TRUSTED_SOURCE_DIR/scripts/releaseStageShellBridge.cjs" end "$BUNDLE_SHA256" "$RELEASE_SEQUENCE" candidate-readiness ok
node "$TRUSTED_SOURCE_DIR/scripts/releaseStageShellBridge.cjs" recovery "$BUNDLE_SHA256" "$RELEASE_SEQUENCE" "$phase"
node "$TRUSTED_SOURCE_DIR/scripts/releaseStageShellBridge.cjs" finish "$BUNDLE_SHA256" "$RELEASE_SEQUENCE" ok
node "$TRUSTED_SOURCE_DIR/scripts/releaseStageShellBridge.cjs" report "$BUNDLE_SHA256" "$RELEASE_SEQUENCE"
```

实际 shell 通过 `release_stage_observe`、清空环境的 `env -i` 和 Node 直接调用。**不要在外面加 `timeout`、`bash -c`、命令替换或其他会改变每次 Node 父 PID 的包装层。** 恢复流程仍只认可原 `write_recovery_phase` 的原子写和 fsync；新增观察在 fsync 成功后才执行，fsync 失败仍先返回错误。

观察失败仅返回经过脱敏的固定 warning，CLI 退出 0；shell 还通过原地 `|| log` 处理模块或二进制不可用。它不会吞掉被观察的原验证命令退出码，因为观察调用与原命令的 `|| abort_before_swap`／`|| rollback` 分支是独立的。不能用观察命令返回 0 作为阶段或发布成功判断。

已连接 11 个明确跨度：候选构建、候选 readiness、官方数据准备等待、SQLite prebuild、受控停止窗口、切换、PostgreSQL 投影、worker 官方阶段等待、worker enrichment 等待、上线后 readiness 和 finalization。恢复状态切换只关闭上一观察跨度为 `unknown`，绝不自动补写上一项成功。finish 对没闭合的子阶段同样只记录 `unknown`。

### 三类时间不要混用

- `release-observation` 从既有 `trap release_exit_trap EXIT` 安装之后开始，到正常 finish／错误观察结束；它只覆盖**受保护发布事务段**，不含此前只读配置/worker/转换窗口检查和可能的一次性 TLS 动作。
- 完整派发到结束的耗时继续读取现有 release status 的真实起止时间，不把上述跨度冒充 r711 的 59 分 19 秒总耗时。
- `stopped-window` 是控制脚本调用停止到健康探测通过的边界跨度，不是高频外部探测测得的精确公众访问中断时间。缺失关闭、进程被强杀、不可写 journal 等情况保留“不完整观察”，不推断终态。

完成后的历史 `report` 可以从 APP 中的桥接脚本读取原始 journal；无需原已清理的 trusted source 目录还存在，也不要求控制 shell 还活着。这只是历史只读报告，不会恢复或续跑该发布。

### 接入验证证据

`scripts/verifyReleaseStageShellBridge.cjs` 本地 Windows 14 项通过；2026-09-08 真实 Linux Node 22.22.1 的 20 项通过，846 ms，UID 1000 的显式私有 fixture，无 sudo、无生产 journal/应用/服务写入。`outputs/release-stage-bridge-linux-1788858862597.json` 绑定四个实际输入源码哈希并确认运行前后未变化，临时目录已清除。

除了真实文件系统身份/权限/漂移测试，验证器从当前发布 shell 提取并运行真实 helper，确认两次 Node 调用的 PPID 相同，原本失败的验证仍以原测试退出码结束；还提取真实 `write_recovery_phase`，注入 fsync 失败，确认错误先返回、没有调用观察。该证据证明接口和控制流接入，不证明新流程已经生产运行或部署已经提速。
