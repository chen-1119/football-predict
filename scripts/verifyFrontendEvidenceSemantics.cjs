const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(fullPath) : [fullPath];
});

const sourceFiles = walk(path.join(rootDir, 'src'))
  .filter((file) => /\.(?:ts|tsx)$/.test(file));
const sourceText = sourceFiles.map((file) => read(path.relative(rootDir, file))).join('\n');
const presentation = read('src/services/predictionPresentation.ts');
const recommendationCopy = read('src/services/recommendationCopy.ts');
const displayRecommendation = read('src/services/displayRecommendation.ts');
const predictions = read('src/pages/PredictionsList.tsx');
const bestTips = read('src/pages/BestTips.tsx');
const detail = read('src/pages/MatchDetail.tsx');
const worldCup = read('src/pages/WorldCup.tsx');
const betSlip = read('src/pages/BetSlipGenerator.tsx');
const css = read('src/index.css');
const recommendationEvidenceFacts = read('src/components/predictions/RecommendationEvidenceFacts.tsx');
const recommendationEvidenceCss = read('src/styles/recommendation-evidence.css');
const recommendationCenter = read('src/components/recommendations/RecommendationCenter.tsx');
const publishedMatchPick = read('src/components/recommendations/PublishedMatchPick.tsx');
const publishedMatchRecommendation = read('src/services/publishedMatchRecommendation.ts');
const recommendationCenterView = read('src/services/recommendationCenterView.ts');
const recommendationCenterHook = read('src/hooks/useRecommendationCenter.ts');
const selectionQualityNote = read('src/components/recommendations/SelectionQualityNote.tsx');
const marketComparison = read('src/components/recommendations/MarketComparison.tsx');
const dayCoverage = read('src/components/recommendations/DayCoverage.tsx');
const publishedDetailPresentation = read('src/services/publishedDetailPresentation.ts');
const server = read('server/index.cjs');

const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

check('legacy trust score is explicitly ordinal evidence, not probability',
  presentation.includes('ordinal evidence score, never a')
  && presentation.includes('return boundedScore(prediction.trustScore)'));
check('evidence score uses points and never percent formatting',
  presentation.includes('`${Math.round(score)}/100`')
  && !presentation.includes('`${Math.round(score)}%`'));
check('calibrated model probability fails closed', [
  "model.calibration?.status !== 'calibrated'",
  'Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) <= 1',
  'return probability === null ? null',
  "model?.version"
].every((needle) => presentation.includes(needle)));
check('derived model-only references cannot manufacture an evidence score',
  presentation.includes('DERIVED_REFERENCE_TIER')
  && presentation.includes('!prediction.multiFactorEvidence')
  && presentation.includes("prediction.confidence?.available === false")
  && presentation.includes("prediction.confidence?.band === 'unavailable'"));
check('public confidence facts are separated without legacy-score fallback',
  presentation.includes('getRecommendationEvidenceBreakdown')
  && presentation.includes('evidenceCompleteness')
  && presentation.includes('marketConsistency')
  && presentation.includes('calibrationSample')
  && presentation.includes('freshnessQuality')
  && presentation.includes('never backfilled from the aggregate legacy trust score'));
const evidenceBreakdownStart = presentation.indexOf('export const getRecommendationEvidenceBreakdown =');
const evidenceBreakdownEnd = presentation.indexOf('export const getPublishedRecommendationEvidenceBreakdown =', evidenceBreakdownStart);
const evidenceBreakdownSource = presentation.slice(evidenceBreakdownStart, evidenceBreakdownEnd);
const evidenceBreakdownExecutableSource = evidenceBreakdownSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
check('four-dimension model probability reads only the v4 public metric',
  evidenceBreakdownStart >= 0
  && evidenceBreakdownEnd > evidenceBreakdownStart
  && evidenceBreakdownSource.includes('modelProbability: normalizedPercent(metrics?.modelProbability)')
  && !evidenceBreakdownExecutableSource.includes('getCalibratedModelProbability(')
  && !/\b(?:trustScore|odds|posterior|marketProbability)\b/.test(evidenceBreakdownExecutableSource));
