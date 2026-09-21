# 球队队徽来源核验（2026-09-21）

本目录为前端队徽显示资料，不参与比赛身份、模型概率、推荐或结算。球队英文名称、提供方球队 ID 和图片 URL 取自本次实际返回 HTTP 200 的 ESPN Teams API JSON、K League 官网球队页及藤枝 MYFC 官网；未按 ID 拼接图片 URL。中文名称是本地比赛快照的精确别名，人工逐项映射至 API 实体。

## 核验范围

- 本地快照：outputs/light-ui-snapshot.json，保存时间 2026-09-21T08:43:35.679Z。
- 当前 39 场、78 个不同球队名称；其中成年男子俱乐部 54 个，已核验覆盖 54/54。
- 复盘 69 条记录涉及 138 个名字，本目录覆盖 132/138；女足、亚运代表队不映射为成年俱乐部。
- 目录共 140 个成年男子俱乐部，仅收录当前及复盘中实际出现的球队，不收录联赛列表内的无关球队。
- 140 张俱乐部队徽与 87 张国家或地区旗帜已下载并随前端发布，共 227 张 PNG、9,567,741 字节。每张均验证 HTTP 200、PNG 类型、文件头、尺寸和 SHA-256；图片来源及哈希保存在 src/assets/team-badges/manifest.json。国家队以国旗展示并明确标注，不称其为足协队徽。
- ESPN 是资料提供方，不代表各球队官方授权。本目录记录来源，不声称队徽素材采用开放许可证。

## 目录约束

- key 固定使用 espn-<提供方球队ID>、kleague-<官网球队ID小写> 或官网稳定 slug，不随中文或英文显示名变动。
- aliases 仅允许名称归一化后的精确匹配（Unicode NFKD、去重音、大小写、空白及指定标点）；不允许模糊匹配、前缀匹配或去除“女足 / U21 / U23 / 青年”等实体限定。
- entityType=club、gender=male、ageGroup=senior。国家队、女足、青年队使用单独的实体与徽标处理，不复用本目录。
- “PSV埃因霍温”只映射 PSV Eindhoven；未将“埃因霍温”添加为其别名，以免与 FC Eindhoven 混淆。
- 来源联赛是本次 API 列表来源；不是对任一历史赛季联赛归属的断言。

## 当前未覆盖成年俱乐部

无。54/54 个当前成年俱乐部均已匹配。

## 当前国家队及特殊年龄/性别实体（有意不使用俱乐部目录）

中国女足、菲律宾女足、韩国亚运男足、沙特阿拉伯亚足、中国亚运男足、阿联酋亚运男足、日本亚足、泰国亚运男足、日本、乌拉圭、韩国、厄瓜多尔、中国、马尔代夫、科索沃、爱尔兰、葡萄牙、威尔士、荷兰、德国、塞尔维亚、希腊、挪威、丹麦

## 复盘暂未映射名单

伊朗亚运男足、中国亚运男足、大宫松鼠RB、赫尔辛基火花、沙特阿拉伯亚足、卡塔尔亚足

剩余 2 家俱乐部已确认官网实体，但只有明确的 SVG 队徽，按本轮 PNG 缓存要求暂不收录；4 个亚运名字属于特殊年龄国家队，不能误配。大宫官网：https://www.jleague.jp/en/club/omiya/ （页面图片 /image/clubs/omiya.svg）；IF Gnistan 官网：https://gnistan.fi/ （组织结构化数据明确指向 /wp-content/uploads/2019/10/if-gnistan-vector-logo.svg）。未将不确定图片写入目录。
- 额外探测 kor.1 与 jpn.2 返回 HTTP 404，fin.1 返回 HTTP 200 但无球队，均未作为条目来源。

## 可重核验的来源列表

下列响应保存于 outputs/crest-source-<league>.json，SHA-256 对应该文件的 UTF-8 JSON 内容。

