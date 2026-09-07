# API-Football：分开接收时间与上游时间

## 修复前的实际反例

2026-09-07 在真实导出函数复现：

- temporalEligibilityFor 接受 2026-02-30T12:00:00Z，Date.parse 将其转为 3 月 2 日，
  再将它判作 3 月 3 日截止前的有效数据。
- buildPieceMetadata 未收到 sourceUpdatedAt 时，把 observedAt 复制成上游时间。
  伤停、首发采集调用者也直接传 sourceUpdatedAt=observedAt；赔率缺更新时间
  时同样回退到 observedAt。
- 显式 buyEndTime=false 被 compactText 清空后，回退到较晚 kickoffTime。
- 缓存及已有片段保留路径只看 temporalEligibility.eligible=true，没有重新
  校验时钟、来源字段一致性或当前截止时间。

## 新行为

统一使用 apiFootballClockEvidence.cjs 与项目 strictInstant：

1. 非法日历、无时区、非字符串和晚到观测均拒绝。
2. 缺失上游更新时间保留 null，clockEvidence.sourceTimeStatus=missing；合法
   接收时间仍允许影子使用，但 upstreamTimeVerified=false，不冒充官方公布时间。
3. 显式非法上游时间或晚于接收时间的上游更新标记为冲突并拒绝；不自动修正。
4. 构建器未收到真实 observedAt 时不再调用 nowIso 补造。实际网络采集仍在
   收到响应后记录当前接收时间，再传给构建器。
5. 截止字段保留现有优先级；null/undefined 可视为可选缺失，显式错误字段
   返回 null，不继续找一个更晚时间。没有在本补丁里改变全部截止时间政策。
6. 新片段标记 api-football-clock-evidence-v2。缓存复用与最终合并重新检查
   时钟/声明一致性，生产合并还传入当前比赛重新核对截止时间。
7. 不带 v2 证据的旧片段仅保留作原始缓存审计，不在新的当前信号合并中
   继续作为已验证时间片段采用；后续正常采集形成新证据。未回写历史快照。
8. 当前信号记录 temporalRejections，合法新片段替换时清除陈旧拒绝说明。
9. 对阵评分和缓存映射复核同步拒绝非法开赛时间，不将非法日历归一化后匹配。

未改变数学权重、正式推荐权限或官方结算身份。clockEvidence 只表示本地
时间合同通过，不证明响应真实性、官方发布时间、足够新鲜或整场证据完整。
实体注册表自身 canonicalIso/旧证据全部时间语义并未在本补丁中重构，不能
把片段校验扩大表述为整个 Source→Snapshot→双库→API 链路已验收。

## 验证

- 57 项新回归：实际构建器、非法/未来/空时钟、时区、截止优先级、来源时间
  冲突、片段字段不一致、伪造 eligible、最终合并、当前截止变更、陈旧拒绝
  提示清除，以及评分/映射时钟路径。
- 接入 verifyApiFootballHardening，外层149项；原联赛字段74项继续保留。
- 13:55:22.658Z 主服务器只读缓存盘点：全部3个伤停/首发/赔率片段均是旧
  时间证据形态，上游时间缺失；当前43场对应缓存fixtureId为0，因此当前
  对阵涉及这些片段为0。该盘点不等于所有在线来源健康或全量投影同代。
- 缓存 SHA-256 29b95c502d3838cff35a9717492a7f4accab7f85e4c63cba55f5cc8df83463c2，
  读取前后字节一致；报告 outputs/live-fragment-clock-inventory-1788789322659.json。
  没有写生产文件/数据库或调用付费 API。

本批改动不在排队 r701 中，未改已签名发布包。后续上线仍需实际采集周期、
当前信号缺口展示和存储链路复核，不能用本地通过替代部署验收。
