# 下一交付：一次真正 UI-only 发布闭环

前置模块已经有定向运行证据，但当前没有生产 UI authorizer，不得把 fixture 的 `ok` 或 sandbox 的 `signingEligible:false` 当发布授权。下一批直接接通下面的完整流程，不再单独增加一层未接入的报告模块。

## 单次源码授权构建

沿用 `createReleaseBundle`、`deployReleaseBundle`、`football-release <SHA>`、原 RSA 公钥、全局递增序号和 `/run/lock/football-release.lock`。不增加 CLI、sudoers 权限、常驻服务或服务器私钥。

首版仍可打完整源码包：从认证原始 runtime archive 提取，只覆盖明确授权的 UI 文件，所有非 UI 字节/模式保持一致。签名准确命名为 `source-authorized-build`，绑定当前 runtime SHA、原完整 source inventory、当前 frontend state/index/累计 dist manifest、候选完整 inventory、固定策略/Node/依赖约束及既有 site/channel/序号/有效期。不是“已经预签名最终构建产物”。

`createReleaseBundle.cjs` 必须在原本的本地完整 build 之前分流，UI 源码包不先编译一次再让服务器重复编译。`releaseSigning.validateReleaseManifestV3()` 与固定 wrapper 的 inline validator 同时严格校验 releaseKind/UI 授权对象；非法 UI 请求拒绝，不能降级执行 full。

wrapper 在验签/压缩包检查之后、调用候选 full shell 之前，将 UI 请求交给独立 bootstrap 的固定 root authorizer。不得加载候选携带的同名政策。授权成功后、首次构建前消耗同一全局序号；失败不退号。

## 固定 authorizer 连接

1. 核对实际完整发布双 marker、recovery 空闲、当前 frontend state/index。按准确 full SHA 调用 `releaseSourceBaseline.verifyRetained()`，重新认证原签名/原包，不选“最新基线”或从 APP 倒推。
2. 对认证 baseline/candidate 完整库存按 UI 白名单比较，并调用 `frontendRuntimeBoundary.compareFrontendRuntimeBoundary()`；核对真实运行时 units/drop-ins、启动命令、环境摘要、Node/外部程序与依赖闭包。环境只记摘要、不公开值。
3. 在固定 root 私有 stage 放准确源码/完整构建依赖、空 dist，调用一次 `runSandboxedFrontendBuild()`；读取 root 完整记录，逐项对齐本次授权、输入/依赖、策略/runtime及产物哈希。
4. 将实际构建与最终 overlay 哈希写入 root 持久授权记录，再调用文件事务核心；源码授权与产物承诺关系必须可核验。

现有 `classifyReleaseChanges()` 的旧式双 buildBinding 合同始终 full；不得伪造 binding 来绕过。最小新合同应明确采用“已接受完整发布的认证 baseline artifact + 本次真实 sandbox candidate”，重用库存/白名单/运行闭包，不暗改旧分类器的成功含义。若仍采用旧双构建合同，首次 full 必须额外生成真实 baseline binding。

## 原子事务与断电恢复

复用 `frontendOverlayTransaction` 的已验证算法，但生产不开放 fixture hooks。staging 应放在 `/opt/.football-frontend-transactions/<id>/` 之类 root 0700、dist 外且 **st_dev 与 dist 相同** 的位置；不可假设 `/var/lib` 到 `/opt` 的 rename/link 不会 EXDEV。

切换前持久化 staged index 的 inode/dev/SHA/bytes、backup 身份、准确 assets 和授权记录。现有纯 fixture 仅在 rename 后获取内存身份，尚不足以处理断电窗口。

复用 `/var/lib/football-release/recovery/current` 和既有 `--recover`，在 full v3 恢复解析之前区分 UI kind/version：

- 未切 index：核对 staging/已装 assets，保留原 index，结束失败事务。
- 已切、尚无持久 acceptance：仅当当前 index 仍匹配本事务 inode/SHA 时回滚。
- 已有 acceptance intent：核验 index/资产/双身份及只读验收后完成 roll-forward。
- 外部 index、新 inode、未知成员/缺身份：保留 pending，不覆盖、不猜测。

临时 hardlink alias 只能在准确 inode/SHA/链接关系证明后移除；旧/新公开资产都保留。超出累计文件/字节上限则拒绝 UI，不自动垃圾清理。UI 恢复绝不能进入 full 的停服务/数据库/模型恢复分支。

## 双身份和验收

UI 保持 APP 的 `.release-bundle-sha256`、`.release-live-complete` 不变。新增 root 控制的 `/var/lib/football-release/frontend-state.json`，记录 runtime full SHA/sequence、frontend request SHA/sequence、index/累计 dist/acceptance 哈希。敏感原签名、完整 inventory 和环境信息仍私有。

首次 full 加入 health 双身份读取，处理现有 health 5 秒缓存，不能把旧缓存当新 UI 身份。同步更新 `releaseProgress.cjs`、`queueServerRelease.cjs`、`deployReleaseBundle.cjs`、`checkReleaseStatus.cjs`，不能继续要求两个 full marker 等于 UI 请求 SHA。

只读验收 `/`、准确新旧 assets、health 和既有未授权保护路径，保持真实服务/数据源/worker 状态检查。`recommendationReliable=false` 不自动等于 UI 部署失败，不运行会自动修复的 runtime 命令。文件切换后仍保持事务未接受，验收成功再持久 acceptance，失败按 CAS 回滚。

## 一次 full 与独立 bootstrap 的分工

首次真实 UI-only 前需要一次 normal full：运行新的同 FileHandle 静态响应、health 双身份、具有原始签名 source inventory 的包，并初始化 frontend/运行时基线。旧 r711 不能补造 inventory。

fixed wrapper/authorizer/recovery/完整模块与可信 TypeScript parser、私有目录、准确离线构建依赖可独立 bootstrap，不重启应用；继续持同一发布锁并拒绝 pending recovery。现有 full shell只轮换 recovery helper，不自动更新外层 wrapper，不能把“合并+full”当独立 bootstrap 已完成。

交付以一次真实 UI-only 变更为准：同入口/序号/锁、只构建一次、index 切换、旧资产可读、双身份正确、失败/断电可恢复；不以任意局部毫秒测试替代线上整轮提速。
