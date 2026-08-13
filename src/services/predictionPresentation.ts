import type { Match, PredictionDetail } from './mockData';

type OutcomeCode = '1' | 'X' | '2';
type ProbabilityTriplet = {
  home?: number | null;
  draw?: number | null;
  away?: number | null;
} | null | undefined;

const DERIVED_REFERENCE_TIER = /(?:^|[-_ ])(?:reference|model[-_ ]?only|handicap[-_ ]?companion|watch)(?:$|[-_ ])/i;

const boundedScore = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
};

const isMissingNumericValue = (value: unknown) => (
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

export const isFormalPresentationAllowed = (
  riskTier: unknown,
  servingMode?: unknown
) => String(riskTier || '').toLowerCase() === 'stable'
  && !['fallback-degraded', 'critical'].includes(String(servingMode || '').toLowerCase());
