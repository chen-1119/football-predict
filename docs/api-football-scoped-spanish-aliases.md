# API-Football 西甲限定名称映射

## 修复范围

2026-09-07 的只读诊断发现：当前赛事有 API 缓存候选，但本地中文名称无法参与英文名称评分。不是所有缺口都由免费访问日期范围导致。

新增四个限定词条：赫塔费/Getafe/546、维戈塞尔塔/Celta Vigo/538、埃尔切/Elche/797、皇家社会/Real Sociedad/548。仅在本地西甲别名、API 联赛 140、赛季 2026、对应侧球队 ID 和完整名称同时相符时启用。不自动导入历史短名词典，不凭名称分配 ID。

中文词条来自已有 freeFootballTeamAliases.cjs；API 名称和 ID 来自既有缓存的只读检查，不是新发起的来源请求。以下官方赛程交叉核对俱乐部和赛事日期，不作为 API ID 或人工主数据审批证明：

- https://www.laliga.com/clubes/rc-celta/proximos-partidos
- https://www.laliga.com/clubes/real-sociedad/proximos-partidos
- https://www.laliga.com/laliga-easports/clubes

名称评分、追加式身份登记、当前周期复核使用同一限定词条。首次登记仍需真实当前周期响应摘要、赛事身份摘要及既有严格资格检查。没有新来源证据的缓存不能凭新增别名晋升为可信来源。

## 验证及边界

`node scripts/verifyApiFootballHardening.cjs`：147 项通过，新增 52 项；两组离线合成案例贯通实际评分→登记→复核；覆盖错 ID、名称、联赛、赛季、主客、女足/青年/预备队、缓存及错误来源凭据。无新增外部请求。

`node scripts/verifyEntityResolutionRegistry.cjs`：36 项通过。发布必需文件清单及制品安全清单均包含新模块。7 项生产验证器合同与目标文件 ESLint 通过。

这不代表生产已增加四个可信映射，不提高已发布命中率，不修改冻结推荐和历史结果，不完成整个 Q2。现有赛事摘要哈希未包含赛季的历史合同也未在本补丁中重写。

此修改在 r699 已签名后完成，因此不在 r699 内。必须通过后续正常发布及真实采集周期观察采纳结果，不能手工改生产 registry 或旧采集时间来制造完成证据。
