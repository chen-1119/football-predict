# 阵容、体能与盘口轨迹 V3 实施记录

## 本次交付边界

本分支从 `1dd00ad3dc737dd80ba5956834028c6dc7ad7e89` 开始，实现独立的球队证据、亚洲盘轨迹、训练与影子评估链路。正式推荐仍需既有准入和正常签名发布；本实现不把研究候选改成正式推荐，不改旧冻结决策、串关或比分结算分母。

本次没有证明命中率提高。边界测试全部使用合成数据；真实验证读取的是新取得的线上 PostgreSQL 当前输入，未使用本地旧比赛数据训练或回测。

## 已实施的修复

1. `formNeedPressure.cjs` 接入 `syncData.cjs`：缺失休息天数、场均积分和净胜球保持未知，不再被 `Number(null)` 当成 0。真实 0、有效数字字符串和原有观测规则保留。
2. 所有 V3 知识时钟使用纳秒比较；事件版本、截止、来源观察和实际接收时间不静默截断。原有 prospective 匹配和生成时钟也补上精度检查。
3. `prematchTeamEvidenceV3.cjs` 保存首发/预计阵容、伤停、体能、历史和实测 xG 的事件、球队、双时钟及来源哈希。缺值为 null；空伤停响应不代表全员健康；预计阵容不算确认首发。球员影响需要有明确指标的贡献、替补差值和学得参数，不默认添加人为系数。
4. `asianHandicapEvidenceV3.cjs` 保存同源同公司各次观察，升降盘、同盘水位变化及 A→B→A 不合并丢失。显式转换 decimal/Hong Kong/Malay/Indonesian，拒绝猜水位格式。季度盘按两份半注结算，区分全赢、半赢、走盘、半输、全输；AH 与竞彩整数 HHAD 分开。
5. `forecastDynamicGoalStrengthV3` 从已有历史球队模型的嵌入记录重演训练状态，再以实际球队映射、对手攻防、比赛地点及时间生成零市场基础 λ。拒绝裸露的“marketIncluded=false”标签或旧混合模型 λ；来源和参数效果仍未正式准入。
6. `prematchV3Learning.cjs` 实际拟合有边界的正则化进球参数，按日期分训练、校准保留集和测试。同场多版本不增加独立样本；未知、取消、争议和未来赛果排除。候选、无阵容/体能基础模型、纯市场及固定 50/50 混合参照在相同留出场次计算 Brier、Log Loss 和覆盖。50/50 是实验对照，未声称是学得的最优市场权重。
7. `prematchV3Assessment.cjs` 在正常 `attachProspectiveForecastInputs` 中生成独立影子审查。输入来自本轮 fresh match；旧父级概率与冻结决策不变。缺训练模型或必需特征就阻断，不用赔率补齐独立推荐。验证须提供原输入/参数重演；重封 JSON 哈希不能证明算术正确。

## 来源输入合同

现有 `attachExternalSignals` 已保留事件绑定的源对象。采集器必须提供：

```js
externalSignals.prematchV3 = {
  version: 'prematch-v3-source-input-v1',
  teamObservations: [/* 下述球队观测 */],
  asianHandicapObservations: [/* 下述 AH 观测 */],
  entityMapping: {/* 必要时：明确球队/联赛 ID 映射、来源、事件及双时钟 */}
}
```

球队观测至少包含 `family`、`side`、`sourceMatchId`、`eventVersion`、`teamId`、`providerObservedAt`、`receivedAt`、`source` 和 `data`。来源提供者、原响应/交付哈希及球员/历史记录的细节按模块合同验证。禁止把旧 quality 状态、粗略状态均值或匿名球员推断为带有收据的实际观测。

AH 观测包含 `market:'AH'`、`source`、`company`、双方 ID、事件版本、主队带符号的 `homeLine`、`oddsFormat`、`rawPrices`、双时钟和 `rawPayloadHash`。第一次收到的观察叫首次观察，不能冒充官方初盘；公司更换不能当成升降盘。

