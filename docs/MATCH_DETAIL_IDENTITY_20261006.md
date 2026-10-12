# 比赛详情别名身份修复

基线：`d041cd09242c0545de16f27b84d9d191c34912bd`。本改动只处理详情路由身份，不改变模型概率、原发布决策、比分或结算。

## 原因

推荐中心可以保存 `sporttery_<source>`，而 PG 详情原件保存 `fivehundred_<source>`。原详情 API 接受请求别名并返回原 ID；前端严格 ID 比较拒绝该响应。固定 r793 已有此机制。仅忽略 ID 或比较数字后缀不能证明同一比赛。

## 新契约

- 只为本系统两种明确前缀提供别名；原 payload ID 不重写。
- 在同一 PG `REPEATABLE READ READ ONLY` 事务中读取原比赛、冻结决策身份头、真实 publication metadata 和数据库观察时钟。
- 比赛必须具备明确 source ID、eventVersion、kickoff、有序球队 ID、官方比赛序号、业务日、销售截止和源观察/接收时钟。
- 冻结身份头先验证完整 `validDecision` 与 `recordHash`，再检查 DB 列和 payload 的 ID/source/event/day/pub/cutoff/inputHash 完全一致。
- 同一事件的概率版本通过 `DISTINCT ON` 折叠为最新身份头；事件、球队顺序、业务日、比赛序号或截止发生变化仍保留独立头。最多 16 头，读取第 17 个表示超出边界而拒绝。比赛候选同样最多 16；SQL statement timeout 为 2500ms。
- 所有候选和身份头必须绑定同一事件。缺字段、歧义、时间倒流、纳秒差异、无有效冻结决策或非 active PG generation 均拒绝，不回填数据。
- 原 `buyEndTime` 北京本地合同及其逐字副本，只有在上述有效冻结 Sporttery 身份完整绑定后才按 `+08:00` 解读；不修改原字段或原件字节。冻结报价截止可以早于销售截止，不能晚于销售截止。
- 返回 `detailIdentity`，绑定请求 ID、canonical ID、事件/球队/业务日/比赛序号/时钟、冻结 decisionId/recordHash、真实 PG generation/manifest/source cycle/commit/observation。SHA256 是响应内容完整性绑定，并非新增独立数据源认证；信任仍来自既有受保护 HTTPS endpoint 和真实 PG 事务。

前端共享规则及 WebCrypto 校验 SHA256。正常响应、304 缓存复用、状态渲染都检查请求身份与时钟。别名响应作为一个完整 PG 快照使用，不和宽松 context fallback 合并。精确 ID 响应继续走严格原路径。

## 验证边界

本地身份回归覆盖真实 `makeDecision` 合成冻结原件、缺项/交换球队/号码/日期/纳秒/截止/源时钟/record hash、PG 同事务及列一致性、generation drift、正常响应和缓存拒绝。合成测试不代表线上比赛采集或浏览器验收。

本改动同时包含 server 和 frontend，必须由根任务集成后走正常完整签名发布，再用新线上响应与 Chrome 验证。仅发布 frontend 不足以交付此修复。没有生产 DB 写入，不创建 QA，不推送或部署。历史冻结记录不改；超过身份上限或缺完整字段的旧记录仍显示无法确认。