check('legacy model facts remain audited and unified list/detail use bound publication facts',
  predictions.includes('<PublishedMatchPick row={unifiedRow}')
  && detail.includes('<RecommendationEvidenceFacts')
  && detail.includes('publishedDecision={useUnified ? unifiedRow?.decision || null : undefined}')
  && recommendationEvidenceFacts.includes('if (publishedDecision !== undefined)')
  && recommendationEvidenceFacts.includes('publishedDetailPresentation(publishedDecision)')
  && recommendationEvidenceFacts.includes('data-decision-id={view?.decisionId}')
  && recommendationEvidenceFacts.includes('data-record-hash={view?.recordHash}')
  && recommendationEvidenceFacts.includes('getPublishedRecommendationEvidenceBreakdown(match, prediction)')
  && recommendationEvidenceFacts.includes("'模型概率'")
  && recommendationEvidenceFacts.includes("'方向输入覆盖'")
  && recommendationEvidenceFacts.includes("'市场一致性'")
  && recommendationEvidenceFacts.includes("'决策时数据时效'")
  && recommendationEvidenceFacts.includes("'校准样本'")
  && recommendationEvidenceFacts.includes('recommendation-evidence-facts__sample')
  && recommendationEvidenceFacts.includes('breakdown.freshnessObservedAt')
  && recommendationEvidenceFacts.includes('breakdown.freshnessSourceUpdatedAt')
  && recommendationEvidenceFacts.includes('breakdown.freshnessAsOf')
  && recommendationEvidenceFacts.indexOf('breakdown.freshnessObservedAt')
    < recommendationEvidenceFacts.indexOf('breakdown.freshnessSourceUpdatedAt')
  && recommendationEvidenceFacts.indexOf('breakdown.freshnessSourceUpdatedAt')
    < recommendationEvidenceFacts.indexOf('breakdown.freshnessAsOf')
  && !recommendationEvidenceFacts.includes('breakdown.freshnessEvaluatedAt')
  && recommendationEvidenceFacts.includes("'观测时间未知'")
  && recommendationEvidenceFacts.includes('data-testid="recommendation-evidence-breakdown"'));
check('four-dimension confidence display fails closed without legacy or neutral backfill',
  recommendationEvidenceFacts.includes("breakdown.modelProbability === null")
  && recommendationEvidenceFacts.includes("formatEvidenceCompleteness(breakdown, '--')")
  && recommendationEvidenceFacts.includes("formatMarketConsistency(breakdown, language, '--')")
  && recommendationEvidenceFacts.includes("formatFreshnessQuality(breakdown, '--')")
  && recommendationEvidenceFacts.includes("formatCalibrationSample(breakdown, '--')")
  && !recommendationEvidenceFacts.includes('trustScore'));
check('page confidence facts bind back to an API-published prediction identity',
  presentation.includes('resolvePublishedEvidencePrediction')
  && presentation.includes('samePublishedPredictionIdentity')
  && presentation.includes('getPublishedRecommendationEvidenceBreakdown')
  && presentation.includes('Array.isArray(match.predictions) ? match.predictions : []')
  && presentation.includes('resolvePublishedEvidencePrediction(match, displayedPrediction)')
  && recommendationEvidenceFacts.includes('getPublishedRecommendationEvidenceBreakdown(match, prediction)')
  && !recommendationEvidenceFacts.includes('getRecommendationEvidenceBreakdown(match, prediction)'));
