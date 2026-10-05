"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8").replace(/^\uFEFF/, ""));
const snapshot = read("release-readiness-live.json");
const releaseStatus = read("release-readiness-status.json");
const publicAudit = read("release-readiness-public.json");
const health = snapshot.observations.find(row => row.endpoint === "/api/v1/health").body;
const source = snapshot.observations.find(row => row.endpoint === "/api/v1/source-health").body;
const sporttery = source.sources.find(row => row.id === "sporttery").metrics;
const policy = require(path.join(root, "scripts/releaseChangeClassification.cjs"));
const changedSource = execFileSync("git", ["diff", "--name-only", "6fce1805d0d8db0410c71231d6df6ce72ec766cb..c2f9be1bc1ae2b902e5bb4f15d161f3fff35f734", "--", "src"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/);
const sourceRefs = [
  { path: "scripts/createFrontendReleaseBundle.cjs", line: 261, fact: "仅叠加 FRONTEND_PATHS 内已经存在的文件；新增成员拒绝，非白名单成员不打包。" },
  { path: "scripts/releaseChangeClassification.cjs", line: 14, fact: "精确 UI 白名单和策略散列，新增 CSS/PublicBrowse 不在其中。" },
  { path: "deploy/light-server/release-native.sh", line: 283, fact: "现有 native full 流程公开验收固定 REMOTE_REQUIRE_HEALTHY=0，仍校验 PostgreSQL、公开契约，恢复 worker 后再校验 worker。" },
  { path: "scripts/verifyRemotePublicReadiness.cjs", line: 604, fact: "独立采集器契约校验始终必需；trustedKeyCount>=1 及 runtime/domain 一致性；不因健康总开关关闭而跳过。" },
  { path: "scripts/verifyNativeDeploymentCore.cjs", line: 13, fact: "验证 PostgreSQL、冻结发布、比分和推荐投影一致性；显式保留 recommendationReliable=false 和 reference-shadow。" },
];
const steps = [
  { phase: "现在可继续", owner: "数据与评估任务", action: "继续保存线上历史及结算数据，分离 current/result/history lane，保留源时间、收到时间、hash、sourceCycleId；仅用可审计赛前快照做模型评分。", acceptance: "历史刷新成功不改变当前赔率、正式推荐资格；回测输入均早于 cutoff，迟到/缺失有原因计数。" },
  { phase: "现在可准备", owner: "采集与云迁移任务", action: "核对授权采集环境、实际调度和接收签名；将官方休市公告与 HTTP 567 等传输结果分别保留。现有 collector 运行状态与真正 current/result 成功单独计数。", acceptance: "休市仅改变诊断文案/明确调度规则，不把旧赔率变新、不把 current=0 自动当作采集成功；多密钥不冒充多运行环境。" },
  { phase: "10月5日11:00后", owner: "采集与发布任务", action: "先单次观察官方允许入口的 current/result 真实响应；如仍567，保存一次状态码、响应摘要/hash和时间，暂停该源并走站方放行/正式交付路径。若成功，按实际响应逐字段校验、签名上传并读取回执。", acceptance: "current/source时间真实且在20分钟现有窗口内，官方SP来源明确，current/result分别通过；不得伪造时间戳、扩大TTL或用参考赔率冒充官方。开售时间不等于567解除。" },
  { phase: "源恢复后", owner: "质量与发布任务", action: "重跑相同严格只读公网验收，再在配置完整的既有发布工作区准备完整签名版本；不得将本轮候选硬塞入UI通道。完成登录后列表/详情/手机布局回归。", acceptance: "数据fresh、源健康恢复；独立collector/runtime证据满足当前策略；包清单包含全部修改；Node22、质量和回归检查通过；远端 accepted/liveComplete、SHA、页面静态资源一致。" },
  { phase: "云迁移切换", owner: "云采集任务", action: "在已具备授权及可运行调度的目标环境完成连续7天影子采集、上传回读和差异复核；失败可回退旧通道。", acceptance: "每天预定周期有原始证据与签收回执，缺漏/迟到/身份映射/冲突可审计；完成后才停旧采集。当前报告不证明新云资源已建立。" },
];
const report = {
  version: "release-source-readiness-review-v1", generatedAt: new Date().toISOString(), observedAt: snapshot.capturedAt,
  timezone: "Asia/Shanghai", candidateCommit: "c2f9be1bc1ae2b902e5bb4f15d161f3fff35f734",
  scope: { onlineReadsOnly: true, deployed: false, processOrDatabaseMutation: false, businessCodeModified: false, officialSourceProbeThisTurn: false },
  live: { status: health.status, frontendRelease: health.frontendRelease, sync: health.sync,
    servedData: { historyCount: health.data.historyCount, currentCount: health.data.currentCount, updatedAt: health.data.updatedAt,
      postgresHistoryMatches: health.storage.postgres.counts.historyMatches,
      differenceFromCollector: "2289仅为relaySnapshot.historyLane行数；当前服务和PostgreSQL历史仍2272，不能把采集快照计为发布或回测新增样本。" },
    publicAudit: { checkedAt: publicAudit.checkedAt, required: publicAudit.summary.required, failed: publicAudit.summary.failed,
      failures: publicAudit.checks.filter(row => row.required !== false && !row.ok) },
    sourceErrors: source.errors, sources: source.sources.map(row => ({ id: row.id, status: row.status, updatedAt: row.updatedAt })),
    laneEvidence: { currentMatches: sporttery.currentMatches, officialOddsMatches: sporttery.officialOddsMatches,
      current: sporttery.relaySnapshot.currentLane, result: sporttery.relaySnapshot.resultLane, history: sporttery.relaySnapshot.historyLane,
      lastCurrentOkAt: sporttery.relaySnapshot.collectorState.currentLaneState.lastOkAt,
      direct: sporttery.egress, redundancy: source.officialSourceRedundancy } },
  officialCalendar: { title: "国家体育总局体育彩票管理中心关于2026年国庆节期间体育彩票市场休市的公告",
    url: "https://www.gstc.org.cn/newsDetail/160700/80256", publisher: "甘肃省体育彩票管理中心官方网站，转载国家体彩中心公告",
    publishedAt: "2026-09-24", noticeDate: "2026-09-22", verifiedOn: "2026-10-02",
    generalClosedFrom: "2026-10-01T00:00:00+08:00", generalClosedUntilExclusive: "2026-10-05T00:00:00+08:00",
    singleMatchSalesStop: "2026-09-30T22:00:00+08:00", singleMatchSalesResume: "2026-10-05T11:00:00+08:00",
    interpretation: "公告说明销售安排，不能证明API开放、567自动解除或空返回必属休市。current最后成功早于停销；9月30日18:53快赛果审计已因clock-invalid不具备发布资格。current首次失败时刻未公开，不能仅凭最后成功时间推断首次失败。" },
  diagnosticTargets: [
    { endpoint: "/api/v1/health", field: "sync.workerLastError", next: "定位2026-10-02T15:42:09.857Z一轮validate:data的具体失败输出；公开只有npm run validate:data exited with 1，需既有只读服务日志/状态，不直接重跑写入型sync。" },
    { endpoint: "/api/v1/health", field: "sync.lastSync.phase / sync.lastCycle", next: "official-result-failed区分官方结果阶段失败与慢补充源失败；代码 scripts/runSyncWorker.cjs:4726。" },
    { endpoint: "/api/v1/health", field: "sync.fastResultWatcher.lastError / inputEvidence", next: "检查trusted-fast-result-endpoints-unavailable、relay-fast-envelope-clock-invalid的原始签名封包、receipt、源时间，不修写旧时间戳。" },
    { endpoint: "/api/v1/source-health", field: "sources[id=sporttery].metrics.relaySnapshot.collectorState.currentLaneState", next: "lastOkAt、lastFailedAt、consecutiveFailures与current快照原始响应逐轮对齐；公共lastFailure=null不足以断定无失败。" },
    { endpoint: "/api/v1/source-health", field: "sources[id=sporttery].metrics.relaySnapshot.collectorAttestation / officialSourceRedundancy", next: "查当前lane可信key、运行环境/domain归属和20分钟证据窗口；只增加密钥不会增加独立采集器。" },
  ],
  releaseBoundaries: {
    policyHash: policy.POLICY_HASH, sourcePaths: changedSource.map(name => ({ path: name, frontendOnlyAllowed: policy.FRONTEND_PATHS.includes(name) })),
    localReadinessMissing: releaseStatus.blockers,
    localMissingMeaning: "集成树未配置签名候选包、SSH固定主机指纹及密钥；这不等于远端服务故障，也不证明根工作区没有已有配置。本次未复制或输出密钥。",
    existingHealthPolicy: "现有native全量发布允许reference-shadow状态，REMOTE_REQUIRE_HEALTHY=0并非新建议、不能恢复推荐资格；collector契约仍强制。本次主动严格审计用1，27/29通过；即使沿用已有0，当前collector契约也失败。",
    preferredRoute: "本轮含worker、服务资格脚本及新增CSS，采用既有完整签名发布路径；UI-only无法覆盖。不要只改本地白名单，因为远端授权、runtime binding、原始full包共同绑定策略。",
    noDeploymentUntil: ["配置完整的签名发布工作区及精确候选包就绪", "采集器契约通过，数据恢复按产品门槛独立验收", "全部新增文件纳入完整包并通过候选与页面验收"],
    evidence: sourceRefs,
  },
  recommendationEligibility: { recommendationReliable: false, promoted: false, reason: "服务运行/历史更新/技术发布成功均不能替代概率校准和独立留出验证。" },
  steps,
  inputs: ["release-readiness-live.json", "release-readiness-status.json", "release-readiness-public.json"].map(name => ({ name,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, name))).digest("hex") })),
};
fs.writeFileSync(path.join(__dirname, "release-readiness-summary.json"), JSON.stringify(report, null, 2) + "\n");
const esc = text => String(text ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const bj = iso => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(iso));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>线上数据与发布恢复方案</title><style>body{font:16px/1.75 system-ui,sans-serif;color:#172b3a;background:#f5f7fa;margin:0;padding:24px}main{max-width:1020px;margin:auto;background:white;padding:32px;border-radius:16px}h1,h2{line-height:1.4}h2{margin-top:32px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid #dde3e8;text-align:left;padding:12px;vertical-align:top}a{color:#05617c}code{overflow-wrap:anywhere}aside{padding:16px;background:#fff4d8;border-left:4px solid #d39518}li{margin:8px 0}@media(max-width:600px){body{padding:8px}main{padding:16px}table{font-size:12px}td,th{padding:8px}}</style><main><h1>线上数据与发布恢复方案</h1><p>线上读取时间：${esc(bj(report.observedAt))}（北京时间） · 候选 ${report.candidateCommit.slice(0,12)}</p><aside>本次仅刷新只读证据、核查发布边界并整理执行方案。没有部署、开启新云采集、修改数据库/进程或提升正式推荐资格。</aside><h2>1. 新鲜结果</h2><table><tr><th>检查</th><th>结果</th></tr><tr><td>线上版本</td><td>前端 r${health.frontendRelease.frontendSequence} / 运行时 r${health.frontendRelease.runtimeSequence}，accepted 身份一致</td></tr><tr><td>服务 / 存储</td><td>serviceOk=true；PostgreSQL 主读；worker 正在运行，但上一轮 validate:data 失败，phase=official-result-failed</td></tr><tr><td>数据 / 源 / 推荐</td><td>dataFresh=false；sourceHealthOk=false；recommendationReliable=false</td></tr><tr><td>严格公开验收</td><td>${publicAudit.summary.required-publicAudit.summary.failed}/${publicAudit.summary.required}；未通过 health 和 collector 独立运行环境契约</td></tr><tr><td>历史 lane</td><td>采集器 relay history lane ${sporttery.relaySnapshot.historyLane.rows} 行，未过期；当前服务/PG历史仍 ${health.data.historyCount} 行。前者不等于已发布或回测新增。</td></tr><tr><td>current / result</td><td>current=0、官方SP=0；result 已超过20分钟有效窗口；近期可信采集器0/2</td></tr></table><h2>2. 休市与真实故障需要分开</h2><p>官方公告：竞彩于9月30日22:00停止销售，10月5日11:00恢复销售。<a href="${report.officialCalendar.url}">国家体彩中心公告（甘肃体彩官网）</a>。</p><p>当前lane最后成功是9月30日18:33，首次失败时间未公开；18:53快赛果审计已因 clock-invalid 无发布资格，不能把全部失败归因休市。服务器直连是明确 disabled，wafBlocked=false 来自跳过状态；本轮没有重新探测官方入口，不能宣称567已解除。历史可读也不能替代当前赔率与结果源。</p><h2>3. 发布路径</h2><p>${esc(report.releaseBoundaries.preferredRoute)}</p><table><tr><th>本轮 src 修改</th><th>当前 UI-only 白名单</th></tr>${report.releaseBoundaries.sourcePaths.map(row=>`<tr><td><code>${esc(row.path)}</code></td><td>${row.frontendOnlyAllowed?"允许已有文件变更":"不覆盖，需要完整发布"}</td></tr>`).join("")}</table><p>${esc(report.releaseBoundaries.existingHealthPolicy)}</p><p>集成树缺少当前候选签名包及固定主机指纹配置，这是本地准备缺口。本次未借此改动远端策略。需要在既有配置完整的发布工作区完成精确包构造与验证。</p><h2>4. 执行顺序和验收</h2>${steps.map((step,index)=>`<h3>${index+1}. ${esc(step.phase)} · ${esc(step.owner)}</h3><p>${esc(step.action)}</p><p><strong>验收：</strong>${esc(step.acceptance)}</p>`).join("")}<h2>5. 下一轮故障定位</h2><ul>${report.diagnosticTargets.map(row=>`<li><code>${esc(row.endpoint)} → ${esc(row.field)}</code><br>${esc(row.next)}</li>`).join("")}</ul><h2>6. 原始证据</h2><ul>${report.inputs.map(row=>`<li><a href="${row.name}">${row.name}</a> — SHA256 <code>${row.sha256}</code></li>`).join("")}</ul><p>代码门槛位置：${sourceRefs.map(row=>`${esc(row.path)}:${row.line}`).join("；")}。</p></main></html>`;
fs.writeFileSync(path.join(__dirname, "release-readiness-report.html"), html);
console.log(JSON.stringify({ report: "release-readiness-report.html", summary: "release-readiness-summary.json", observedAt: report.observedAt, testsPassed: publicAudit.summary.required-publicAudit.summary.failed, testsTotal: publicAudit.summary.required, deployed: false }));
