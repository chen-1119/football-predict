# 当前赛程、结果同步与可信采集器：根因和本地修复

## 本轮边界与证据时间

- 基线：`295a173d117cbb0f889197dbeff13501d79dfd15`。本轮未部署、未运行生产 sync、未改生产文件/进程/数据库、未提交 Git。
- 公共 GET：北京时间 2026-10-03 00:13:13，`release-readiness-live.json`，两项 GET 均 200，TLS 正常验证。HTTP 200 不代表数据就绪。
- 有界 SSH：北京时间 00:14:20，`remote-source-state.json`；固定已知指纹 `SHA256:t3Y9DoAdbURl0ibCHQEYENSARoqcm3OSK+ERl/Sg8to`。只读 4 个固定状态路径和 worker 最近 120 条过滤日志；文件大小及时间/身份检查、45 秒远程超时，无凭证输出。
- 原始签名空列表：北京时间 00:15:58，`remote-empty-current-proof.json`。只读双端点封包、公开信任注册表及源文件哈希；没有访问官方服务的新请求。
- 真实封包重放：`closure-proof-replay.json`，包含测试结果、代码 SHA、原 GET/SSH 收据和原观察时/当前时两组结果。

## 已证实的三个情况

### 1. 空赛程的校验缺陷会拖住整个结果同步

生产 journal 六次明确报错：`matches-current.json must contain a non-empty array.`；worker 最近失败时间 `2026-10-02T16:13:04.307Z`，运行 308513 ms，错误 `npm run validate:data exited with 1`。这比泛称“数据源全部获取不到”更具体：生成过程已到数据完整性校验，空当前列表被无条件拒绝。

同一 full relay cycle 的两个官方端点都有 HTTP 200、成功 JSON、0 行且有效 Ed25519 签名。current 返回 `totalCount: 0`；calculator 的线上/线下状态均为 `1`，停止销售说明均为 `抱歉，本彩种已停止销售`。原 payload canonical hash 已重算，使用现有部署公钥独立验签；运行域均为 `mainland-collector-runtime-1`。

- 原 full snapshot 捕获时间：`2026-10-02T15:56:02.682Z`，原 cycle `sporttery-relay:20261002T155602682Z:081b699d-cb65-4cbc-ba75-c029ca9da80d`。
- 原 full snapshot SHA-256：`cd97b78f63e934176fcb51a97b0cb084b43ffe080c52258f1c470303534199bc`；2660009 bytes。
- 原观察时不到 20 分钟，有效；现在已经过期，重放正确拒绝。未将旧观察改写为当前采集。

### 2. `relay-fast-envelope-clock-invalid` 是实际过期，没有发现应放宽的时钟 bug

fast 文件捕获于 `2026-09-30T10:33:48.935Z`，merge 时间 `.974Z`。三个端点 requested/received 顺序正常；已有最后审计在 10:53:49.384Z，已跨过 1200 秒。错误指向旧 envelope 超时，不能刷新旧 timestamp、放大 TTL 或伪造新成功。fast/result 独立修复仍需要原采集端交付新的真实合规封包。

### 3. 可信采集器 0/2 的门槛不因停销证明而改变

GET 仍显示 `serviceOk=true`，`sourceDataFresh=false`，`recommendationReliable=false`，`trustedCollectorCount=0`、`requiredTrustedCollectors=2`，`servingMode=critical`。现有市场采集器审计只接受非空市场数据；两份有效空列表属于同一运行域，只证明停销，不能算两条市场通道。

full/history lane 的 **2289 是采集器 lane 健康摘要的行数**；不是本次已发布 generation 的历史行数，更不能与先前 generation 导出的 2272 混用。当前 GET 仍指向 `g-79b3788d9a6029e3dccaeb3366d04ef0da49a8c01d24457492fe0c370a867273`。

该封包来自已有 mainland collector；不能用于宣称 dot 云端的 567 已解除。server-direct 的 disabled/wafBlocked=false 只说明跳过，不能证明放行。原 source failure 早于本次停销，并非休市能够解释所有来源故障。

## 已实现的最小接线

1. `scripts/officialClosedScheduleEvidence.cjs`：对固定 current/calculator 两个端点逐一重算 payload hash、复用已有验签实现、检查独立部署 trust registry、同源 cycle/同 key/同 runtime、原封包与请求时间、精确 1200 秒边界、明确双侧停止销售语义。无证据、伪造 true、过期、单端点、签名坏、payload 改动、cycle/runtime 不符、567 等默认拒绝。
2. `scripts/syncData.cjs`：仅 `split.current.length === 0` 时从既有 full snapshot 的固定路径读取原封包，生成精简双端点签名证明，放入 `currentListPolicy.officialClosedSchedule`。正常非空路径不增加字段。不从 rows>0 市场过滤后的摘要恢复空响应，不回退到另一份旧 snapshot。显式路径别名冲突拒绝。
3. 源采集 cycle/原 capturedAt 与本次 publication cycle/evaluatedAt 分开保存；proof 原文件 SHA/bytes 保留，公开只投影已知端点的 payload 与公开承诺/签名，不复制 producer、授权头、环境或 trust registry。
4. `scripts/validateData.cjs`：服务器与 `--public-distribution` 都独立重验同一 proof，且检查与本代 metadata 的绑定。实际 `matches-current.json` 必须存在并确为 `[]`。不信任 metadata 的 eligible 字段或 proof 自带公钥。公钥默认使用已有 `deploy/light-server/collector-trust-registry.json`，可由既有显式路径覆盖，缺文件拒绝。
5. 停销例外只改变空数组的结构完整性结果。历史比分、赔率、数据文件大小、私有 archive scope、freshness、0/2 冗余、推荐资格等校验没有放宽。

## 验证结果

- Node **22.22.1**，`tests/official-closed-schedule-evidence.test.cjs`：**44/44**。
- 包括真实 syncData metadata 构造片段、实际 validateData 的两个 scope；缺当前文件/伪 eligible/历史坏比分仍失败，非空 current 行为保留；纳秒过期边界、签名/payload/端点/cycle/runtime/停销条件负例。
- 三个业务脚本 `node --check` 通过。
- 真实在线签名样本原观察时通过；当前过期拒绝。精简 public proof **5177 bytes**；未放宽 sync-meta 既有文件大小限制。
- 真实样本回放输入是“已导出双端点投影”，其本地文件 hash 与原 full relay snapshot hash 分别记录，不能互相替代。
- 没有使用本地 public/data 的比赛结果来声称线上命中率或采集恢复。

## 后续接入与验收

1. 将上述四个文件经独立审查后纳入现有发布流程。仍受源新鲜度、冗余、模型与正式推荐门槛约束；此变更不自行授权部署或开推荐。
2. 真实执行时需要一份采集时间距校验不超过 20 分钟的双端点停止销售封包。旧证据拒绝是预期行为，不能以本地重放时钟替换生产时钟。
3. 一次受控真实 sync 后核对：当前文件明确 `[]`；sync-meta proof 的源 cycle/capturedAt 与原 relay 一致；public/server validator 均通过；历史结果仍满足旧完整性门槛；新 generation 三端身份一致。
4. 仍需分别恢复 fast 新封包、市场真实非空数据与独立采集器证据。恢复销售后先确认官方实际状态和完整非空赛程/赔率，再核对赛果、0/2 来源独立性与 freshness，最后开展原先要求的持续验收；不承诺恢复销售时 567 自动消失。
5. 本轮验收完成的是“真实根因、本地修复及真实封包重放”，不是“线上已修复/已部署/推荐资格已恢复”。
