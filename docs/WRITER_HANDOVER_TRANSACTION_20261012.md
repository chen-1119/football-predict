# 独立采集与推荐任务的持久交接顺序

`services/release/writerHandoverTransaction.cjs` 实现交接的持久状态机，提供给后续独立安装的控制器。它没有生产 CLI，不签发许可，不包含数据库写入适配器，也不能启动生产采集任务。

原 `FOOTBALL_SERVICE_LAYOUT=separated-v1` 标志只描述布局，不能证明原 writer 已停止。现在任务 CLI 除 `--plan` 外一律退出75；默认 `runTask` 也拒绝真实 spawn。原 r844 和已安装只读 API 都未修改。生命周期测试可注入模拟 spawn，但这不是生产启用入口。

交接顺序如下：

1. 已安装控制器验证独立签名、固定源码、原 APP、发布锁、数据库/schema和新旧 writer 身份，最长900秒双时钟。
2. 在任何停机前 create-only、fsync 保存原 owner、候选、原 selector hash、签名请求和阶段。
3. 停止旧 owner，实际证明 unit/PID/Job/cgroup 和全部相应数据库消费者已清空。
4. 数据库 fence 的事务 COMMIT、真实回执以及第二次读取都一致，才允许启动候选。
5. 检查候选健康、冻结方向/SP/比分/ACK连续性和原环境后，CAS 选择新 owner，再持久记录 accepted。

任何 COMMIT结果不明保留 `commit-unknown`，不自动启动候选或重试同一写入。恢复先读取真实 fence；未知或其他 owner 仍阻断。候选停机或消费者清空不能证实时，不开始旧 writer。确认后使用更高 epoch 恢复原代码，不能复用旧 fencing token。恢复写本身发生未知 COMMIT，也必须先读取。

已accepted后仅回执/开机设置失败，恢复完成其交付，不重启候选或回写业务数据。原 owner 和请求绑定字段、源版本、两个 fence回执均按持久原件核对。

## 尚需实现

- 独立 root writer控制器及域隔离签名；所有真实现场观察和消费者清空证明。
- PostgreSQL fence存储和事务级验证，以及所有写入路径接入；原 writer也要按正常新版本交付合同处理。
- official所有来源/后处理拆分，准确资源冲突组，启动及回退的实际Linux故障测试。

现有读API控制器仍只接受 read-api，writer组件依旧 `WRITER_HANDOVER_UNIMPLEMENTED`。本地状态机测试不证明上述SQL fence或生产交接完成。本次没有启动第二collector/publisher、没有迁移、没有预测写入、没有旧同步恢复。
