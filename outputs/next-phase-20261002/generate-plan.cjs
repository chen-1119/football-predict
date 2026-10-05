"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = path.resolve(__dirname, "../.."), read = p => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const diagnostic = read("outputs/prospective-recommendation-20261002/diagnostic.json");
const coverage = read("outputs/prospective-data-coverage-20261002/coverage-final.json");
const live = read("outputs/next-phase-20261002/release-readiness-summary.json");
const validation = fs.existsSync(path.join(__dirname, "verification.json")) ? read("outputs/next-phase-20261002/verification.json") : null;
const recovery = fs.existsSync(path.join(__dirname, "form-recovery-receipt.json")) ? read("outputs/next-phase-20261002/form-recovery-receipt.json") : null;
const phases = [
  { id: "A", title: "补齐证据与恢复采集", owner: "数据采集与云迁移 + 历史回归", state: recovery?.ok ? "355 份历史 form 已恢复；线上 current/result 待恢复" : "本轮工具已实现；线上来源待恢复",
    actions: ["补导同一不可变线上快照中被大小限制省略的 form，逐场核对原快照哈希和字段哈希。",
      "定位 current/result 的实际失败输出；快赛果 relay-fast-envelope-clock-invalid 按原始签名封包逐项核对，保留失败回执。",
      "在未来采集入口记录原始响应、字段提取位置、事件映射、来源授权引用和 provider/received/available 时钟；在决策前留存。",
      "按独立运行环境核验可信采集器契约，新增密钥不计为新增采集器。"],
    accept: ["旧 432 场输入与 154 场评分不回写；补导有同 generation/manifest/object/field 哈希对照。",
      "缺失、省略、晚到、未发布、过期、567 分别可追溯；本地材料不自动成为可信模型输入。",
      "真实 current/result 响应和可信时间证据恢复；源健康及数据新鲜度通过既有规则。"] },
  { id: "B", title: "分歧归因与固定对照", owner: "推荐评估与校准 + 历史回归", state: "历史诊断已完成；未来实验待接入既有台账",
    actions: ["逐场审阅 26 场模型/市场分歧的冻结概率、SP、版本及原始计算凭据，分别检查方向变化与概率降温。",
      "复用既有 candidateProspectiveLedger/challenger suite，核对已注册候选、实现哈希、参数锁定及激活回执。",
      "按未来时间隔离训练、校准和最终测试。标签时钟或样本不足时继续积累，禁止用已看过的 9 月样本充当最终测试。"],
    accept: ["模型与市场使用同场、同决策 SP；报告命中率、覆盖率、Brier、LogLoss 及比赛日区间。",
      "保持现有至少 500 场有效结算、6 个 30 天窗口、每窗至少 50 场、至少 5 个胜窗及全部其他晋级门槛。",
      "某组历史表现或少量全中不触发线上阈值变更；正式晋级须独立验证。"] },
  { id: "C", title: "推荐表达与完整发布", owner: "界面与使用流程 + 回归测试与发布验收", state: "上一批 UI 已验证；本轮未部署",
    actions: ["资料不足显示等待资料；资料齐全但模型未通过显示分析参考；全部现有资格通过才显示可发布推荐。",
      "完成登录后的比赛列表/详情及移动端整页验收，核对方向、概率、SP、冻结版本和资料时间。",
      "采用现有完整签名发布路径，将 PublicBrowse 与新增 CSS 等一并纳入；保留回滚版本与精确线上身份回执。"],
    accept: ["采集器契约与完整发布必需检查通过，候选包包含所有新增文件。",
      "前端资源、运行时、数据库主读、worker 与线上页面逐项验证；构建成功不记为部署成功。",
      "技术上线与正式推荐资格分别记录。"] },
  { id: "D", title: "云采集交接", owner: "数据采集与云迁移", state: "连续运行与切换验收待完成",
    actions: ["云端按既有采集契约输出带来源与时钟的证据包，现有服务接收后核验并保存。",
      "完成含恢复销售期间的连续 7 天对照：任务触发、上传回读、去重、更正、失败退避、事件差异和回退。"],
    accept: ["每次计划任务有成功或失败回执；失败不伪装为空结果或更新时间。",
      "连续对照与回滚验收通过后再关闭旧采集通道；当前保留原服务与数据库。",
      "7 天采集验收独立于模型效果验收；本轮未确认成本节省或模型提升。"] },
];
const files = ["outputs/prospective-recommendation-20261002/diagnostic.json", "outputs/prospective-data-coverage-20261002/coverage-final.json", "outputs/next-phase-20261002/release-readiness-summary.json"];
if (validation) files.push("outputs/next-phase-20261002/verification.json");
if (recovery) files.push("outputs/next-phase-20261002/form-recovery-receipt.json");
const plan = { version: "football-next-phase-plan-v1", generatedAt: new Date().toISOString(), timeZone: "Asia/Shanghai",
  delivered: { sourceCoverageAndRetention: true, fixedGroupDiagnostic: true, disagreementCases: diagnostic.disagreementAppendix.length,
    productionDeployed: false, futureExperimentActivated: false, accuracyImprovementProven: false },
  baseline: { ...coverage.funnel, model: diagnostic.overall.models.publishedModel, market: diagnostic.overall.models.sameDecisionMarket },
  formEvidence: coverage.cohorts.allSelected.form, agreement: diagnostic.groups.agreement, liveObservedAt: live.observedAt,
  live: { frontend: live.live.frontendRelease.frontendSequence, runtime: live.live.frontendRelease.runtimeSequence,
    dataFresh: live.live.status.dataFresh, sourceHealthOk: live.live.status.sourceHealthOk,
    trustedCollectors: live.live.status.officialSourceRedundancy.trustedCollectorCount },
  validation, recovery, phases, officialCalendar: live.officialCalendar,
  evidence: files.map(file => ({ file, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex") })) };
fs.writeFileSync(path.join(__dirname, "implementation-plan.json"), JSON.stringify(plan, null, 2) + "\n");
const esc = v => String(v ?? "—").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const pct = n => `${(n * 100).toFixed(2)}%`, li = xs => `<ul>${xs.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`;
const time = value => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
const evidenceLink = file => "../../" + file;
const tableRows = diagnostic.groups.agreement.map(g => `<tr><td>${g.value === "agree" ? "模型与市场同向" : "模型与市场分歧"}</td><td>${g.rows}</td><td>${pct(g.coverageOfPaired)}</td><td>${g.models.publishedModel.hits}/${g.rows} · ${pct(g.models.publishedModel.hitRate)}</td><td>${g.models.sameDecisionMarket.hits}/${g.rows} · ${pct(g.models.sameDecisionMarket.hitRate)}</td></tr>`).join("");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>足球系统 · 下一版本实施与验收方案</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f3f6f8;color:#172b3a;font:16px/1.75 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:auto;padding:36px 22px 80px}h1{font-size:34px;line-height:1.35}h2{font-size:24px}h3{font-size:19px;margin-bottom:8px}.eyebrow{color:#087e71;font-weight:700;letter-spacing:.08em}.muted{color:#556777}section{background:white;border:1px solid #dce5eb;border-radius:14px;padding:24px;margin-top:22px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card{background:#eaf4f2;border-radius:10px;padding:18px}.card strong{font-size:28px;display:block}.badge{display:inline-block;background:#fff2d8;color:#704b00;padding:3px 12px;border-radius:20px;font-size:14px}table{border-collapse:collapse;width:100%;font-size:15px}th,td{text-align:left;padding:12px;border-bottom:1px solid #e0e7ed}th{background:#f1f5f8}.scroll{overflow:auto}li{margin:6px 0}a{color:#006d79}.phase{border-top:1px solid #dce5eb;padding-top:12px;margin-top:22px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}code{overflow-wrap:anywhere;font-size:13px}details{margin-top:14px}summary{cursor:pointer;font-weight:650}@media(max-width:680px){main{padding:24px 14px}h1{font-size:27px}.cards,.cols{grid-template-columns:1fr}section{padding:18px}}</style>
<main><div class="eyebrow">FOOTBALL / 实施方案与结果</div><h1>先补证据，再验证模型，按条件发布</h1><p class="muted">生成：${esc(time(plan.generatedAt))}（北京时间） · 线上观测：${esc(time(live.observedAt))}</p><span class="badge">代码与诊断已交付 · 未部署 · 命中率提升未获验证</span>
<section><h2>本轮完成了什么</h2><div class="cards"><div class="card"><strong>${coverage.funnel.selected} 场</strong>线上冻结历史逐字段审计</div><div class="card"><strong>${diagnostic.disagreementAppendix.length} 场</strong>模型与市场分歧逐场清单</div><div class="card"><strong>${validation?.testsPassed ?? "待汇总"}</strong>本轮定向验证通过</div></div><p>新增证据留存入口：保存原始响应、字段提取位置、来源和时钟；按内容去重，更正新增版本。当前留存属于本地审计材料，需通过既有来源和采集验证后才能供模型使用。</p><p>覆盖报告明确区分导出省略、快照内缺失和整份快照缺失；固定分组诊断同时报告命中率与选择覆盖率。</p></section>
<section><h2>优先处理的两个问题</h2><h3>1. 近期状态资料被导出限制省略</h3><p>432 场中 form 原值保留 ${coverage.cohorts.allSelected.form.valuePresent} 场，导出省略 ${coverage.cohorts.allSelected.form.exportOmitted} 场，整份冻结快照缺失 ${coverage.cohorts.allSelected.form.snapshotEvidenceMissing} 场。优先从同一不可变线上快照核对补导，不能把省略直接当成上游没有数据。</p><p>${recovery ? "本轮已通过原始字段与快照哈希校验，恢复全部 355 份省略资料。原值可读数量从 24/432 增至 379/432，覆盖率从 5.56% 提高到 87.73%；53 份无快照保持缺失。补回原值不等于补齐可信时钟，也不改变旧评分。" : "补导正在按原始字段哈希与大小制定受限方案；当前报告不计为已恢复。"}</p><h3>2. 概率质量与方向分歧分别诊断</h3><div class="scroll"><table><thead><tr><th>固定分组</th><th>场次</th><th>占154场</th><th>模型命中</th><th>市场命中</th></tr></thead><tbody>${tableRows}</tbody></table></div><p>26 场分歧是下一轮归因清单，样本不足以据此修改线上阈值。同向组的命中率相同，模型概率误差仍较大，因此概率校准也需单独对照。</p><p class="muted">这些为已看过的历史概率最大方向统计，与线上公开参考推荐的 151 场口径不同。它们不充当未来独立测试。</p></section>
<section><h2>按四阶段落实</h2>${phases.map(p => `<article class="phase"><h3>${esc(p.id)} · ${esc(p.title)}</h3><p class="muted">负责：${esc(p.owner)} · ${esc(p.state)}</p><div class="cols"><div><b>实施内容</b>${li(p.actions)}</div><div><b>完成条件</b>${li(p.accept)}</div></div></article>`).join("")}</section>
<section><h2>当前上线条件</h2><p>线上前端 r${plan.live.frontend} / 运行时 r${plan.live.runtime}，数据新鲜度与源健康未通过，近期可信采集器 ${plan.live.trustedCollectors}/2。采集 relay 的历史行数不等于已发布历史；当前数据库主读仍保留已发布数据。</p><p>竞彩恢复销售时间为 <b>2026 年 10 月 5 日 11:00</b>。公告不证明 API 开放或 567 解除；恢复后需实际验证 current/result 返回与原始时间证据。<a href="${esc(live.officialCalendar.url)}">官方公告</a></p><p>本轮没有放宽采集器、数据鲜度或模型晋级门槛。源恢复与完整发布验收通过后再执行部署。</p></section>
<section><h2>交付与复核</h2><p><a href="../prospective-data-coverage-20261002/integration-guidance.md">数据留存接入说明</a> · <a href="../../docs/prospective-recommendation-diagnostic.md">模型诊断执行说明</a> · <a href="release-readiness-report.html">发布与源恢复明细</a></p><details><summary>输入哈希与机器可读回执</summary>${li(plan.evidence.map(e => `${e.file} · SHA-256 ${e.sha256}`))}<p><a href="implementation-plan.json">完整结构化方案</a></p>${plan.evidence.map(e => `<p><a href="${esc(evidenceLink(e.file))}">${esc(e.file)}</a></p>`).join("")}</details></section></main></html>`;
fs.writeFileSync(path.join(__dirname, "implementation-plan.html"), html);
console.log(JSON.stringify({ report: path.join(__dirname, "implementation-plan.html"), tests: validation?.testsPassed ?? null, sourceRows: coverage.funnel.selected, deployed: false }));