const publicConfidenceProjectionStart = server.indexOf('const CURRENT_LIST_PUBLIC_CONFIDENCE_METRIC_KEYS =');
const publicConfidenceProjectionEnd = server.indexOf('const compactPredictionForCurrentList =', publicConfidenceProjectionStart);
const publicConfidenceProjection = server.slice(publicConfidenceProjectionStart, publicConfidenceProjectionEnd);
check('current list API carries only the public facts consumed by the four-dimension display',
  publicConfidenceProjectionStart >= 0
  && publicConfidenceProjectionEnd > publicConfidenceProjectionStart
  && [
    'modelProbability',
    'evidenceCompleteness',
    'marketConsistency',
    'calibrationSample',
    'freshnessQuality',
    'freshnessObservedAt',
    'freshnessSourceUpdatedAt',
    'freshnessAsOf',
  ].every((field) => publicConfidenceProjection.includes(`"${field}"`))
  && server.includes('confidence: compactPublicConfidenceForCurrentList(prediction.confidence)')
  && !/\b(?:components|penalties|unavailableReasons|priceIndependent)\b/.test(publicConfidenceProjection)
  && !/\.\.\.(?:confidence|source|compact)/.test(publicConfidenceProjection));
check('confidence facts remain readable on narrow screens',
  recommendationEvidenceCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))')
  && recommendationEvidenceCss.includes('@media (max-width: 720px)')
  && recommendationEvidenceCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))')
  && recommendationEvidenceCss.includes('@media (max-width: 480px)')
  && recommendationEvidenceCss.includes('grid-column: 1 / -1'));
check('legacy confidence labels and trust percentages are absent from frontend source',
  !/(推荐强度|分析置信度|Pick Strength|pick strength|Analysis Confidence|Analysis confidence)/.test(sourceText)
  && !/trustScore[^\n]{0,80}%/.test(sourceText)
  && !/averageTrust[^\n]{0,40}%/.test(sourceText)
  && !/minTrust[^\n]{0,40}%/.test(sourceText));
check('public copy labels score as evidence and forces references neutral',
  recommendationCopy.includes('证据评分 ${formatEvidenceScore(prediction)}')
  && recommendationCopy.includes("strengthTone: hasPick ? strengthTone : 'pending'")
  && recommendationCopy.includes('!options.forceReference'));
check('list and detail copy resolve the same official outcome odds before stored fallback',
  recommendationCopy.includes("import { getOfficialMatchOdds } from './bettingDisplay'")
  && recommendationCopy.includes('const officialOutcomeOddsForPrediction = (')
  && recommendationCopy.includes("prediction.oddsPoolCode === 'HHAD'")
  && recommendationCopy.includes('!hasCurrentOfficialResultPoolIdentity(match, prediction)')
  && recommendationCopy.includes('const forceUnavailableSp = isDirectionalResultPrediction && !hasResultPoolIdentity')
  && recommendationCopy.includes("? 'SP --'")
  && recommendationCopy.includes("'模型 1X2'")
  && recommendationCopy.includes("prediction.tipCode === 'X'")
  && recommendationCopy.includes('const officialOddsValue = officialOutcomeOddsForPrediction(match, prediction)')
  && recommendationCopy.includes('officialOddsValue > 1')
  && recommendationCopy.includes('storedOddsValue > 1'));
check('published handicap extension comes only from the bound decision',
  displayRecommendation.includes('export const getAnalysisReferenceHandicapSupplement = (')
  && displayRecommendation.includes("referenceSource === 'published-reference'")
  && detail.includes('getAnalysisReferenceHandicapSupplement(')
  && detail.includes('detailAnalysisReferenceSelection?.source')
  && recommendationCenter.includes('primarySelectionSummary(d)')
  && recommendationCenter.includes('handicapExtensionText(h,language)')
  && publishedMatchPick.includes('primarySelectionSummary(d)')
  && publishedMatchPick.includes('handicapExtensionText(h,language)')
  && !predictions.includes('getListHandicapSupplement(')
  && !detail.includes('getListHandicapSupplement('));
check('unified HAD and HHAD prices remain distinct and bound to archived selections',
  recommendationCenter.includes('rc-primary-pick--had')
  && recommendationCenter.includes('rc-primary-pick--hhad')
  && recommendationCenter.includes("selection.market==='HHAD'")
  && recommendationCenter.includes("comboLegSelection(combo,index)")
  && recommendationCenterView.includes("if(market==='HAD')")
  && recommendationCenterView.includes("if(handicapLine!==0||tipCode!==parent.tipCode||odds!==parent.odds)")
  && recommendationCenterView.includes("if(!h||handicapLine===0||handicapLine!==h.handicapLine)")
  && recommendationCenterView.includes("throw new Error('Selection differs from archived market evidence')"));
