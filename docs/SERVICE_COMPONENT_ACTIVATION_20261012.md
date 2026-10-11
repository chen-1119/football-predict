# 第一版组件签名和独立切换合同

在首版候选基础上增加组件外部签名，复用现有 RSA 发布密钥，但使用独立签名域。签名绑定实际 archive bytes/hash、源码 HEAD、完整 manifest 和 inventory hash、API/schema 合同、入口及平台。组件签名不消耗旧全量发布序号，不修改已打包内容，也不构成生产启用许可。

```powershell
node scripts/signServiceArtifact.cjs C:/absolute/read-api.tgz
node scripts/signServiceArtifact.cjs --verify C:/absolute/read-api.tgz
```

`readOnlyActivationPlan` 只为 read-api/web 设计并行安装与回退。它检查实际签名与包身份、Linux 精确包运行证明、schema/API 兼容、原发布锁/双标记/无恢复、同生产数据库只读、60 秒新观测、900 秒双时钟、实际容量预算和独立 loopback 端口。collector/publisher 在 durable 单一 writer 交接完成前不能进入这个计划。计划返回 `executableControllerImplemented:false / installed:false`，不伪称控制器已完成或组件已安装。

## 目标 Linux 只读运行检查

03:16 北京时间在生产原 r844 双标记、正常 fd9 和源码 pin 下，将候选 API 模块编译到内存，临时 loopback HTTP 使用真实 PostgreSQL，只读事务和只读会话。health/fixtures/detail 为 200，越界 limit 为 400，失效账号为 401，POST 为 405，旧 generation cursor 为 409。探测结束关闭 HTTP 和 pool；原 API/worker PID 未变。没有安装组件、启动 Next、写库或启用第二 writer。

首次运行发现 current 场次使用 `fivehundred_` 原 ID，而候选详情路由只接收 `sporttery_`，导致列表链接 404。现在两类原 ID 都按数据库 exact match_id 查询；不得仅按数字后缀授予 alias，返回 ID 不一致直接拒绝。SSR 详情读取采用同一限制和响应身份检查。原失败回执保留。

实际读取的 committed generation 仍来自 10/11 00:27 的源批次，页面明确过期。这次 Linux API 运行检查不证明旧采集故障恢复、不证明新推荐生成、不证明 Next Linux/登录 GUI 通过。Linux 前端构建、完整组件运行及正常 executable controller 仍需完成。
