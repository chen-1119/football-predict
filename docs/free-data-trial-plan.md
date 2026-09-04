# 免费数据试用方案

更新时间：2026-09-02

## 已选择方案：零成本 14 天验证

不购买套餐，不把缺失字段伪造成中性值。继续使用现有免费数据链，并将已经部署的 Cloudflare 体彩独立采集器接入生产签名证据链。

### 数据来源

| 数据 | 来源 | 试用成本 | 用途与边界 |
|---|---|---:|---|
| 体彩 HAD/HHAD | 现有大陆采集器 + Cloudflare Worker | ¥0 | 目标从单采集器 1/2 提升到独立采集器 2/2；必须验签、同事件、截止前到达 |
| 天气 | Open-Meteo | ¥0 | 场地可解析时提供天气；无法定位场地继续显示缺失 |
| 基础赛程/积分/状态 | 现有 free-football、football-data、联赛官方页 | ¥0 | 只接受可追溯来源，不把搜索摘要当数值模型证据 |
| 裁判/首发/伤停 | 联赛、协会、俱乐部官方比赛中心 | ¥0 | 先覆盖重点联赛；官方未发布时保持 `--` |
| API-Football | Free，100 requests/day | ¥0 | 现有账号 suspended，恢复免费账号后使用；同步器已有日请求账本和 fail-closed 保护 |
| Sportmonks | Free plan 或付费方案 14 天 trial | 暂不启用 | 免费层只有少数联赛；付费 trial 可能要求支付方式并会自动续费，未经单独确认不得开通 |

官方价格参考：

- API-Football Free：$0/月、100 次/日；Pro 页面当前标价 $19/月。
  <https://www.api-football.com/pricing>
- Sportmonks：免费层无卡、无到期，但只覆盖丹麦超和苏超；Starter 当前 €29/月，付费方案有一次性 14 天试用。
  <https://www.sportmonks.com/football-api/plans-pricing/>

## 执行步骤

### 第 0 天：已完成

1. 增加 `npm run audit:free-data-trial`，从生产 `/api/v1/health` 读取真实覆盖率并生成 JSON/Markdown 报告。
2. 在生产环境模板加入 Cloudflare 证据 URL、loopback 上传地址、超时和 5 分钟拉取周期；令牌仍只允许存放在 `/etc/football-predict/env`。
3. 验证 Cloudflare Worker 健康、独立体彩采集器已配置，拉取协议、签名校验和生产配置门槛全部通过。
4. 复核 API-Football `/status`：当前令牌对应账号 suspended，因此保持 `ENABLE_API_FOOTBALL_SYNC=0`，不让失败账户污染主同步。

### 第 1 天：需要外部凭据后自动执行

1. 在生产私有环境安装 `SPORTTERY_CLOUDFLARE_PULL_TOKEN`，重启 sync worker。
2. 等待一个完整同步周期，验收 `trustedCollectorCount=2`、两个不同 independence domain、签名和 payload hash 均通过。
3. 恢复 API-Football 免费账号或更换免费 token 后，只开启已有同步器；`API_FOOTBALL_MAX_CALLS_PER_SYNC=35` 实际同时是当天账本上限，低于免费层 100 次/日。

### 第 2–14 天：观察，不调方向

每天保存一次审计报告，比较裁判、伤停、首发、xG、天气、牌数据和市场覆盖率。试用期间只补证据，不改变推荐方向，不把参考推荐计入正式命中率。

## 验收指标

- 线上健康和源健康通过。
- 体彩可信独立采集器达到 2/2。
- 免费足球基础信号覆盖保持 100%。
- 裁判、伤停、首发分别以 50% 为试用目标；未达到时如实显示缺失。
- 所有新增证据具有来源、观测时间和事件身份；截止后不得回填赛前决策。
- 14 天后只有在覆盖率、稳定性和模型增益有实证时才讨论付费。

## 报价

- 当前方案：¥0。
- 可选 API-Football Pro：官方当前 $19/月；只有免费层 100 次/日确实不够且覆盖验证通过后再考虑。
- 可选 Sportmonks Starter：官方当前 €29/月；xG add-on 另计，当前不建议购买。