参数应放在私有模型注册表的 `prematch-v3-baseline` 和 `prematch-v3-parameters`。模型读取固定为 PostgreSQL 两个 key 的只读访问，核对原字节哈希及真实创建/可用时间；不回退到 public/data 或 SQLite 旧样本，不读取时刷新模型时钟。基础包为 `{artifact,createdAt,availableAt}`；参数保留学习输出的原合同。

## 真实线上验证

北京时间 **2026-10-06 12:19:06.331095** 的固定 SSH v2 只读读取（赛程、两固定模型包与代际在同一快照）：

| 检查项 | 实测 |
| --- | ---: |
| 当日线上输入 | 12 场 |
| 同时点 HAD 报价参照 | 10 场 |
| 可用于 V3 的零市场模型 | 0 |
| 符合 V3 合同的 AH 轨迹 | 0 |
| 双方均有 V3 阵容/伤停/体能/历史/实测 xG 特征 | 各 0 |
| 本次新独立候选/正式推荐 | 0 / 0 |
| 生产写入 | 0 |

这些“0”是 V3 严格合同的可用性，不代表世界上没有相关数据，也不否定旧模型存在历史统计。读取到的赔率只能作为同时间市场参照，不能生成所谓独立球队推荐。

原响应 SHA256：`8bc2508421cdfc4d2d71f83b0e159dd43d45672f092b8b01dd8d4e4779931041`。两固定私有模型 key 均 missing，新冻结训练记录为 0。此前 v1 输入/报告继续保存，不覆盖。新报告、原始输入与回执保留于被 Git 排除的 `outputs/prematch-v3-20261006/`，不提交私有业务导出。影子计算使用实际计算时间，未把报告生成时间倒填为赛前原发布时间。

## 执行入口

要求 Node 22。远端读取沿用现有固定 SSH host key 配置，密钥仅静默加载。

```powershell
node scripts/readPrematchV3OnlineInputs.cjs --date 2026-10-06 --output <新的输入文件>
node scripts/readPrematchV3TeamHistory.cjs --input <上述输入文件> --output <新的线上历史文件>
node scripts/collectPrematchV3Evidence.cjs --input <上述输入文件> --history <上述历史文件> --output <新的私有采集报告>
node scripts/runPrematchV3Shadow.cjs --input <上述输入文件> --output <新的报告文件>
node scripts/runPrematchV3Learning.cjs --input <新的V3冻结研究请求文件> --output <新的训练报告文件>
```

输入/原响应字节须匹配，报告和训练结果只新建、不覆盖。报告实际消费同一 PG 快照返回的模型原文本包，不从不可信源 JSON 填补缺失模型。每包最多 4 MiB，总响应最多 12 MiB；超限保留缺口，不能悄悄截断模型。

`prematchV3FrozenRecord.cjs` 在模型、时钟和特征有效时产生新的不可变研究记录；没有已学参数也能先冻结基础 λ 与特征以启动训练。后续赛果关联形成新对象，预测哈希不变。显式 eventVersion 和 kickoffTime 均须与目标精确一致，不能用一个正确时钟掩盖另一个冲突时钟。关联结果本身不代表可信 90 分钟赛果或正式结算准入。

学习入口不扫描旧目录、不写模型注册指针、不启动同步/采集。模型实际拟合完成时刻作为新参数的创建/可用时刻；历史留出评估标为 retrospective shadow，不冒充原来部署过的模型。

## 激活前必须完成