- [eng.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100)：20 队；SHA-256 `3f2716fefd5ebcdaaff815a3fe814e5c0d728ef639095f67a2bd055bebecd6fd`。
- [eng.2 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/teams?limit=100)：24 队；SHA-256 `b44a7030d490674efec4e22501d2c4a21f48c9b32d7ab05ce4804bcc519985ad`。
- [eng.3 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.3/teams?limit=100)：24 队；SHA-256 `088fc8ffcefc06e18a4115393165b1b3fa88c8a03d31bb887a8db73054889f58`。
- [eng.4 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.4/teams?limit=100)：24 队；SHA-256 `445e227558e7bb23ecd16538d4eafd3e8572dca0a171acb79a248a0471b9b362`。
- [ita.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100)：20 队；SHA-256 `575f8fd96cb7e5b015902c61a344796bf312d99d470683e2c99a3b8f97331eab`。
- [ita.2 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.2/teams?limit=100)：20 队；SHA-256 `2d493db111994e2c8cd72f52d5eeb01528d21aa05ef2245c6afdfd4750fe4ebd`。
- [ger.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100)：18 队；SHA-256 `ddf0425e233fb607d317c9f94888fdf2d3f341bfe4c4f2067f16be6c6d43e600`。
- [ger.2 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.2/teams?limit=100)：18 队；SHA-256 `466fdb9459aa11ab9cf52ba61a822d6d520d75c71369a87e9ca10841ed6f89b6`。
- [fra.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100)：18 队；SHA-256 `039df194ec9b7fe7e3a09ef15d81007bcc42c34461597ab1ca77e96883082d25`。
- [fra.2 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.2/teams?limit=100)：18 队；SHA-256 `e3f41e34a18fba43483c19e842874bd268cd91b0bb89193bfcd638cdc88ff369`。
- [esp.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100)：20 队；SHA-256 `fc3b6f335d4cd263aaf15779ff8624f8fa9dc5a5708c92fbdf3094fbed87aa9b`。
- [swe.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/swe.1/teams?limit=100)：16 队；SHA-256 `f1d5eee0135cdb930ece66fb5e9df68c69218fa4f26aebf6b3881c1412e47e3e`。
- [nor.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams?limit=100)：16 队；SHA-256 `270f863002e0348272bf06a05fcf207d868d975d1328b2fa2533ecf4ec520e66`。
- [ned.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/teams?limit=100)：18 队；SHA-256 `0b13be10ac690bbabaa31d7175b8d19185a94894e77155576d447d569f18a4b7`。
- [usa.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams?limit=100)：30 队；SHA-256 `81b1074e351834171d7c3ae67bf0a8c454bfc805d26446d9602d64f779ff9961`。
- [por.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/teams?limit=100)：18 队；SHA-256 `ca2c03460bbfa2e12df541d0d55e314cfb27972b62704b3b3dfa0d28919c428a`。
- [bra.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams?limit=100)：20 队；SHA-256 `8843c099807bc2f2d777250857fc46345ec2849feb337de2e8b013765ce6d8b8`。
- [jpn.1 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100)：20 队；SHA-256 `202acd14b4838188e7b3afd651eb9176930e34128cb55430fadc605207e940f3`。
- [ned.2 Teams API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.2/teams?limit=100)：20 队；SHA-256 `ffb2f1ee99e72654345224b1d71f6b210118e03e58532850cb6b35e416c8103a`。

## 已收录映射

