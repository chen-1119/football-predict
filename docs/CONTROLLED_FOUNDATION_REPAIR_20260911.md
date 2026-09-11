# 2026-09-11 受控基础修复

本工作区从 `baf275c2c48325a072dc0a4bc32ea10c5b723d88` 隔离建立；没有修改主工作区中的冲突或业务数据。

## 修复边界

该通道把已审计的基础修复差异应用于线上 r718 的原始代码，仅改变 12 个读取/写入相关文件。`createFoundationRepair.cjs --check-sources` 从线上原始文件重建 `baf275c2^..baf275c2` 差异，并核对完整结果。新增读取器允许 Windows 检出产生的 CRLF/LF 差异；实际投递字节仍有独立 SHA256 与签名。

修复不等于整版发布。原始运行基线仍为 r718；修复通过独立的 `.foundation-repair.json` 记录，普通发布版本号不会被占用。未关闭 SQLite 导出，未改变模型门槛，也未把失败发布包作为已接受版本。

## 本次查明的数据层差异

- 当前已发布 generation：`g-61ad338e74e427afd4314aad03bded5f254ea572e9b81f9bc9a17097ab179fe8`，来源正式周期始于 2026-09-11 02:51:19 UTC。
- 已发布快照：530,469,288 字节，193 条推荐及 193 条有效绑定；SHA256 `5c77d551cb977cdcc63858f1cf15638bdba8200e6a67cea678ea027951eb6550`。
- mutable 原始快照：536,933,381 字节，198 条推荐及 198 条有效绑定；SHA256 `23c537461bc6d4728fb5cc53554dfaa8241ee19816a30de24e77eff71e5ba944`。
- 193 条已发布对象全部保留在 mutable 的 198 条中。多出的 5 条尚未随新的正式周期发布。
- 隔离压缩结果：342,911,560 字节，SHA256 `ca379d99e3620815ddba3315cb61ea4cfb16bf7d26faf76b45624518100530f5`。4,420 条 rows、78 条 observations、198 条 decisions、198 条 evidence 的完整对象摘要均不变。

## 通道约束

1. 使用既有固定 SSH 主机指纹和发布 RSA 公钥，签名绑定原运行 SHA、前端状态 SHA、两层快照、补丁前后字节、控制器和验证器。
2. 隔离副本在 `PrivateNetwork=yes`、生产路径只读的 systemd 单元中运行。此阶段仅改隔离目录，不调用采集源。
3. 停机前先核验两层证据。切换时占用同一个 release lock，记录原服务和定时器状态，暂停写入服务。
4. 完整复制 application、store、运行配置；逐个文件核对字节、权限、属主和链接。另做 PostgreSQL custom dump，记录 SHA256 并通过 pg_restore 清单检查。
5. 备份完成后逐文件原子替换修复代码；不手工改写生产快照、不清除 Worker 失败状态、不改正式采集证据。
6. 必须取得属于新 Worker PID 且开始于切换后的 `official-result-published` 记录。再核对冻结对象、193 条已发布对象，以及全部 198 条 mutable 原始对象均进入新发布投影。
7. 健康检查要求服务、快速赛果完整性、推荐投影一致性通过；模型仍为非正式推荐。
8. 控制器失败或中断时恢复本次替换的代码和原服务状态。数据不自动回滚，不覆盖新观察；完整备份与恢复日志保留。systemd `ExecStopPost` 提供进程退出后的恢复入口。

## 已执行验证

- 签名和范围策略：22 项，含过期、篡改、错误路径、缺失文件和模型/存储越权。
- Linux 隔离故障注入：11 项，含部分代码替换、重复恢复、无关文件拒绝覆盖、保留新观察、已接受状态不回滚，以及 mutable 新证据必须进入正式投影。
- 精确基础差异重建：12 个文件，patch SHA256 `d469c18636bad863bb2ebf19b68b4df175a65c2b448cede55ac5ae7cf6486e05`。
- 使用服务器 Node 22.22.1 完成真实大快照隔离验证；最终准备耗时约 72 秒，峰值 RSS 约 1.23 GiB。这是完整对象读写比较的实测，不宣称常量内存。

