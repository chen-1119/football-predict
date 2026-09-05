import type { Match, PredictionDetail } from './mockData';

type OutcomeCode = '1' | 'X' | '2';
type ProbabilityTriplet = {
  home?: number | null;
  draw?: number | null;
  away?: number | null;
} | null | undefined;

const DERIVED_REFERENCE_TIER = /(?:^|[-_ ])(?:reference|model[-_ ]?only|handicap[-_ ]?companion|watch)(?:$|[-_ ])/i;

const boundedScore = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
};

const isMissingNumericValue = (value: unknown) => (
  (typeof value !== 'number' && typeof value !== 'string')
  ||
  value === null
  || value === undefined
  || (typeof value === 'string' && value.trim() === '')
);

/**
 * `trustScore` is legacy naming. It is an ordinal evidence score, never a
 * probability or hit-rate estimate. A model-derived reference without a real
 * evidence chain deliberately has no public evidence score.
 */
export const getEvidenceScore = (prediction: PredictionDetail | null | undefined): number | null => {
  if (!prediction) return null;
  if (prediction.confidence?.available === false || prediction.confidence?.band === 'unavailable') {
    return null;
  }
  const evidenceScore = boundedScore(prediction.multiFactorEvidence?.evidenceScore);
  if (evidenceScore !== null) return evidenceScore;

  const tier = String(prediction.recommendationTier || '');
  if (!prediction.multiFactorEvidence && DERIVED_REFERENCE_TIER.test(tier)) return null;
  return boundedScore(prediction.trustScore);
};

export const formatEvidenceScore = (
  prediction: PredictionDetail | null | undefined,
  fallback = '--'
) => {
  const score = getEvidenceScore(prediction);
  return score === null ? fallback : `${Math.round(score)}/100`;
};

const isValidProbabilityTriplet = (probabilities: ProbabilityTriplet) => {
  const rawValues: unknown[] = [probabilities?.home, probabilities?.draw, probabilities?.away];
  if (rawValues.some(isMissingNumericValue)) return false;
  const values = rawValues.map((value) => Number(value));
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    && Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) <= 1;
};

const probabilityForCode = (probabilities: ProbabilityTriplet, code: OutcomeCode) => {
  if (!isValidProbabilityTriplet(probabilities)) return null;
  const value = code === '1' ? probabilities?.home : code === 'X' ? probabilities?.draw : probabilities?.away;
  return boundedScore(value);
};

/**
 * Public model probability is intentionally fail-closed. Baseline,
 * backtesting, market-implied and malformed probability rows are not exposed
 * as calibrated model probabilities.
 */
export const getCalibratedModelProbability = (
  match: Match,
  prediction: PredictionDetail | null | undefined
): number | null => {
  if (!prediction || (prediction.tipCode !== '1' && prediction.tipCode !== 'X' && prediction.tipCode !== '2')) {
    return null;
  }
  const model = match.probabilityModel;
  if (!model?.version || model.calibration?.status !== 'calibrated') return null;

  const probabilities = prediction.oddsPoolCode === 'HHAD'
    ? model.handicap?.unifiedPosterior
    : model.oneXTwo?.unifiedPosterior
      || model.calibrationAdjustment?.oneXTwo?.after
      || model.calculationTrace?.outcome?.calibration?.after
      || model.oneXTwo?.final;

  return probabilityForCode(probabilities, prediction.tipCode);
};

export const formatCalibratedModelProbability = (
  match: Match,
  prediction: PredictionDetail | null | undefined
) => {
  const probability = getCalibratedModelProbability(match, prediction);
  return probability === null ? null : `${Math.round(probability)}%`;
};

export type MarketConsistencyPresentation = 'aligned' | 'conflicted' | 'unavailable';

export interface RecommendationEvidenceBreakdown {
  modelProbability: number | null;
  evidenceCompleteness: number | null;
  marketConsistency: MarketConsistencyPresentation;
  calibrationSample: number | null;
  freshnessQuality: number | null;
  freshnessObservedAt: string | null;
  freshnessSourceUpdatedAt: string | null;
  freshnessAsOf: string | null;
  freshnessEvaluatedAt: string | null;
  freshnessAgeSeconds: number | null;
  freshnessSource: string | null;
  freshnessBasis: 'observed-at' | 'source-updated-at' | 'unavailable';
}

const canonicalEvidencePool = (prediction: PredictionDetail) => {
  if (prediction.oddsPoolCode === 'HAD' || prediction.oddsPoolCode === 'HHAD') {
    return prediction.oddsPoolCode;
  }
  return null;
};

const canonicalEvidenceHandicapLine = (prediction: PredictionDetail) => {
  const pool = canonicalEvidencePool(prediction);
  if (pool === 'HAD') return '0';
  if (pool !== 'HHAD') return null;
  const line = String(prediction.handicapLine ?? '').trim();
  return line || null;
};

const samePublishedPredictionIdentity = (
  left: PredictionDetail,
  right: PredictionDetail
) => left.marketType === right.marketType
  && left.tipCode === right.tipCode
  && canonicalEvidencePool(left) === canonicalEvidencePool(right)
  && canonicalEvidenceHandicapLine(left) === canonicalEvidenceHandicapLine(right);

