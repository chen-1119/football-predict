# 推荐展示与赛前采集接入

推荐列表集中展示比赛、比赛赔率、推荐方向、对应 SP、正式/参考及命中状态。采集信息和分析参数放在单场详情，公开文案隐藏来源地址。参考计算不会进入正式命中率。

从本地已开发的 0.2.0 包移入 `collectors/leisu-prematch`，保留今天/明天、赛前身份核验、有限重试与失败保留规则。新增鉴权接口 `GET /api/v1/matches/{id}/prematch-evidence`，读取 `PREMATCH_EVIDENCE_FILE`，默认 `/var/lib/football-prematch-public/latest-evidence.json`；详情页直接读取该接口。缺失、过期、访问受限、暂未公布分别展示，生产代码不读取本地预览样例。

安装器支持服务器现有 `/opt/node-v*/bin/node` 和 `--headless-only`，首次服务器取数测试无需安装远程桌面。首次安装仍默认关闭采集；实际通过访问测试后启用。专用 PostgreSQL 表与现有预测表独立，观测不会自动作为模型输入。

## 小包部署

`node scripts/deployPrematchAppUpdate.cjs` 使用既有 `RELEASE_DEPLOY_*` SSH 固定指纹和 `RELEASE_SIGNING_PRIVATE_KEY`。还需指定 `APP_UPDATE_BASE_BUNDLE`（实际线上整包 SHA），可用 `APP_UPDATE_SOURCE_BASE` 指定本次代码基线，默认 `HEAD^`。先提交、合并、构建，再执行部署。

此通道只上传已构建的 index/assets、本次前端源码、赛前资料接口和采集器运行文件。签名、有效期、线上基础包、后端源码基线及文件范围验证通过后更新。沿用线上依赖；不创建候选库、不导出 SQLite、不复制 PostgreSQL、不重启 Worker。旧的带哈希静态资源保留，避免已打开页面丢失分块。应用 HTTP 启动失败时恢复被替换的应用文件，数据库及 Worker 不回退。

结果写入线上 `.release-app-update.json`，与基础整包标记并存。HTTP 上线与正式采集验收独立记录；不能用这个应用标记宣称正式采集、来源可用性或模型门槛已通过。

验证包含采集器 128 项、推荐页 42 项、结算展示 42 项、实际页面 SSR 20 项、参考计算与集成，以及 TypeScript 和 Vite 生产构建。源码样例保留原始时间，只供可复现测试；无需本地 SQLite 或 outputs 目录即可运行参考计算测试。
