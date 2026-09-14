# 数据采集、取值与界面架构

延续现有 Node.js、React、TypeScript、PostgreSQL 技术栈，不另建 Python 服务，不修改生产凭据，不自动部署或合并主分支。

## 代码分层

```text
公开/授权数据源
    |
collectors/market/http.cjs          请求时限、字节预算、限流响应
    |
现有 scripts/sync500Data.cjs       复用页面解析器
    |
collectors/market/policy.cjs        配置、字段校验、去重、轮询策略
    |
collectors/market/store.cjs         单源锁、运行审计、事务、最新状态
    |                 |
market_observations   +-> collectors/market/features.cjs
market_latest                  |
                     scripts/marketFeatureLogic.cjs
                               |
                     market_feature_latest（描述性统计）

已发布的 Match 数据
    |
src/services/marketQuotePolicy.ts  原子候选选择、来源/时间/盘口校验
    |
src/services/bettingDisplay.ts    保留既有公开调用入口
    |
MatchMarketOdds -> MarketQuoteCard -> MatchSummaryRow
```

| 层 | 责任 | 不做什么 |
| --- | --- | --- |
| HTTP | 有界 GET、正确识别 HTTP 状态和 Retry-After | 不绕过验证码、签名或访问控制 |
| Policy | 校验单条候选，拒绝冲突，生成稳定状态 hash | 不把缺失字段补成 0、不生成预测 |
| Store | 请求前取得单源锁，保留审计，原子提交数据和特征 | 不直接修改已冻结推荐或 serving publication |
| Feature | 同一来源/比赛/玩法/公司和连续事件段的描述性统计 | 不把去水概率当模型概率、不把首次采集当官方初赔 |
| Resolver | 整体选择赔率、来源、观察时间、盘口 | 不跨来源拼字段、不把参考报价伪装成官方 SP |
| UI | 展示有效值、缺失、过期与出处；保留原始记录 SP | 不在浏览器根据最低赔率生成主推 |

## 取值策略

`resolveMatchQuotes()` 返回 HAD、HHAD 及拒绝原因。`getResolvedMatchOdds()` 委托该策略，旧调用入口保留。

- 官方模式只能读取根记录中声明为 `sporttery:had` / `sporttery:hhad` 的相应报价；外部嵌套候选不能通过改 source 名称变成官方数据。
- 数值、来源、时间和让球线在一个候选中绑定。外部回退不继承旧官方时间。
- HHAD 必须具备整数让球线。显式 `0` 有效；空白、缺失、`-0.5` 或混合文本无效。Asian handicap 应走独立类型。
- 通用 `externalOdds` 必须声明 HAD/HHAD，不能仅靠“没有让球线”来猜玩法。
- 已提供的开赛时间、事件版本或站点比赛 ID 不一致时拒绝。来源内 ID 不与其他来源 ID 强行比较；仍需可靠的上游映射。
- `preferFresh` 只用于当前行情展示；归档默认保留官方记录优先级。缺失时间显示未知，过期值显示滞后。
- `asOf`、`prematchOnly`、`requireFresh` 可供严格调用方使用，未来观察值不可穿越时间截面。
- 官方推荐 eligibility 与冻结发布仍由原有治理模块负责，展示回退不改变正式资格。

## 采集与 PostgreSQL

`runMarketCollector.cjs` 只负责编排，原导出函数保留。运行时不执行 DDL，只校验 migration；按原签名发布流程安装 schema。

单源 advisory lock 在 HTTP 前取得，在周期结束后释放。一次请求只下载一份竞彩页面。运行记录在请求前写为 `running`，报价状态、最新指针、描述性特征与运行结果在同一事务内提交。重复 run 不累加计数，旧观察不倒退最新指针；A -> B -> A 仍保留三段。

完成或失败后的下次执行时间保存进运行记录，重启继续遵守冷却期。普通轮询仍为 60 秒至 30 分钟；403/429 等阻断默认退避 6 小时，并取源站 Retry-After 与本地退避的较大值。退避不受普通 MAX_SECONDS 截短，不加负向抖动。

`008_market_feature_latest.sql` 现在由采集事务内的特征 writer 填充。此表是**描述性参考层**，不是已接入预测的特征仓库：

- 用当前连续开赛时间/让球线段计算首次采集价、最新价、极值、变化幅度、单步变化、反转次数。
- 价格与事件发生往返变化时不丢掉中间段。
- 最大读取 5000 条状态；截断时明确 `historyTruncated=true`。
- 历史 as-of 不使用之后的价格，也不从未来 `last_seen_at` 伪造过去某一时刻的采集成功。
- 压缩状态只证明采样时看到了相同值，不能证明两个样本之间从未变价。
- `predictionEligible=false`；市场隐含概率、真实 xG 和模型概率保持独立。

## UI 组织

`MatchSummaryRow` 仅负责卡片布局，保留原 props、比赛事件 key、详情回调及正式/参考标识。

`MatchMarketOdds` 选择报价与人工记录，`MarketQuoteCard` 统一展示价格、来源、北京时间和新鲜度。HAD 存在时 HHAD 在可键盘操作的原生 details 中展开；只有 HHAD 时不把它冒充 HAD。

`matchday-cards.css` 管理赛事卡片；`matchday-shell.css` 管理导航与页面留白。没有继续向历史 `index.css` 追加页面规则。响应式覆盖 320px 至桌面宽屏，并支持 reduced motion。

## 验证与发布

```bash
node scripts/verifyMarketPlatform.cjs
node scripts/verifyMarketCollector.cjs
npm run build
```

本地实际执行范围见 `docs/market-platform-validation.md`。完整 React 19/Vite 构建、真实 PostgreSQL 事务/权限测试和真实源站连续采集必须在项目依赖与数据库均可访问的环境中完成。

新采集层仍未接入 `football.odds_snapshots` / `odds/history` 发布投影；不得直接往会被投影清理的旧表塞数据。旧 `sync:500` 和新 collector 的请求预算尚未全局合并，因此上线前需审查并行采集任务，不能宣称全站只有一次请求。

本次没有重写预测算法、冻结记录或 20 多万字符的 MatchDetail 主组件。后续应按市场、球队状态、证据和归档分区逐步拆分，同时保留回归测试与发布边界。
