# 独立让球参考适配器与后续接入边界

## 本次交付

仅新增纯模块 `src/services/standaloneHandicapReference.cjs`、定向测试及本文档。没有接入生产发布器、数据库、调度器、串关或页面，也没有修改旧 HAD 决策、概率、冻结记录或结算。模块完成不等于线上两场缺方向已经解决。

新记录使用独立 discriminant：`version=independent-handicap-reference-v1`、`market=HHAD`、`statisticsTrack=independent-handicap-reference-only`、`publicationStatus=FROZEN_REFERENCE`。HAD 部分可以不存在；不构造虚假 HAD 赔率或 HAD 决策，也不冒充旧双选记录。`formalEligible=false`、`formalPromotion=false`、`primary=null`、`companion=null` 固定保留。

### 调用接口

- `createStandaloneHandicapReference(match, {now, publication, snapshot, trustRegistry, referenceMatch, referenceEvidence})`：返回 `{record, reason}`；原输入不变，成功记录递归冻结。
- `validStandaloneHandicapReference(record, {trustRegistry})`：以封存输入、完整签名端点、原参考证据重放全部校验，比较完整内容哈希。自改字段后重新计算 recordHash 不能取得准入。
- `projectStandaloneHandicapReference(record, {trustRegistry})`：只投影独立、未校准的模型倾向与研究准入原因；不暴露端点完整载荷、模型原件或信任注册表。
- `settleStandaloneHandicapReference(record, resultEvent, {trustRegistry})`：按自身 HHAD 整数让球结算，未知为 PENDING、无效/身份冲突为 DISPUTED、VOID 排除；结果事件必须来自调用方已经准入的结果账本。本纯函数检查账本内容完整性和事件/球队身份，**不独立证明上游官方结果真实性**。
- `compareMarketEvents(left, right)`：比较两个玩法实际整数净胜球集合；无法验证的玩法、代码或让球返回未核验。

## 源、时间与准入

1. `calculator` 与 `current` 各一个同采集周期的端点；固定官方 URL、签名 request URL、GET、角色、空页号、HTTP 200 全部核对。调用方的 unsigned 标签不能替代签名请求地址。
2. 使用运行环境受保护的信任注册表验证 Ed25519 采集签名，并对保留的完整解析 payload 重新计算 canonical hash。显式核对 HHAD marketExtractionHash。纯测试允许依赖注入合成 registry；未来 HTTP/业务请求不能传入信任公钥或注册表。
3. 两份签名 payload 的目标 sourceMatchId、比赛时刻、业务日、球队名称、Selling/sellStatus 必须一致。calculator 的 HHAD 完整三项赔率、非零整数让球及开售池必需；current 可以没有 HHAD 赔率，但显式 HHAD 关闭、停售或重复矛盾不能忽略。
4. 请求/取得时间不在未来且不超过 15 分钟；提供方观测时间、明确池更新时刻不能晚于取得时刻。报价、模型、发布代际取得时间严格绑定各自真实时刻，不能复制元数据延长有效期。适用开赛、业务日闭售及所有显式截止值中的最早值。已截止、已开赛或锁定输入不能创建记录。
5. 签名是**可信采集者对源请求及解析载荷的签名**，并非竞彩网官方提供方签名；本模块没有重新获取并哈希原 HTTP 响应字节/headers，因此固定写明 `raw-http-bytes-not-rehashed`。
6. 完整模型 inputEvidence 必须通过现有算术验证。概率来自原模型无条件净胜球矩阵，不重训、不手动改 p、不通过配额凑上盘/下盘。该模型本身含市场输入及人工权重；“独立 HHAD”仅指独立记录/玩法路径，**不表示赔率独立预测**。
7. 样本不足、领先太薄、非正 EV、绝对模型与同报价去水市场偏差至少 10 个百分点等原因保留为观察，不能成为研究价值候选。没有正式校准准入适配器，不产生正式推荐或合格串关。
8. 旧公参原件只能证明内容与原时刻绑定，不能改称采集源验证。仅已核验内容、同事件/球队/时刻且整数事件集合确实互斥时，才能阻止研究价值准入；未核验公参仅诊断。

## 让球与胜平负相容性

记 `d=主队90分钟进球−客队90分钟进球`、主让球为 `L`：让胜集合 `d≥1−L`，让平 `d=−L`，让负 `d≤−1−L`。HAD 等价于 `L=0`。

| 两个方向 | 净胜球交集 | 结论 |
|---|---|---|
| 主胜 与 -1 让负 | 无 | 互斥 |
| 主平 与 -1 让负 | d=0 | 相容 |
| 主胜 与 -2 让负 | d=1 | 相容，主队仅赢一球 |
| 客胜 与 +1 让胜 | 无 | 互斥 |
| 客胜 与 +2 让胜 | d=-1 | 相容，主队仅输一球 |

