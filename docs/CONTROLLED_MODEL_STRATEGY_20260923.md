# 2026-09-23 发布模型策略来源

本次整包使用当时线上运行实例的公开模型策略文件，而不是本地未合并工作树中的生成文件。通过固定 SSH 主机指纹，从 `/opt/football-predict/public/data/model-strategy.json` 只读取得文件并校验 SHA-256：

`f31d3b3b2b49bf5dcc5ac73d1b8e5ee22b4a6ceac85f0522f38384b63ce01268`

文件声明 `self-optimization-v9-formal-ledger`，生成时间 `2026-09-23T02:59:29.269Z`；`activation.promotionGate.status` 和 `activation.onlineEffect` 均为 `shadow`。这只是发布时策略输入的来源证明，不表示模型已达到正式推荐门槛或当前数据有新的命中率结论。正式发布后应通过线上模型评估接口再次核对实际生效状态。

整包所需的 `public/data/model-evaluation.json` 也从线上数据目录 `/var/lib/football-predict/model-artifacts/evaluation.json` 经固定 SSH 指纹只读复制，原文件与复制后文件均为 558267 字节，SHA-256 均为 `4262d21909907f2209c2ef0e7784591eb920864585f4a72723933ec52469ed92`。它是 `2026-09-12T20:01:43.631Z` 生成的 `rolling-backtest-v19` 历史评估，风险等级 `degraded`，不能当作今日新评估；本次未重训、未解除影子门槛。
