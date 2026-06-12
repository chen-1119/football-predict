# 自主优化落地方案

## 总结

自主优化不应该直接把更多比赛数据喂给前端或 GPT，而应该做成一个可审计闭环：

1. 只用赛前预测和赛后结算结果做复盘，避免赛后信息泄漏。
2. 离线统计不同联赛、玩法、赔率区间、推荐方向的命中率和回报。
3. 自动生成策略阈值，只在样本不足时收紧推荐，不自动放松。
4. 同步脚本读取策略，把冷却规则合入 `modelCalibration`。
5. 前端继续读取现有预测结构，后续可以选择展示策略版本和激活状态。

## 当前第一版

已落地 `self-optimization-v1`：

- 输入：`public/data/matches-current.json` 和 `public/data/matches-history.json`
- 脚本：`scripts/optimizePredictionStrategy.cjs`
- 输出：
  - `public/data/model-strategy.json`
  - `server-data/model-strategy.json`
- 服务端 API：`/api/model/strategy`
- 审计命令：`node scripts/auditPredictions.cjs`

第一版采用 `cooling-only` 模式：

- 命中率低、ROI 低、样本达到最低门槛的桶会自动提高推荐门槛。
- 样本不足的桶只观察，不参与线上放松。
- 样本达到 100 条以前，即使表现好也不会自动降低门槛。

## 策略影响

策略会影响：

- 1X2/HHAD 推荐最低概率
- 模型概率差门槛
- 让球同向支持门槛
- 信任分惩罚
- 最大可接受风险标签数
- 大小球推荐概率和 edge 门槛

## 后续路线

下一步建议接入历史训练层，但仍然不要污染网站展示历史：

```text
server-data/training/historical-matches.jsonl
server-data/training/team-aliases.json
server-data/training/model-backtests.json
```

优先接入：

1. Club-Football-Match-Data-2000-2025：赔率、赛果、统计更贴近当前推荐逻辑。
2. football-data：补长期赛果和国际赛事样本。
3. openfootball：作为轻量 fixtures/results 补充源。

历史数据进入模型时，只作为赛前可得特征：

- 长期 Elo
- 最近 6/12 场状态
- 联赛进球均值
- 主客场先验
- 平局率、大小球率、BTTS 率
- SP 桶历史表现

## 操作命令

```bash
node scripts/optimizePredictionStrategy.cjs
node scripts/auditPredictions.cjs
```

如果要让同步流程重新生成比赛数据并合入策略：

```bash
SKIP_SPORTTERY_FETCH=1 node scripts/syncData.cjs
```

在 PowerShell 中：

```powershell
$env:SKIP_SPORTTERY_FETCH='1'; node scripts\syncData.cjs; Remove-Item Env:\SKIP_SPORTTERY_FETCH
```
