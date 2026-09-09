# 可复用 UI 发布准备入口

`scripts/prepareFrontendRelease.cjs` 只通过一次固定主机密钥 SSH 读取当前前端发布输入。版本号从已验证的原始 full 签名清单及当前 accepted 状态自动取得，不写死 r718/r719，也不要求前后端版本号相同。

## 配置与调用

使用 Node v22.22.1，沿用部署时已有配置：

- `RELEASE_SITE`、`RELEASE_CHANNEL`、`RELEASE_SIGNING_PUBLIC_KEY`。
- `RELEASE_DEPLOY_HOST`、`RELEASE_DEPLOY_USER`、`RELEASE_DEPLOY_KEY`、`RELEASE_DEPLOY_KNOWN_HOSTS`、`RELEASE_DEPLOY_HOST_KEY_SHA256`。
- 可选 `RELEASE_DEPLOY_PORT`（默认 22）及 `RELEASE_DEPLOY_HOST_KEY_TYPE`（默认 ssh-ed25519）。
- `RELEASE_FRONTEND_BASELINE_BUNDLE`：后台当前完整版本的**原始签名 full 归档**，相邻 `.manifest.json`、`.manifest.sig` 必须存在。不能改为上一次 frontend-only 包。
- 可选 `RELEASE_FRONTEND_INPUTS_OUTPUT_DIR`：已存在的输出目录；默认工作区 `.codex-tmp`，只创建独立新目录。

本地检查（不连接服务器）：

```text
node scripts/prepareFrontendRelease.cjs --check
```

实际读取并准备（不签包、不部署）：

```text
node scripts/prepareFrontendRelease.cjs
```

结果提供 `environment` 三个字段：原始归档、当前 state 文件、当前 runtime binding 文件路径。原始远端字节保存为新建目录内的 `frontend-state.json`、`frontend-runtime-binding.json`、`frontend-acceptance.json`，附带大小和 SHA，不重序列化这些输入。`preparation.json` 是读取记录，不是部署许可。

在同一次已授权的发布操作中，把结果路径交给正常构造入口。例如 PowerShell（调用前已经配置上述变量和既有签名私钥、序号状态路径）：

```powershell
$frontendPreparationText = & node scripts/prepareFrontendRelease.cjs
if ($LASTEXITCODE -ne 0) { throw 'UI 发布输入准备失败，停止' }
$frontendPreparation = $frontendPreparationText | ConvertFrom-Json
if (-not $frontendPreparation.ok) { throw 'UI 发布输入未通过验证，停止' }
$env:RELEASE_KIND = 'frontend-only'
$env:RELEASE_FRONTEND_BASELINE_BUNDLE = $frontendPreparation.environment.RELEASE_FRONTEND_BASELINE_BUNDLE
$env:RELEASE_FRONTEND_STATE_PATH = $frontendPreparation.environment.RELEASE_FRONTEND_STATE_PATH
$env:RELEASE_FRONTEND_RUNTIME_PATH = $frontendPreparation.environment.RELEASE_FRONTEND_RUNTIME_PATH
& node scripts/createReleaseBundle.cjs
if ($LASTEXITCODE -ne 0) { throw 'UI 签名包构造失败，停止' }
```

此后仍按 `frontend-source-bundle.md` 及 `frontend-release-workflow.md` 核验精确候选身份、通过正常 `deployReleaseBundle.cjs` 发布并检查 accepted 回执。不要使用仍指向旧包的 `RELEASE_BUNDLE_PATH`，不要自动回退 full 发布。没有实际待发布 UI 变更时不要为了测试而签发新序号。

## 已验证与尚未证明

- 只执行固定的 Node 内置文件读取逻辑，不加载远端候选/应用 JavaScript；没有 HTTP、provider、构建、数据库、服务重启或恢复写入。
- 读取 root state/binding 和公开投影，要求字节相等；核对 accepted 回执、原始 full 完成状态、两个后台版本标记和实际 index。
- 输入文件及祖先路径拒绝链接、不当所有权/权限、超限和读取变化，读取完成后再次比较文件身份；恢复事务出现则拒绝。
- 本地解析同时支持 full/full 和 full/frontend-only；拒绝 pending、改写回执、重复/未知状态字段、绑定/锁文件不匹配、超过 60 秒或未来超过 5 秒的观察。
- Windows 最小环境显式保留 OpenSSH 所需 `ProgramData`，不传递 API key/token；只有公钥及 SSH 既有身份用于读取，不需要发布签名私钥。
- 不重复读取整个原始归档、不重新验证整个业务链路。构造器必须继续验证原始归档签名/完整成员；服务器必须继续新鲜核对真实运行环境、全部依赖/策略、隔离构建和公开验收。读取成功不能代替这些检查。
- 本入口不是一键自动发布器，也不把一次成功观察缓存为未来的发布许可；新的实际发布操作应重新读取。

## 针对性验证

```text
node scripts/verifyFrontendReleaseInputs.cjs
node scripts/verifyReleaseSpeedFix.cjs
```

准备输入专项有 29 组可移植校验及远端读取逻辑 VM 场景。VM 不是 Linux 文件系统权限证明。2026-09-09 17:21:43 的真实 Linux 只读调用通过，自动识别 runtimeSequence=718、frontendSequence=719，端到端 465ms，状态 SHA `7bb08321f5e95ae7bd2fd78fb00f8ace37a38d5903c6764e303581d7586d0c2d`。这是当前真实路径的读取证明，不是所有恶意文件系统夹具证明，也不是新发布耗时。

三项准备脚本纳入正常创建包/验包的必需成员，以及签名前专项校验；模型分类只精确标记这些发布工具，不改 package scripts/dependencies 分类，不放行未知近似文件名。
