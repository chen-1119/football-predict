const CONFIDENCE_POLICY_VERSION = 'dynamic-evidence-confidence-v4-auditable-public-facts';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const finiteNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const probability = (value, fallback = null) => {
  const numeric = finiteNumber(value);
  if (numeric === null) return fallback;
  return clamp(numeric > 1 ? numeric / 100 : numeric, 0, 1);
};

const normalizedCount = (value, ceiling) => clamp((finiteNumber(value) || 0) / ceiling, 0, 1);

const canonicalInstant = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

const freshnessQualityForAge = (ageSeconds) => {
  if (ageSeconds <= 15 * 60) return 1;
  if (ageSeconds <= 60 * 60) return 0.9;
  if (ageSeconds <= 6 * 60 * 60) return 0.75;
  if (ageSeconds <= 12 * 60 * 60) return 0.6;
  if (ageSeconds <= 24 * 60 * 60) return 0.45;
  if (ageSeconds <= 48 * 60 * 60) return 0.25;
  if (ageSeconds <= 72 * 60 * 60) return 0.1;
  return 0;
};

const auditedFreshness = (input) => {
  const source = typeof input?.source === 'string' && input.source.trim()
    ? input.source.trim()
    : null;
  const observedAt = canonicalInstant(input?.observedAt);
  const sourceUpdatedAt = canonicalInstant(input?.sourceUpdatedAt);
  const evaluatedAt = canonicalInstant(input?.evaluatedAt);
  const asOf = observedAt || sourceUpdatedAt;
  const basis = observedAt ? 'observed-at' : sourceUpdatedAt ? 'source-updated-at' : 'unavailable';
  if (!source || !asOf || !evaluatedAt) {
    return {
      quality: null,
      observedAt,
      sourceUpdatedAt,
      asOf: null,
      evaluatedAt,
      ageSeconds: null,
      source,
      basis: 'unavailable',
    };
  }
  const rawAgeSeconds = (Date.parse(evaluatedAt) - Date.parse(asOf)) / 1000;
  if (!Number.isFinite(rawAgeSeconds) || rawAgeSeconds < -5 * 60) {
    return {
      quality: null,
      observedAt,
      sourceUpdatedAt,
      asOf: null,
      evaluatedAt,
      ageSeconds: null,
      source,
      basis: 'unavailable',
    };
  }
  const ageSeconds = Math.max(0, Math.round(rawAgeSeconds));
  return {
    quality: freshnessQualityForAge(ageSeconds),
    observedAt,
    sourceUpdatedAt,
    asOf,
    evaluatedAt,
    ageSeconds,
    source,
    basis,
  };
};

const reliabilityFromHistory = (hitRate, sampleSize) => {
  const rate = probability(hitRate);
  const sample = Math.max(0, finiteNumber(sampleSize) || 0);
  if (rate === null || sample < 8) return 0;
  const sampleWeight = clamp((sample - 8) / 42, 0, 1);
  const observed = clamp(0.35 + (rate - 1 / 3) * 1.05, 0.28, 0.82);
  return 0.5 * (1 - sampleWeight) + observed * sampleWeight;
};

/**
 * Confidence is deliberately independent from SP/odds. Price remains useful
 * for value and market diagnostics, but the same evidence must receive the
 * same confidence score regardless of whether its displayed SP is 1.40 or
 * 3.40. Direction selection and formal-promotion eligibility stay separate.
 */