| 中文名称 | API 英文名称 | 球队 ID | 来源 |
| --- | --- | --- | --- |
| 乌迪内斯 | Udinese | 118 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/118.png) |
| 卡利亚里 | Cagliari | 2925 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2925.png) |
| 博洛尼亚 | Bologna | 107 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/107.png) |
| 都灵 | Torino | 239 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/239.png) |
| 韦斯特罗斯 | Västerås SK | 22163 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/swe.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/22163.png) |
| 马尔默 | Malmö FF | 2720 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/swe.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2720.png) |
| 法兰克福 | Eintracht Frankfurt | 125 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/125.png) |
| 弗赖堡 | SC Freiburg | 126 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/126.png) |
| 汉堡 | Hamburg SV | 127 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/127.png) |
| 科隆 | FC Cologne | 122 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/122.png) |
| 门兴格拉德巴赫 | Borussia Mönchengladbach | 268 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/268.png) |
| 美因茨 | Mainz | 2950 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2950.png) |
| 云达不来梅 | Werder Bremen | 137 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/137.png) |
| 奥格斯堡 | FC Augsburg | 3841 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3841.png) |
| 埃弗顿 | Everton | 368 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/368.png) |
| 伊普斯维奇 | Ipswich Town | 373 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/373.png) |
| 纽卡斯尔联 | Newcastle United | 361 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/361.png) |
| 赫尔城 | Hull City | 306 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/306.png) |
| 克里斯蒂安松 | Kristiansund BK | 6672 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/6672.png) |
| 罗森博格 | Rosenborg | 438 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/438.png) |
| 毕尔巴鄂竞技 | Athletic Club | 93 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/93.png) |
| 阿拉维斯 | Alavés | 96 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/96.png) |
| 巴黎FC | Paris FC | 6851 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/6851.png) |
| 斯特拉斯堡 | Strasbourg | 180 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/180.png) |
| 特温特 | FC Twente | 152 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/152.png) |
| PSV埃因霍温 | PSV Eindhoven | 148 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/148.png) |
| 利兹联 | Leeds United | 357 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/357.png) |
| 水晶宫 | Crystal Palace | 384 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/384.png) |
| 伯恩茅斯 | AFC Bournemouth | 349 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/349.png) |
| 利物浦 | Liverpool | 364 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/364.png) |
| 曼彻斯特城 | Manchester City | 382 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/382.png) |
| 桑德兰 | Sunderland | 366 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/366.png) |
| 帕尔马 | Parma | 115 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/115.png) |
| 热那亚 | Genoa | 3263 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3263.png) |
| 弗洛西诺内 | Frosinone | 4057 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/4057.png) |
| 科莫 | Como | 2572 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2572.png) |
| 勒沃库森 | Bayer Leverkusen | 131 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/131.png) |
| 莱比锡红牛 | RB Leipzig | 11420 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/11420.png) |
| 马德里竞技 | Atlético Madrid | 1068 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/1068.png) |
| 皇家马德里 | Real Madrid | 86 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/86.png) |
| 米亚尔比 | Mjällby AIF | 20301 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/swe.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/20301.png) |
| 哥德堡盖斯 | GAIS | 8222 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/swe.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/8222.png) |
| 维京 | Viking FK | 510 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/510.png) |
| 利勒斯特罗姆 | Lillestrom | 987 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/987.png) |
| 尼斯 | Nice | 2502 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2502.png) |
| 里尔 | Lille | 166 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/166.png) |
| 米尔顿凯恩斯 | Milton Keynes Dons | 390 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.3/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/390.png) |
| 克劳利 | Crawley Town | 2594 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.4/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2594.png) |
| 维冈竞技 | Wigan Athletic | 350 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.3/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/350.png) |
| 布莱克浦 | Blackpool | 346 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.3/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/346.png) |
| 诺茨郡 | Notts County | 340 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.3/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/340.png) |
| 格里姆斯比 | Grimsby Town | 386 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.4/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/386.png) |
| 西雅图海湾人 | Seattle Sounders FC | 9726 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/9726.png) |
| 皇家盐湖城 | Real Salt Lake | 4771 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/4771.png) |
| 尤文图斯 | Juventus | 111 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/111.png) |
| 亚特兰大 | Atalanta | 105 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/105.png) |
| 帕德博恩 | SC Paderborn 07 | 3307 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3307.png) |
| 霍芬海姆 | TSG Hoffenheim | 7911 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/7911.png) |
| AC米兰 | AC Milan | 103 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/103.png) |
| 莱切 | Lecce | 113 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/113.png) |
| 巴伦西亚 | Valencia | 94 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/94.png) |
| 皇家社会 | Real Sociedad | 89 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/89.png) |
| 波尔图 | FC Porto | 437 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/437.png) |
| 本菲卡 | Benfica | 1929 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/por.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/1929.png) |
| 富勒姆 | Fulham | 370 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/370.png) |
| 曼彻斯特联 | Manchester United | 360 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/360.png) |
| 沙尔克04 | Schalke 04 | 133 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/133.png) |
| 埃尔沃斯堡 | SV Elversberg | 10388 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/10388.png) |
| 比利亚雷亚尔 | Villarreal | 102 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/102.png) |
| 莱万特 | Levante | 1538 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/1538.png) |
| 拉科鲁尼亚 | Deportivo | 90 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/90.png) |
| 皇家贝蒂斯 | Real Betis | 244 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/244.png) |
| 马赛 | Marseille | 176 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/176.png) |
| 巴黎圣日尔曼 | Paris Saint-Germain | 160 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/160.png) |
| 巴拉纳竞技 | Athletico-PR | 3458 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3458.png) |
| 巴伊亚 | Bahia | 9967 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/9967.png) |
| 赫塔费 | Getafe | 2922 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2922.png) |
| 马拉加 | Málaga | 99 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/99.png) |
| 伍尔弗汉普顿 | Wolverhampton Wanderers | 380 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/380.png) |
| 西布罗姆维奇 | West Bromwich Albion | 383 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/383.png) |
| 佛罗伦萨 | Fiorentina | 109 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/109.png) |
| 那不勒斯 | Napoli | 114 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/114.png) |
| 町田泽维亚 | Machida Zelvia | 22167 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/22167.png) |
| 柏太阳神 | Kashiwa Reysol | 7476 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/7476.png) |
| 大阪钢巴 | Gamba Osaka | 7102 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/7102.png) |
| 神户胜利船 | Vissel Kobe | 7477 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/7477.png) |
| 罗马 | AS Roma | 104 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/104.png) |
| 国际米兰 | Internazionale | 110 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/110.png) |
| 斯图加特 | VfB Stuttgart | 134 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/134.png) |
| 多特蒙德 | Borussia Dortmund | 124 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/124.png) |
| 威尼斯 | Venezia | 17530 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/17530.png) |
| 拉齐奥 | Lazio | 112 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/112.png) |
| 昂热 | Angers | 7868 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/7868.png) |
| 特鲁瓦 | Troyes | 170 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/170.png) |
| 里昂 | Lyon | 167 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/167.png) |
| 雷恩 | Stade Rennais | 169 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/169.png) |
| 米拉索尔 | Mirassol | 9169 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/9169.png) |
| 博塔弗戈 | Botafogo | 6086 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/6086.png) |
| 诺丁汉森林 | Nottingham Forest | 393 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/393.png) |
| 考文垂 | Coventry City | 388 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/388.png) |
| 维戈塞尔塔 | Celta Vigo | 85 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/85.png) |
| 桑坦德竞技 | Racing Santander | 87 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/87.png) |
| 奥萨苏纳 | Osasuna | 97 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/97.png) |
| 巴列卡诺 | Rayo Vallecano | 101 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/101.png) |
| 托特纳姆热刺 | Tottenham Hotspur | 367 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/367.png) |
| 阿斯顿维拉 | Aston Villa | 362 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/362.png) |
| 斯托克城 | Stoke City | 336 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/336.png) |
| 谢菲尔德联 | Sheffield United | 398 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/398.png) |
| 横滨水手 | Yokohama F. Marinos | 7116 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/7116.png) |
| 水户蜀葵 | Mito Hollyhock | 131701 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/131701.png) |
| 长崎航海 | V-Varen Nagasaki | 19001 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/19001.png) |
| 大阪樱花 | Cerezo Osaka | 7109 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/jpn.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/7109.png) |
| 沃尔夫斯堡 | VfL Wolfsburg | 138 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/138.png) |
| 达姆施塔特 | SV Darmstadt 98 | 3812 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ger.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3812.png) |
| 萨尔普斯堡 | Sarpsborg FK | 5002 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/5002.png) |
| 奥斯陆KFUM | KFUM Oslo | 22165 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/nor.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/22165.png) |
| 兰斯 | Stade de Reims | 3243 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3243.png) |
| 蒙彼利埃 | Montpellier | 274 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/274.png) |
| 格罗宁根 | FC Groningen | 145 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/145.png) |
| 兹沃勒 | PEC Zwolle | 2565 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/2565.png) |
| 登博思 | FC Den Bosch | 271 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/271.png) |
| 海尔蒙特 | Helmond Sport | 3775 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ned.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3775.png) |
| 蒙扎 | Monza | 4007 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/4007.png) |
| 萨索洛 | Sassuolo | 3997 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3997.png) |
| 摩纳哥 | AS Monaco | 174 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/174.png) |
| 朗斯 | Lens | 175 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/175.png) |
| 布伦特福德 | Brentford | 337 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/337.png) |
| 切尔西 | Chelsea | 363 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/363.png) |
| 布里斯托尔城 | Bristol City | 333 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/333.png) |
| 沃特福德 | Watford | 395 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/395.png) |
| 西班牙人 | Espanyol | 88 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/88.png) |
| 埃尔切 | Elche | 3751 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/3751.png) |
| 纽约城 | New York City FC | 17606 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/17606.png) |
| 纽约红牛 | Red Bull New York | 190 | [API](https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/teams?limit=100) / [队徽URL](https://a.espncdn.com/i/teamlogos/soccer/500/190.png) |

## 补充的 6 家俱乐部（2026-09-21）

图片地址取自响应中的 logos[].href、HTML src 或 srcset。K League 页面带球队 ID、全英文名和相同 ID 队徽；藤枝图片直接出现在官网本队赛程卡的主客队位置。新增图片主机为 www.kleague.com、myfc.co.jp。

| 中文名称 | 来源英文名称 | 提供方球队 ID | 来源 / 图片 |
| --- | --- | --- | --- |
| 蔚山现代 | Ulsan HD | 7120 | [来源](https://site.api.espn.com/apis/site/v2/sports/soccer/afc.champions/teams/7120) / [队徽](https://a.espncdn.com/i/teamlogos/soccer/500/7120.png) |
| 赫尔辛基 | HJK Helsinki | 502 | [来源](https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/teams/502) / [队徽](https://a.espncdn.com/i/teamlogos/soccer/500/502.png) |
| 安养FC | FC ANYANG | K27 | [来源](https://www.kleague.com/club/club.do?teamId=K27) / [队徽](https://www.kleague.com/assets/images/emblem/emblem_K27@3x.png) |
| 大田市民 | DAEJEON HANA CITIZEN FC | K10 | [来源](https://www.kleague.com/club/club.do?teamId=K10) / [队徽](https://www.kleague.com/assets/images/emblem/emblem_K10@3x.png) |
| 仁川联 | INCHEON UNITED FC | K18 | [来源](https://www.kleague.com/club/club.do?teamId=K18) / [队徽](https://www.kleague.com/assets/images/emblem/emblem_K18@3x.png) |
| 藤枝MYFC | Fujieda MYFC | myfc | [来源](https://myfc.co.jp/) / [队徽](https://myfc.co.jp/wp-content/themes/myfc/img/logo_myfc.png) |

补充来源响应证据：

- outputs/crest-extra-ulsan.txt：SHA-256 `8558c889baf19a9070963a255dbdc5ad9c5c36f6a5a4aad41dfc3e315aacb6c7`。
- outputs/crest-extra-hjk.txt：SHA-256 `b6edd24fe0b4554b7ce8ff7be0c2123c14336702484c8e677939fc57c3d72c69`。
- outputs/crest-extra-anyang.txt：SHA-256 `3b55b6884aa34d064626dacac75d84e0df36e749e39912adcb8bf8b40acf287d`。
- outputs/crest-extra-K10.txt：SHA-256 `995dabc9c45c851c76a9cc9f8e7b737d28719f681e546e174622cb0310d7bf54`。
- outputs/crest-extra-K18.txt：SHA-256 `a522453d88e4d07bf32bd68a90699bafcdeacf1a4b089bc8c43d4a9bdb588675`。
- outputs/crest-extra-myfc.txt：SHA-256 `8587320c0a252a45e7040324c9bd0731efb541b2b5b9f2e6a876fdcb1dc766b4`。
- outputs/crest-extra-omiya.txt：SHA-256 `26a68f48a80413f58c87ed175399ec17b769b8829a194d4029b75efc7cbda9b5`。
- outputs/crest-extra-gnistan.txt：SHA-256 `37983a4ec48c88c115eb2f87759db553f548f7ca43d726d79141db21dd7935e2`。
