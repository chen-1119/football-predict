# UI 发布前置批验证记录（2026-09-08）

本批是源码基线、隔离构建、静态响应和文件切换的前置实现，尚未启用生产 UI-only 分流。线上仍是已验收 r711，未为这些测试重复部署。

## 一次集成与后续定向差量

- `outputs/ui-prerequisite-integration-1788862317879.json`：签名前合同 294 项、签名入口 69 项、部署配置 122 项通过；24 个受观察源码哈希前后相同。这是一次集成执行，各组有重叠，不相加宣称独立覆盖数。
- 该集成之后只做了构建兼容性和最低覆盖数量的差量：合法嵌套 npm `.bin`（17 项）、隔离环境的固定 librt、拒绝 syscall 返回 EPERM、只读挂载内的输入文件复制权限语义、空的只读 HOME。未改变网络、生产挂载、capability、可写路径或正式发布门槛。
- 最终隔离控制器 `abd0fad916050d917f8e21a91aa5b3f364296cc4daf0c17bce6cb9b513ece387`：Windows 8 项、Linux hostile 12 项和真实 Linux 构建通过；`outputs/frontend-sandbox-final-1788863999892.json`、`outputs/frontend-sandbox-linux-1788863648832.json`、`outputs/frontend-real-sandbox-linux-1788863923672.json` 保留准确身份与清理证据。旧集成报告不能冒充这些后续源码的整套重跑。
- 原包读取的异步 fd 关闭竞态已修复：36 项含 100 轮成功/坏 gzip/早期拒绝后的文件句柄哨兵。最终实际 Linux 基线模块闭包 18 项通过，`outputs/release-source-baseline-linux-1788862225628.json`；失败证据也保留。
- 同 FileHandle HTTP 响应 19 项和真实 Linux 18 个 HTTP 场景；overlay 15 项及切换前后 32 个 HTTP 请求。后者仍是独立 fixture，不能当作生产断电恢复或发布授权。

## 真实构建而非部署计时

最终 Linux 实际执行 tsc、Vite、strip，三个 unit 均退出 0 且 cgroup 清空。包含材料准备至清理 67.432 秒，控制器 61.340 秒；tsc 13.878 秒、Vite 4.398 秒、strip 0.216 秒包含各自 unit 的启停和观测。含 SSH 的本地跨度 77.342 秒。

独立扫描 63 文件、4,362,977 字节，与原 r711 dist 完全相同，treeHash `d2bab0666563188226e07d0af0e223696ee7729992d177d71363f027075953c3`。本轮依赖安装、供应商请求和生产发布均为零。原 r711 缺少签名 source inventory，不因成功复现而获得 UI-only 资格。

下一步按 `frontend-production-integration-plan.md` 接通同入口/全局序号/锁、源码授权单次构建、原子 index、只读验收、双版本身份和冷恢复。一次完整 runtime 发布加独立 bootstrap 后，再以真实 UI-only 发布测量端到端耗时；不拿 67 秒构建时间替代原 59 分 19 秒完整发布基线。
