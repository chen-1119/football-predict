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
const analysisReferenceSelection = read('src/services/analysisReferenceSelection.ts');
const predictions = read('src/pages/PredictionsList.tsx');
const bestTips = read('src/pages/BestTips.tsx');
const detail = read('src/pages/MatchDetail.tsx');
const worldCup = read('src/pages/WorldCup.tsx');
const betSlip = read('src/pages/BetSlipGenerator.tsx');
const css = read('src/index.css');
const recommendationEvidenceFacts = read('src/components/predictions/RecommendationEvidenceFacts.tsx');
const recommendationEvidenceCss = read('src/styles/recommendation-evidence.css');
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
check('list and detail recommendation cards render the four audited confidence facts',
  predictions.includes('<RecommendationEvidenceFacts')
  && detail.includes('<RecommendationEvidenceFacts')
  && recommendationEvidenceFacts.includes('getPublishedRecommendationEvidenceBreakdown(match, prediction)')
  && recommendationEvidenceFacts.includes("'模型概率'")
  && recommendationEvidenceFacts.includes("'证据完整度'")
  && recommendationEvidenceFacts.includes("'市场一致性'")
  && recommendationEvidenceFacts.includes("'数据时效'")
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
  recommendationEvidenceCss.includes('grid-template-columns: repeat(4, minmax(0, 1fr))')
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
check('published analysis references never synthesize a client handicap companion',
  displayRecommendation.includes('export const getAnalysisReferenceHandicapSupplement = (')
  && displayRecommendation.includes("referenceSource === 'published-reference'")
  && predictions.includes('getAnalysisReferenceHandicapSupplement(')
  && predictions.includes('analysisReferenceSelection?.source')
  && predictions.includes('marketSelection?.referenceSource')
  && detail.includes('getAnalysisReferenceHandicapSupplement(')
  && detail.includes('detailAnalysisReferenceSelection?.source')
  && !predictions.includes('getListHandicapSupplement(')
  && !detail.includes('getListHandicapSupplement('));
check('published MODEL_ONLY and mismatched HHAD identities stay detached from odds-table markers',
  predictions.includes("type ListMarketCode = ResultPoolCode | 'MODEL_ONLY_1X2'")
  && predictions.includes("referenceSource === 'published-reference' && prediction.oddsPoolCode === undefined")
  && predictions.includes("'模型 1X2（无官方 SP）'")
  && predictions.includes('isPublishedReferenceSpUnavailable')
  && predictions.includes("? 'SP --'")
  && predictions.includes('publishedHhadLineMatches')
  && predictions.includes("marketSelection.referenceSource !== 'published-reference'")
  && predictions.includes('sameHandicapLine('));
check('reference copy keeps the generated BEST direction stable while updating evidence',
  recommendationCopy.includes('不会用市场概率首位改写已生成的主方向')
  && recommendationCopy.includes('赛前 BEST 主方向保持稳定')
  && !recommendationCopy.includes('参考推荐会随赔率、盘口与数据质量变化'));
const referencePriority = [
  "isCalibratedMarketAnalysisReferenceEligible(match, storedBest, now)",
  "isDirectionalAnalysisReferenceEligible(match, storedBest, now)",
  "isModelOnlyAnalysisReferenceEligible(match, storedBest, now)",
  "const stableModelReference = buildStableLowEvidenceModelReference(match, storedBest, now)",
  "const officialMarketConsensus = buildOfficialMarketConsensusReference(match, undefined, now)",
  "const fiveHundred = buildFiveHundredMarketReferencePresentation(match, now)",
  "const lowEvidenceMarket = buildLowEvidenceMarketLeaderReference(",
].map((needle) => analysisReferenceSelection.indexOf(needle));
check('analysis coverage and executable best-pick surfaces use separate reference gates',
  predictions.includes("getOnSaleAnalysisReference as selectAnalysisReferencePrediction")
  && predictions.includes('allowModelOnly: true')
  && bestTips.includes("selectOnSaleAnalysisReference(match, { allowModelOnly: false, now })")
  && analysisReferenceSelection.includes('OFFICIAL_MARKET_REFERENCE_MIN_LEADER_PROBABILITY = 0.55')
  && analysisReferenceSelection.includes('OFFICIAL_MARKET_REFERENCE_MIN_LEADER_GAP = 0.08')
  && analysisReferenceSelection.includes('leader.probability < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_PROBABILITY')
  && analysisReferenceSelection.includes('leader.probability - runnerUp.probability < OFFICIAL_MARKET_REFERENCE_MIN_LEADER_GAP')
  && analysisReferenceSelection.includes("source: 'official-market-consensus'")
  && analysisReferenceSelection.includes("source: 'model-low-evidence'")
  && analysisReferenceSelection.includes('market probability leader cannot overwrite the model probability leader')
  && analysisReferenceSelection.includes('const probabilityLeader = modelOutcomeLeader(modelProbabilities, match.id)')
  && referencePriority.every((position) => position >= 0)
  && referencePriority.every((position, index) => index === 0 || position > referencePriority[index - 1])
  && !analysisReferenceSelection.includes("recommendationAction: 'recommend'"));
check('action surfaces keep the risk gate while published list picks stay visible read-only',
  [bestTips, detail, worldCup, betSlip]
    .every((source) => source.includes('isFormalPresentationAllowed('))
  && !predictions.includes('isFormalPresentationAllowed(')
  && predictions.includes('getOnSaleDisplayRecommendation(match, language, nowMs)')
  && predictions.includes('getLiveDisplayRecommendation(match, language)')
  && predictions.includes('const marketSelection = getListMarketSelection(')
  && predictions.includes('const nowMs = clockNow')
  && !predictions.includes('const nowMs = Math.max'));
check('reference cards override positive green treatments', [
  '.decision-card.is-reference.is-steady',
  '.decision-card.is-reference.is-lean',
  '.signal-summary-card.is-reference .signal-badge'
].every((needle) => css.includes(needle)));
const tipCardsStart = bestTips.indexOf('const tipCards = React.useMemo<TipCard[]>');
const dataCardsStart = bestTips.indexOf('const observationCards = React.useMemo<ObservationCard[]>', tipCardsStart);
const featuredCardsStart = bestTips.indexOf('const featuredMatchIds = React.useMemo', dataCardsStart);
const translationsStart = bestTips.indexOf('const translations =', featuredCardsStart);
const tipCardsSelection = bestTips.slice(tipCardsStart, dataCardsStart);
const dataCardsSelection = bestTips.slice(dataCardsStart, featuredCardsStart);
const featuredCardsSelection = bestTips.slice(featuredCardsStart, translationsStart);
check('best-pick data recommendations stay fully visible with only three featured',
  tipCardsStart >= 0
  && dataCardsStart > tipCardsStart
  && featuredCardsStart > dataCardsStart
  && bestTips.includes('<div className="best-pool-v4__rows is-formal-list">')
  && bestTips.includes('{observationCards.map((card) => {')
  && bestTips.includes("observation: { zh: '数据推荐', en: 'Data pick' }")
  && bestTips.includes("reference.source === 'official-market-consensus'")
  && bestTips.includes("card.referenceSource === 'official-market-consensus'")
  && bestTips.includes("官方市场数据推荐")
  && bestTips.includes('tipCards.length + observationCards.length')
  && !tipCardsSelection.includes('.slice(0, 3)')
  && !dataCardsSelection.includes('remainingSlots')
  && featuredCardsSelection.includes('[...tipCards, ...observationCards]')
  && featuredCardsSelection.includes('.slice(0, 3)')
  && bestTips.includes('全部赛前推荐 · 重点 3 场')
  && bestTips.includes("const isLowEvidenceMarketSource = (source: AnalysisReferenceSource)")
  && bestTips.includes('市场去水概率 ${probabilityLabel} · 证据等级低')
  && !bestTips.includes('card.evidenceScore ?? Number(prediction.trustScore || 0)')
  && !bestTips.includes('<details')
  && !bestTips.includes('观察'));
check('reference rows are recommended and excluded from unavailable totals',
  predictions.includes('else if (analysisReference) counts.reference += 1')
  && predictions.includes('if (!displayRecommendation && !analysisReference) counts.unavailable += 1')
  && !predictions.includes('if (!displayRecommendation) counts.unavailable += 1'));
check('recommendation cards expose accounting, usage, data clock and cutoff without mislabeling model scores as market probabilities',
  predictions.includes('className="decision-accounting-fact"')
  && predictions.includes('className="decision-usage-fact"')
  && predictions.includes('className="decision-data-time-fact"')
  && predictions.includes('className="decision-cutoff-time-fact"')
  && predictions.includes("'model-low-evidence'")
  && predictions.includes('Model direction · Low confidence')
  && predictions.includes('不计入正式命中率')
  && !predictions.includes('500.com data supplements')
  && bestTips.includes('className="best-pool-v4__governance"')
  && bestTips.includes('Included in formal record')
  && bestTips.includes('Excluded from formal record'));
check('benchmark review exposes actual kickoff or live-clock evidence coverage',
  predictions.includes('data-time-integrity-coverage={benchmarkTimeIntegrityCoverage}')
  && predictions.includes('benchmarkProspective?.metrics?.timeIntegrityEvidenceRows')
  && predictions.includes('benchmarkProspective?.metrics?.timeIntegrityEvidenceCoverage')
  && predictions.includes('below 95% blocks review'));
check('model probability is rendered only through calibrated formatter',
  [bestTips, detail, worldCup]
    .every((source) => source.includes('formatCalibratedModelProbability'))
  && recommendationEvidenceFacts.includes('breakdown.modelProbability')
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
check('formal and reference settlement language remains separate', [
  '推荐命中',
  '推荐未中',
  '分析参考符合赛果',
  '分析参考不符合赛果'
].every((needle) => predictions.includes(needle))
  && detail.includes('分析参考主方向符合赛果')
  && detail.includes('分析参考主方向不符合赛果'));
check('combination controls expose evidence points, not pseudo-probability',
  betSlip.includes("minTrustLabel: { zh: '最低证据评分'")
  && betSlip.includes('{minTrust}/100')
  && betSlip.includes('{displayedGenerationResult.averageTrust}/100')
  && betSlip.includes('generationPoolSignature === formalPoolSignature'));

const failures = checks.filter((item) => !item.ok);
console.log(JSON.stringify({
  ok: failures.length === 0,
  verifier: 'frontend-evidence-semantics',
  assertions: checks.length,
  checks
}, null, 2));
if (failures.length > 0) process.exitCode = 1;
