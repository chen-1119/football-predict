# 发布状态与本地验收产物

2026-09-08：修复 `checkReleaseStatus.cjs` 把根目录 `outputs/` 的新验收报告当作发布后源码变化的问题。打包器已有明确的根目录 `outputs/` 排除规则；此次只让状态检查与这一规则一致。

仅跳过根目录的该目录，不把 `outputs` 加入任意层级目录名忽略集合。`src/outputs/`、`server/outputs/`、`outputs-next/` 及普通源码仍可使候选过期。签名、包哈希、双发布标记、恢复状态、主机密钥和候选连续性检查不变。此修复减少误报，不代表构建、回填、数据库完整性检查或部署总耗时已经缩短。

## 验证

新增四组真实临时文件扫描回归，先在旧实现上复现报告文件被错误列入的失败，再修复为通过。不是只匹配源码字符串；测试取实际扫描器代码执行，且不触发 SSH/HTTP 状态入口。

- Windows Node 22：`verify:release-status-transport` 11 组通过；主机密钥固定 7 组、部署配置检查通过，变更文件 ESLint / `git diff --check` 通过。
- Linux Node 22：07:33:43，在 root 持有、ubuntu 只读的三文件源码树运行同一 11 组全部通过；写探测 EACCES，前后文件哈希相同；生产写入 0、上游请求 0。
- Linux 证据目录：`/var/tmp/football-status-freshness-vq4u8Y`；本地报告 `outputs/release-status-freshness-linux-1788824023493.json`，SHA-256 `098440dde4b2ade6d0c1e2fd13cee83d65b8dded90d3d05bc5fbcd455f240b18`。

Linux 外围传输脚本初次有模板转义语法错误，发生在执行前；保留失败输出，修正外围脚本后才得到上述成功证据。项目代码和断言未因此降级。临时测试文件清理限定在新建测试目录，原工作树和生产数据不清理。

这批修复不包含在已签名的 r704 中；不修改、重签或重放 r704。r704 自带旧状态检查器仍可能把后生成的本地验收文件列为 workspace freshness 告警，必须如实区分该告警与远程上线终态，不能据此重发已运行的包。
