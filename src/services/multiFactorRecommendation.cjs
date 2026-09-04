const MULTI_FACTOR_POLICY_VERSION = 'multi-factor-dynamic-evidence-v3';
const MIN_MODEL_GAP = 0.06;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const finiteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const probability = (value) => {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  return clamp(numeric > 1 ? numeric / 100 : numeric, 0, 1);
};

const weightedRange = (value, low, high, weight) => {
  if (!Number.isFinite(value) || high <= low) return 0;
  return clamp((value - low) / (high - low), 0, 1) * weight;
};

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const parseHandicapLine = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(/\uFF0B/g, '+')
    .replace(/[\uFF0D\u2212\u2013\u2014]/g, '-');
  if (/^(?:\u4E0D\u8BA9\u7403|\u4E0D\u8BA9|\u5E73\u624B|HAD)$/i.test(normalized)) return 0;
  const match = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isFinite(line) ? (line === 0 ? 0 : line) : null;
};

const formatHandicapLine = (value) => {
  if (value === null) return null;
  if (value === 0) return '0';
  const absolute = Math.abs(value);
  const text = Number.isInteger(absolute) ? String(absolute) : absolute.toFixed(2).replace(/\.?0+$/, '');
  return `${value > 0 ? '+' : '-'}${text}`;
};

/**
 * Decide whether a selected HAD/HHAD direction has enough independent,
 * market and data-quality evidence to be promoted. Official SP is a
 * continuous value/risk input; it is deliberately not an accuracy ceiling.
 *
 * The upstream gate is required because it already contains the independent
 * Elo/Poisson/form, draw-pressure, handicap-support and rolling-calibration
 * checks. This final gate prevents the unified-posterior layer from silently
 * overriding those checks merely because another direction has a lower SP.
 */