const buildDynamicRecommendationConfidence = (input = {}) => {
  const observedSelectedProbability = probability(input.selectedProbability);
  const observedDataQuality = probability(input.dataQuality);
  const observedEvidenceCompleteness = probability(input.evidenceCompleteness);
  const observedEvidenceScore = probability(input.evidenceScore);
  const freshness = auditedFreshness(input.freshnessEvidence);
  const observedFreshnessQuality = freshness.quality;
  const calibrationSampleValue = finiteNumber(input.calibrationSample);
  const unavailableReasons = [];
  if (observedSelectedProbability === null) unavailableReasons.push('model-probability-missing');
  if (observedDataQuality === null) unavailableReasons.push('data-quality-missing');
  if (observedEvidenceCompleteness === null) unavailableReasons.push('evidence-completeness-missing');
  if (observedEvidenceScore === null) unavailableReasons.push('evidence-score-missing');
  if (observedFreshnessQuality === null) unavailableReasons.push('freshness-quality-missing');

  const publicMetrics = {
    modelProbability: observedSelectedProbability,
    evidenceCompleteness: observedEvidenceCompleteness,
    evidenceCompletenessBasis: observedEvidenceCompleteness === null
      ? 'unavailable'
      : 'input-coverage-ratio',
    dataQuality: observedDataQuality,
    evidenceScore: observedEvidenceScore,
    marketConsistency: input.marketAligned === true
      ? 'aligned'
      : input.marketAligned === false
        ? 'conflicted'
        : 'unavailable',
    marketConsistencyBasis: input.marketAligned === true || input.marketAligned === false
      ? 'auditable-market-leader'
      : 'unavailable',
    calibrationSample: calibrationSampleValue === null
      ? null
      : Math.max(0, Math.floor(calibrationSampleValue)),
    freshnessQuality: observedFreshnessQuality,
    freshnessObservedAt: freshness.observedAt,
    freshnessSourceUpdatedAt: freshness.sourceUpdatedAt,
    freshnessAsOf: freshness.asOf,
    freshnessEvaluatedAt: freshness.evaluatedAt,
    freshnessAgeSeconds: freshness.ageSeconds,
    freshnessSource: freshness.source,
    freshnessBasis: freshness.basis,
  };

  if (unavailableReasons.length > 0) {
    return {
      version: CONFIDENCE_POLICY_VERSION,
      available: false,
      unavailableReasons,
      score: 0,
      band: 'unavailable',
      priceIndependent: true,
      components: {},
      penalties: {},
      publicMetrics,
    };
  }

  const selectedProbability = observedSelectedProbability;
  const modelGap = probability(input.modelGap, 0);
  const dataQuality = observedDataQuality;
  const evidenceScore = observedEvidenceScore;
  const marketProbability = probability(input.marketProbability, 0);
  const marketAligned = input.marketAligned === true
    ? 0.86
    : input.marketAligned === false
      ? 0.36
      : 0;
  const supportingFactorScore = normalizedCount(input.supportingFactorCount, 7);
  const evidenceCoverage = observedEvidenceCompleteness;
  const independentAgreement = probability(input.independentAgreement, 0);
  const freshnessQuality = observedFreshnessQuality;
  const uncertainty = probability(input.uncertaintyScore, input.inputSparse === true ? 0.72 : 0.42);
  const historicalReliability = reliabilityFromHistory(
    input.calibrationHitRate,
    input.calibrationSample,
  );
  const probabilityStrength = clamp((selectedProbability - 0.3) / 0.34, 0, 1);
  const separationStrength = clamp(modelGap / 0.18, 0, 1);
  const marketSupport = clamp((marketProbability - 0.2) / 0.45, 0, 1);
  const agreement = clamp(
    independentAgreement * 0.58
      + supportingFactorScore * 0.27
      + marketAligned * 0.1
      + marketSupport * 0.05,
    0,
    1,
  );

  const composite = (
    probabilityStrength * 0.14
    + separationStrength * 0.13
    + evidenceScore * 0.18
    + dataQuality * 0.16
    + evidenceCoverage * 0.13
    + agreement * 0.12
    + freshnessQuality * 0.06
    + historicalReliability * 0.08
  );
  const blockerPenalty = Math.min(0.12, normalizedCount(input.blockerCount, 6) * 0.12);
  const trustPenalty = clamp((finiteNumber(input.trustPenalty) || 0) / 100, 0, 0.18);
  const conflictPenalty = input.materialConflict === true ? 0.08 : 0;
  const uncertaintyPenalty = uncertainty * 0.12;
  const sparsePenalty = input.inputSparse === true ? 0.045 : 0;
  const rawScore = Math.round(
    25 + composite * 65
      - (blockerPenalty + trustPenalty + conflictPenalty + uncertaintyPenalty + sparsePenalty) * 100,
  );
  const score = clamp(rawScore, 25, input.formalRecommendation === true ? 92 : 88);
  const band = score >= 70 ? 'high' : score >= 55 ? 'medium' : score >= 40 ? 'cautious' : 'low';

  return {
    version: CONFIDENCE_POLICY_VERSION,
    available: true,
    unavailableReasons: [],
    score,
    band,
    priceIndependent: true,
    components: {
      probabilityStrength: Number(probabilityStrength.toFixed(3)),
      separationStrength: Number(separationStrength.toFixed(3)),
      evidenceQuality: Number(evidenceScore.toFixed(3)),
      dataQuality: Number(dataQuality.toFixed(3)),
      evidenceCoverage: Number(evidenceCoverage.toFixed(3)),
      agreement: Number(agreement.toFixed(3)),
      independentAgreement: Number(independentAgreement.toFixed(3)),
      freshnessQuality: Number(freshnessQuality.toFixed(3)),
      historicalReliability: Number(historicalReliability.toFixed(3)),
    },
    penalties: {
      blockers: Number(blockerPenalty.toFixed(3)),
      trust: Number(trustPenalty.toFixed(3)),
      materialConflict: Number(conflictPenalty.toFixed(3)),
      uncertainty: Number(uncertaintyPenalty.toFixed(3)),
      sparseInput: Number(sparsePenalty.toFixed(3)),
    },
    publicMetrics,
  };
};

const confidenceReferenceTier = (confidence, prefix = 'dynamic-evidence') => {
  const band = String(confidence?.band || 'low');
  return `${prefix}-${band}-reference`;
};

module.exports = {
  CONFIDENCE_POLICY_VERSION,
  buildDynamicRecommendationConfidence,
  confidenceReferenceTier,
  reliabilityFromHistory,
};