1. 来源采集实际交付带事件和双时钟的阵容、球员贡献/替补、伤停、休息和负荷、旅行、历史实测 xG，以及逐公司 AH 轨迹。缺口逐项保留。
2. 提供可核验的零市场球队训练产物与准确的球队/联赛映射；冻结前瞻 V3 特征、模型、源响应及报价，随后独立加入可信 90 分钟赛果。
3. 按留出日实际比较覆盖、校准、Brier、Log Loss、分市场表现和稳定性；维持既有不少于 500 个有效样本及 6 个独立窗口等正式门槛，不依据当天 12 场或七场实验宣称提升。
4. 固定集成提交后走当前发布窗口、签名、完整构建与正常发布验收。现有 r793 验收自动化及独立七场赛果任务不重复部署或改写。未通过准入的 V3 始终 `formalEligible=false`、`primary/companion=null`。

## 验证与发布状态

固定 Node **22.22.1** 的 V3 联合回归 **144 / 144 通过，0 跳过**。完整 TypeScript、Vite 和静态剥离构建通过。独立审查所发现的来源 namespace 回填、模型消费死链路、截止别名遗漏、重封哈希、纳秒未来输入、历史量化区间及赛果双时钟冲突均已修复并覆盖测试。

原有兼容测试为 **93 / 94**：`published-forecasts.test.cjs` 的 `exact tie is not broken arbitrarily` 失败。已在原固定提交 `1dd00ad3dc737dd80ba5956834028c6dc7ad7e89` 单独复现相同失败（37 / 38），是已有并列方向策略与旧测试的分歧，本分支没有更改该旧方向选择规则。不能把兼容测试写成全通过。

全仓 lint 原有 22 errors / 4 warnings 未记为通过。本分支尚未执行签名发布，未训练真实 V3 参数，也没有正式准入或新命中率结论。不能将本地构建或影子读取称为部署成功。

## 后续采集与方向摘要修复

本次继续使用新取得的线上输入。`sportteryDeadlineClock.cjs` 仅将已明确绑定 Sporttery 比赛的 `buyEndTime` 北京时间文本，以及完全相同的截止别名，转换为带 `+08:00` 的派生知识时钟。原始响应字节保持不变，非法日期和其他无时区时钟仍拒绝。凌晨场次仍采用前一日 22:00 销售截止，不能推迟至开球。

`readPrematchV3TeamHistory.cjs` 在固定 SSH pin 下以有界只读事务新读取线上结果头及唯一历史投影，核对事件、球队、比分、结果修订和观察时间。每队最多 12 条、120 天窗口；同一比赛出现在两队记录中只算一场。历史样本不完整，因此不能用“最新已知记录”推断最近一次比赛结束、休息天数、球员负荷或旅行。

`prematchTeamCollectionAdapter.cjs` 通过普通 HTTPS 实际读取 KFA 当前男子国家队征召页和 FA 本期名单/更新页，保存原 HTML 后再重放解析。征召不是确认首发，退出征召不是已确认医疗诊断；名字记录不伪造成球员 ID。采集器第一次收到页面的时间与来源发布时刻分开保存，后者不明时保持 null。

`prematchAsianHandicapCollectionAdapter.cjs` 保存公开入口和实际请求的页面字节及阻断原因。500 亚洲盘口首个详情页遭遇安全验证后，其余同主机详情不继续请求。既有失败可通过 `--ah-status <原始失败回执>` 进入 6 小时退避；这仅复用访问状态，不更新时间、不读取旧报价，也不计为本轮成功采集。无需把 500 数据放进竞彩网官方 intake。

推荐组件默认只显示胜平负倾向、带正负让球数的原冻结让球方向、比分首选和简短参考状态；概率、SP、Top 3、模型来源及风险解释移入默认关闭的“查看依据”。不改任何概率、冻结方向、比分矩阵或命中率分母。摘要中的胜平负是原模型无条件倾向，仍含市场输入，不能称为正式推荐或赔率独立预测。

Chrome 本地构建预览消费北京时间 15:30 新读回的真实线上推荐中心数据：390px 手机视口无横向溢出，全部 10 个依据面板默认关闭；首个面板展开后仍保留原概率、SP、Top 3 和研究结算解释。桌面视口也无横向溢出。这是本地新代码视觉验收，尚非线上新 UI。
