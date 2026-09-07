# 预测捕获与重放校验：只读发布目录适配

2026-09-08，北京时间。

## 真实失败与边界

r703（包 SHA `8cdcdcace4bbb66a9911773448be9da3eae276c9b38bfa057c1dbbace8b57132`）04:24:24 开始、04:47:03 在切换前退出1。173项候选校验仅两项失败：`verifyPredictionExecutionCapture.cjs` 与 `verifyPredictionReplay.cjs`，均0项业务断言执行，错误为 mkdir `/opt/football-predict.next/outputs` 的 ENOENT。

实际候选校验服务 User=football-build、ProtectSystem=strict、PrivateTmp=yes、ReadOnlyPaths=/opt/football-predict.next。两份校验器原来在源码根目录创建 outputs，不适配只读候选目录。没有把该错误称为模型数值失败，也不将隔离环境的 EACCES 与发布现场的 ENOENT 混成同一错误码。

服务器切换前恢复健康通过，双发布标记仍r699；随后固定发布入口检查 recoveryPending=0、appPresent=1。r703不会重派发，此文修复也不在原r703签名包内。

## 修改

- 两份校验器使用系统临时目录中独立、不可预知名称的 mkdtemp 子目录，并验证真实父目录。仍保留实际513批留存、写锁竞争、独立子进程重放及全部原断言。
- 不放宽目录权限、测试门禁、正式推荐条件或源身份要求，不改计算公式、冻结方向和历史统计。
- 发布校验错误增加stderr首段，保留原尾段；部署配置检查防止测试文件回写源码 outputs。
- 临时样本是合成数据，本轮保留作验证证据，没有清理用户文件。

## Windows 与 Linux 证据

Windows Node22.22.1：采集49项（9写锁、18留存、真实513批）、重放13项通过；原99项门禁合同仍通过。

Linux Node22.22.1，04:47:14–04:47:24，独立目录 `/var/tmp/football-verifier-readonly-jHQKxNFL`：

- 非root uid1000，原版和候选各499文件；文件0444、目录0555，真实写探测均EACCES。
- 原版两份校验器都在源码 outputs 的mkdir失败；候选49/13全部通过，fixtures实际落在/tmp。
- 各自499输入文件前后SHA256不变；清空生产环境变量、仅设置依赖解析路径；nice15、512MiB堆、每项90秒超时。生产写0，无生产密钥/数据库复制。
- 比较包SHA `0d2647305beb2bdf79b8d0186bed59cba6e91b41dd2c912a4c039b76393bcd9a`；报告SHA `c078e649c6c5626275fcc3276ed5cf50ef2ab501fb3554ef01e9ae06f878bdf3`。

这证明两项校验器可在只读Linux源码树运行，不等于完整173项新候选校验、部署成功或预测准确率改善。后续仍须新签名发布及上线验收。
