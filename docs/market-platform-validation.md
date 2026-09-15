# 市场采集发布验证（2026-09-15）

## 本地与真实数据库补验

- 完整 `npm.cmd run build` 通过（项目实际 React / TypeScript / Vite 依赖）。
- `node scripts/verifyMarketPlatform.cjs`：52 项通过。
- `node scripts/verifyMatchMarketOddsPresentation.cjs`：19 项通过，保留冻结推荐 SP 与当前报价隔离检查。
- `verifyDisplayRecommendationBindingIntegrity`、`verifyExternalOddsAnalysisReference`、`verifyMarketSourceProvenance` 通过。
- 完整应用在 320、390、768、1024、1440px 通过报价数值、键盘展开、详情导航及横向溢出检查。
- `scripts/verifyMarketPostgres.cjs` 在 PostgreSQL 16、`football` 运行角色下通过全部迁移、真实写入、A-B-A、重复观察、回滚、跨进程锁、重启冷却、请求中止、连接中断和空档保留检查。只接受 `football_market_test_*` 测试库，验证后删除临时库，不复制生产比赛或推荐数据。

## 本次补齐的运行连接

- 新采集器是生产 500 盘口页面唯一的 HTTP 请求入口。原 `sync:500` 在 PostgreSQL 模式下读取 `market_latest`，复用原发布流程的事件映射与资料合并；无数据库模式保留原本地采集入口。
- 快照包含原来源映射键。HAD / HHAD 分别保留采集时间，旧开赛时间的盘口不补入新事件；读取缓存不会把报价时间刷新为现在。
- 默认使用源站公开链接的混合玩法页面 `?playid=312&g=2`。验收时该页面 HTTP 200，明确显示“暂无赛事信息”。这证明网页可访问，**不能证明本轮已取得新行情**。
- 明确的空档页面记为 `completed` / `sourceState=no-events`，约 15 分钟后再检查，保留已有观察。无法识别的空页仍报错；403 / 405 / 429 仍进入持久退避。
- 新特征仍为 `predictionEligible=false`，未自动写入正式模型；独立的行情投影与 source-health 展示仍是后续工作。

## 网页端原始验证记录（以下为发布前历史记录）

## 已执行

- `node scripts/verifyMarketPlatform.cjs`：49 项测试，49 通过，0 失败。
- `marketQuotePolicy.ts`：TypeScript strict 单文件类型检查通过。
- 改动的 TypeScript/TSX 文件：转译及语法诊断通过。
- 隔离组件浏览器预览：320、390、768、1024、1440px 五种视口，无文档级横向溢出。
- 原生 HHAD 展开与详情按钮回调检查通过；预览中无 pageerror。

## 测试内容

原子来源选择、无效赔率、整数让球线、HAD/HHAD 隔离、未来时间、显式 as-of、事件冲突、已完成运行重放、A-B-A 路径、乱序观察、请求前锁、持久退避、Retry-After、请求总时限、响应大小、截断响应、特征分段、未来 last_seen 信息泄漏与事务失败路径。

## 不能由这些测试证明的内容

数据库测试使用可控 client double，验证调用顺序和事务边界，**没有连接真实 PostgreSQL**。纯测试通过不能证明迁移权限、真实并发事务、索引成本或线上吞吐。

当前执行环境不能直接下载该仓库依赖，因此没有执行完整 `npm ci` / `npm run build`。隔离 UI 预览使用可用的本地 React UMD、真实改动组件和明确标注的测试数据，不是项目 React 19/Vite 全量构建，不是生产网站截图，也不是实际比赛预测。

没有安装或启动生产 systemd 服务，没有写入生产数据库，没有调整生产凭据，没有合并 main。代码进入开发分支不等于已经上线。

## 合并前仍需执行

1. 安装锁定依赖后执行完整构建、仓库已有前端/赔率/冻结归档回归检查。
2. 在临时 PostgreSQL 测试库应用现有 migration，以运行角色验证 SELECT/INSERT/UPDATE 权限。
3. 并发启动两个采集实例，确认源站请求被单源锁串行化。
4. 验证 SIGTERM、数据库连接中断、进程重启和源站 403/429 冷却。
5. 使用可访问、允许采集的真实数据源做单次采集和连续运行验收，核对页面值与入库值。
6. 通过既有签名发布流程上线，不绕过 publication / generation 校验。
