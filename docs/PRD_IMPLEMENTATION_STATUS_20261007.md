# PRD v1.0 实施状态与当前证据边界

本文件对照 `C:/Users/86188/Downloads/足球预测系统_PRD_v1.0.md`（2026-10-06，待评审）。研究源码基点为 `90a3d2e8c836af9481abe0d3a8d01b8e7618ecea`。状态依据已保存的实际线上回执与研究原件；本文件不重新访问服务器、批准新事件、生成预测或修改冻结记录。

## 1. 当前实际完成到哪里

| 内容 | 状态 | 已有结果与限制 |
|---|---|---|
| r806 官方销售与报价合同 | **真实已上线并验收** | 固定源 `47c768a366ff5517039ecc428eee30280fde5410`，包 SHA `ed0e3c63aa21392d8451a8844ec4e70ecb00af6a35a2ed4f339ab3d3952f4c7c`。10月7日 10:56:57 UTC 全验收：1885 源文件、218 dist 文件匹配，PG/服务、发布后自然完整周期通过；11:02:17 UTC 公共 TLS 通过。只是这个实际观察时点的成功。 |
| r806 新正式 HAD 来源时序 | **实际 6 条通过** | 新 V2 来源回执与 capture 时钟重放通过。该版本冻结决策的回执→发布为 13.153 秒；不是首次报价→首次发布的端到端延迟。HAD 的 6 条签名证明不能代替 HHAD 独立整载荷与成员绑定重放。 |
| 当前方向与串关 | **参考方向已存在，资格缺口仍在** | 上述 r806 切片 6 条主方向均为 HHAD 下盘；只见 1 项研究价值候选，未证明正式 2串1/3串1。`formalEligible=false`、`recommendationReliable=false` 不因服务健康而变为通过。模型仍含市场先验与人工风险调整，不能叫赔率独立。 |
| 不可变历史 | **实际 ID/hash 连续性通过** | 10:43:26 UTC 核对原 44513 条 decisionId/recordHash 与四份封存原件未变；新增记录另计。不是全部历史 payload 独立重算证明。 |
| 零市场基线 | **真实研究拟合及3个后来新增的前瞻研究冻结，未上线** | 277 个 CC0 普通 FT 格式标签、20 个源内研究实体；泊松进攻/防守参数实际拟合 517 次迭代，收敛。原拟合没有目标预测；root 后于12:09:42 UTC仅对3个新的受限事件技术审核并冻结研究预测。没有价格作为 p 输入、未写 registry/publisher、未测准确率或校准。 |
| 日志、备份、监控保留策略 | **r807 正常部署进行中，待实际验收** | 固定源 `940e3a8490c81f5681a628181efc1a9e0a4dd0b0`，包 SHA `68b2ef45948f0a808eed9020983a9a9bd4c1baf078bf7e542042dfc80cfb868f`。最后已保存 11:34:31 UTC 观察仍 running；该时点生产双标记仍是 r806。五个验收助手已绑定，不代表新策略已安装或自然备份/清理/监控已运行。 |
| Chrome | **r806 限定页面证据通过** | 已保存方向与串关 DOM、代表性截图及 QA 清理。不是全产品、全部来源或模型效果验收。部分 `.png` 原件实际为 JPEG；`.jpg` 展示副本字节相同，不是新图片证据。 |

## 2. PRD 各阶段尚需完成的条件

| PRD 阶段 | 当前状态 | 下一份必须真实取得的产物 |
|---|---|---|
| P0：近五季 ≥3 联赛历史 | **真实社区标签数量已取得，完整准入未完成** | CC0 影子地基已有英超/德甲/西甲 2021/22–2025/26 的 15 个原文件、5320 条赛果标签。缺口是历史可用时钟、正式事件/球队 ID 与官方结算准入，不能把当前取得时间倒填为历史已知时间。足球数据网站的许可限制仍有效，不从镜像绕限制采其赔率。 |
| P0：五时点报价快照 | **未证明覆盖齐全** | 每事件、每市场分别追加开盘/T-24h/T-2h/T-1h/收盘原报价、盘口、来源与 observed/received 时钟，以及实际缺失清单。今日一个签名 SP 切片不能补造过去五时点，也不能冒充亚洲盘口轨迹。 |
| P1：Elo/泊松与严格 OOS | **研究模型已有，严格效果验证未完成** | 时间顺序、独立未训练赛季/窗口的 Brier、logloss、校准曲线；同事件同时间市场基线与消融结果。今日取得的旧赛果可用于声明为历史拟合，不能据其假装历史时点 OOS。联赛模型不能直接外推国家队。 |
| P2：阵容/伤停/体能/xG | **资料研究与 V3 接口存在，实际合资格完整证据未补齐** | 逐球员稳定 ID、赛前可用时钟、预测/确认 XI 区分、明确医疗/出战语义、完整赛程和实际结束/球员分钟、观测 xG 来源；再拟合和验证因子参数。新闻、召集名单或缺资料不能自动成为可出场概率、零伤病、体能优势。 |
| P2：价值筛选/仓位 | **不能宣布完成** | 已校准模型概率与真实同市场同 outcome SP 分离绑定；保留独立球队基线作为消融对照，分别验证 PRD 分层参数、EV 与去水 edge；可靠样本、偏差审查与纸面风险合同。不能为凑 2/3 串关而降低门槛。 |
| P3：8 周 CLV/纸面 ROI | **尚未建立连续 8 周证据** | 前瞻冻结价格与后来同市场收盘价格的配对轨迹、作废/争议排除、真实周报及样本分母。CLV>0 不能单独证明盈利或模型准确率提高。 |
| P4：迭代调权 | **待前述数据和严格 OOS** | 每次新参数来源、时间窗、未训练样本与旧基线对照。不能按上/下盘配额或人为删市场权重调整概率来制造改善。 |

