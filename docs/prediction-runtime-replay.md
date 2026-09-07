# 独立进程与运行时绑定：保留跨版本负面结果

## 真实发现

上一轮 Node 25 同进程的 34 次完整重放，不足以证明生产目标 Node 22 一致。本轮使用独立子进程和上海/UTC 两种时区检查同一 Node 25 捕获批次：

| 引擎 | 上海 | UTC |
| --- | ---: | ---: |
| Node 22.22.1 / V8 12.4 | 32/34 | 32/34 |
| Node 24.19.0 / V8 13.6 | 34/34 | 34/34 |
| Node 25.8.1 / V8 14.1 | 34/34 | 34/34 |

差异事件为 2041353、2041363，差异仅见于输入算术回执中的浮点末位和对应内容哈希，例如 `0.24017910179284352` 与 `0.2401791017928435`。这批对照未发现公开预测字段变化，但 **32/34 不能当作完整一致**。没有四舍五入、容差放宽或改写原始回执。

首次负面矩阵保留为 `outputs/runtime-replay-matrix-20260908.json`，SHA-256 `e9046373622503fc4bb524d6b07081a5d228007995d6e5f267b73fb273051031`。

## 实际修复与默认安全行为

- 新捕获批次记录 Node、V8、平台、架构、时区和可执行文件 SHA-256。二进制使用 64 KiB 分块读取，进程内缓存摘要，避免每条记录读大文件；Linux 使用 `/proc/self/exe`，不把可能已替换的路径直接当运行镜像。读取失败记为缺失，不伪造身份。
- `replayPredictionCapture.cjs` 默认要求上述身份全部完整且一致。缺失或不同先拒绝，不把其他环境的输出当严格重放通过。
- 只有明确传入 `--cross-runtime-diagnostic` 才允许跨运行时对照。即使输出相同，该模式 `strictReplayPassed=false`、`nominationAllowed=false`，不得转换成正式样本或晋级证据。
- 重放前验证六份已记录实现文件哈希、批次解压内容哈希、每条记录/输入/输出哈希、无损编码、赛前时钟区间、事件/模型身份、原时钟序列及批次内事件去重。计算中禁止未记录的系统时钟和网络请求，前后核对源文件与输入不变。
- 比较完整编码输出，不忽略字段，不放宽数值精度。失败结果给出有界差异路径，过长字符串只给长度/哈希，避免大段原内容进入日志。

这不改变概率公式、舍入规则、历史推荐或结算，也没有更换模型 v75 的权重。实现文件身份改变仍须遵守原签名版本转换门禁。

## Node 22 正向验证

