# 全页验收与公开方向稳定性修复

2026-09-07，r694 封包后的独立补丁；本文件不是生产上线证明。

## 已复现的问题

在实际 `main.tsx`、AppProvider、路由、导航及全局样式环境，用实际公开记录发布器生成合成平局记录，随后只把接口的可变 BEST 改成主胜，保留原公开记录和哈希。修复前赛前列表显示主胜，违背公开记录。此实验确定了当前消费者的缺陷，但没有替代纽卡斯尔历史争议场次的原始档案核验。

选择器现在在截止前后都优先回放有效的公开记录：核对赛事身份、开球/记录/决策/截止时钟及完整性标记；存在但无效时拒绝回退到可变 BEST。证据时间使用原决策时钟。严格官方盘口通道只回放符合当前官方 HAD 完整性及时效要求的记录，否则隐藏，不重新选择另一方向。显式 WATCH 仍可撤回展示；正常的新公开修订及其 previousHash 血缘不被禁止。未修改发布器、历史记录或模型权重。

## UI 与统计

- 模型研究指标移至默认折叠的原生 details，保留完整统计及键盘访问。
- 正式样本只读取明确的 formalRecommendationRows；去除旧别名回退，不以其他样本填补缺失。
- 正式结算审计只读取自身 observed.settled；缺失和有效零分开显示。
- 此改变不证明生产曾借用其他样本，也不代表命中率提升。

## 验证结果

- `verify:analysis-reference-selection`：54 场景，含截止前/后、严格通道、可变方向、合法新修订、错误身份/哈希/时钟、WATCH 和明确的合成 safeguard 两分支。
- `verify:predictions-page-focus`：41/41；`verify:predictions-focus-gate-mutations`：基线加12组破坏检查全部通过。
- `verify:prediction-metric-semantics`：13组；`verify:data-adoption`：51项通过。
- `verify:full-app-evidence-browser`：真实 Chromium，390/768/1440 宽度，复盘/赛程/赛前/详情共33场景通过。公开平局保持不变，接收到的内部主胜及 DOM 公开哈希都有断言；无页面溢出、标题遮挡、指定关键文本截断、运行错误和意外外部请求。
- 同一合成赛前页在390宽度折叠高度2773px，展开4227px；已查看实际截图。该高度不是生产性能指标。
- 选择器定向 ESLint 通过。PredictionsList 的既有第955行 set-state-in-effect 检查仍失败，已在未修改 HEAD 上复现，不声称全量 lint 通过。
- 前端构建通过；方向准入65场景、公开记录完整性44检查、生产测试夹具隔离3入口通过。构建仍报告已有 worldcup-glory-hero.jpg 运行期解析警告，不将其算作本次新增修复。

浏览器测试通过 `REVIEW_QA_BASE_URL` 指向本地 Vite，默认端口5197；可用 `REVIEW_QA_PLAYWRIGHT_MODULE` 和 `REVIEW_QA_CHROMIUM_EXECUTABLE` 选择本机已安装运行时。所有 HTTP 数据均为明确隔离合成样本，不证明线上来源真实或正式推荐达到准入条件。

## 下一步

等待正在进行的 r694 发布进入终态后，再集成此补丁和此前 e1267a3 / 099fc12 的输入缺口 UI 修复，按受控发布重新验收。不能把本地构建、合成页面或 app marker 切换视为 live-complete；Q1/Q2 真实链路、历史争议、Q4/Q5 独立前瞻条件继续保留。
