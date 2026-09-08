# 影子观察运行健康与模型资格分离

## 事故与边界

2026-09-08 07:41（北京时间），r704 实际回测生成新的有效 SHADOW 账本，
随后 worker 在回测后的严格心跳检查中失败：
`CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT` /
`candidate-deadline-capture-status-not-advanced`。
旧 `exactHeartbeatMatches` 只允许 ACTIVE，合法的未提名新版本无法完成发布。
07:44 签名发布终态失败，已回滚到 r699；禁止重放 r702/r703/r704。
失败 heartbeat 原文件随后被恢复的旧 worker 覆盖，不推定未保存字段。

## 本次修复

- 统一 `candidate-shadow-observation-state-v1` 协议，仅允许有明确回执的 SHADOW
  通过**运行健康**检查；单独改一个 `state` 字符串仍失败。
- 回执绑定候选版本、当前根哈希、冻结与检查时间；要求账本有效、未激活、
  全部正式计数为零、正式窗口为零、未获晋级资格、无线上推荐效力。
- 仍执行原有完整心跳、截止点漏账、原子决策、就绪分母、阻塞项和时效校验。
  不新增 skipped 成功分支，不延长时效，不继承旧窗口/样本，不激活候选。
- 真实公开投影必须将回执与当前 registry 的 revision/root/frozenAt 重新绑定，
  并拒绝含 activation 或 formal 事件的 SHADOW。旧根或不同账本不投影健康回执。
- worker、发布 keeper、公开上线检查、运行巡检和采集紧急程度识别使用一致语义。
  发布停止前重新审计 registry，停止后仍核对 drain、版本、根、状态与时效。
- 未来 SHADOW 实现漂移仍可进入原有受限 refreeze 恢复流程，不能直接跳过回测。
- 原“状态未推进”失败现在附带有限枚举状态、安全原因和 ok 值，便于区分
  时间未更新与状态/证据不符；不输出 API key、原始错误正文或整份账本。
- 页面明确提示：采集正常不代表模型验证通过，激活前记录不计正式命中率。

同时修复全量 lint 暴露的三处 UI 状态更新：首次可用日期只在提交界面前解析一次，
手选日期不被背景刷新覆盖；竞技场日期失效时有界重置；远端竞技场结果绑定获取它的
访问会话，退出或换会话时立即不再展示旧会话结果。未关闭 lint 规则。

## 已执行的本地验证

- 实际 child capture + SQLite 的截止采集验证 35 组；新增真实 ACTIVE→SHADOW
  换版，不继承旧 activation，旧事件前缀不变，worker 接受完整新心跳。
- 执行发布 shell 内真正的 Node baseline/stop 代码：合法 SHADOW 通过；
  缺回执、伪装 ACTIVE、改版本、混入正式样本或宣称推荐授权全部拒绝。
- 发布事务安全 65/65；发布配置 122；worker cadence、refreeze 17、
  版本连续性 27、公开投影 6、全量就绪分母 48、运行监控 59、采集熔断 28 通过。
- 原生 SQLite + 实际 HTTP 的证据往返 285 项通过；公开 SHADOW 被运行巡检正确
  接受，删除回执则拒绝；原公开平局与原市场主胜仍各自绑定，不替换历史方向。
  这 285 项中的 PostgreSQL 是查询替身，与下面的原生测试单独记录。
- 页面结构 41 项、竞技场验证、lint、TypeScript 和生产构建通过。

### 固定源码 f960eb23dedcb 的补充验证（08:15–08:16）

- 原生 Windows PostgreSQL 16.15：404 项通过，实际迁移、全量/增量投影、
  SQLite 和 PostgreSQL 两种主读的真实 HTTP 均覆盖新 SHADOW 公开契约。
  临时数据库已停止清理。报告 `outputs/latest-native-evidence-1788826505484.json`；
  原生报告 SHA256 `e09c1138d711f87f9934e5fb853c42263f4d25c8c93cf89ed02d9117e89d44d7`。
- Linux：509 份源码按原始字节在独立 `/var/tmp/football-shadow-health-01s296/tree`
  运行，root 所有且只读；普通用户写入被 EACCES 拒绝，测试进程禁用网络。
  截止采集 35 组、实际 worker cadence 和 refreeze 17 项全部通过；源码前后哈希相同，
  不触碰生产数据。报告 `outputs/shadow-health-linux-1788826565794.json`，
  SHA256 `c988a2c1a09ab4d59787cd0c5bb9376d070b8e7699859a3ea2cd2e44bea8d2fa`。
  首次传输脚本有正则转义语法错误，发生在远端执行前；修复隔离工具后才得到此通过结果。
- 08:21 实际 Chrome/React 的 12 项状态转换验证通过，检查初始日期、空数据、
  手选日期在刷新后保留、竞技场失效日期、换会话与退出登录的旧结果隔离；浏览器错误为零。
  测试提取原组件未改写的 hooks 与选择表达式，使用合成上下文，**不是完整页面布局验收**。
  报告 `outputs/ui-state-transitions-1788826898720.json`。

这些是隔离验证，不是生产部署成功、推荐命中率改善或真实前瞻样本。
下一次发布必须使用新身份，继续保留签名验证、连续性声明、双数据库同代、
新 worker 完整周期、双 marker、recoveryPending=0、公开/受保护 API 和浏览器验收。
Q1–Q5 的正式前瞻门槛未改；研究/影子/正式分母始终独立。