本机原有 Node 25.8.1 与应用捆绑 Node 24.19.0。仅在本次 outputs 目录下载官方 Node 22.22.1 Windows x64 便携可执行文件，87,059,456 字节；实际 SHA-256 `923a41f268ab49ede2e3363fbdd9e790609e385c6f3ca880b4ee9a56a8133e5a` 与 [Node 官方校验清单](https://nodejs.org/download/release/v22.22.1/SHASUMS256.txt) 一致。没有系统安装或修改 PATH，二进制不提交 Git。

使用 Node 22 对原 g-e283… 副本产生新的本地计算（额外校准参数 null，不是历史生产回测）：43 行中 9 行按原保护未重算，34 次新计算成功捕获，编码 4,091,123 字节。新批次内容哈希 `33474e6297257b1945f1b7419f52a664fc2b31afc546c0cc2adc1d15403c8036`；来源报告 `outputs/clock-execution-rehearsal-usYjc0/report.json`。

随后 12 个独立 Windows 子进程验证：

- 严格模式：Node 22、上海、相同可执行文件，34/34 完整输出一致；另外五种运行身份/时区组合在计算前全部拒绝。
- 显式诊断：Node 22 两种时区均 34/34；Node 24/25 两种时区均 32/34，继续保留负面结果。
- 忽略字段 0，额外系统时钟读取 0，provider 请求 0，生产写入 0。

最终 `outputs/runtime-bound-replay-matrix-20260908.json` SHA-256 `c527e3a895e2fdf1e0a1d31d2f71104e5e674aa1b80c690e5da0d16e8211e000`，明确分别记录 `bindingGatePassed=true` 和 `allCrossRuntimeOutputsEqual=false`。门禁行为正确不等于跨版本算术一致。

## 验证命令与门禁

```powershell
npm.cmd run verify:prediction-replay
node scripts/replayPredictionCapture.cjs <捕获批次.json.gz> <来源报告.json>
# 仅诊断，永不返回 strictReplayPassed=true：
node scripts/replayPredictionCapture.cjs <捕获批次.json.gz> <来源报告.json> --cross-runtime-diagnostic
```

13 个新增验证覆盖真实独立子进程全输出、完整运行身份、批次/记录/输入哈希、预期结果被改后的失败、运行时不符、旧身份缺失、实现文件不符、重复事件、原时钟缺失/越界及诊断选项类型。Node 22 和 Node 25 各自通过。

Node 22 下又执行了 14 时钟、22 捕获、20 算术、16 分类、46 公开参考、22 冻结版本、截止保护与 85 发布合同检查，均通过。SQLite ExperimentalWarning 保留为运行时提示，不当作测试失败或部署成功证据。新模块/CLI/验证器加入未来包创建与验包必需项，实际 production-readiness 执行独立子进程验证；定向 lint/diff 通过。

## 仍未完成

以上矩阵验证的是 Windows 独立进程，不是生产 Linux 的执行证明。六个源文件和运行镜像身份也不是全部模块/环境/数据依赖闭包，更不是独立来源认证。Linux 隔离进程验证已在下面补充；完整依赖治理、长期留存容量、同组模型质量/独立前瞻及完整新版发布验收仍待完成。

本轮没有部署、没有改 r702 已签包/源码/队列，没有上传私有样本或便携 Node。命中率提升未得到证明，整体 Q1–Q5 不算完成。

## 2026-09-08 01:51：Linux 隔离进程实测

在原服务器上新建 ubuntu 私有目录 `/var/tmp/football-replay-Ok3dlPRM`，不进入生产应用或数据目录。预检四核、可用内存 5966 MiB、磁盘可用约 116 GiB；主服务和同步 worker 均 active。白名单包保留实际工作树字节（包括行尾），仅 502 个代码/包描述/公开公钥注册表/历史修复配置/私有研究输入文件，未上传密钥、数据库、node_modules 或 Windows Node。包压缩后 4,709,460 字节，SHA-256 `b51dc3c5aea05f0ed0a89b00042165a8f7221833ef598b19b28736a4cb6f63d7`，来源源码 `798fd28a4680c46a74066b6fbcffc5b463803e43`。

解包器先校验摘要、白名单路径、重复/越界路径、长度及每文件哈希，再在新目录中独占创建。运行使用清空继承变量后的环境、上海时区、隔离 store 路径、非 root、nice 15、256 MiB 堆、总超时 180 秒/子进程 60 秒，三个子进程顺序运行。没有安装依赖、调用同步主流程、重启服务或改发布队列；新计算时禁止网络调用。实际计算与验证约六秒完成。

运行镜像是服务器 Node `v22.22.1` / V8 `12.4.254.21-node.35` / Linux x64 / Asia/Shanghai，可执行文件 SHA-256 `243fd8938011479f41b3de101842150fa990f33fbbb3f7aabd330857f2d79e1d`。

- 原 Windows Node22 捕获在 Linux 严格模式按平台/镜像不符拒绝，未算通过。
- 明确跨运行时诊断为 34/34 全输出一致，但 `strictReplayPassed=false`。此前 Node24/25 的 32/34 负面结果仍有效，未覆盖或删除。
- 从原批次解码的 34 条实际入参重新执行模型，仍在赛前且不触发原锁，34 条新 Linux 计算全部捕获；额外校准参数仍为 null，不改入参或历史方向。这不是原历史生产计算。
- 新 Linux 批次内容 SHA-256 `895cd6b70561a45d7d249e8863b1413a813d41849054a778a9753d3cd29ec893`，另一个全新 Linux 子进程严格重放 34/34 一致，退出 0；额外系统时钟读取 0、provider 请求 0、忽略字段 0。
- 502 个包内文件前后哈希不变，实际加载的 55 个模块及哈希记录在私有来源报告；这是观测到的加载清单，不宣称所有环境/数据依赖闭包。Linux 上 13 项重放验证器检查也通过。

结果已取回 `outputs/linux-replay-results-20260908/` 并再次核对批次内容哈希和 34 条记录。私有数据不进 Git：

| 工件 | SHA-256 |
| --- | --- |
| summary.json | 897d9ef457aa04387bb4236f915bd5303ce2becef4275619f8dbaff49b631d89 |
| linux-strict-replay.json | a4e3866c673d6337c009dbc142d2c904403bd7f2b8554f400ad1773cf5a650f8 |
| linux-source-report.json | e6dbcb15d99cc503c85980aaed81e968c34f47d5698b7a9c0ded65504b385351 |

临时目录和本地研究包保留为证据，未执行清理。此轮生产写入 0，模型权重/UI代码改动 0；不得将隔离重放称为生产应用已经接通、独立见证、正式样本或命中率提高。

## 同轮生产观察与剩余问题

01:52:59 北京时间（17:52:59Z）原 r702 队列 PID 3577920 仍存活、waiting-not-before、attempted=false；计划仍为 03:31，最晚 03:36，并且必须通过原安全窗口门禁。app/live-complete 双标记仍是 r699 的 `e4bb349180b3dfce4df305fc8fdb2820868709208ae660b13fb018a825a343ef`，没有切换、重签或重排。本页验证的新代码不在既有 r702 签名包内。

01:48:18 的监控快照显示主读 PostgreSQL、43 场、dataFresh=true，但 recommendationReliable=false；监控服务失败来自快速赛果监视器 `PUBLISHER_RETRYABLE_SKIP`，具体为 `trusted-fast-result-endpoints-unavailable`，最后成功 01:23:46，赛果探测证据 01:26:29、采样时已过期 1305 秒。另有 five-hundred 补充源过期和 SQLite 体积超预算 watch。该快照不是最终实时健康证明，也不是上游故障根因已修复；本轮未重启监视器、未放宽信任/时效门禁，需继续追查可信端点及发布资格链。
