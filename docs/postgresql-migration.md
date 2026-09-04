# PostgreSQL 渐进迁移方案

目标是把应用发布与数据迁移彻底解耦。PostgreSQL 保存比赛、赔率、冻结推荐、赛果、复盘、正式命中率和 AI 积分账本；SQLite 最终只作为可重建的本机只读缓存。

## 生产拓扑

1. PostgreSQL 运行在独立托管实例或独立数据盘，不与当前生产根盘争用容量。
2. 应用仅通过受限账号和连接池访问；远端连接默认校验证书。
3. 当前/上一代 publication 在数据库内事务切换，应用版本包不再携带或重建事实库。
4. Nginx 在 A/B 应用实例之间切换；数据库迁移与前端发布分别执行。

## 四阶段切换

### 1. disabled

SQLite 继续作为生产事实库。只运行 `npm run verify:postgres-migration-plan` 和 `npm run postgres:migrate-schema`，不接管读写。

### 2. shadow-write

所有新事件先按原逻辑提交 SQLite，再以同一幂等键写入 PostgreSQL。PostgreSQL 写失败只告警，不影响现网；冻结推荐、官方赛果和 AI 积分账本必须保持一场一条原子记录。

晋级条件：连续 72 小时无丢写，按表计数、确定性样本哈希、publication revision 与正式命中率完全一致。

### 3. shadow-read

生产仍返回 SQLite 结果，同时后台读取 PostgreSQL 并比对。发现任一字段不一致立即停止晋级，不回写已冻结推荐。

晋级条件：三个核心 API 连续 24 小时结果等价，P95 延迟不劣化超过 20%，热同步期间无持续 502/503。

### 4. primary

PostgreSQL 成为唯一事实库。SQLite 从已提交 publication 异步生成，仅作本机只读缓存；缓存失败不得阻塞应用发布，也不得改变 PostgreSQL 当前 revision。

回退只切换读取路径，不回滚数据库事务，不覆盖新写入。

## 硬门禁

- 每个正式推荐具有唯一 `decision_hash`，截止后不可更新方向、盘口和 SP。
- 每场每个 AI 只有一条 `ai_decisions`；`stake=0` 是合法自主决策，不强制下注。
- 积分通过 `ai_score_ledger.idempotency_key` 防重，余额不得小于 0。
- 正式命中率仅由 `won + lost` 构成；参考推荐、作废和赛果归档不进入分母。
- 迁移 SQL 写入不可变 SHA-256；已执行脚本发生修改时直接失败。
- 未完成备份恢复演练、影子一致性和 A/B 回切演练前，不允许把模式设为 `primary`。
