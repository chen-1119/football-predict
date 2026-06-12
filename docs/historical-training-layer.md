# 历史训练库落地说明

## 目标

把当前窗口内的短样本特征升级成长期样本特征，但不把历史比赛直接展示到网站上。历史数据只作为赛前可得的模型输入，用来稳定：

- 长期 Elo 强度
- 近期 Form 种子样本
- 联赛/国家队赛事进球先验
- 大小球、BTTS、平局率基准

## 数据源

- 俱乐部比赛：[`xgabora/Club-Football-Match-Data-2000-2025`](https://github.com/xgabora/Club-Football-Match-Data-2000-2025)
- 国家队比赛：[`martj42/international_results`](https://github.com/martj42/international_results)

训练索引由 `scripts/importHistoricalTrainingData.cjs` 生成到：

```text
server-data/training/historical-training-index.json
server-data/training/raw/
server-data/training/team-aliases.json
```

`server-data/` 已在 `.gitignore` 中，原始 CSV 和训练索引不会被误提交。

## 已接入模型

1. `buildEloSnapshots` 会先用历史训练库种子评分，再滚动吸收当前窗口比赛。
2. `buildFormSnapshots` 会先用历史训练库最近比赛作为队伍 form 种子，再滚动吸收当前窗口比赛。
3. `leaguePriorForMatch` 会为国际赛、国家/联赛、全局样本选择长期进球先验。
4. `blendLambdasWithLeaguePrior` 会在市场 lambda 和 form lambda 之间先混入长期联赛先验。
5. `predictionMeta.trainingSignature` 记录训练签名：版本、来源、行数、最新比赛日期。训练库刷新后，即使代码版本没变，也会触发预测缓存重算。

## 当前样本

最近一次导入：

```text
version: historical-training-v1
rows: 279,932
clubRows: 230,554
internationalRows: 49,378
teams: 1,537
firstMatchDate: 1872-11-30
lastMatchDate: 2026-06-08
```

当前赛程覆盖：

```text
scheduled: 26
eloHistorical: 26
formHistorical: 26
leaguePrior: 26
lambdaLeagueWeight: 26
trainingSignature: 26
```

## 操作命令

```bash
npm run import:training
npm run sync:data
npm run audit:predictions
npm run build
```

强制刷新远端 CSV：

```bash
HISTORICAL_TRAINING_REFRESH=1 npm run import:training
```

PowerShell：

```powershell
$env:HISTORICAL_TRAINING_REFRESH='1'; npm run import:training; Remove-Item Env:\HISTORICAL_TRAINING_REFRESH
```

## 注意

历史训练库不会直接保证命中率提升；它主要减少小样本漂移，让 Elo、Form 和进球期望更稳定。真正的提升需要继续用赛前快照和赛后结果做滚动回测，比较接入历史层前后的 Brier、log loss、分桶命中率和 ROI。