check('reference copy keeps the generated BEST direction stable while updating evidence',
  recommendationCopy.includes('不会用市场概率首位改写已生成的主方向')
  && recommendationCopy.includes('赛前 BEST 主方向保持稳定')
  && !recommendationCopy.includes('参考推荐会随赔率、盘口与数据质量变化'));
check('unified coverage and published picks keep qualified selection separate from model direction',
  bestTips.includes('<RecommendationCenter language={language}')
  && recommendationCenter.includes("data?.current.filter(row=>!qualifiedOnly||row.selectionQuality?.qualified)")
  && recommendationCenter.includes('<DayCoverage coverage={data?.coverage}')
  && dayCoverage.includes('current.qualifiedCount')
  && dayCoverage.includes('current.targetCount')
  && dayCoverage.includes('item.reasonText')
  && recommendationCenter.includes("quality.qualified===false?(zh?'观望方向'")
  && recommendationCenter.includes("selectionPriceStatus(quality)==='unsupported'?(zh?'模型方向 · 价格不支持'")
  && recommendationCenter.includes("data-price-status={reviewSelection?.selectedMarket==='HHAD'?'unknown':selectionPriceStatus(quality)}")
  && selectionQualityNote.includes('quality.reasons.map')
  && selectionQualityNote.includes('暂不进入新串关'));
check('new published surfaces are reference only and old formal actions retain their gate',
  detail.includes('isFormalPresentationAllowed(')
  && worldCup.includes('isFormalPresentationAllowed(')
  && !predictions.includes('isFormalPresentationAllowed(')
  && predictions.includes('const nowMs = clockNow')
  && !predictions.includes('const nowMs = Math.max')
  && bestTips.includes('<RecommendationCenter language={language}')
  && betSlip.includes('<RecommendationCenter language={language}')
  && recommendationCenter.includes('参考推荐 · 模型验证中')
  && publishedMatchPick.includes('参考入选 · 尚未通过正式验证')
  && recommendationCenterHook.includes("buildApiUrl('/api/v1/daily-featured-combos')")
  && recommendationCenterHook.includes("cache:'no-store'")
  && recommendationCenterHook.includes('data:authorizationRequired?null:snapshot.data')
  && !recommendationCenter.includes('isFormalPresentationAllowed('));
check('reference cards override positive green treatments', [
  '.decision-card.is-reference.is-steady',
  '.decision-card.is-reference.is-lean',
  '.signal-summary-card.is-reference .signal-badge'
].every((needle) => css.includes(needle)));
check('all current published rows remain visible and reference selection is not counted as missing',
  recommendationCenter.includes('const visibleRows=rows')
  && recommendationCenter.includes('visibleRows.map(row=><Pick')
  && recommendationCenter.includes('row.selectionQuality?.qualified')
  && recommendationCenter.includes('暂时没有可展示的推荐')
  && !recommendationCenter.includes('visibleRows.slice(0, 3)')
  && recommendationCenter.includes('data?.review.statistics'));
check('published and settled totals come from verified ledger, not list inference',
  recommendationCenter.includes('value?.hitRate==null')
  && recommendationCenter.includes('${value.won} / ${value.settled}')
  && recommendationCenter.includes('value?.pending')
  && recommendationCenterView.includes("throw new Error('Inconsistent statistics')")
  && publishedMatchRecommendation.includes('const rows = data.current.filter(matches)')
  && publishedMatchRecommendation.includes('Date.parse(d.eventVersion) === event')
  && publishedMatchRecommendation.includes('Date.parse(d.kickoffTime) === event')
  && publishedMatchRecommendation.includes('name(d.homeTeamName) === name(match.homeTeamName)')
  && publishedMatchRecommendation.includes('name(d.awayTeamName) === name(match.awayTeamName)'));
