# 第二批：冻结记录可信信息展示

计划：先改完整详情的证据区，在同一处查看三方向概率与本条冻结 SP、模型验证状态、服务返回的参考资格、截止与冻结版本；保留原有资料采用边界。

已实现：

- `RecommendationEvidenceFacts.tsx`：三方向概率/SP同列；完整 SP 缺失时只展示本决策已有选中方向的 SP，其他缺项为 —；非法 SP 不展示。不会读取当前赛程 SP 或旧 BEST 概率。
- 同一证据区分开显示模型验证状态与单场参考资格。参考资格直接复用服务 `selectionReferenceLabel`；没有资格字段时显示“证据待核 · 资格未提供”。不调用新资格算法，不把 reference-qualified、shadow 或研究候选提升成正式。
- 显式显示北京时间的完整年月日、截止时间、模型生成、发布时间和 SP 采集时间；展开展示 decisionId、recordHash 与原始 SP 来源。转录来源不会标成官方直连。
- 原展示契约未提供完整输入采用凭证时明确说明边界，不把伤停未知写为零、阵容写为已确认或 xG 写为已取得。原补充模型采用展示继续复用 `DataAdoptionDetails`/既有证据呈现，不改其计算与时钟。
- `MatchDetail.tsx` 的三个现有证据区传递统一 row 的 `selectionQuality`，无新请求、账号创建、权益购买或服务变更。
- 新的专用 CSS 使用现有主题文字与边框 token，三列概率平等展示，手机版验证状态堆叠，冻结版本可键盘展开。

未改首批 `PublicBrowse.tsx` / `public-browse.css`，未改推荐列表、PublishedMatchPick、services、公共 schema、采集、发布或数据库。02 新资格接口只读核对，现有 formal/reference 门槛保留原样。05 的 154 场同决策配对报告校验文件哈希后只作分析参考，不用于生成本批卡片或证明模型可发布。

已测：26 项定向测试；320/390/768/1440 宽度下12项组件浏览器检查，包括长版本号折行、无横向溢出、Enter/Space展开收起；60处文字计算对比度通过。截图 `before-{390,1440}.png`、`after-{390,1440}.png` 和 `after-{390,1440}-version-open.png` 均为组件隔离验收。已人工查看390宽度的冻结版本展开截图。

证据限制：当前 Chrome `/best` 是未登录公开预览，不表示无推荐。本批截图使用仓库保留的“2026-09-22只读生产冻结回执”，`source-evidence.json`记录来源声明、时间、文件哈希和真实决策ID；不是今日实时数据，也没有重新验远端签名。它仅用于组件呈现复现，不能证明线上效果或当前登录后的整页健康。新四项边界测试中改造赔率和资格的样本明确属于隔离合成场景，不是真实比赛预测。

已上线：无。首批进入00集成与本批候选代码是两个独立状态。本批等待总控集成；完整权益页面仍需获授权有效会话做整页验收。无需共享文件补丁。

复现命令（在03工程内）：

```
node --test tests/published-evidence-snapshot.test.cjs tests/publication-evidence-labels.test.cjs tests/recommendation-detail-consistency.test.cjs tests/recommendation-match-parity.test.cjs
npm run build
npm run lint
node outputs/ui-trust-detail-20261002/verify-source.cjs
node outputs/ui-trust-detail-20261002/render-preview.cjs after
node outputs/ui-trust-detail-20261002/serve-preview.cjs
node outputs/ui-trust-detail-20261002/verify-browser.cjs
node outputs/ui-trust-detail-20261002/verify-contrast.cjs
```

`before.html`已保存原组件渲染，不应在候选代码上重生成before。浏览器验证使用现有本机Playwright/Chrome，无额外安装或付费API。
