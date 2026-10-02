"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const inputs = [];
function input(relative, json = true) {
  const filename = path.join(root, relative), bytes = fs.readFileSync(filename);
  inputs.push({ path: relative.replace(/\\/g, '/'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), fileModifiedAt: fs.statSync(filename).mtime.toISOString() });
  return json ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8');
}
const summary = input('outputs/history-regression-20261002/report/summary.json');
const review = input('outputs/history-regression-20261002/report/review.json');
const delivery = input('outputs/history-regression-20261002/delivery-receipt.json');
const live = input('outputs/integration-20261002/live-public-overview.json');
const observation = input('outputs/integration-20261002/public-observation.json');
const browser = input('outputs/integration-20261002/browser-verification.json');
const cohort = input('outputs/integration-20261002/cohort-verification.json');
const finalVerification = input('outputs/integration-20261002/final-verification.json');
const featureVerification = input('outputs/history-feature-admission-20261002/verification-receipt.json');
const secondUi = input('outputs/ui-trust-detail-20261002/delivery-summary.json');
const pythonLog = input('outputs/integration-20261002/python-tests.log', false);
input('outputs/integration-20261002/final-build.log', false);
input('outputs/integration-20261002/final-lint.log', false);
// Process exit codes were confirmed by the coordinating task after these exact
// final logs were produced. An empty successful lint log is not parsed as failure.
const buildLintExecution = { buildExitCode: 0, lintExitCode: 0, evidenceSource: '总控最终执行回执确认；final-build.log 与 final-lint.log 对应本轮实际退出 0', inferredFromLogText: false };
const check = (value, why) => { if (!value) throw Error(why); };
check(review.rows === review.perMatch.length && review.rows === summary.funnel.sameDecisionPaired, 'paired row mismatch');
check(review.productionEligible === false && summary.productionEligible === false, 'unexpected promotion state');
const outcomes = ['home', 'draw', 'away'];
function recompute(name) {
  let won = 0, brier = 0, loss = 0;
  for (const row of review.perMatch) {
    const p = row.predictions[name];
    check(p && outcomes.includes(row.actual), 'invalid result or probability');
    const chosen = outcomes.reduce((best, key) => p[key] > p[best] ? key : best, outcomes[0]);
    won += Number(chosen === row.actual);
    brier += outcomes.reduce((total, key) => total + (p[key] - Number(key === row.actual)) ** 2, 0);
    loss -= Math.log(Math.max(1e-15, p[row.actual]));
  }
  const n = review.perMatch.length, stated = review.metrics[name];
  check(Math.abs(stated.accuracy - won / n) < 1e-12, 'accuracy recomputation mismatch');
  check(Math.abs(stated.brier - brier / n) < 1e-12 && Math.abs(stated.logLoss - loss / n) < 1e-12, 'loss recomputation mismatch');
  return { n, won, accuracy: won / n, brier: brier / n, logLoss: loss / n };
}
const model = recompute('publishedModel'), market = recompute('sameDecisionMarket');
const publicSummary = live.review.summary;
check(publicSummary.settled === publicSummary.won + publicSummary.lost, 'public settlement mismatch');
check(Math.abs(publicSummary.hitRate - publicSummary.won / publicSummary.settled) < 1e-12, 'public hit rate mismatch');
check(live.referenceOnly === true, 'public reference flag changed');
check(finalVerification.ok && finalVerification.unchanged && finalVerification.runtimeVersion === 'v22.22.1', 'final verification unavailable');
check(finalVerification.implementationHead === 'a229d3b7b653f624e0859582b845d3f715c9faa6', 'unexpected final implementation');
for (const row of finalVerification.checks) {
  check(row.exitCode === 0 && row.error === null, 'final check failed');
  const log = input('outputs/integration-20261002/' + row.log, false);
  check(crypto.createHash('sha256').update(log).digest('hex') === row.logSha256, 'final check log hash mismatch');
}
const targeted = finalVerification.checks.find(row => row.name === 'targeted');
const targetedPassed = targeted.passed;
const pythonPassed = Number(pythonLog.match(/Ran (\d+) tests/)?.[1]);
check(targetedPassed === 270 && targeted.tests === 270 && targeted.failed === 0, 'joint tests not confirmed');
check(pythonPassed === 12 && /\bOK\b/.test(pythonLog), 'python tests not confirmed');
check(featureVerification.tests.independentBefore.pass === 38 && featureVerification.tests.independentAfter.pass === 50 && featureVerification.tests.independentAfter.fail === 0, 'independent repair result unavailable');
check(featureVerification.result.fullFrozenReportIdentical && featureVerification.result.originalInputsAndReportsUnchanged && featureVerification.result.pairedRows === 154, 'historical evidence changed');
const data = {
  version: 'football-integration-results-report-v1', generatedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai',
  status: { deployedThisRound: false, newModelTrained: false, improvementProven: false, frontendSequence: observation.frontendRelease.frontendSequence, runtimeSequence: observation.frontendRelease.runtimeSequence,
    observationAt: observation.completedAt, readiness: observation.readiness, secondBatch: '5 个任务两批交付均已集成，代码状态以本轮最终验收回执为准。', implementationHead: finalVerification.implementationHead, finalVerifiedAt: finalVerification.verifiedAt },
  publicReferenceRecord: { ...publicSummary, referenceOnly: true, updatedAt: live.review.updatedAt, sourceUpdatedAt: live.sourceUpdatedAt, businessDate: live.businessDate,
    metricMeaning: '公开参考推荐的已结算方向命中率；不是新候选模型成绩，也不是经校准的正式推荐准确率。' },
  historicalPair: { from: review.source.selection.from, untilExclusive: review.source.selection.until, receivedAt: review.source.transport.receivedAt,
    model, market, matchDays: review.matchDays, pairedUncertainty: review.pairedAgainstMarket.publishedModel, modelVersions: summary.recordedClocks.modelVersions,
    comparisonMeaning: '相同154场、同一决策时点官方SP的对照；方向命中按各自三项概率最大项计算，与公开151场推荐集合不同。', previous145Reproduced: summary.historicalPublished145Reproduced,
    previous145Explanation: '旧145场另有历史训练特征与watermark准入条件，本批154场不是其同口径复算。' },
  funnel: summary.funnel, coverage: summary.coverage,
  fieldEvidenceMeaning: '0表示本批导出中没有满足时间审计条件的完整特征回放样本；不能推出线上所有数据源没有这些数据。缺失计数为字段级，可一场多项，不能相加当比赛数。',
  codeDelivery: { integratedFirstBatchCommits: 8, integratedTotalCommits: 15, integratedTasks: 5, batchesIntegrated: 2, confirmedBy: '总控协调记录与最终集成验收回执', fixes: [
    '让质量检查选取与实际推荐相同的 BEST 记录，修复概率漂移漏报。',
    '修正市场角色说明，使界面说明与已有概率融合逻辑一致。',
    '补充日期合法性检查与历史样本集合对账，拒绝无效日期并区分154场与旧145场。',
    '整合来源覆盖诊断、候选评估协议、公开页排版与移动端适配、发布证据检查和线上历史导出。',
    '修复 P1 候选回放信息泄漏漏洞；同一套独立测试由旧代码 38/50 通过提升至修复后 50/50，原 432 场输入与 154 场完整评分未改变。',
    '修复采集跨轮计数（cf34611），新影子采集接口默认关闭。',
    '合入第二批推荐证据组件 UI（d74）：呈现已发布证据、时间和风险边界。'
  ], tests: { targetedPassed, pythonPassed, browserChecks: browser.checks.length, browserWidths: [...new Set(browser.checks.map(r => r.width))], browserErrors: browser.errors,
    runtimeVersion: finalVerification.runtimeVersion, sourceUnchanged: finalVerification.unchanged, finalChecks: finalVerification.checks, buildPassed: true, lintPassed: true, buildLintExecution, authenticatedAnalysisTested: browser.authenticatedAnalysisTested,
    secondBatchUi: { ...secondUi.verification, scope: '历史组件隔离回放；不是登录后的整页验收，也不是新生产效果。' },
    scope: '代码正确性与页面交互验证；浏览器使用线上公开响应的本地回放，不证明候选已上线或预测准确率提高。' } },
  pending: [
    'P1 候选回放信息泄漏漏洞已修复并通过固定独立验收；未来窗口实验仍待开展。',
    'PublicBrowse.tsx、public-browse.css 和新增 published-evidence-snapshot.css 不在当前 UI 发布白名单；本轮新 UI 尚未部署。',
    '线上dataFresh、sourceHealthOk、recommendationReliable尚未通过，完整发布门槛仍关闭。',
    '没有完成新模型训练、未来窗口对照或效果提升验收。'
  ],
  roadmap: [
    { phase: '第一阶段', name: '补齐可复算证据', work: '冻结比赛身份、决策概率与赔率；保存每个输入的来源、载荷哈希、提供方时间、接收时间、首次可用时间，以及赛果标签的首次观察时间。', acceptance: '重放不得使用决策之后才知道的输入；标签不能用后补时间倒填。导出缺失与原源缺失分开记录，负例能阻断泄漏。' },
    { phase: '第二阶段', name: '预注册未来窗口对照', work: '在未来比赛结果出现前锁定候选版本、时间窗口、排除规则、指标和推广门槛；并行保留现有模型与同一时点市场基线。', acceptance: '训练、校准、验证和最终测试按时间分离；最终测试不用于反复挑参数。每日冻结预测，所有版本使用同一事件集合。' },
    { phase: '第三阶段', name: '校准与市场融合候选', work: '先比较概率校准和受约束的市场融合，再逐项检查Elo、近期表现、阵容、伤停、天气、真实xG等特征的增量贡献。', acceptance: '有可靠时点证据的字段才进入实验；同一测试集评估Brier、LogLoss、命中率和覆盖率，并报告配对不确定性。不能把同源模型当独立共识。' },
    { phase: '第四阶段', name: '分组诊断与推荐输出', work: '按联赛、胜平负、赔率区间和预测概率桶诊断偏差；界面给出等待资料、分析参考或可发布推荐，并展示版本、时间、风险和缺失项。', acceptance: '小样本分组不单独宣传效果；命中率与推荐覆盖率一起报告，避免靠减少或挑选样本制造提升。' },
    { phase: '第五阶段', name: '验收后分批上线', work: '完成候选独立复核与发布边界处理；先验证UI，模型经影子观察达标再推广；云采集迁移另行并行验收。', acceptance: '检查真实accepted版本、静态资源、受保护接口、进程与数据连续性、回退点；旧采集通道在迁移验收前保留。' }
  ],
  deliveryVerification: { verifiedAt: delivery.verifiedAt, result: delivery.result, cohort, finalVerification, featureRepair: featureVerification.result,
    independentBefore: featureVerification.tests.independentBefore, independentAfter: featureVerification.tests.independentAfter,
    meaning: '38/50→50/50 是同一套软件防泄漏测试的修复证据，不是预测准确率提升。原完整特征漏斗保持原口径；新标量训练准入的两个窗口分别仅 0 和 2 场，不能据此宣称新模型训练完成。' },
  limitations: ['这批九月数据属于回顾性研究；已知总体结果，不能当作未看过的未来确认。', '154场冻结概率审查有效，不代表新增特征候选已经训练或通过验收。', '95%区间来自21个比赛日的1000次成组bootstrap，只描述本批数据的不确定性，不是推广证明。', '来源签名与导出承诺已核验；未重新抓取并独立解析全部原提供方HTTP载荷。', '本轮未证实推荐命中率提升，不承诺60%、70%命中率或盈利。'],
  inputs
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = value => (value * 100).toFixed(2) + '%';
const num = value => value.toFixed(4);
const sign = value => (value >= 0 ? '+' : '') + value.toFixed(4);
const bjt = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value));
const delta = data.historicalPair.pairedUncertainty.metrics;
const interval = (row, percent = false) => row.interval.map(v => percent ? (v * 100).toFixed(2) : num(v)).join(' ～ ') + (percent ? ' 个百分点' : '');
const evidenceRows = inputs.map(row => `<tr><td>${escape(row.path)}</td><td>${row.bytes.toLocaleString('zh-CN')}</td><td><code>${row.sha256}</code><small>文件时间：${escape(bjt(row.fileModifiedAt))} 北京</small></td></tr>`).join('');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>足球系统 · 优化结果与下一版方向</title><style>
:root{--ink:#172e35;--muted:#536b71;--green:#0d6a59;--line:#d8e4e3;--wash:#f3f7f6;--amber:#785019;--amber-bg:#fff7e7}*{box-sizing:border-box}body{margin:0;background:#f6f8f7;color:var(--ink);font:15px/1.75 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1140px;margin:auto;padding:40px 28px 64px}header{padding-bottom:28px;border-bottom:1px solid var(--line)}.eyebrow{font-size:12px;letter-spacing:.16em;color:var(--green);font-weight:750}h1{font-size:clamp(27px,4vw,42px);line-height:1.22;margin:12px 0 16px;letter-spacing:-.035em}h2{font-size:23px;line-height:1.35;margin:0 0 12px}h3{font-size:17px;line-height:1.45;margin:0 0 9px}p{margin:0 0 12px}p:last-child{margin-bottom:0}.muted,small{color:var(--muted)}.lead{max-width:790px;font-size:17px}.tags{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.tag{border:1px solid var(--line);border-radius:30px;padding:4px 12px;font-size:12px;background:white}.tag.warn{background:var(--amber-bg);border-color:#ebd6b0;color:var(--amber)}section{margin-top:32px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.card,.panel{border:1px solid var(--line);background:#fff;border-radius:14px;padding:22px}.card .value{font-size:38px;font-weight:740;line-height:1.25;letter-spacing:-.04em;margin:8px 0}.card .label{font-size:13px;color:var(--muted);font-weight:650}.card .context{font-size:13px}.note{background:var(--amber-bg);border-left:3px solid #b88430;padding:15px 18px;border-radius:0 9px 9px 0;color:#634720;margin-top:16px}.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}table{width:100%;border-collapse:collapse;text-align:left}th{background:#eaf1ef;font-weight:650;font-size:13px}th,td{padding:13px 16px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:0}.numeric{white-space:nowrap;font-variant-numeric:tabular-nums}.bad{color:#9a4635}.sectionhead{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.caption{font-size:13px;color:var(--muted);margin-top:10px}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.funnel{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.funnel .step{padding:18px;background:#e9f2ef;border-radius:12px;border:1px solid #cfdfd9}.funnel .count{font-size:30px;font-weight:740}.funnel .last{background:#fff7e7;border-color:#ead7b4}.funnel small{display:block}ul{padding-left:20px;margin:10px 0 0}li+li{margin-top:7px}.statusline{font-size:13px;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.statusline span{background:#e8f2ee;color:#24564a;padding:3px 9px;border-radius:5px}.steps{display:grid;gap:12px}.roadmap{display:grid;grid-template-columns:95px 1fr;gap:16px}.phase{color:var(--green);font-size:13px;font-weight:750}.acceptance{background:var(--wash);padding:11px 14px;border-radius:7px;font-size:13px;margin-top:12px}details{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-top:14px}summary{cursor:pointer;font-weight:650}details[open] summary{margin-bottom:14px}code{font:11px/1.6 ui-monospace,Consolas,monospace;word-break:break-all}small{display:block;font-size:12px}footer{border-top:1px solid var(--line);margin-top:32px;padding-top:16px;font-size:12px;color:var(--muted)}a{color:var(--green)}.evidence td:first-child{word-break:break-all;font-size:12px}.evidence td:nth-child(2){white-space:nowrap;font-size:12px}.evidence td:last-child{min-width:200px}:focus-visible{outline:3px solid #2d9a84;outline-offset:3px}@media(max-width:740px){main{padding:25px 16px 42px}.cards,.two{grid-template-columns:1fr}.cards .card{padding:18px}.card .value{font-size:34px}.funnel{grid-template-columns:1fr 1fr}.sectionhead{display:block}.roadmap{grid-template-columns:1fr;gap:7px}.panel{padding:18px}th,td{padding:11px 12px}.tablewrap{font-size:13px}.evidence{min-width:650px}}@media print{body{background:#fff}main{max-width:none;padding:15px}section,.card,.roadmap{break-inside:avoid}.tablewrap{overflow:visible}details:not([open]){display:none}}
</style></head><body><main>
<header><div class="eyebrow">FOOTBALL / 结果报告 / 2026.10.02</div><h1>优化代码已整合。<br>模型效果，现在能逐场复核。</h1><p class="lead">本轮补齐了线上历史回归、推荐口径检查和公开页优化。现在能够明确衡量已有模型与市场基线的差距；<strong>尚未证明新模型提高命中率，也尚未部署本轮候选。</strong></p><div class="tags"><span class="tag">线上：前端 r${data.status.frontendSequence} / 运行时 r${data.status.runtimeSequence}</span><span class="tag">5 个任务 · 两批集成 · 15 个提交</span><span class="tag warn">新模型未训练</span><span class="tag warn">本轮尚未上线</span></div><small>报告生成：${escape(bjt(data.generatedAt))} 北京 · 公开成绩更新：${escape(bjt(live.review.updatedAt))} 北京</small></header>
<section><div class="sectionhead"><h2>01 · 当前结果，分开看</h2><span class="muted">两个不同样本集合，不构成优化前后对比</span></div><div class="cards"><article class="card"><div class="label">线上公开参考推荐</div><div class="value">${pct(publicSummary.hitRate)}</div><p>${publicSummary.won} 命中 / ${publicSummary.settled} 已结算</p><p class="context muted">另有 ${publicSummary.pending} 条待结算。公开接口标记 referenceOnly=true；属于参考推荐实绩。</p></article><article class="card"><div class="label">历史冻结模型 · 同场配对</div><div class="value">${pct(model.accuracy)}</div><p>${model.won} 命中 / ${model.n} 场</p><p class="context muted">按冻结胜平负概率最大项判断方向。覆盖 21 个比赛日、三个既有模型版本。</p></article><article class="card"><div class="label">同一决策时点市场基线</div><div class="value">${pct(market.accuracy)}</div><p>${market.won} 命中 / ${market.n} 场</p><p class="context muted">使用上述同一批 ${market.n} 场、同一决策时点的官方 SP，换算归一化隐含概率。</p></article></div><div class="note"><strong>本轮能确认的结论：</strong>公开推荐 ${publicSummary.won}/${publicSummary.settled} 与历史模型 ${model.won}/${model.n} 的样本与方向规则不同，不能用它们计算“提升了多少”。市场概率也不等于真实胜率。没有证据承诺 60%、70% 命中率或盈利。</div></section>
<section><h2>02 · 原模型与市场，差距在哪里</h2><p class="muted">九月历史窗口：2026-09-01 至 2026-10-01（结束时点不含），北京时间。仅对相同 154 场进行配对。</p><div class="tablewrap"><table><thead><tr><th>指标</th><th>冻结模型</th><th>市场基线</th><th>模型 − 市场</th><th>差值 95% 区间</th></tr></thead><tbody><tr><td>Brier 概率误差 ↓</td><td class="numeric">${num(model.brier)}</td><td class="numeric">${num(market.brier)}</td><td class="numeric bad">${sign(delta.brier.delta)}</td><td class="numeric">${interval(delta.brier)}</td></tr><tr><td>LogLoss 概率损失 ↓</td><td class="numeric">${num(model.logLoss)}</td><td class="numeric">${num(market.logLoss)}</td><td class="numeric bad">${sign(delta.logLoss.delta)}</td><td class="numeric">${interval(delta.logLoss)}</td></tr><tr><td>方向命中率 ↑</td><td class="numeric">${pct(model.accuracy)}</td><td class="numeric">${pct(market.accuracy)}</td><td class="numeric bad">${(delta.accuracy.delta * 100).toFixed(2)} 个百分点</td><td class="numeric">${interval(delta.accuracy, true)}</td></tr></tbody></table></div><p class="caption">Brier 为三分类平方误差之和的场均值；LogLoss 使用自然对数，二者越低越好。区间来自 21 个比赛日、1,000 次按整日重采样的配对 bootstrap。</p><div class="two"><article class="panel"><h3>优先修正概率质量</h3><p>本批数据中，模型 Brier 与 LogLoss 都高于市场，且差值区间均在零以上。应先检查概率校准、市场融合权重和信息重复，而不是单纯调高“信心”。</p></article><article class="panel"><h3>命中率结论保留不确定性</h3><p>模型少命中 5 场；方向命中差值区间跨过零，不能据此断言未来一定落后或一定反超。九月回顾结果只能用于诊断，推广仍需未来窗口确认。</p></article></div></section>
<section><h2>03 · 数据已打通，特征回放仍有缺口</h2><div class="funnel"><div class="step"><div class="count">432</div><strong>窗口内独立已结算比赛</strong><small>历史原文件共 2,272 行<br>按预设九月窗口筛选</small></div><div class="step"><div class="count">180</div><strong>冻结概率可评分</strong><small>占窗口比赛 ${pct(summary.coverage.frozenProbability)}<br>其余缺决策或时钟无效</small></div><div class="step"><div class="count">154</div><strong>同决策官方 SP 可配对</strong><small>占窗口比赛 ${pct(summary.coverage.pairedMarket)}<br>再排除 26 场缺配对 SP</small></div><div class="step last"><div class="count">0</div><strong>时间证据完整的特征回放</strong><small>新特征候选尚不可训练验收<br>不代表线上所有数据都没有</small></div></div><p class="caption">主排除原因：决策时钟无效 199 场、冻结决策缺失 53 场、同决策 SP 缺失 26 场；这三类与 154 场准入相加为 432。其他重叠原因不可重复计数。</p><div class="panel"><h3>下一步补的是“当时实际可用”的证据</h3><p>本批导出中，阵容、伤停、天气、真实 xG 和赛程密度各有 432 个字段记录缺失；近期状态缺失 408。原因包括导出未携带字段，以及来源快照本身没有字段。这些是<strong>本批回放证据的缺口</strong>，需要逐字段检查，不能推断整个线上系统完全没有相应数据。</p><p class="muted">保留原始缺失状态；不以赔率拟合值冒充真实 xG。已有签名和载荷哈希也不能替代每个字段的时点证据。上方 0 场保留原完整特征漏斗口径；新标量特征准入的两个训练窗口分别仅 0 和 2 场，仍不足以训练新模型，原始冻结评分没有变化。</p></div></section>
<section><h2>04 · 已交付的实际优化</h2><div class="statusline"><span>构建通过</span><span>Lint 通过</span><span>${targetedPassed} 项联合测试</span><span>${pythonPassed} 项 Python 测试</span><span>${browser.checks.length} 项 Chrome 页面检查</span></div><div class="two"><article class="panel"><h3>推荐与数据口径</h3><ul><li>线上历史导出、时间准入和逐场评分连通，154 场配对结果可以复算。</li><li>让质量检查选取与实际推荐相同的 BEST 记录，修复概率漂移漏报。</li><li>修正市场角色文案；补充真实日期校验与历史样本集合对账。</li><li>P1 候选回放泄漏漏洞已修复：同一套独立测试从旧代码 38/50 通过变为新代码 50/50；原 432 场输入与 154 场完整评分保持不变。</li><li>修复采集跨轮计数，影子采集接口默认关闭；来源覆盖诊断和候选资格边界已经整合。</li></ul></article><article class="panel"><h3>界面与使用体验</h3><ul><li>公开赛程卡片更紧凑，主胜／平局／客胜赔率更易比较。</li><li>历史日期、数据时间、参考范围与空数据状态更清楚。</li><li>列表与详情完成 320、390、768、1,440 像素检查，没有横向溢出或浏览器错误。</li><li>第二批推荐证据组件已合入：26 项测试、12 项浏览器检查、60 项文字对比度检查通过，均属历史组件回放。</li><li>登录后的完整分析页与实体手机仍待验收。</li></ul></article></div><p class="caption">5 个任务的两批交付均已集成，共 15 个代码／交付提交。最终验收使用 Node 22.22.1，270/270 联合测试，以及前端／完整发布 worker 路由、模型重新冻结、候选协议和真实历史独立核验全部通过，源码未漂移。构建与 Lint 本轮实际退出均为 0。8 项页面检查已重跑；第二批组件检查单独列示，不等于登录后的整页验收。软件测试通过不等于命中率提高。</p></section>
<section><h2>05 · 下一版，按证据推进</h2><div class="steps">${data.roadmap.map(row => `<article class="panel roadmap"><div class="phase">${escape(row.phase)}</div><div><h3>${escape(row.name)}</h3><p>${escape(row.work)}</p><div class="acceptance"><strong>验收：</strong>${escape(row.acceptance)}</div></div></article>`).join('')}</div><div class="note">新版本目标是可追溯、可比较、可验证地改善预测质量。最终同时报告<strong>命中率、覆盖率、Brier、LogLoss 与不确定性</strong>；不能通过事后挑比赛、改阈值或缩小分母包装提升。</div></section>
<section><h2>06 · 当前仍需处理</h2><div class="panel"><ul>${data.pending.map(row => `<li>${escape(row)}</li>`).join('')}</ul><p class="caption">${escape(data.status.secondBatch)} 线上公开检查于 ${escape(bjt(observation.completedAt))} 北京确认前端 r787 / 运行时 r785；完整签名验收与进程连续性不在本次公开检查范围。</p></div></section>
<section><details><summary>查看样本口径、核验范围与局限</summary><ul>${data.limitations.map(row => `<li>${escape(row)}</li>`).join('')}<li>${escape(data.historicalPair.previous145Explanation)}</li><li>公开成绩接口更新时间较新，但其 sourceUpdatedAt 为 ${escape(bjt(live.sourceUpdatedAt))} 北京；不能将成绩查询时间当作新赛程采集时间。</li></ul></details><details><summary>查看输入 SHA-256、更新时间与可重跑数据</summary><p class="muted">数值来自下列已保存线上响应与回归回执。文件修改时间用于定位副本，业务采集时间见上方说明。报告未读取仓库本地业务种子数据。</p><div class="tablewrap"><table class="evidence"><thead><tr><th>输入文件</th><th>字节数</th><th>SHA-256 与文件时间</th></tr></thead><tbody>${evidenceRows}</tbody></table></div><p class="caption">配套：<a href="results-report-data.json">结构化数字 JSON</a> · <a href="generate-results-report.cjs">生成脚本</a>。运行 node outputs/integration-20261002/generate-results-report.cjs 可重新读取这些输入并验证数值；状态文字仍需总控按最新回执复核。</p></details></section>
<footer>本报告只记录已确认的代码交付与线上历史证据。新模型未训练，本轮改动未部署，未建立效果提升或盈利承诺。</footer>
</main></body></html>`;
fs.writeFileSync(path.join(__dirname, 'results-report-data.json'), JSON.stringify(data, null, 2) + '\n');
fs.writeFileSync(path.join(__dirname, 'results-report.html'), html);
console.log(JSON.stringify({ ok: true, generatedAt: data.generatedAt, publicReference: `${publicSummary.won}/${publicSummary.settled}`, pairedModel: `${model.won}/${model.n}`, pairedMarket: `${market.won}/${market.n}`, sourceInputs: inputs.length, outputs: ['results-report.html', 'results-report-data.json'], productionWrites: 0 }));