不能比较两个玩法的原始 1/X/2 标签是否相同，也不能笼统把“主胜+让负”判为错误而忽略具体整数让球。新测试对 15 种 HAD/HHAD 事件两两做 225 个组合的独立整数算术对照。

## 线上缺方向及集中下盘的已查原因

以下为本聊天本轮新取得的线上只读观测，不是训练数据或命中率证明，后续自然周期可能变化：

- 2026-10-06 19:59:58 北京时间：12 个目标、10 个旧冻结方向；英格兰—捷克与瑞士—北马其顿被现有 HAD-first publisher 以 `official-had-quote-unavailable` 排除，不能因有 HHAD 就回填假 HAD。
- 20:10:09 官方双端点只读重放：两场实际 HHAD 分别 -2、1.74/4.30/3.10 与 -2、1.65/4.20/3.50；证明当次真实 HHAD 可以独立取得，不证明生产发布器已经接入新记录类型。
- 20:07:47 取得的 10 条冻结记录均选 HHAD 主方向；其中 6 条使用 market=.15、teamStrength=.35、elo=0、poisson=.5，至少一队 Elo/form 样本不满足基线要求。韩国为 Elo 1009/0、form 12/0；哈萨克斯坦 2/1；卢森堡 2/2；摩尔多瓦 0/1；芝加哥 Elo 4/7、form 4/12；中国 Elo 703/0、form 12/0。其余 4 条基线是 market=.10、teamStrength=.15、elo=.30、poisson=.45。
- `src/services/baselineEnsemblePolicy.cjs:10`：Elo 每队至少 6 场、form 每队至少 8 场且 confidence≥.25，否则走相应冷启动人工权重；当前不是训练出来的阵容/体能模型。
- `scripts/syncData.cjs:2173`：基础概率是 market/teamStrength/elo/poisson/worldCupPrior 加权混合。
- `scripts/syncData.cjs:2331`：国际比赛、非平市场首位且 SP≤1.7 时固定扣除 .05，`redistributeOutcomePenalty` 将被扣量的 55% 加给平、45% 加给另一胜方向；其他冷却可以叠加。`preserveOutcomeLeader` 防止此阶段改换原首位。这是人为风险调整，不能称已训练校准。封存的紧凑模型没有完整此阶段 trace，不能据此声称每一场实际都触发了该分支。
- `src/services/coherentPrimarySelection.cjs:25`：比较 HAD 最大无条件边际与 HHAD 最大无条件边际，较大者作为主方向。较宽的 HHAD 结果集合自然更易胜出。例如苏格兰 HAD 主胜 42.1421%、平 29.6296%、客胜 28.2282%，-1 让负覆盖平+客胜，合计 57.8579%；爱沙尼亚 HAD 主胜 30.4%、平 28.6%、客胜 41%，+1 让胜覆盖主胜+平，合计 59%；克罗地亚 +2 让胜 73.6596%还包含仅输一球的概率质量。
- 后续自然批次证明还存在**玩法可用性随采样切换**：20:37:10 新 PG 只读回执中，2 场已截止仍保留原 HHAD，8 场未截止最新 20:36:37 发布记录全部为 HAD 主方向且 HHAD `marketReference=null`。同一观察时快源 20:37:08 双端点签名均有效，纯函数 `joinOfficialHandicap` 能更新 10 个未截止输入；快源比当次 publisher 时刻更晚，不能倒推该 publisher 已拿到这份载荷。
- 20:39:34/20:41:19 固定 pin 只读现场检查：正常 `football` UID 999 可按 `O_NOFOLLOW` 读取实际 `/var/lib/football-predict/sporttery-relay-fast-lane.json`，普通文件 mode 640；正常源 reader 返回成功，calculator/current 签名有效。同步/API 服务实际路径与文件配置一致，已安装 Repository 源包含正常官方 join。此时没有复现永久路径/权限缺源；未读取 publisher 当时的签名原件与调用边界，**切换唯一原因仍未证明**。
- 根任务 Chrome 在 20:36 同样实见未截止 HAD-only，在 20:38 实见 HHAD 回来（美国 SP 2.15、克罗地亚 2.00、苏格兰 2.02），期间 backend 仍为 r793，r799 只改前端价格展示。这些后来观测不能改称新模型已经上线或前端修复造成概率改善。下一次链路调查应绑定同一 publisher 的 `now`、实际源原件/取得时刻、join 输出与 HHAD gate 原因，保留未来源/过期源拒绝，不强制同步或写假绑定。

