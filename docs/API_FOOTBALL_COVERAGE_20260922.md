# 2026-09-22 竞彩日 API-Football 对应补全

本次修复补充词表及一个赛事参赛身份说明。它不直接批准实体登记、不写预测，不把缓存当作新的实时响应；生产采集仍须通过现有响应哈希、双方实体 ID、赛事、赛季、开球时间及原始球队类别检查。

## 已核对输入

2026-09-22 14:08 北京时间，只读生产 PostgreSQL 竞彩日名单和既有 API-Football 响应缓存：4 场均存在对应赛程，却因中文队名/联赛别名缺失而没有进入伤停采集。缓存日期 09-22 / 09-23 分别于 13:19:37 / 13:19:39 更新。赛程存在不代表伤停或阵容已有数据。

| 竞彩 ID | API 比赛 ID | 联赛 ID / season | 站内主队 → API 主队（ID） | 站内客队 → API 客队（ID） | 北京开球 |
|---|---|---|---|---|---|
| 2041643 | 1588908 | 46 / 2026 | 米尔顿凯恩斯 → Milton Keynes Dons（1348） | 克劳利 → Crawley Town（1362） | 09-23 02:00 |
| 2041655 | 1588849 | 46 / 2026 | 诺茨郡 → Notts County（1376） | 格里姆斯比 → Grimsby（1365） | 09-23 02:00 |
| 2041644 | 1588823 | 46 / 2026 | 维冈竞技 → Wigan（61） | 布莱克浦 → Blackpool（1356） | 09-23 02:00 |
| 2041642 | 1639468 | 803 / 2026 | 韩国亚运男足 → Korea Republic U23（10177） | 沙特阿拉伯亚足 → Saudi Arabia U23（10955） | 09-22 18:00 |

英格兰锦标赛对应 API 的 EFL Trophy，不能误用英冠 Championship。新增词表不适用于其他联赛、赛季、同名不同 ID、女足、预备队或其他年龄组。

独立官方网站核查（2026-09-22）：

- [克劳利俱乐部客场售票页](https://crawleytownfc-awayfans.ktckts.com/)列出 MK Dons 客场、EFL Trophy、9 月 22 日当地 19:00。[MK Dons 官方历史比赛报道](https://www.mkdons.com/news/2025/august/19/report-crawley-mkdons/)标题使用完整名称 Milton Keynes Dons 和 Crawley Town；它仅用于名称核对，不作为当天赛果证据。
- [格里姆斯比俱乐部票务页](https://www.venuetoolbox.com/Grimsby/ASP/bookTickets.asp?dept=&homeArea=home)列出 Notts County 客场、EFL Trophy、9 月 22 日 19:00。
- [EFL 的 Wigan Athletic 报道](https://efl.com/news/2025/july/31/ryan-lowe-leading-latics--revival/)同时使用 Wigan 与完整俱乐部名称；[布莱克浦官方比赛页](https://www.blackpoolfc.co.uk/match/first-team-squad/2025-26/g2567338)核对双方俱乐部名称。此项仅核对名称；当天场次和开球取自上表两路现有赛程证据，不拿历史比赛时间替代。
- [韩国足协官网](https://kfa.or.kr/)列出 9 月 22 日当地 19:00 韩国对沙特亚运男足比赛；[韩国足协男 U23 页面](https://kfa.or.kr/national/?act=mu_23&cursor=&position=Coach&s_idx=8031&search_val=2026)确认该届亚运男子参赛队身份。
- [沙特足协本届参赛页](https://www.saff.com.sa/en/nationalteams.php?id=17&type=2)在 U21 栏目列出同一亚运男子对阵、9 月 22 日当地 13:00，折合北京 18:00。沙特派 U21 阵容参赛，API 对该赛事参赛实体命名为 Saudi Arabia U23。因此这是本场参赛身份对应，不是把所有沙特 U21、U23 或成年队等同。

## 亚运身份限定

类别补充必须同时满足竞彩 ID 2041642、API 比赛 ID 1639468、联赛 803、season 2026、表中的双方准确名称和 ID、同一开球时刻以及未发生 eventVersion 改期。缺少任一项，继续使用原有严格类别检查。

补充只为该赛事参赛身份提供原始中文短名缺少的男子/U23 比赛类别。原始中文、英文标签全部保留参与检查；显式女足、U21、B 队等矛盾不会被覆盖。没有将这项说明写入全局国家队身份，也没有更改 API 原始名称、响应哈希或数据库证据。

## 验证与上线边界

`tests/api-football-scoped-coverage.test.cjs` 覆盖 4 场名称评分、错误联赛/赛季/ID/队别、无实时响应及响应哈希不一致拒绝、模拟有效实时响应后的登记及复核，以及亚运限定失配。模拟信任哈希仅存在于测试中。

2026-09-22 14:17 只读生产实体登记表，上述 8 个 API 球队 ID 尚无所有者、没有现有归属冲突。实际部署后仍由一轮真实响应建立对应关系并独立验证，不能以本地测试直接宣布生产登记或伤停采集完成。

伤停输出新增 `injuriesResponseRows` 保存原始响应数组行数；阵容 `lineupsRows` 在响应不是数组时为 `null`。过滤后有效人数为 0 不能等同源站明确返回空数组。

账号仍为 Free，保留每轮/每日请求预算和退避；本次核查未触发 API-Football 请求，也没有使用付费接口。取数结果始终仅用于参考，不能自动升级正式推荐。
