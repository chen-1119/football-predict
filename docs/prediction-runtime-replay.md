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

这里验证的是 Windows 独立进程，不是生产 Linux 的执行证明。六个源文件和运行镜像身份也不是全部模块/环境/数据依赖闭包，更不是独立来源认证。仍需 Linux 环境验证、完整依赖治理、长期留存容量、同组模型质量/独立前瞻及完整新版发布验收。

本轮没有部署、没有改 r702 已签包/源码/队列，没有上传私有样本或便携 Node。命中率提升未得到证明，整体 Q1–Q5 不算完成。