## 执行记录

第一轮切换请求 `22f8be...` 因把已发布证据误当作 198 条而在代码替换之前拒绝；服务已自动恢复，生产代码和数据未修改。

当前最终签名包：`46a94ee2a780b3888dc59be78d35f23dfc7275e0b577695f02aa328858394a5b`。

服务器事务目录：`/var/lib/football-release/foundation-repairs/46a94ee2a780b3888dc59be78d35f23dfc7275e0b577695f02aa328858394a5b`。

状态检查：`node scripts/checkFoundationRepairRemote.cjs 46a94ee2a780b3888dc59be78d35f23dfc7275e0b577695f02aa328858394a5b`。

只有事务目录出现并验证 `accepted.json` 后，才能声称修复验收完成；仅有 `prepared.json` 或 `activated.json` 不代表完成。

## 最终结果

2026-09-11 北京时间 16:32:20，签名修复通过验收。新 Worker 的正式发布在 16:30:55 成功，完整周期在 16:31:27 成功结束。数据 generation 为 `g-669d6274ed6376e2498d7fc64f5c5f02fd25c06854ae3cac47ad2aa157770a64`；同周期 SQLite 发布身份核验通过，PostgreSQL 投影同步命令成功完成。

逐对象检查确认：635 条原始冻结推荐不变，193 条原始已发布推荐及证据保留，mutable 历史中的全部 198 条推荐及证据均进入新发布投影；新投影共 203 条推荐及有效证据。没有手工补造证据或清除失败状态。

完整应用、存储、配置备份通过逐文件核对；PostgreSQL dump 为 856,211,869 字节，摘要见 `outputs/final-repair-evidence/backed-up.json`。本次只验证了 dump 清单和摘要，未以此冒充 PostgreSQL-only 恢复/回滚演练。

重启后的第一次采集辅助请求出现 `fetch failed`。在应用已恢复公网健康后，按原流程重跑服务器直连采集，取得 206 行真实采集、10 行签名赛果、142 行快通道数据；未改状态文件。16:35:46 公网复核：`serviceOk/dataFresh/sourceHealthOk/fastResultIntegrityOk/recommendationProjectionParityOk=true`，当前签名可信采集证据为 2/2，`recoveryPending=false`，普通发布早期预检 `ok=true`。16:37:03 核验两个服务和三个原定时器均恢复 active。

Cloudflare 补充拉取脚本仍报 `fetch failed`；当前两条有效可信通道是华为云采集器和服务器直连采集器。该补充拉取问题没有伪装成成功，也没有影响本次最后一次数据健康检查。

模型风控仍为 `modelRiskStable=false`、`recommendationReliable=false`，继续保留参考/影子语义。

### 性能实测

- 数据同步：约 77 秒。
- generation 提交：约 109 秒。
- SQLite 导出 + PostgreSQL 同步：约 188 秒。
- 正式发布阶段合计：约 452 秒；完整周期约 503 秒。
- 首次服务暂停用于完整备份和核验，约 8 分钟；验收阶段另有一次短暂重启。不能把本通道称为无停机发布。

### 尚未完成

- 当前身份为 **r718 基线 + 签名修复 46a94ee2…**，前端仍为 r719；没有创建或部署新的整版发布包。
- 16:37 交接时受控通道源码尚未提交或合并，后续源码归档不改变已经执行的 capsule。已投递字节由 capsule 签名固定，不能用之后修改的本地源码替代该执行证据。
- PostgreSQL-only、关闭 SQLite、常规发布缓存优化、模型/串关/UI 改造均未在本次启用。
- 后续整版发布仍须经过正常全部门槛；早期预检通过仅表示可以准备。
- 未做失败包清理。服务器完整备份、三次隔离准备目录和恢复记录均保留。

最终证据：`outputs/final-repair-evidence/accepted.json` 与 `outputs/foundation-live-verification-1789115746530.json`。
