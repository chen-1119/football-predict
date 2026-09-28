# 零订阅采集：自动源、手工证据与缺失边界

本方案不购买 xG 或赔率订阅。免费源没有覆盖所有竞彩比赛的服务承诺；可持续运行来自多源降级、真实收据、缺失告警与人工补录，而不是把缺失值估算成采集值。

## 运行顺序

| 层 | 使用现有项目能力 | 覆盖与边界 |
| --- | --- | --- |
| 竞彩主源 | `sync:sporttery-snapshot`，已有签名 relay、Cloudflare 独立采集器和 Windows 定时任务 | 需要运行该采集器的网络实际可以访问源站，HTTP 567 时应退避、告警；不能把 500.com 价或赛果称为官方。relay 的密钥放私有环境。 |
| 免费赛程、赛果与历史赔率 | `sync:football-data-fixtures`、`sync:football-data-current`、`sync:openfootball-observations`，按原有低频预算运行 | Football-Data fixtures 是每周更新资料，不是逐小时盘口；历史 CSV 没有可靠的原始发布时钟，旧记录只能研究。OpenFootball 按真实下载收据建立向前的赛果时间轴。 |
| 补充赛果交叉核验 | 官方联赛/赛事页面；免费 football-data.org 或 OpenLigaDB 只在许可、赛事映射和实际覆盖核对后使用 | 社区赛果不能直接替换体彩结算；免费套餐的赛事范围与数据字段有限。 |
| xG | StatsBomb Open Data 只对发布的赛事和赛季做离线研究；有明确来源的单场 xG 可以人工记录 | 不用拟合进球率 λ、射门数或比分冒充实测 xG。无真实同场 xG 时联合拟合保持缺失。 |
| 2.5 大小球 | Football-Data 的周赛程/历史 CSV 用于研究；需要更近时点的 2.5 双边报价时人工记录 | 保存实际盘口、公司、大/小两价及收据时间。历史大 2.5 球频率与市场报价分别存放。 |

自动链路的健康指标读取 `public/data/sync-meta.json`：`sourceHealth.currentLaneFresh`、`resultLaneFresh`、`sourceAttempt.officialOddsMatches`、`relayResultRows`。工作流成功但这些值为 0 或过期，应报告“源缺失”。采集仍可在停售后继续，预测与已冻结快照不得更新。

## 本机人工补录

`capture:goal` 接受网页截图或 PDF 和手填 JSON。它从本地 `matches-current.json` / `matches-history.json` 自动生成精确赛事模板，拒绝错场、非法盘口、单边报价和缺失的结果/xG。**收据时间由执行机器生成，输入文件中的时间不能回填成过去。**原图及观察记录保存在忽略 Git 的 `server-data/manual-goal-observations/`；原图 SHA-256、赛事身份与记录哈希可核对，重复导入不会新增一条。

```bash
npm run capture:goal -- list
npm run capture:goal -- template --match-id "替换成上面列出的实际ID" --kind total-odds --out capture.json
# 在 capture.json 填 sourceUrl、sourceLabel、values；保留自动生成的 match 字段。
npm run capture:goal -- capture --file capture.json --evidence source-screenshot.png
npm run capture:goal -- report
```

Windows PowerShell：

```powershell
npm run capture:goal -- list
npm run capture:goal -- template --match-id "替换成上面列出的实际ID" --kind total-odds --out capture.json
npm run capture:goal -- capture --file capture.json --evidence source-screenshot.png
```

类型分别为 `result`（主客 90 分钟整数比分）、`xg`（完赛后主客实际 xG）、`total-odds`（公司、如 `2.5` 的盘口、大球价、小球价）。用 `template --kind xg` 或 `template --kind result` 生成相应格式。输入的 `sourceUrl` 必须是无凭据的 HTTPS 地址；截图须为 PNG、JPEG、WebP 或 PDF。不同时间或变价应留下不同截图，不能重用旧图制造新的时间点。

这条人工链**仅作私有证据收集和核对**：`predictionEligible:false`，当前不写公开历史、正式赛果或模型输入，也不会因人工录入就激活 xG 联合拟合。后续要晋级，必须额外完成来源授权、同场映射、双时钟和按时间滚动验证。修复主源采集与可信赛果收据仍是优先任务。
