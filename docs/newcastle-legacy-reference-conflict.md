# 旧参考方向冲突：纽卡斯尔 2041270 的进一步核验

2026-09-07，北京时间 23:06–23:19。只读历史核验与页面诊断优化；没有修改生产历史方向、比分、命中结果或发布队列。

## 新证据

旧 Git 提交 `674b04ac65a53eaf87267f579432ef9612a06c40`（2026-09-05T11:27:15Z）中，该场 `predictions.BEST` 是 HAD 平局 X、cold-start-reference；同一个对象的 `predictionMeta.immutableAnalysisReferenceDecision` 却是 HAD 主胜 1，赔率 2.03，decisionAt=2026-09-04T03:41:46.880Z。

该独立 500 网参考的内容哈希是 `0ca8f7f3b89485fc2b6851ae3800a7daf100eef2280f232c5bdb8ad825b8daa2`。核对当时与当前的 immutableAnalysisReferenceDecision/externalOddsAnalysisReference 源码（仅归一化行尾）完全一致，实际纯验证器检查通过。

截止后提交 `48af5b9cbfa70746de88cf98be4af4d33bd361d7`（11:57:05Z）仍保留 BEST 平局，但 archive 为主胜，签名字段直接引用上述 500 网参考哈希。这明确连接了该份 Git 归档的主胜与另一条旧参考记录，而不是从 2-2 赛果推断方向。

使用当前真实 `selectOnSaleAnalysisReference`、`canonicalArchiveBestPrediction`、`buildArchivedPreMatchPrediction` 对该保留对象做隔离回放：赛前选择 X，归档选择 1，引用相同哈希。归档回放显式把副本设为 LIVE、快照 Map 为空；这两个条件是反事实实验，不冒充当时真实执行。原输入逐字节序列化前后相同。这些函数在 UI 1cbf457 和 r702 源 6f86e44 之间未变化。

记录：UI `outputs/newcastle-direction-lineage-1788793759568.json`，文件 SHA256 `851c4b1099f7b689968eb83f3570a5f8425d86df135c4ba5ddcab8af55c8f58f`。

## 超出原 200 条 API 页限的核验

2026-09-07T15:09:50.430Z，以原生 SQLite readOnly + query_only + 单次读事务查询生产库，只限定 `source_match_id=2041270`，最多允许 2000 条。当前保留 209 条，全部读取，内容摘要 `8c85dd23649e348c3c7135ff631eb3130db8ecb56f90ce5161662b17f9f90a5f`；独立 publicReferenceHash 为 0 条。

分组：baseline 无 selectedCandidateKey 65 条、baseline 平局 15 条、baseline 主胜 98 条；mid 主胜 23、late 主胜 4、final 主胜 3；locked 平局 1。

首条 2026-09-03T11:46:12.455Z；最后 locked 2026-09-05T11:39:02.947Z（截止后），内部 decisionAt=2026-09-04T02:02:04.943Z。当前保留记录的完整扫描不等于过去从未删除记录，也不是原网页响应证明。

## 本次页面改动

新增 `hasUnboundLegacyReferenceConflict`，只识别同事件的旧 500 网 HAD 参考声明与原 BEST/reference/HAD 声明方向不同、且没有独立 publicReferenceDecision 的情形。在共享 RecommendationEvidenceFacts 中明确显示“旧参考记录不一致 · 公开方向待核验”，覆盖赛程、赛前分析、详情三处。

这是声明冲突诊断，不验证或伪造签名，不选择哪条是原公开方向，不改模型/推荐/归档/结算/样本。已有独立公开记录时不把私有候选差异当冲突；HAD/HHAD、错赛事和重赛时间不混比。不能从未出现该提示推断历史无争议；已经丢失另一条声明的记录，需要单独历史核验。

本次没有通过声明任何一条“正确”来修复原事件，也没有给未知历史补公开记录。真实故障的一条代码路径已复现，但当次线上部署版本与独立受保护响应仍未确认，因此原事件的公开方向裁定继续待证。

## 验证和发布边界

- 14 项真实 TS 判定/TSX 渲染检查通过，包含隔离事件/玩法、已冻结公开记录保护、双语文案、输入不变和不输出原始私有内容。
- 真实历史 674b04 对象被新诊断识别，输入不变。
- 62 项数据采用回归、28 项发布校验器合同、定向 ESLint、TypeScript/Vite build 通过。
- 2026-09-07T15:18:26.200Z 实际 dist 的全应用 72 项浏览器检查通过，390/768/1440 三个尺寸、三处页面可见冲突提示，脚本错误与意外请求为零。手机/桌面提示截图已目检。使用合成 API，不当成生产验收。
- 初次浏览器样例错误地尝试删除此前已缓存的同事件独立公开记录；页面保留该记录，未出现“无独立记录”提示。样例改用另一场旧事件，不修改应用的冻结记录缓存保护。
- 新检查加入生产就绪门禁，源码与验证器加入两处包必要文件检查。
- 此补丁晚于 r702 签名，不在 r702 包内。保持已排定 r702 唯一 SHA/PID，不为该提示重复启动发布。整个 Q1–Q5 未完成。
