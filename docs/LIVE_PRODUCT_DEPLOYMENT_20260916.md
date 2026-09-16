# 实时页面 V2 发布补验

基于网页端 PR #19。保留新版导航、实时通道/场次/活动时间、深蓝视觉和移动布局。

## 修正

- 相同来源比赛编号和事件时间不足以证明任意队名相同。保留已核验的简称映射，拒绝未知球队、主客颠倒、真实 provider ID 和事件时间冲突。原全局生命周期校验不变。
- 只读诊断读取 `data-generations/current.json` 正确路径；PostgreSQL 模式在同一只读事务中读取实际 publication identity 和 current rows，避免把待发布工作文件当作线上数据。
- Worker unit 默认关闭 SQLite 导出，与线上 PostgreSQL-only 模式一致。
- `configure-postgres-logging.sh` 将慢查询参数限制为 256 字节，保留耗时/错误日志，改为每日压缩轮转。执行前备份配置，reload 不重启数据库。

## 2026-09-16 现场故障

今早失败为磁盘 `ENOSPC`。清理前系统盘可用约 600 MiB；已核对无进程使用后移除 16 个过期测试副本、23 个重复发布解包目录和 10 个超过 48 小时的中断 staging 目录。清单保存于服务器 `/var/lib/football-release/*cleanup-20260916.json`。当前/上一代 publication、数据库、冻结推荐和备份不在清理范围。

PostgreSQL 默认无限长绑定参数把整份 JSON 写入慢日志，两个未压缩日志累计约 28 GB。旧日志压缩保留并限制后续增长。

09:07 北京时间自动 Worker 完成完整周期，`lastCycleOk=true`、`lastError=null`。只读诊断确认今日 17 场、PostgreSQL publication 与 generation 一致，历史无身份冲突。

## 验证

- 完整 TypeScript / Vite build 和 public-distribution 数据验证通过。
- 球队身份 8 项、快赛果 reconciliation 25 项、盘口展示 19 项、冻结推荐绑定 42 项通过。
- 完整应用使用明确的本地验收数据，在 320/390/768/1024/1440px 验证报价、键盘展开、详情导航、无横向溢出；该项不是生产取数证明。
- 修改后的诊断脚本以服务器实际运行角色、现有 PostgreSQL 连接只读运行通过。
- 模型继续保持参考/影子。PR #18 的旧版 Worker wrapper 和额外组合面板不混入本次 V2。

本次发布仅传变更源码和已构建前端产物，签名校验及线上基线核对后原子切换首页入口，不重复导出或传输历史比赛数据。
