# 本机雷速每日采集与 PostgreSQL 入库

运行目录：`C:/Users/86188/Documents/football/.codex-tmp/native-postgres-release-20260912`。
Node：`C:/Users/86188/Documents/football/.codex-tmp/prediction-quality-ui-20260907/outputs/node22-validation-20260908/node.exe`。

通过本机 Codex 每日任务和 Browser Use，复用本机已登录的雷速网页。
用户不需要手动补录。电脑、Codex、浏览器连接与已有 SSH 密钥需可用；任务消耗 Codex 用量。
不使用远程 noVNC，不复制 Cookie，不调用验证码私有接口。出现验证或访问阻断时记录失败并停止该来源。

## 每次执行

1. 仅使用 CUA/Browser Use 操作本机浏览器。选择包含已登录雷速分析页面的现有浏览器；缺失时记 `browser-unavailable`，不要扫描浏览器磁盘凭据。
2. 按需打开以下已核实的普通联赛页面：英超 comp-82、德甲 comp-129、西甲 comp-120、意甲 comp-108、法甲 comp-142，均在 `https://www.leisu.com/data/zuqiu/` 下。
3. 只读页面实际显示的赛程行。DOM 读取形状：`Array.from(document.querySelectorAll('tr,.tr')).filter(r=>r.getClientRects().length>0&&r.querySelector('a[href*="shujufenxi-"]')).map(r=>({text:r.innerText,href:r.querySelector('a[href*="shujufenxi-"]').href}))`。先观察当前页面，按实际结构读取；不得使用缓存冒充当天结果。
4. 保存 `[{sourceUrl,rows}]` 到本轮 outputs JSON，再执行 `node scripts/syncLocalLeisuBrowser.cjs plan <league-rows.json> <plan.json>`。计划自动选择北京时间今天和明天未开赛的比赛，最多 8 场、12 个详情页；优先最近开赛。联赛页最多 5 页。完整一轮最多 10 分钟。
5. 按计划在同一浏览器打开真实分析链接；阵容任务使用页面可见的技术统计/球队阵容入口。使用 `collectors/leisu-prematch/browser.cjs` 的 `readRenderedDocument` 只读 DOM 函数获取字段。Browser Use 的 evaluate 仅用于 DOM 读取，不能 fetch、读取 Cookie 或隐藏运行时状态。
6. 将工具实际返回的 view 原样构成批次，不推断缺失球员、不补日期、不抓赔率。每条使用读取完成时的真实 ISO UTC 时间 `observedAt`。字段：`{version:'leisu-local-browser-v1',runId,startedAt,leaguePages,outcome,entries:[{fixture,kind,observedAt,view}]}`。fixture 来自计划，outcome 为 completed/no-due-matches/blocked/login-required/browser-unavailable。不要把 plan.targets 混入批次。无比赛或浏览器不可用也提交空 entries 的真实运行状态。
7. 执行 `node scripts/syncLocalLeisuBrowser.cjs ingest <batch.json> <receipt.json>`，随后 `node scripts/syncLocalLeisuBrowser.cjs status`。SSH 仅传输结构化数据，数据库凭据留在服务器。通信结果不确定时只重发完全相同的批次和 runId，不重新生成采集时间。
8. 本轮失败后不要连续刷新或解验证码。保留已有登录标签页，其余本轮新建页正常关闭。仅报告新增有效数据、首次异常/恢复或需要用户重新登录；相同未变化的失败不重复提醒。

## 数据位置与含义

现有 PostgreSQL 的 `leisu_prematch.local_browser_runs` 记录每轮状态，
`leisu_prematch.local_browser_observations` 保存经过 URL、球队、开赛时间、伤停/阵容结构校验的真实来源记录。
两表在现有数据库内；没有新的数据库实例、SQLite 导出或推荐写入。
事务写入、同 runId 精确重放去重；请求失败不覆盖旧记录。HTTP 状态没有被浏览器工具观察到时保持 null。

站内赛程快照过期不会阻止来源事实入库。新来源记录尚未自动关联站内竞彩 ID，
因此不能仅凭这里入库就宣称网页已补齐或模型已经采用。全部 `prediction_eligible=false`，不回填冻结推荐。

## 运维

首次部署后只执行一次 `node scripts/syncLocalLeisuBrowser.cjs migrate`，只创建上述两张表和索引。
以 status 的实际数据库回读为成功证据。回滚定时任务只需暂停该本机 Codex 自动任务；保留已入库证据。
服务器原有 `leisu-prematch.timer` 应停止，避免继续从返回 405 的服务器环境重复采集。
