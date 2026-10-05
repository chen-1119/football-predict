'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const read = relative => JSON.parse(fs.readFileSync(path.join(__dirname, relative), 'utf8'));
const verification = read('integration-verification.json'), build = read('build-verification.json');
const model = read(fs.existsSync(path.join(__dirname, 'model/disagreement-attribution-v2.json')) ? 'model/disagreement-attribution-v2.json' : 'model/disagreement-attribution.json'), cloud = read('cloud/cloud-run.json');
const ui = read('ui/delivery-receipt.json'), source = read('source/closure-proof-replay.json');
const canonicalSources = read('source-line-endings.json');
const sourceHashLineage = source.codeFiles.map(file => {
  const relative = file.file || file.path;
  const prior = file.sha256;
  const raw = fs.readFileSync(path.resolve(__dirname, '../..', relative));
  const current = crypto.createHash('sha256').update(raw).digest('hex');
  const lineEnding = canonicalSources.files.find(row => row.path === relative);
  return { path: relative, currentSha256: current, recordedReplaySha256: prior, sameOrLfEquivalent: current === prior || Boolean(lineEnding?.beforeSha256 === prior && lineEnding?.afterSha256 === current) };
});
if (!verification.ok || !build.ok || !sourceHashLineage.every(row => row.sameOrLfEquivalent)) throw Error('Integration evidence incomplete');
const schedulePath = path.join(__dirname, 'cloud/schedule-persistence-update.json');
const report = {
  version: 'football-four-step-implementation-result-v1', createdAt: new Date().toISOString(),
  baseCommit: '295a173d117cbb0f889197dbeff13501d79dfd15', branch: 'codex/football-integration-oct02',
  deployed: false, formalModelChanged: false, accuracyUpliftDemonstrated: false,
  steps: [
    { id: 1, name: '修复数据同步', status: 'implemented-and-verified-locally', result: '实际同步流程加入官方停销证明，服务器与公开分发独立重验；缺文件、伪签名、不同周期或过期均拒绝。', onlineRootCause: '官方签名停止销售空列表触发旧非空断言，阻断worker完整性校验。', onlineRecoveryClaimed: false },
    { id: 2, name: '推荐模型诊断与审计修复', status: 'implemented-and-verified-locally', result: '拒绝非法日期和晚1纳秒输入；7类真实scorer输出与父提交一致。', pairedRows: 154, modelHits: 78, marketHits: 83, disagreementPatterns: model.observations.patterns, supplementaryRowsPrepared: 22, supplementExecuted: false, newTrainingEligibleRows: 0 },
    { id: 3, name: '推荐页面优化', status: 'implemented-and-verified-locally', result: '清晰展示等待资料、分析参考和资格缺口；合并重复验证卡，保留冻结概率、赔率和时间。', browserChecks: ui.browserChecks, widths: [320,390,768,1440], minimumContrast: ui.minContrast, fullAuthenticatedPageVerified: false },
    { id: 4, name: '云端资料交接与巡检', status: 'real-cloud-run-and-file-handoff-verified-migration-pending', result: '原包20文件/manifest19项恢复校验；三个自有接口真实读取；新模型诊断和355条恢复收据已跨端交接。', rawRunSha256: '7676b94235db4681b7e6fc3a2da0a77b7c6de88a04cf3f2e58e3738c805a0796', scratchContinuity: false, scheduleTimes: ['08:00','16:00'], timezone: 'Asia/Shanghai', enabledSchedules: 2, firstScheduledRunVerified: false, qualifiedOfficialTrialDays: 0, schedulePersistenceUpdate: fs.existsSync(schedulePath) ? read('cloud/schedule-persistence-update.json') : { status: 'requested-awaiting-platform-receipt' } },
  ],
  verification: { targetedChecksPassed: verification.totalPassed, fileHashChecksPassed: verification.evidence.length, build: build.ok, lint: build.jobs.find(row => row.name === 'eslint')?.exitCode === 0, sourceHashLineage, independentReview: 'source/independent-review.json' },
  productionObserved: { at: cloud.currentSourceFacts.sourceCheckedAt, dataFresh: cloud.currentSourceFacts.dataFresh, recommendationReliable: cloud.currentSourceFacts.recommendationReliable, trustedCollectors: cloud.currentSourceFacts.trustedCollectors, requiredTrustedCollectors: cloud.currentSourceFacts.requiredTrustedCollectors, currentMatches: cloud.currentSourceFacts.officialCurrentMatches, officialOddsMatches: cloud.currentSourceFacts.officialOddsMatches },
  limitations: ['没有部署；来源新鲜度和0/2独立采集器仍未达到发布验收要求。','新代码不会把休市或空响应转换成可推荐比赛。','旧verifyModelInputUsage验证脚本的固定过期赛程与旧基线问题仍保留；本轮用295a父提交完成真实算术兼容验证。','模型结论来自已检查的线上冻结历史数据，未证明新版本命中率提升。','云端定时首跑及连续7天官方采集验收未完成，旧通道尚未停用。'],
  next: ['取得新鲜双端点签名证明后，按既有发布门槛完成受控部署与线上sync验证。','补齐22份usageSummary和逐阶段算术回执，重点检查19场Poisson偏离与5场后续方向变化。','将预先登记候选放入未来冻结样本对照，持续比较Brier、LogLoss、覆盖率及同场命中率。','按08/16现有云日程验证恢复、持久存档与真实执行收据；满足连续7天验收后再切换。'],
};
report.modelSummaryEvidence = model.formEvidence;
fs.writeFileSync(path.join(__dirname, 'implementation-result.json'), JSON.stringify(report,null,2)+'\n');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>足球系统 · 本轮实施结果</title><style>body{margin:0;background:#f4f7f9;color:#152c3a;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1000px;margin:auto;padding:32px 20px}h1{font-size:32px;margin:8px 0}h2{font-size:21px;margin:8px 0}.eyebrow{color:#376457}.note{background:#fff4d9;border-left:4px solid #a96513;padding:14px 18px;border-radius:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:22px 0}.card{background:#fff;border:1px solid #dbe5e9;border-radius:14px;padding:22px}.num{color:#277965;font-weight:700}.muted{color:#516878;font-size:14px}table{border-collapse:collapse;width:100%;background:white}th,td{border-bottom:1px solid #dbe5e9;text-align:left;padding:12px}a{color:#185d85}li{margin:8px 0}footer{margin-top:30px;font-size:13px;color:#516878}@media(max-width:650px){.grid{grid-template-columns:1fr}h1{font-size:27px}.card{padding:18px}}</style><main><div class="eyebrow">2026年10月3日 · 本轮代码与云端交接</div><h1>四步优化实施结果</h1><p>已完成代码修改、真实线上证据回放和云端巡检交接。</p><div class="note"><b>当前尚未部署。</b> 线上来源新鲜度及独立采集器仍未满足验收；正式推荐与旧采集切换继续保持待验收。</div><div class="grid">${report.steps.map(row=>`<section class="card"><span class="num">0${row.id}</span><h2>${esc(row.name)}</h2><p>${esc(row.result)}</p><p class="muted">${row.id===4?'云端执行与文件回读已核验；定时首跑、7天官方采集待验收。':'代码已实现并通过本轮本地验证；线上生效待部署。'}</p></section>`).join('')}</div><section class="card"><h2>验证结果</h2><p><b>224 项检查通过</b> · 44 份文件哈希一致 · 完整构建和全库 lint 通过。</p><p>UI：四种宽度共20项浏览器检查；132个文字样本最低对比度8.48:1。测试使用线上冻结记录回放，合成边界另作标识。</p><p><a href="ui/after.html">打开实际组件预览</a> · <a href="integration-verification.json">验证明细</a> · <a href="cloud/cloud-run.json">云端原始运行回执</a></p></section><h2>模型优化依据</h2><table><thead><tr><th>同场、同决策的154场</th><th>命中</th><th>命中率</th></tr></thead><tbody><tr><td>既有冻结模型</td><td>78 / 154</td><td>50.65%</td></tr><tr><td>同期官方市场热门</td><td>83 / 154</td><td>53.90%</td></tr></tbody></table><p>26场分歧中：<b>19场</b>Poisson已明确偏离；<b>5场</b>在后续处理后方向不同；<b>2场</b>因保存精度无法确定。不是本轮优化后的准确率，也未据此反调生产阈值。</p><h2>下一步</h2><ol>${report.next.map(v=>`<li>${esc(v)}</li>`).join('')}</ol><details><summary>本轮边界与未完成项</summary><ul>${report.limitations.map(v=>`<li>${esc(v)}</li>`).join('')}</ul></details><footer>生成于 ${esc(report.createdAt)} · 分支 ${esc(report.branch)} · 原始JSON与SHA回执均保存在当前目录。</footer></main></html>`;
fs.writeFileSync(path.join(__dirname, 'implementation-result.html'), html.replace('224 项检查通过', verification.totalPassed + ' 项检查通过').replace('44 份文件哈希一致', verification.evidence.length + ' 份文件哈希一致').replace('<h2>下一步</h2>', '<p>云端QA发现7份摘要使用了晚于原决策的评估截止时间；诊断v2已修正，原决策可用性与训练准入仍未得到证明。</p><h2>下一步</h2>'));
console.log(JSON.stringify({ok:true,output:'outputs/implementation-20261003/implementation-result.html'}));