### PRD 首选历史来源的实际许可限制

root 于 2026-10-07T12:02 UTC 核查 Football-Data 官方页面：页面标示更新至 06/10/26，允许个人用途，但限制将资料用于商业产品或以自动机器人、采集器、AI 作数据训练产品。因此没有自动下载该站资料供本次模型训练；首次 terms 页面不可访问不代表没有限制。严格实施 PRD §4.1 时，应保留其本来已列出的 GitHub/CC0 备选并记录许可差异，不能为完成“五季三联赛”绕用镜像或抹掉限制。[Football-Data 官方资料说明](https://football-data.co.uk/data.php)

### 已真实取得的三联赛五季影子标签

实际 manifest 生成于 2026-10-06T13:19:58.852Z，固定 openfootball/football.json commit `e6744429ee395bc86f247348c6184bb08d4eb361`、CC0-1.0。逐文件取得时钟为当日 13:19:53.058Z–13:19:55.159Z，不能替代各历史赛前的可用时钟。

| 来源联赛 | 季数 / 文件数 | 实际社区赛果标签 | 数量缺口 |
|---|---:|---:|---|
| 英超 en.1 | 5 / 5 | 1900 | 无源内预期数量缺失 |
| 德甲 de.1 | 5 / 5 | 1530 | 无源内预期数量缺失 |
| 西甲 es.1 | 5 / 5 | 1890 | 2024/25 为370/380，10场无 FT，未补0-0 |
| 合计 | 5季 / 15文件 | 5320 | 不代表正式历史模型准入 |

本地影子导入与来源链确已运行；所有行 `providerAvailableAt=null`、`historicalAvailabilityProven=false`。严格历史 asOf 可用行、官方 HAD/HHAD/AH 赔率、五时点、国家队行数仍为0。54条旧数组标签明确保留为社区标签，没有进入原观察仓的5266条严格 FT 对象候选；不能据这份历史数量宣布模型效果或来源可信度通过。manifest SHA `35fd840c4bf679c250a44a35bb2a0a9ef0fdad55aef2d55e4745b0733b80e704`、contentHash `21f6ffbe6bd9faf11daaf8d285909d8534d53de487f8ec3ec3d3a8867590e87a`，与下述另一份277条巴甲拟合资料分开。

### 需要先消除的 PRD 内部定义差异

- PRD §1 的 Brier 目标是 `<0.62`、校准误差 `<3%`；§7 P1 是 `<0.64`、`<5%`。应明确阶段门与最终目标，并分别记录；任何一个都尚未由此零市场拟合证明。
- `p×SP>1.05` 是预期回报安全垫；`p−去水市场概率>5个百分点` 是概率分歧，两者不等价。例如 p=0.53、SP=2.00、去水市场 p=0.50 时，前者 1.06 通过，后者仅 3 个百分点。**依用户最新“严格按照 PRD 原文执行”，实施合同同时要求两门通过**，不能把它们混写为一项或任选一项。
- **用户最新要求严格执行 PRD，保留 §2 的 40/35/25 分层初值**，以及 §6 因子初值作为需验证的候选参数；它们尚未取得严格样本外准入。PRD 的核心顺序仍为模型 p→同市场去水价格→EV 与 edge 联合筛选。此前“先独立球队 p，再比较价格”的要求提示不要把价格比较阶段误写成已有赔率独立模型的证明；本文件不据此取消 PRD，亦不手工部署百分比来宣称改善。具体参数及价格对 p 的作用必须记录并通过样本外验证后采用。
- PRD 的“CLV 连续 8 周>0”目前是待验证标准，不能标已完成，也不是盈利保证。现网展示的旧聚合指标或 277 条训练目标不能替代这项前瞻证据。

## 3. 277 条零市场产物到底证明了什么

固定来源为 `openfootball/south-america@119fa1724b2079a1072a0cb0ca0ccac26d92fd34/brazil/2026_br1.txt#source-season-2026`，原文件 SHA `abfe3b76ab0c59464c0547479dd2d8d905553e3dadfc91f4c644fbad5bdf36f6`，许可 CC0。最近有比分的名义日期仍是 **2026-09-20**，`completeCompetitionHistory=false`。

真实新研究批准时间为 2026-10-07T06:50:37.428Z；拟合 06:50:37.442Z→06:50:37.483Z，模型 `availableAt` 等于完成时钟。训练目标 1.4266917562142405→1.379560473399431，约束梯度约 9.93417×10⁻⁸。该变化只证明指定输入的拟合计算；没有样本外 Brier/logloss、校准或命中率结果。

制品保留 `historicalAsOf=null`、`actualEndedAt=null`、阵容/伤病/体能/xG=null。普通 FT 标签没有成为已确认官方 90 分钟赛果；源内实体不是竞彩网 canonical ID；无主场参数且中立场事实未知。不能据此自动补芬兰场次、国家队、完整近期赛程、休息天数或首发。

研究 artifact contentHash：`94fb0d1663c4ae31207400a1d181d954a420e3b7de753758062cfd3d518eabba`；inputHash：`57d14b6033ac0e9a72218133950a24a065696a965a71448f50f0361ca5e39526`。原件、原知识批准与原影子不得重写。

## 4. 五场巴甲目标仍需新在线事件审批

以下为**原草稿中的候选桥接**，不是新的在线事实或已批准 alias。该草稿的 `approved=false`、`approvalReviewedAt/approvedEventHash/eventEvidenceSha256=null`，五条 `sourceAliasApproved/sourceTimezoneMappingApproved=false`。其 source 与旧 PG 切片并非同一事务；新审批必须由 root 从新在线六事件取得一致证据。

| 场次 / 源事件 | 有序在线球队 ID（主→客） | 候选 CC0 名字（主→客） | 原草稿 UTC 开赛 / 截止 | 原一手页面问题 |
|---|---|---|---|---|
| 周三002 / 2041824 | team_182jpze → team_1jfnb0g（provider 575→567） | SC Internacional → SC Corinthians Paulista | 10/7 22:30 / 10/7 14:00 | 国际官网明确 UTC 与官方时钟相符；仍需 alias/新销售审核。 |
| 周三003 / 2041825 | team_5oy8ow → team_ku5my8（1035930→791） | Clube do Remo → Grêmio FBPA | 10/7 22:30 / 10/7 14:00 | 里莫页面明确 UTC；仍需双方名字有序证据与新销售审核。 |
| 周三004 / 2041826 | team_1i7574x → team_1w1rqlj（2734→2469） | RB Bragantino → Mirassol FC | 10/7 22:30 / 10/7 14:00 | 原页面嵌入机器 UTC 与叙述时间冲突，不能自行选择一个。 |
| 周三005 / 2041827 | team_12id1us → team_2zbc2i（1097→1947） | EC Vitória → Chapecoense AF | 10/7 23:00 / 10/7 14:00 | 沙佩科恩斯页面 −03:00 与官方相符；仍需有序 alias/新销售审核。 |
| 周三006 / 2041828 | team_gy0p8k → team_7kc4yk（566→584） | Botafogo FR → CR Vasco da Gama | 10/7 23:30 / 10/7 14:00 | 本轮原官网 HTML 返回403，没有成功原件来完成桥接。 |

root 的新审批必须同时满足：

1. 保留真正新官方完整原件/签名回执与 PG 事件原件 hash，核对 sourceMatchId、eventVersion、官方序号、businessDate、主客有序 provider/PG ID、实际报价/销售池状态与截止；不能把 target 名单冒充已发布决策。
2. 把上述候选 source entity refs 与新的主客 ID、官方原始名字逐项绑定。中文名字、calculator 三字母码和旧派生 ID本身不等于已签名英文名或已批准 canonical alias。
3. 源日期可能是巴西当地 10/7、北京比赛日期为10/8、竞彩业务日为10/7，三者分别保留。将有明确时区的源时钟换算后核对，不能以 businessDate 替代 sourceNominalDate；冲突仍标待核。
4. `reviewedAt` 必须是新的实际审核时刻，且不早于采用的所有原件 receivedAt 与新在线观察结束；`knownAt` 不得复制草稿生成时间、历史比赛日期或旧源时间。eventHash 绑定全部有序事件和新证据 hash。
5. 模型已可用、目标未训练、当前实际时钟严格早于销售截止/开赛，预测计算结束再复核。旧草稿的 14:00Z 截止不是一张以后可复用的通行证；过截止只保留研究拒绝。
6. 只能产生新的独立研究冻结；不替换现网旧方向、概率、比分首项或串关，不宣称正式准入。芬兰周三001不在这批20源实体/277标签内，必须单列缺口。

### 后来实际新增的三事件研究冻结

root 于本轮新 PG 只读采样 2026-10-07T12:01:06.805661Z 后，实际技术审查并在12:09:42 UTC封存了 **2041824（巴西国际—科林蒂安）、2041825（里莫—格雷米奥）、2041827（维多利亚—沙佩科恩斯）**。新文件 `zero-market-new-forward-freezes-1791374982601.json` SHA `20fd04947199290e8f3106f92a2a44b069d7833fc1e800a244561ed520619c56`。它是明确源内实体的未来研究桥接，`canonicalAdmission=false`、`formalEligible=false`；未重训原277条拟合，未写线上、未改变原预测，未取得模型效果结论。此新事实与上方仍未批准的旧五条草稿分开；芬兰缺历史、布拉干蒂诺时钟冲突与博塔弗戈原页403仍保留。

## 5. 球队资料的现有合同与下一份审计

`scripts/officialClubResearchEvidence.cjs` 只做有界官方页 literal research staging。名字人工审查和网页 hash不授予来源许可/正式模型准入；医疗新闻的 rawName仍无稳定 playerId，`admittedToFeatures=false`。`scripts/prematchTeamCollectionAdapter.cjs` 保留国家队召集/退集训事实，明确不是确认 XI、疾病诊断、球员影响或当前出场率。

`prematchTeamEvidenceV3.cjs` 已具备两侧事件/队伍、来源、publication/provider/received/mapping-review/asOf纳秒级时钟及冻结 hash校验；确认/预测阵容分别保存，观测 prior xG与估计值分离，未知特征为 null。其 fatigue 当前只验证取得的结束时刻/分钟字段，**不具有完整所有赛事赛程覆盖证明**；数值存在不能自动解释为完整体能历史。首发公告也需真实发布和知识时钟，不能把临场确认 XI搬进早盘。

本轮新增纯 `prematchTeamKnowledgeAudit.cjs` 复用这份 snapshot 合同，保留 available/partial/unknown/conflict、字段缺口和来源验证界限，未知 null 与明确零值分开，未重新创建概率、训练或生产 schema。14项本地定向测试已通过、0跳过；未接入生产。亚洲盘口半球/半一/水位与竞彩整数 HHAD是不同市场；映射与结算必须分别绑定，不能从亚洲线推造竞彩 SP。

## 6. 可复核原件指针

所有业务/研究原件保存在 `.codex-tmp`，不随本文件提交。

- 研究：`zero-market-approved-real-fit-1791355837427-e047a1b4/fit.receipt.json` SHA `3ac42874e7bc594281e268e1cc55930c86d3238a8ee26a81c54a664e156afc1d`；`fit.result.json` SHA `094052fb162529417f9bf6cffb2916f23b601a3ead0b2cfb39738a308d82aa5b`；独审 `zero-market-real-fit-independent-review-1791356062553.json` SHA `59679fc22d179043893b831581f64780d44d3e70c94b6e7ec17bc7ea94887d5f`。
- 事件草稿：`forward-zero-market-event-input-draft-1791358662811-739f1870.json` SHA `41957b80c2552ac032668cd84095e8c355a717c1a164668df268d17b88791ac8`。
- 三联赛五季 manifest：`C:/Users/86188/.codex/worktrees/prd-history-foundation-oct06/football/.codex-tmp/history-foundation/online-20261006-final/manifest.json` SHA `35fd840c4bf679c250a44a35bb2a0a9ef0fdad55aef2d55e4745b0733b80e704`。
- SALES 私有 full：`official-sale-47c768a3-full-acceptance-20261007T105659552Z-c11295.json` SHA `ae9d1164797f0333ccf90c4fac9091ec3df2f87bd62c6c5a467aa9773f822141`；public：`official-sale-47c768a3-full-public-dist-20261007T110217959Z-9e7779.json` SHA `739e290ce1219ca50348da17cdd1b84a1c036c5261b4210a5a228f9d54d29178`。
- STORAGE 私有进度：`storage-940e3a849-full-progress-20261007T113431316Z-c82953.json` SHA `2b3e3fabe4c88baf5eabbb7aca86907898c237f6136e9d9ac71aa1b0fee96a54`。它只证明当时既有部署在运行，不能替代后续 r807 full/public/frozen/自然周期与 retention 实测。

本次文档检查：仅本地读取既有原件/源码和新增本文件；无新线上采样、来源/事件审批、拟合、预测、PG/registry/publisher写入或部署。