check('published cards expose identity, prices, clocks and reference status',
  recommendationCenter.includes('data-decision-id={d.decisionId}')
  && recommendationCenter.includes('data-record-hash={d.recordHash}')
  && recommendationCenter.includes('d.modelGeneratedAt')
  && recommendationCenter.includes('d.quoteObservedAt')
  && recommendationCenter.includes('d.publishedAt')
  && publishedMatchPick.includes('Date.parse(d.cutoffTime)')
  && publishedMatchPick.includes('data-selection-status={row.selectionQuality?.status')
  && publishedMatchPick.includes('quoteStale')
  && !recommendationCenter.includes('500.com data supplements'));
check('model validation status and daily coverage remain visible',
  recommendationCenter.includes('data?.review.qualityReport')
  && recommendationCenter.includes('modelQuality.independentMatchDays')
  && recommendationCenter.includes('modelQuality.minimumSettled')
  && recommendationCenter.includes('modelQuality.minimumMatchDays')
  && recommendationCenter.includes('缺赛果不计入命中率')
  && dayCoverage.includes('coverage?.businessDate === businessDate')
  && dayCoverage.includes('current.missing'));
check('new published probabilities are labeled unvalidated and bound to one decision',
  recommendationCenter.includes('概率与让球分析')
  && recommendationCenter.includes('<MarketComparison decision={d}')
  && marketComparison.includes('buildMarketComparison(decision)')
  && marketComparison.includes('data-decision-id={comparison.decisionId}')
  && marketComparison.includes('概率为模型估计 · 尚未验证')
  && marketComparison.includes('未保存可核验的完整报价；缺失项不补价。')
  && recommendationEvidenceFacts.includes('breakdown.modelProbability')
  && publishedDetailPresentation.includes('decisionId: decision.decisionId, recordHash: decision.recordHash')
  && !sourceText.includes('formatGptProbability'));
check('lineup referee injury and xG cards require auditable provenance before success',
  detail.includes('const hasAuditableSource = (signal:')
  && detail.includes('signal?.verified === true')
  && detail.includes("Date.parse(String(signal.sourceObservedAt || ''))")
  && detail.includes('hasAuditableSource(confirmedLineupSignal)')
  && detail.includes('hasAuditableSource(externalSignals?.injuries)')
  && detail.includes('hasAuditableSource(externalSignals?.referee)')
  && detail.includes('const verifiedXgReady = Boolean(')
  && detail.includes("tone: verifiedXgReady ? 'success' : xgHasValue ? 'warning' : 'neutral'"));
check('published settlement is tied to record state while legacy references stay observational',
  recommendationCenter.includes("resultLabel(settlement.state,zh)")
  && recommendationCenter.includes('selected?resultLabel(selected.state,zh)')
  && recommendationCenter.includes('仅已结算计入命中率')
  && publishedMatchRecommendation.includes('row.settlement.state')
  && detail.includes('分析参考主方向符合赛果')
  && detail.includes('分析参考主方向不符合赛果'));
check('combination surface uses bound market, SP, cutoff and freshness instead of pseudo-probability',
  betSlip.includes('<RecommendationCenter language={language}')
  && recommendationCenter.includes('comboLegSelection(combo,index)')
  && recommendationCenter.includes('comboLaneFresh(data,now)')
  && recommendationCenter.includes('comboPreviewForSize(data,size,now,failed)')
  && recommendationCenter.includes('报价已超过15分钟有效期')
  && recommendationCenter.includes('不会改选第二方向凑SP')
  && recommendationCenterView.includes("throw new Error('Post-cutoff combo')")
  && recommendationCenterView.includes("throw new Error('Invalid SP product')")
  && recommendationCenter.includes('SP 只用于最低门槛')
  && recommendationCenter.includes('也未验证价格优势或真实串关命中率')
  && !recommendationCenter.includes('combo.probability')
  && !recommendationCenter.includes('combo.modelProbability'));

const failures = checks.filter((item) => !item.ok);
console.log(JSON.stringify({
  ok: failures.length === 0,
  verifier: 'frontend-evidence-semantics',
  assertions: checks.length,
  checks
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