/**
 * UI-only reference selections may clone a published prediction and attach a
 * locally calculated confidence object for ranking/copy. Public confidence
 * facts must instead come from the API row itself. If the displayed selection
 * cannot be bound back to a published prediction identity, every fact remains
 * unavailable rather than being derived from odds, posterior or trustScore.
 */
export const resolvePublishedEvidencePrediction = (
  match: Match,
  displayedPrediction: PredictionDetail | null | undefined
): PredictionDetail | null => {
  if (!displayedPrediction) return null;
  const publishedPredictions = [
    ...(Array.isArray(match.predictions) ? match.predictions : []),
    ...(match.archivedPreMatchPrediction?.prediction
      ? [match.archivedPreMatchPrediction.prediction]
      : []),
  ];
  return publishedPredictions.find((prediction) => prediction === displayedPrediction)
    || publishedPredictions.find((prediction) => (
      samePublishedPredictionIdentity(prediction, displayedPrediction)
    ))
    || null;
};

const normalizedPercent = (value: unknown): number | null => {
  if (isMissingNumericValue(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const percent = numeric <= 1 ? numeric * 100 : numeric;
  return percent <= 100 ? percent : null;
};

const nonNegativeInteger = (value: unknown): number | null => {
  if (isMissingNumericValue(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
};

const nonNegativeNumber = (value: unknown): number | null => {
  if (isMissingNumericValue(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

const canonicalInstant = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

/**
 * Public evidence facts remain separate. Missing observations stay missing;
 * they are never backfilled from the aggregate legacy trust score.
 */
export const getRecommendationEvidenceBreakdown = (
  _match: Match,
  prediction: PredictionDetail | null | undefined
): RecommendationEvidenceBreakdown => {
  const metrics = prediction?.confidence?.publicMetrics;
  const marketConsistency = metrics?.marketConsistency === 'aligned'
    || metrics?.marketConsistency === 'conflicted'
    ? metrics.marketConsistency
    : 'unavailable';

  return {
    // This value is the selected-direction probability normalized by the v4
    // confidence contract. A missing public fact stays missing; the list must
    // not substitute posterior, market odds, trustScore or a baseline model.
    modelProbability: normalizedPercent(metrics?.modelProbability),
    evidenceCompleteness: normalizedPercent(metrics?.evidenceCompleteness),
    marketConsistency,
    calibrationSample: nonNegativeInteger(metrics?.calibrationSample),
    freshnessQuality: normalizedPercent(metrics?.freshnessQuality),
    freshnessObservedAt: canonicalInstant(metrics?.freshnessObservedAt),
    freshnessSourceUpdatedAt: canonicalInstant(metrics?.freshnessSourceUpdatedAt),
    freshnessAsOf: canonicalInstant(metrics?.freshnessAsOf),
    freshnessEvaluatedAt: canonicalInstant(metrics?.freshnessEvaluatedAt),
    freshnessAgeSeconds: nonNegativeNumber(metrics?.freshnessAgeSeconds),
    freshnessSource: typeof metrics?.freshnessSource === 'string' && metrics.freshnessSource.trim()
      ? metrics.freshnessSource.trim()
      : null,
    freshnessBasis: metrics?.freshnessBasis === 'observed-at'
      || metrics?.freshnessBasis === 'source-updated-at'
      ? metrics.freshnessBasis
      : 'unavailable',
  };
};

export const getPublishedRecommendationEvidenceBreakdown = (
  match: Match,
  displayedPrediction: PredictionDetail | null | undefined
): RecommendationEvidenceBreakdown => getRecommendationEvidenceBreakdown(
  match,
  resolvePublishedEvidencePrediction(match, displayedPrediction)
);

export const formatEvidenceCompleteness = (
  breakdown: RecommendationEvidenceBreakdown,
  fallback = '--'
) => breakdown.evidenceCompleteness === null
  ? fallback
  : `${Math.round(breakdown.evidenceCompleteness)}%`;

export const formatMarketConsistency = (
  breakdown: RecommendationEvidenceBreakdown,
  language: 'zh' | 'en' = 'zh',
  fallback = '--'
) => breakdown.marketConsistency === 'aligned'
  ? (language === 'zh' ? '一致' : 'Aligned')
  : breakdown.marketConsistency === 'conflicted'
    ? (language === 'zh' ? '冲突' : 'Conflicted')
    : fallback;

export const formatCalibrationSample = (
  breakdown: RecommendationEvidenceBreakdown,
  fallback = '--'
) => breakdown.calibrationSample === null ? fallback : `n=${breakdown.calibrationSample}`;

export const formatFreshnessQuality = (
  breakdown: RecommendationEvidenceBreakdown,
  fallback = '--'
) => breakdown.freshnessQuality === null
  ? fallback
  : `${Math.round(breakdown.freshnessQuality)}%`;

export const isFormalPresentationAllowed = (
  riskTier: unknown,
  servingMode?: unknown
) => String(riskTier || '').toLowerCase() === 'stable'
  && !['fallback-degraded', 'critical'].includes(String(servingMode || '').toLowerCase());
