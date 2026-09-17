# 稳定发布、统一决策、统一复盘

## 本轮范围

基准 main: `e0830b4e11a79f93f3bb5f1334f9608e9fa6dca3`。

不训练模型，不调整球队强度或进球模型的参数。不承诺命中率提升。使用既有 `publishedForecastPolicy.evaluateForecast` 校验当前真实输入；保留未验证模型状态。普通胜平负每个输入版本取唯一模型首选，取消串关模块再次融合市场并改变同场方向的路径。

## 实际运行链路

- 原 `scripts/dailyFeaturedComboLedger.cjs` 的 CLI 改为统一发布入口；publish、combos、view分别提交事务。
- `scripts/runRecommendationSettlement.cjs` 是独立的赛果处理进程，只调用 settlement、view。历史结算不是发布事务的一部分，也不需要当前模型晋级。
- 当前赛程和报价仍来自既有 PostgreSQL generation/projection 通道。本次不改上游采集器或重写 `syncData.cjs`。源站断流不能靠这次改造生成数据。
- 迁移011监听 projection_meta 的版本变化，递增持久化唤醒计数并发出不含业务数据的通知。两个worker监听通知，同时每30秒兜底核对最新已提交输入及截止时间。通知遗漏时只处理当前仍可发布的输入，不倒填过去预测。
- 单次 `--once` 风格调用（不带 `--watch`）仍可用；生产service使用 `--watch`。前端读取已有受访问控制的 `/api/v1/daily-featured-combos` 中 `recommendationCenter` 字段，不增加另一套鉴权入口。

## 统一决策契约

`decisionId = hash(policy, sourceMatchId, eventVersion, market, inputHash)`。

每个新输入追加一个不可变版本，包含唯一方向、完整概率、原始SP、源/报价/模型时间、upstreamModelVersion、来源周期及实际使用的模型输出。既有原始特征仓库的完整输入仍由generation/周期标识关联；本轮不声称已保存所有训练特征。

单场当前卡片使用事件的最新已发布版本。串关每腿直接引用已提交的decisionId，数据库外键约束绑定，不能自行换第二方向。同一决策ID在推荐、组合、内嵌版本详情和复盘中完全一致。冻结组合绑定的旧版本不会随新的单场版本变化，界面显示绑定发布时间，避免把不同节点误看成同一判断。

每场单场成绩按预先固定的“截止前最后一次实际发布”口径、每事件一次计数；不得在多版本中挑命中的版本。新决策一旦过开赛/停售/业务日停止线不能插入。数据库延迟约束在事务结束时使用数据库时钟复核截止。

## 组合策略

- 2串1原始SP乘积>=2.50；3串1>=5.00。
- 十进制四位定点比较，不先四舍五入越过门槛；超出支持精度的单腿拒绝，不静默取整。
- 不以旧BEST、recommendationAction或单腿2.60上限过滤。
- 最大化已记录模型概率的对数和，只做组合排序；不宣称得到校准过的联合命中概率。
- 相同比赛和共享球队不重复。使用乐观上界剪枝，不按前18名截断候选。
- 临近最早停售5分钟提前冻结，否则工作日21:00/周末22:00（北京时间）。冻结当轮重新核对当前在售状态及精确输入ID，不拿旧预览在停赛后补发布。
- 每日每种组合最多一次冻结；原决策、组合及腿映射均禁止UPDATE/DELETE。

## 统一复盘

官方结果由现有生命周期校验器验证，再进入一个公共结果事件流。单场和串关从同一个事件头推导状态。官方显式更高revision可更正成绩；同revision矛盾保持DISPUTED，不能因为下一轮少读一条记录就自动解除。

PENDING、VOID、DISPUTED不计入已结算命中率。组合任何腿待核则整组待核；全部确认后判WON/LOST。原始比分与方向不改，只追加结果事件。相同事实重读不增长事件日志。

旧 `published_forecasts`、`daily_featured_combos` 及参考归档未迁移或改写，不回填成绩。旧复盘实现按原Git blob保留为 `LegacyHitAndWin.tsx`，在“升级前原始口径”折叠入口可查看。新台账独立统计，不能把升级前历史样本假装成此策略的验证结果。

## 发布故障隔离

数据库故障、赛果任务失败、视图刷新失败分别保留各自上次提交结果，状态单独记录。一个有问题的当前比赛通过保存点隔离，其他有效比赛继续。记录损坏会进入issues并从当前统计排除，UI显示排除数量；不得把读取失败变成0%或“0条合格比赛”。

这不是“不管源数据对不对都发布”：来源、事件、截止、未来数据、新鲜度、SP完整性仍有效。源数据缺失时保留旧冻结记录并显示延迟。

## 推荐页

`/best`、`/betslip`、`/review` 使用同一个推荐中心组件与共享请求store。取消旧正式/实时/参考区块并排互相矛盾的默认展示。单场、2串1、3串1分别显示，可展开查看实际决策ID及生成/报价/发布时间。

资料按钮仍进入原比赛资料页，该页面的旧模型解释未整体重写；本轮统一的是新推荐中心内的决策和版本详情。没有把所有既有详情页的历史模型输出强行覆盖成当前新决策。

前端15秒安全轮询，隐藏页暂停后续请求，失败退避。切换页面共用一个在途请求。401/403清空内存数据并提示重新登录，不保存访问码。

## 数据库与部署顺序

1. 在完整工作树跑构建、现有回归，以及本PR新增Node与本地PostgreSQL测试。不得将本地适配器测试当作数据库测试。
2. 用现有迁移流程安装011；运行角色需要新表SELECT/INSERT、heads/lanes/issues/state的UPDATE，以及identity序列USAGE。不向PUBLIC授予业务表写权限。唤醒触发器是固定SQL、固定搜索路径的SECURITY DEFINER，由迁移角色拥有，避免普通source writer需要业务表权限。
3. 停止旧combo timer和旧oneshot进程后，安装更新的 `football-featured-combo.service` 与新增 `football-recommendation-settlement.service`，再启用两者。不可同时运行旧legacy CLI与新worker。
4. 配套部署新版前端。验证API含recommendationCenter、decisionId绑定和各lane独立时间。服务节点版本/数据库版本核验仍应纳入现有部署流程。
5. 回滚时先停新服务，再回滚代码/前端；保留新不可变表供审计，不删除业务记录。旧API字段在兼容期保留，未自动改写旧产品状态。

新增SQL不对生产执行；本次交付是分支代码与测试，不等于线上完成迁移或恢复。

## 验证

本地执行：54项Node测试全部通过，包含80组随机样本、两种串数共160次最优性对照；2个纯TypeScript服务文件strict检查；所有新增CJS语法检查。TSX、hook完成语法转译，不等于完整React/Vite构建或浏览器验收。

发布故障测试使用可回滚的内存事务适配器。新增 `verifyUnifiedRecommendationPostgres.cjs` 和PR工作流用于原生PG、并发、不可变触发器、赛果更正及完整build；本地环境无pg/数据库，未本地执行该集成脚本。

```bash
node --test tests/recommendation-unified.test.cjs tests/recommendation-center-view.test.cjs
UNIFIED_TEST_DATABASE_URL=postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1/recommendation_test node scripts/verifyUnifiedRecommendationPostgres.cjs
npm run build
```

模型优化留在下一阶段：仅从真实冻结的时间点和对应官方结果构建样本外对照，不在这次架构变更中偷偷改训练权重。