这解释选择集中现象；UI 的赔率错位、两场被 HAD 门槛挡住、串关未准入是另外的具体问题。不能通过随机混入上盘、固定上下盘比例、删掉市场权重或调低门槛宣称修好了预测能力。后续应采集阵容/伤病/体能/真实盘口序列，冻结赛前可知样本，分别消融上述人工冷却、冷启动先验与跨玩法最大边际规则，按国家队/联赛分层做滚动验证及覆盖率、Brier/log loss、同报价市场基线对照。

### 本轮私有证据

工作树 `.codex-tmp/current-quote-chain-health-fresh-20261006.json`、`live-handicap-join-diagnostic-20261006.json`、`online-direction-combo-gap-review-final-20261006.json`、`current-quote-chain-health-fresh-20261006-2042.json`（实际观察 20:37:10）、`live-handicap-join-diagnostic-20261006-2042.json`（实际观察 20:37:10）及两份 `hhad-reader-context-20261006-2040/2045.json`（实际观察 20:39:34/20:41:19）保留原只读观测。它们不提交 Git，不当成之后发布的最新证明，不修改封存预测。

## 必须完成的后续生产接入

当前生产迁移固定到 014。旧 `recommendation_decisions` 是 HAD 记录；014 双选表限定原 V2 双选版本及二选结构，均不适合冒充独立 HHAD。接入应单独实施以下完整依赖：

1. **015 追加表**：独立 HHAD reference-only 类型、source/event/team/line/quote/snapshot/evidence/hash/recordedAt 身份约束；仅 append-only 记录与单独结果头/统计轨。已有 HAD payload/hash、历史已闭售方向和串关不更新。
2. **签名 native schema bridge**：`deploy/light-server/recommendation-schema-bridge.cjs` 当前 `expectedBaseline()` 强制 001–014 共 14 个文件。必须正规支持 015 的 signed baseline、候选/线上 SERIALIZABLE+advisory lock、已有 migration SHA 校验、幂等/意外表拒绝和权限，不可只放 SQL 文件绕过桥接。
3. **发布与冷恢复**：`release-native.sh` 候选和已停止旧 writer 的线上交换阶段调用桥接；`football-release-recovery.cjs` 的 root schema intent 需要明确 015 两阶段状态、保留原 014、已使用新表不得删除、未使用候选失败时合法恢复、断电后重入与代际/库配对验收。不得直接在生产创建表、改 migration highwater 或清恢复状态。
4. **正常 publisher/repository**：原 HAD 成功/拒绝路径不改。HHAD-only 在独立受保护源捕获及当前代际绑定后调用本纯适配器，保存新轨；只接受尚未闭售事件，source trust registry 不能来自客户端。模型 inputEvidence 算术验证不等于独立体育证据或正式校准。
5. **独立 reader/parser/UI**：显式 HHAD discriminant 与 reference-only 方向；旧 HAD 中心 parser 不硬塞新类型。列表、详情和串关所显示 SP 必须与各自 record/code/line/source/clock 绑定，不能借 HAD 值。合格串关仍按正式规则，不因纯适配器产生观察记录就强凑二/三串。
6. **结果与统计**：新的正常有界只读结果 reader 查询独立记录目标，复用已准入且可信 90 分钟结果头与修订；按本轨自身让球结算。旧 HAD、HHAD、冻结比分首项及分母不变，Top3 覆盖不改比分 Top1 命中定义。
7. **完整发布验收**：先定向 PG/schema/native/cold-recovery 正负回归、runtime require 装包闭包与签名静态回执；再固定 commit 经正常 full release 窗口、锁、签名、代际/完整源码 dist 验证，自然 worker、新真实报价、新独立记录与 Chrome 实测逐条确认。前端快包不能部署 backend/schema 修改。

本次已验证的是纯函数和合成可信签名的算术/边界回归，不是线上新预测发布、正式推荐命中率提升、自动训练或采集完整覆盖。

## 本次验证记录

固定 Node v22.22.1：以下四个真实测试文件联合 **37/37 通过、0 跳过**：`tests/standalone-handicap-reference.test.cjs`（17 项，含 225 个整数事件交集子断言）、`tests/recommendation-live-official-handicap.test.cjs`（4 项）、`tests/recommendation-selection-quality.test.cjs`（6 项）、`tests/recommendation-official-results.test.cjs`（10 项）。新模块和测试 `node --check` 通过；现有 ESLint 配置仅覆盖 TS/TSX，未将这两个 CJS 文件或全仓 lint 记为通过。

先前 27 项日志只代表前三个真实文件；第四个误写的 `tests/recommendation-results.test.cjs` 不存在，Node test CLI 未执行它。发现后保存原日志，并用上面真实四文件生成全新 `standalone-hhad-reference-joint-corrected-final-20261006.log`。独立审查也使用固定 Node22 重新执行同一四文件，保留其独立日志，不沿用缺失文件的声明。
