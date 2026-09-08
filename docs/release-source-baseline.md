# 原始签名发布源码基线

这是未来 UI overlay 构建器的前置材料保留模块，不是 UI 快速部署功能。`releaseSourceBaseline.cjs` 只从固定入口已接收的原始包及认证材料创建基线，永不扫描、拷贝或倒推可变 APP。保存源材料不说明该发布已上线，所有返回均保持 `uiFastPathAllowed=false`、`frontendBuildBindingAvailable=false`、`releaseAcceptanceProven=false`。

## 保留哪些材料

固定位置：`/var/lib/football-release/source-baselines/<完整包 SHA256>/`。

```text
original.tgz             原始签名绑定的完整压缩包，逐字节保留
manifest.json            原始 manifest 字节，不重排或重新签名
manifest.sig             原始 detached RSA signature
signing-public.pem        接收时外部受信公钥的原始字节
source-inventory.json    原 manifest 中签名绑定的完整文件清单
baseline.json            SHA/序号/site/channel、各文件哈希、捕获时间、清单身份
complete.json            最后写入，绑定 baseline.json 哈希
```

这里的完整清单来自 `archiveSourceEvidence`，实际解压流会重新核对每个成员的路径、类型、权限、尺寸和 SHA-256；不是相信 manifest 中的“ok”字符串。原始压缩包及清单一同保存，所以后续受控构建可重新提取准确版本，无需保留已运行并可能被改动的 trusted/APP 目录。

## 保存与读取的安全条件

- 生产要求 Linux/root，固定 source-baselines 存储根、固定 `/etc/football-release/signing-public.pem`，以及 `/var/lib/football-release/work/<SHA>.<随机后缀>/` 中以相同 SHA 命名的三个原始包文件。不能用命令参数指向 APP、公钥副本或任意目录。测试仅通过显式私有 fixture 参数使用隔离目录和测试 UID。
- 输入和存储路径祖先必须受保护，文件必须 root 所有、单链接、普通文件，拒绝符号链接和组/其他用户可写文件。元数据有界读取，压缩包按 64 KiB 块复制并核对读前后 inode、尺寸、mtime/ctime。压缩包上限 512 MiB，manifest 和清单各 1 MiB，公钥/签名各 16 KiB。
- 原 manifest 用外部受信 RSA 公钥重新验签，要求 3072–8192 位、PKCS#1 v1.5/SHA-256、准确 keyId、site/channel/序号/包哈希、当前有效时间和空的敏感/阻止/缺失集合。公钥文件不能包含私钥 PEM。
- 私有暂存目录中写入并 fsync 各文件；实际核对保留压缩包与签名清单一致后才写 baseline.json，最后写 complete.json。目录 fsync、封存为 0500，文件 0400，再原子发布到准确 SHA 目录并同步父目录。
- 已存在完整基线仅能在重新验证后幂等复用，不覆盖。已存在不完整/冲突基线、遗留 capture lock 一律拒绝。普通失败的未完成 staging 保留供检查；模块不自动删除基线或失败材料。
- 新建副本前检查真实目标文件系统可用空间，除了原包和 4 MiB 元数据预算，至少留下 4 GiB 固定应用余量；不足时拒绝新增副本，不清理旧基线来腾空间。该前置检查不冒充容量预留，其他进程仍可能同时消耗空间。
- 历史读取始终重新验证外部公钥信任、原签名、实际保留压缩包清单和完整标记。过期旧 manifest 按其有效捕获时刻验证，不把“今天已过签名有效期”误当成当年的源材料损坏；也不借此重新部署过期包。
- 保留的公钥不是自认证信任锚。外部公钥轮换后，旧 keyId 基线默认不再被当前配置接受；支持历史密钥需要另一个明确审核的受信密钥历史机制，不能自动信任基线目录里的公钥。

缺少 `archiveSourceEvidence` 的旧清单（例如 r711 所用旧格式）返回 `legacy-inventory-unavailable`，不写基线、不从线上代码补造清单。这些版本仍不能作为 UI 快速发布依据。完整签名清单本身也没有补齐浏览器构建输入—产物绑定，后续 overlay builder 必须另做。

## 最安全的信任引导

源码已接入 `bootstrap-release-entrypoints.sh` 和外层 `football-release`，但尚未安装到生产固定入口。bootstrap 在现有发布锁下安装固定五文件闭包并核对安装后哈希；wrapper 逐项核验固定目录祖先及文件所有权/模式/单链接，不能从候选 APP 或上传包加载替代政策。不要让未来 UI overlay 包携带的同名脚本替代固定分类/基线校验器。

