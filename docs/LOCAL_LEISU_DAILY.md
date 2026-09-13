# 本机雷速竞彩日采集与 PostgreSQL 入库

运行目录：`C:/Users/86188/Documents/football/.codex-tmp/native-postgres-release-20260912`。
Node：`C:/Users/86188/Documents/football/.codex-tmp/prediction-quality-ui-20260907/outputs/node22-validation-20260908/node.exe`。

每天北京时间 10:00，由本机 Codex 和 Browser Use 复用本机已登录网页。电脑、Codex、浏览器连接和已有 SSH 密钥需可用，任务消耗 Codex 用量。不使用远程 noVNC、不复制 Cookie、不调用验证码私有接口。

## 范围

以服务器 PostgreSQL 中 Sporttery 赛程的 `businessDate` 等于本轮开始时北京时间日期为唯一清单。不得改按开赛自然日、今天加明天或最近有比赛的日期选择。当天竞彩日中次日凌晨开赛的比赛保留；其他竞彩日和非竞彩比赛排除。整轮没有 8 场、12 页或五大联赛上限；12 个详情页只是单批传输限制，后续批次继续完成该日清单。

每场核对伤停／停赛与已公布阵容。已经开赛、取消、官方状态冲突、无法精确匹配、页面未公布或访问失败均逐场记录，不能用其他比赛补数。每天一次读取无法保证拿到稍后才公布的首发。

## 每次执行

1. 执行 `node scripts/syncLocalLeisuBrowser.cjs fixtures outputs/jingcai-roster-<本轮时间>.json`，只读现有 PostgreSQL 当天赛程。保留真实 readAt、fixtureInput、businessDate、完整 matches 和已有 aliases。赛程时间偏旧时仍可核验已列比赛的来源事实，但覆盖率必须带 stale，不能宣称当天清单已经完整刷新。
2. 通过 CUA/Browser Use 选择本机现有雷速浏览器。按清单的赛事查找网页实际可见的联赛／杯赛链接。已在页面发现的 `https://www.leisu.com/data/zuqiu/comp-<数字>` 赛事页都可使用，不限五大联赛。不猜赛事 ID、不调用隐藏 API、不复制凭据。
3. 读取实际赛程行：`Array.from(document.querySelectorAll('tr,.tr')).filter(r=>r.getClientRects().length>0&&r.querySelector('a[href*="shujufenxi-"]')).map(r=>({text:r.innerText,href:r.querySelector('a[href*="shujufenxi-"]').href}))`。结构不同先观察再读取真实 DOM，只读取与清单有关的赛事。
4. 保存 `{roster,leaguePages:[{sourceUrl,rows}]}`，运行 `node scripts/syncLocalLeisuBrowser.cjs plan <input.json> <plan.json>`。roster 为第一步原始结果。计划保留全部清单，通过主客队、开赛时间和已有明确别名映射，仅给匹配的竞彩比赛生成伤停和阵容任务。unmatched 必须保留，不能删行提高覆盖率。查找耗时超过 30 分钟时重新读取 roster 再计划。
5. 按 plan.targets 逐场读取实际分析页与页面可见的球队阵容入口，使用 `collectors/leisu-prematch/browser.cjs` 的 readRenderedDocument 获取真实 DOM。evaluate 仅用于 DOM 读取，不得 fetch、读 Cookie 或隐藏运行时。view 原样保留，每条 observedAt 为读取完成的真实 ISO UTC 时间。
6. 每批最多 12 个详情任务，建议 5 分钟内提交，首条记录不能超过 20 分钟。批次形状：`{version:'leisu-local-jingcai-v2',runId:<新UUID>,cycleId:plan.cycleId,cycleStartedAt:plan.cycleStartedAt,businessDate:plan.businessDate,startedAt:<本批实际开始读取时间>,leaguePages:plan.leaguePages,outcome,missing:[],entries:[{fixture,kind,observedAt,view}]}`。fixture、kind 来自对应计划；中间批次 outcome=running，最终为 completed/partial/no-due-matches/blocked/login-required/browser-unavailable。不把 targets 混入 entries，不刷新旧 observedAt。
7. 使用 Node JSON.parse/JSON.stringify 保存 chunk：`{startedAt,outcome,missing:[],entries:[{siteMatchId,kind,observedAt,view}]}`，再执行 `node scripts/syncLocalLeisuBrowser.cjs batch <plan.json> <chunk.json> <new-batch.json>` 自动带入计划身份。不要通过 PowerShell ConvertFrom-Json/ConvertTo-Json 往返处理计划时间，它会丢失 .000 精度。已有 batch 文件不能覆盖，失败重试使用原文件。未匹配原因填写 `missing:[{siteMatchId,reason:'unmapped'}]`；阻断填写 blocked/login-required/browser-unavailable。已开赛或官方状态冲突由服务端列为 ineligible。空清单或浏览器不可用也提交真实空 entries，不拿其他日期填任务。
8. 执行 `node scripts/syncLocalLeisuBrowser.cjs ingest <batch.json> <receipt.json>`。整轮保持 cycleId、cycleStartedAt、businessDate 不变，每批独立 runId；通信结果不确定时只重放完全相同的批次。保留本地 plan 和逐批回执作为断点，继续全部剩余 targets，不能在第一批后停止。跨午夜仍归原竞彩日，整轮最多 24 小时。
9. 最后执行 `node scripts/syncLocalLeisuBrowser.cjs status`，核对跨批次 coverage：totalMatches、eligibleMatches、requiredTasks、attemptedTasks、availableTasks 和每场 sections。collectionComplete 仅表示任务已处理；dataComplete 才表示当时清单新鲜且所有所需字段 available。source_empty、unmapped、blocked 均不代表内容完整。
10. 出现 405、登录或 CAPTCHA 阻断后停止来源，不连续刷新或自动解验证码。保留用户登录页，关闭临时页。没有变化或没有可操作事项时保持安静，只通知有效数据变化、首次异常、恢复或需要用户操作。

## 数据与运维

复用现有 `leisu_prematch.local_browser_runs` 和 `leisu_prematch.local_browser_observations`。汇总保存竞彩日、完整官方清单和逐场状态；可用数据保存 siteMatchId、businessDate、matchNo，同时保留雷速 ID 和真实采集时间。服务端重新核对数据库清单中的日期、主客队和开赛时间，不接受客户端自行扩大名单。

事务入库，同 runId 精确重放去重，失败不覆盖历史证据。未观察到 HTTP 状态时保持 null。全部 predictionEligible=false，不回填冻结推荐。这里完成来源入库和竞彩身份绑定，尚未接入网页展示或正式推荐。

两表已完成建表并向采集账号授权 SELECT、INSERT。日常不运行 migrate，不新建数据库，不导出 SQLite，不重新部署。服务器 leisu-prematch.timer 已停用；暂停本机自动任务即可停止此路径。
