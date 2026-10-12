# 第一版组件签名和独立切换合同

在首版候选基础上增加组件外部签名，复用现有 RSA 发布密钥，但使用独立签名域。签名绑定实际 archive bytes/hash、源码 HEAD、完整 manifest 和 inventory hash、API/schema 合同、入口及平台。组件签名不消耗旧全量发布序号，不修改已打包内容，也不构成生产启用许可。

```powershell
node scripts/signServiceArtifact.cjs C:/absolute/read-api.tgz
node scripts/signServiceArtifact.cjs --verify C:/absolute/read-api.tgz
```

`readOnlyActivationPlan` 检查实际签名与包身份、Linux 精确包运行证明、schema/API 兼容、原发布锁/双标记/无恢复、同生产数据库只读、60 秒新观测、900 秒双时钟、实际容量预算和独立 loopback 端口。现在 read-api 有可执行控制器源码；web 尚未接入控制器。`installed:false` 仍是计划状态，生产安装必须另有真实回执。collector/publisher 在 durable 单一 writer 交接完成前不能进入这个计划。

## 读 API 控制器

`componentController.cjs` 只能在独立 root 安装目录和真实继承 fd9 的全局发布锁下运行。控制器先核对自身五个模块的完整安装基线，再加载事务模块。`installServiceComponentController.cjs` 使用独立 RSA 签名域、真实 Git HEAD、五文件原始字节、当前双完成标记和原服务 PID 创建控制器安装请求；bootstrap 只安装控制器代码和目录，不启动组件、不改 APP、不访问数据库、不运行 npm。安装原件、失败和部分安装均保留，不覆盖未知旧安装。

组件 artifact 的签名只证明包身份。实际 activate/rollback 还需 `signComponentActivation.cjs` 的单独签名，绑定 action、attemptId、旧 selector、当前 APP/PID、controller hash、精确 runtime proof、源 HEAD、schema、DB OID、端口和最长900秒有效期。旧授权不能续期、改包或重放。没有 writer 或 Next 启动授权。

准备阶段使用 Linux `buildServiceArtifact.cjs read-api ABSOLUTE_OUTPUT --runtime` 打包真实 lock 安装的依赖，不把旧借用依赖的 probe 当新 runtime image 证明。控制器只接受 `artifactPlatform=linux / runtimeDependenciesInstalled=true` 的实际完整包；它不在 root 下安装 npm 依赖。隔离 image 普通文件全清单/hash检查后 create-only 复制到以 archive SHA 命名的目录。没有数据库复制或迁移。

事务在启动前 fsync 保存意图，建立独立 `football-read-api-component-<attemptId>.service`，使用 football 用户、只读默认连接及 loopback8790/8791。连续健康检查核实真实数据库 OID 和 transaction_read_only；同时核对监听 socket 确由该 unit 的 MainPID 持有，不能把占用端口的其他服务误当候选。列表、非法 limit、未鉴权请求分别验证200/400/401。通过后单文件原子选择 image；当前选择才启用开机启动，旧组件进程保留以便直接回退，原 API/worker 不重启。

中途失败只停止新组件并恢复之前 selector。停止、cgroup清空或回退不能证明时保留 pending，阻止第二次安装。签名 rollback 只选择其真实原件记录中的上一组件，通过健康检查后再接受，不覆盖方向/SP/比分/ACK或结算。已接受后的回执/开机设置中断，由正常 recover 补完；recover 不把过期授权作为新的 activate。显式回退失败不会停止原健康组件。

控制器的 selector 是独立读 API 选择记录，尚未接入生产网站反向代理；控制器源码或安装成功不代表公众网站已切换。有效登录正例、Next HTTP及新站GUI仍需独立验收。

## 目标 Linux 只读运行检查

03:16 北京时间在生产原 r844 双标记、正常 fd9 和源码 pin 下，将候选 API 模块编译到内存，临时 loopback HTTP 使用真实 PostgreSQL，只读事务和只读会话。health/fixtures/detail 为 200，越界 limit 为 400，失效账号为 401，POST 为 405，旧 generation cursor 为 409。探测结束关闭 HTTP 和 pool；原 API/worker PID 未变。没有安装组件、启动 Next、写库或启用第二 writer。

首次运行发现 current 场次使用 `fivehundred_` 原 ID，而候选详情路由只接收 `sporttery_`，导致列表链接 404。现在两类原 ID 都按数据库 exact match_id 查询；不得仅按数字后缀授予 alias，返回 ID 不一致直接拒绝。SSR 详情读取采用同一限制和响应身份检查。原失败回执保留。

首次读取的 committed generation 来自10/11 00:27 UTC源批次，明确过期。后续06:35记录已经完成真实 Linux Next 构建与候选依赖 API 运行；这不证明旧采集故障恢复、新推荐生成、Next HTTP或登录 GUI通过。上述控制器新增源码尚需真实目标安装与 runtime image验证，不能套用旧包运行回执。
