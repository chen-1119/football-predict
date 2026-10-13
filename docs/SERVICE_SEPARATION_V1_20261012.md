# 独立服务第一版

2026-10-13 更新：本候选已合并实际上线 r853 的同步修复。最新执行顺序、未完成范围和验收条件见 [继续优化工作方案](OPTIMIZATION_WORK_PLAN_20261013.md)；下文的 r844 运行状态是首版历史记录，不能当作当前线上状态。

用户授权时间：2026-10-12 北京时间约 00:45；第一版检查安排在约 08:48。

## 已实现的代码

- 独立 `services/read-api/server.cjs`：仅 GET、仅 loopback，公共赛程 DTO 与受保护推荐分开；数据库连接、查询时长、返回体和并发有界。
- 元信息和场次在同一个 PostgreSQL `REPEATABLE READ READ ONLY` 事务读取。API 不读取 raw current/previous 文件，不运行迁移、采集或模型计算。分页 cursor 绑定 committed generation 与日期，版本变化返回 409，前端重新翻页。
- 推荐读取沿用现有 `recommendationAuthority` 的原签名、冻结和第二事务 ACK 回放。账号优先于共享访问码；失效账号不会经另一访问码放行。历史内容不重发、不重新计算方向和 SP。
- `apps/web` 为独立 Next.js 应用：公开赛程、比赛详情在服务器渲染；受保护的单场、二串和三串复用原展示组件。公开页面不含私有推荐、参数或账号内容。
- API 临时失败后，SSR 公共页最多保留 24 小时内同一查询曾成功读取的真实快照，并明确过期；不同日期不串用。私有内容不共用缓存，需每次重新鉴权。
- 独立 `combo-archive` 任务保存真实 committed center 已存在的二串、三串，不重新选方向。同一原组合只追加一次；每个竞彩日最多 64 个版本、单件最多 512KiB，读取须重新核对同一组冻结记录、原 SP、乘积和全部截止时钟。仅用于历史显示，不进入结算；历史未保存的组合不追溯生成。任务尚未在生产启用。
- `services/tasks` 给 official、market、team、recommendation、settlement 各提供独立入口。team 有失败间隔与 COMMIT_UNKNOWN 停止码 75；未知提交先读取，不自动盲重试。
- `deploy/services-v1` 提供独立 unit 与共享数据路径示例。`planServiceRelease` / `buildServiceArtifact` 按组件打包，无数据库副本，无 schema migration，后端包不带前端构建。

## 运行

使用固定 Node 22。读 API 需要当前 PostgreSQL连接、既有账号 origin 与会话密钥；密钥仅服务器持有。

```powershell
node services/read-api/server.cjs
npm --prefix apps/web ci
npm --prefix apps/web run build
node scripts/buildSeparatedWeb.cjs
npm --prefix apps/web start
node services/tasks/run.cjs team --plan
node scripts/planServiceRelease.cjs read-api
node scripts/buildServiceArtifact.cjs read-api C:/absolute/read-api.tgz
```

Next 页面从 `FOOTBALL_READ_API_ORIGIN` 读取 API，默认 loopback 8790；自身默认 loopback 3100。SSR 服务器不是直接连数据库的浏览器。现有 SPA 和 `/api/v1` 保留，首版候选只增加独立入口。

## 生产切换范围

组件打包是可审查成果，`signed:false / activationEligible:false` 明确表示尚未形成生产切换许可。新组件签名校验、schema/API兼容性、单一 writer 交接、服务路径及回退需接入正常发布控制器后才可安装。不要复制 unit 直接启用两个 official/publisher。

Web 包要求固定 commit、构建前后源文件一致及完整产物 hash 回放。Windows 构建平台在回执里记录为 win32，不能将它当作 Linux 运行已验；生产 Web 必须在目标 Linux 平台重建/运行核验。后端候选是源码包，运行依赖需按固定 lockfile 安装并核 closure。

现网 r844；之前 r847 在暂停服务前失败。此分支继承 PR159 的 committed-generation reader 修复，但本地编译/采样不证明生产同步恢复。新读 API 的数据库读取不依赖 raw pointer，旧 API/worker 尚需修复交付合同及正常签名部署。

## 首次真实数据核验

北京时间 10/12 01:06，用候选读 repository 在原 r844 同双标记、固定 SSH pin 和正常发布锁下做了生产 PG 只读采样。读事务只读取同一 production `football` / OID 28598409，未安装候选服务、未改数据或重启进程。读到 63 条多日 current 赛程和 10/11 原 27 场人工历史，63 不是今天在售场次总数。该时刻 PG 批次较旧，页面明确过期。

在这个新日读回里，现有旧投影未保存 10/11 二串/三串，故为空。第一版新增的组合存档用两个真实只读采样进行本地演示：10/11 12:05 的原组合与 10/12 01:06 的原单场逐项绑定一致，源页面离线 React 渲染为 27 单场、3 二串、3 三串且不显示信心标签。此处组合存档未写生产，不冒称线上已恢复。

Next HTTP 本地启动被自动审批拒绝，未提供细化原因；浏览器直接打开本地 HTML 又因只允许 HTTP/HTTPS 被拒绝。未使用其他浏览器方式绕过该限制。本次构建和离线页面渲染已验证，Next HTTP 浏览器验收尚未完成；静态 HTML 可在本地作为审查附件打开。

## 第一版与后续

首版复用 Node 算法和冻结合同，未改写为 Go/Java。Next 的公开 SSR 入口已实现；注册登录、球队模型详情和全部旧路由继续在原站。official 入口保留原 worker 必要校验和部分后处理，尚未拆完所有外部源。第二阶段补签名组件 activate、全部来源独立调度、模型卡完整迁移、旧 SPA 逐路由替换，再评估后端语言迁移。

验收应分别记录：代码/构建、控制环境 HTTP/鉴权/故障隔离、真实 PG 只读采样、浏览器、生产切换、自然成功周期。任何一项成功都不能代替后项。