应通过独立审核的 bootstrap，把以下依赖闭包安装到 root 控制且所有祖先受保护的固定目录，例如 `/usr/local/libexec/football-release-source-baseline/`。文件 root:root 0644（或 0444），目录 root:root 0755/0700；固定 Node 必须来自既有受信运行时，使用清空环境的调用。安装前后核对审核通过的闭包哈希及语法/回归证据，不在生产按名称从候选 APP 动态加载替代模块：

- releaseSourceBaseline.cjs
- releaseSigning.cjs
- releaseArchiveSourceInventory.cjs
- releaseChangeClassification.cjs
- releasePrebuiltDist.cjs

如后续闭包发生变化或清单版本升级，应重新审核固定入口，不默默放宽旧校验器。

## 外层 football-release 的准确接入点

已有外层入口先把上传材料复制到 root 私有 work_dir，验签、检查清单身份、检查压缩包结构并验证提取结果，然后调用 `consume_release_sequence_before_execution "$MANIFEST_SEQUENCE"`。当前成功和错误收尾都会清理 work_dir；成功还会删除 incoming 原包。

已在 **consume_release_sequence_before_execution 之后、env/bash 启动 guarded release 之前** 接入固定 helper 保存源码。这样不依赖后面可能修改的提取树，也不会被外层清理丢掉原认证材料。调用有固定 45 秒上限、超时 5 秒强制终止；不接受调用方覆盖时间或 helper 路径。核心调用：

```sh
if ! timeout --kill-after=5s 45s env -i PATH="$PATH" LANG=C.UTF-8 \
  "$NODE_BIN" /usr/local/libexec/football-release-source-baseline/releaseSourceBaseline.cjs \
  preserve "$BUNDLE_SHA" "$MANIFEST_SEQUENCE" "$work_dir"; then
  printf 'football-release: warning: signed source baseline unavailable; UI overlay remains ineligible\n'
fi
```

本模块不依赖父 PID，因此不同于 stage bridge，它可以使用受信 timeout。若中断，不补写 complete、不重发发布；继续保留已有 full-release 控制与回滚规则。保留失败不得使 UI 快速路径降级为“猜测”，也不应在应用已经切换后把源码保留误当成新的回滚理由。

`timeout` 的存在性只在可选保留函数内检查；缺少该工具只让基线不可用，不被提升为完整发布的全局致命依赖。

只读核验调用：

```sh
env -i PATH="$PATH" LANG=C.UTF-8 \
  "$NODE_BIN" /usr/local/libexec/football-release-source-baseline/releaseSourceBaseline.cjs \
  verify "$BUNDLE_SHA" "$MANIFEST_SEQUENCE"
```

该基线可能对应随后失败或回滚的 full release，因此未来 overlay builder 还必须独立证明当前 APP/完整发布标记、活跃发布身份和实际构建绑定，不能“取最新基线”来猜基准。

## 定向验证

`scripts/verifyReleaseSourceBaseline.cjs` 使用实际 RSA-3072 密钥、原始 detached signature 和系统 tar，覆盖原字节保留、外部密钥错配、错误签名、过期/错身份/非 full 清单、签名内伪造文件哈希、原包被改、半完成目标、complete 丢失、私钥误传、输入上限/硬链接、遗留锁、来源清理、封存模式等。

2026-09-08 Windows 15 项通过；真实 Linux Node 22.22.1、UID 1000 的显式 fixture 17 项通过，1645 ms。原始证据 `outputs/release-source-baseline-linux-1788860058420.json` 包含准确的 6 个源码哈希、执行结果和前后未变证明。没有 sudo、没有生产基线/服务写入，测试临时目录已清除。此证据不是生产已保存基线或 UI 快速发布已启用的证明。

新增 `verifyReleaseSourceBaselineIntegration.cjs`：11 项合同检查、8 个实际 Bash 场景。直接运行源码中的保留函数和调用分支，仅模拟所有权观察及固定 helper：正常只调用一次、缺文件/不安全权限/路径别名不执行 helper、helper 失败或退出 124 不改变后续 guarded release 的退出码，可选 timeout 不成为全局致命依赖。它不执行生产 bootstrap，也不把模拟退出 124 说成实际等待 45 秒。

补入空间余量后，一次 Linux 定向回归暴露了原 archive reader 的异步重复关闭 raw fd 问题（失败记录 `outputs/release-source-baseline-linux-1788861888358.json`）。reader 已改为统一 FileHandle 所有权并等待流收尾；100 次成功/坏 gzip/解析早退的哨兵 fd 回归通过。最终新闭包在 Linux 18 项通过，1100 ms，证据 `outputs/release-source-baseline-linux-1788862225628.json`，六文件哈希前后未变、临时目录清除。旧 17 项记录只对应其记录中的原始代码哈希，不冒充新闭包验证。
