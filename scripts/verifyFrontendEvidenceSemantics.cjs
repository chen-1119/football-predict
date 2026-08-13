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
const analysisReferenceSelection = read('src/services/analysisReferenceSelection.ts');
const predictions = read('src/pages/PredictionsList.tsx');
const bestTips = read('src/pages/BestTips.tsx');
const detail = read('src/pages/MatchDetail.tsx');
const worldCup = read('src/pages/WorldCup.tsx');
const betSlip = read('src/pages/BetSlipGenerator.tsx');
const css = read('src/index.css');

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
  && presentation.includes('!prediction.multiFactorEvidence'));
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
  && recommendationCopy.includes("prediction.tipCode === 'X'")
  && recommendationCopy.includes('const officialOddsValue = officialOutcomeOddsForPrediction(match, prediction)')
  && recommendationCopy.includes('officialOddsValue > 1')
  && recommendationCopy.includes('storedOddsValue > 1'));
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
  [predictions, bestTips, detail, worldCup]
    .every((source) => source.includes('formatCalibratedModelProbability'))
  && !sourceText.includes('formatGptProbability'));
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
