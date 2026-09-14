# 无人值守竞彩日赛前采集

`football-daily-prematch.timer` 每半小时唤起服务，包含北京时间每天 10:00。服务器直接访问竞彩官方赛程与现有 API-Football，不使用本机浏览器、网页登录、滑块、短信或 Codex 额度。

每轮从 Sporttery `getMatchListV1` 获取最新清单，以官方 `businessDate` 选择当天所有比赛，包括次日凌晨场次。已经入库的前一竞彩日尚未开赛比赛继续补采，保留原竞彩日。停售、冲突、已开赛、时间非法的比赛不产生赛前请求。

复用原有实体映射、账号权限与赛前时间校验。伤停每 6 小时刷新，阵容在开赛前 60 分钟内每 30 分钟补采；未知映射每 6 小时重试。每轮最多 16 次 API 请求，共享缓存计数达到每天 90 次即暂停，账号额度错误也会阻止后续调用。故障退避 1 小时，进程重启后读取持久化状态继续。免费计划额度是实际限制，不承诺所有比赛都有伤停或赛前阵容。

结果写入现有 `football` PostgreSQL 的 `football.prematch_source_runs` 与 `football.prematch_source_receipts`。保存最新官方清单、每场缺失状态、源响应内容与哈希、实际接收时间。数据库提交后才发布网站参考数据。空响应表示缺失；旧缓存不会算作本轮新增。全部内容 `predictionEligible=false`，不修改正式 SP、结果、冻结推荐或模型。

部署时运行一次 `node scripts/syncDailyPrematchApi.cjs --migrate`，安装两个 systemd 单元，再 `systemctl enable --now football-daily-prematch.timer`。验收：立即启动 service，核对最新 PostgreSQL run/receipt 数、内容时间、timer 下次触发和网站 `/api/prematch/<Sporttery ID>`。仅 timer active 不能证明取数成功。

状态文件 `/var/lib/football-predict/daily-prematch-api/status.json`；错误保存在同目录的运行 ID 子目录。停止自动采集用 `systemctl disable --now football-daily-prematch.timer`。应用主 Worker 的正式发布验收独立报告。