const evaluateMultiFactorRecommendation = (input = {}) => {
  const market = String(input.market || input.oddsPoolCode || '').toUpperCase();
  const code = String(input.code || input.tipCode || '').toUpperCase();
  const rawHandicapLine = input.handicapLine;
  const parsedHandicapLine = market === 'HAD'
    && (rawHandicapLine === null || rawHandicapLine === undefined || String(rawHandicapLine).trim() === '')
    ? 0
    : parseHandicapLine(rawHandicapLine);
  const handicapLine = formatHandicapLine(parsedHandicapLine);
  const odds = finiteNumber(input.odds);
  const modelProbability = probability(input.modelProbability);
  const marketProbability = probability(input.marketProbability);
  const modelGap = probability(input.modelGap);
  const dataQuality = probability(input.dataQuality);
  const probabilityEdge = modelProbability !== null && marketProbability !== null
    ? modelProbability - marketProbability
    : null;
  const expectedValue = modelProbability !== null && odds !== null
    ? modelProbability * odds - 1
    : null;
  const trustPenalty = clamp(finiteNumber(input.trustPenalty) || 0, 0, 40);
  const riskPenalty = clamp(finiteNumber(input.riskPenalty) || 0, 0, 0.3);
  const severeMissingCount = Math.max(0, Math.round(finiteNumber(input.severeMissingCount) || 0));
  const riskTagsCount = Math.max(0, Math.round(finiteNumber(input.riskTagsCount) || 0));
  const scoreAligned = input.scoreAligned === true;
  const crossMarketCompatible = input.crossMarketCompatible !== false;
  const handicapAligned = input.handicapAligned === true;
  const marketLeaderAlignment = input.marketLeaderAligned === true
    ? true
    : input.marketLeaderAligned === false
      ? false
      : null;
  const marketLeaderAligned = marketLeaderAlignment === true;
  const trendSupports = input.trendSupports === true;
  const trendContradicts = input.trendContradicts === true;
  const externalMarketAligned = input.externalMarketAligned === true;
  const externalMarketContradicted = input.externalMarketContradicted === true;
  const externalMarketRisk = String(input.externalMarketRisk || '').toLowerCase();
  const upstreamRecommended = input.upstreamRecommended === true;
  const upstreamAligned = input.upstreamAligned === true;
  const globalRiskTier = String(input.globalRiskTier || '').toLowerCase();

  const components = {
    independentModel: weightedRange(modelProbability, 0.34, 0.64, 18),
    modelSeparation: weightedRange(modelGap, 0.03, 0.18, 12),
    probabilityEdge: weightedRange(probabilityEdge, -0.03, 0.1, 14),
    expectedValue: weightedRange(expectedValue, -0.05, 0.2, 12),
    scoreAndHandicap: (scoreAligned ? 8 : 0)
      + (crossMarketCompatible ? 6 : 0)
      + (handicapAligned ? 4 : 0),
    marketStructure: (marketLeaderAligned ? 5 : 0)
      + (externalMarketAligned ? 3 : 0),
    marketMovement: trendSupports ? 6 : trendContradicts ? -6 : 0,
    dataQuality: weightedRange(dataQuality, 0.35, 0.9, 12),
    upstreamGate: upstreamRecommended && upstreamAligned ? 4 : 0,
  };

  const penalty = Math.min(10, trustPenalty * 0.28)
    + Math.min(9, riskPenalty * 36)
    + Math.min(9, severeMissingCount * 4)
    + Math.min(5, riskTagsCount * 0.65)
    + (externalMarketContradicted ? 7 : 0)
    + (externalMarketRisk === 'high' ? 3 : 0);
  const evidenceScore = Number(clamp(
    Object.values(components).reduce((sum, value) => sum + value, 0) - penalty,
    0,
    100
  ).toFixed(1));

  const supportingFactors = unique([
    modelProbability !== null && modelProbability >= 0.48 ? 'independent-model-probability' : null,
    modelGap !== null && modelGap >= 0.08 ? 'model-separation' : null,
    probabilityEdge !== null && probabilityEdge >= 0.02 ? 'model-market-edge' : null,
    expectedValue !== null && expectedValue >= 0.02 ? 'positive-expected-value' : null,
    scoreAligned ? 'score-matrix-alignment' : null,
    crossMarketCompatible && handicapAligned ? 'had-hhad-consistency' : null,
    marketLeaderAligned ? 'official-market-alignment' : null,
    trendSupports ? 'official-sp-movement-support' : null,
    externalMarketAligned ? 'external-market-alignment' : null,
    dataQuality !== null && dataQuality >= 0.65 ? 'data-quality' : null,
    upstreamRecommended && upstreamAligned ? 'upstream-multi-factor-gate' : null,
  ]);

  const blockers = [];
  if (!['HAD', 'HHAD'].includes(market)) blockers.push('unsupported-market');
  if (!['1', 'X', '2'].includes(code)) blockers.push('unsupported-direction');
  if (market === 'HHAD' && parsedHandicapLine === null) blockers.push('missing-handicap-line');
  if (market === 'HAD' && parsedHandicapLine !== 0) blockers.push('had-line-not-zero');
  if (odds === null || odds <= 1) blockers.push('missing-official-sp');
  if (modelProbability === null) blockers.push('missing-model-probability');
  if (marketProbability === null) blockers.push('missing-devigged-market-probability');
  if (modelGap === null) blockers.push('missing-model-separation');
  if (dataQuality === null) blockers.push('missing-data-quality');
  if (!upstreamRecommended || !upstreamAligned) blockers.push('upstream-multi-factor-gate-not-passed');
  // Fail closed: missing/unknown risk state is not equivalent to a stable,
  // leakage-audited model release.
  if (globalRiskTier !== 'stable') blockers.push('model-risk-not-promotable');

  // SP remains a continuous market/value feature. It must not choose a
  // different probability floor, confidence cap, or promotion lane.
  const minimumModelProbability = 0.4;
  if (modelProbability !== null && modelProbability < minimumModelProbability) blockers.push('model-probability-too-low');
  if (modelGap !== null && modelGap < MIN_MODEL_GAP) blockers.push('model-separation-too-thin');
  if (probabilityEdge !== null && probabilityEdge < -0.025) blockers.push('market-implied-probability-contradiction');
  if (dataQuality !== null && dataQuality < 0.42) blockers.push('insufficient-data-quality');
  if (severeMissingCount > 1) blockers.push('too-many-severe-data-gaps');
  if (!scoreAligned) blockers.push('score-matrix-not-aligned');
  if (!crossMarketCompatible) blockers.push('had-hhad-conflict');
  if (riskPenalty > 0.12) blockers.push('candidate-risk-too-high');
  if (riskTagsCount > 4) blockers.push('too-many-risk-tags');
  if (trendContradicts && (probabilityEdge === null || probabilityEdge < 0.04)) blockers.push('official-sp-movement-contradiction');
  if (externalMarketContradicted && (probabilityEdge === null || probabilityEdge < 0.05)) blockers.push('external-market-contradiction');

  if (supportingFactors.length < 4) blockers.push('insufficient-independent-support');
  if (evidenceScore < 66) blockers.push('evidence-score-below-threshold');

  const uniqueBlockers = unique(blockers);
  const eligible = uniqueBlockers.length === 0;
  const grade = eligible
    ? evidenceScore >= 80 ? 'A' : evidenceScore >= 72 ? 'B' : 'C'
    : 'WATCH';

  return {
    version: MULTI_FACTOR_POLICY_VERSION,
    eligible,
    grade,
    evidenceScore,
    threshold: 66,
    market,
    code,
    handicapLine,
    odds,
    modelProbability,
    marketProbability,
    probabilityEdge: probabilityEdge === null ? null : Number(probabilityEdge.toFixed(4)),
    expectedValue: expectedValue === null ? null : Number(expectedValue.toFixed(4)),
    modelGap,
    minimumModelGap: MIN_MODEL_GAP,
    dataQuality,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Number(value.toFixed(2))])),
    penalty: Number(penalty.toFixed(2)),
    supportingFactors,
    blockers: uniqueBlockers,
    diagnostics: {
      scoreAligned,
      crossMarketCompatible,
      handicapAligned,
      marketLeaderAligned: marketLeaderAlignment,
      trendSupports,
      trendContradicts,
      externalMarketAligned,
      externalMarketContradicted,
      externalMarketRisk: externalMarketRisk || null,
      upstreamRecommended,
      upstreamAligned,
      globalRiskTier: globalRiskTier || null,
      severeMissingCount,
      riskTagsCount,
      trustPenalty,
      riskPenalty,
    },
  };
};

module.exports = {
  MULTI_FACTOR_POLICY_VERSION,
  MIN_MODEL_GAP,
  evaluateMultiFactorRecommendation,
};
