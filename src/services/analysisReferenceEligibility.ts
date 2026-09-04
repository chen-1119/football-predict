export interface ModelOnlyReferencePrediction {
  marketType?: string;
  oddsPoolCode?: string;
  tipCode?: string;
  recommendationAction?: string;
  recommendationTier?: string;
  multiFactorEvidence?: {
    evidenceScore?: unknown;
    modelProbability?: unknown;
    modelGap?: unknown;
    expectedValue?: unknown;
    dataQuality?: unknown;
    supportingFactors?: unknown;
    blockers?: unknown;
    diagnostics?: {
      scoreAligned?: unknown;
      crossMarketCompatible?: unknown;
      externalMarketContradicted?: unknown;
      severeMissingCount?: unknown;
    } | null;
  } | null;
}

export interface ModelOnlyReferenceMatch {
  status?: string;
  resultDisposition?: string;
  kickoffTime?: string;
  buyEndTime?: string;
  probabilityModel?: {
    inputSufficiency?: { sufficient?: unknown };
    publicDecision?: { directionPublished?: unknown };
    contextSignals?: {
      dataGaps?: {
        coverageScore?: unknown;
        severeMissingCount?: unknown;
      } | null;
    } | null;
    unifiedPosterior?: {
      generatedAt?: unknown;
      policy?: unknown;
      selectionPolicy?: unknown;
      selectedCode?: unknown;
      selectedMarket?: unknown;
      selectedProbability?: unknown;
      marketBaseline?: {
        applied?: unknown;
        leaderCode?: unknown;
        leaderProbability?: unknown;
        activeSelection?: {
          market?: unknown;
          code?: unknown;
        } | null;
      } | null;
    } | null;
  } | null;
}

const isDirection = (value: unknown) => value === '1' || value === 'X' || value === '2';
const MODEL_ONLY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MODEL_ONLY_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DIRECTIONAL_REFERENCE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const DIRECTIONAL_REFERENCE_MIN_EVIDENCE_SCORE = 52;
export const DIRECTIONAL_REFERENCE_MIN_MODEL_GAP = 0.03;
export const DIRECTIONAL_REFERENCE_MIN_EXPECTED_VALUE = -0.01;
export const DIRECTIONAL_REFERENCE_MIN_DATA_QUALITY = 0.50;
const DIRECTIONAL_REFERENCE_HARD_BLOCKERS = new Set([
  'unsupported-market',
  'unsupported-direction',
  'missing-handicap-line',
  'had-line-not-zero',
  'missing-official-sp',
  'missing-model-probability',
  'missing-devigged-market-probability',
  'missing-model-separation',
  'missing-data-quality',
  'model-probability-too-low',
  'model-separation-too-thin',
  'market-implied-probability-contradiction',
  'negative-expected-value',
  'insufficient-data-quality',
  'too-many-severe-data-gaps',
  'score-matrix-not-aligned',
  'had-hhad-conflict',
  'candidate-risk-too-high',
  'official-sp-movement-contradiction',
  'external-market-contradiction',
  'long-price-probability-too-low',
  'long-price-edge-too-thin',
  'long-price-value-too-thin',
]);

const isPreMatchReferenceWindowOpen = (
  match: ModelOnlyReferenceMatch | null | undefined,
  now: number
) => {
  if (!match || !Number.isFinite(now) || match.resultDisposition === 'VOID' || match.status !== 'SCHEDULED') return false;
  const kickoffAt = Date.parse(match.kickoffTime || '');
  const buyEndAt = Date.parse(match.buyEndTime || '');
  if (!Number.isFinite(kickoffAt) || now >= kickoffAt) return false;
  if (Number.isFinite(buyEndAt) && now >= buyEndAt) return false;
  return true;
};

const normalizeProbability = (value: unknown) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const text = typeof value === 'string' ? value.trim() : '';
  const percentEncoded = text.endsWith('%');
  const numeric = Number(percentEncoded ? text.slice(0, -1) : value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const normalized = percentEncoded || (numeric > 1 && numeric <= 100) ? numeric / 100 : numeric;
  return normalized >= 0 && normalized <= 1 ? normalized : null;
};

const normalizeFiniteNumber = (value: unknown) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const isCalibratedMarketAnalysisReferenceEligible = (
  match: ModelOnlyReferenceMatch | null | undefined,
  prediction: ModelOnlyReferencePrediction | null | undefined,
  now = Date.now()
) => {
  if (!prediction || !isPreMatchReferenceWindowOpen(match, now)) return false;
  if (prediction.marketType !== 'BEST') return false;
  if (prediction.recommendationAction !== 'reference') return false;
  if (prediction.recommendationTier !== 'calibrated-had-market-reference') return false;
  if (prediction.oddsPoolCode !== 'HAD' || !isDirection(prediction.tipCode)) return false;

  const posterior = match?.probabilityModel?.unifiedPosterior;
  const baseline = posterior?.marketBaseline;
  const leaderProbability = normalizeProbability(baseline?.leaderProbability);
  return posterior?.selectionPolicy === 'calibrated-had-market-baseline'
    && posterior.selectedMarket === 'HAD'
    && posterior?.selectedCode === prediction.tipCode
    && baseline?.applied === true
    && baseline.leaderCode === prediction.tipCode
    && leaderProbability !== null
    && leaderProbability >= 0.60
    && baseline.activeSelection?.market === 'HAD'
    && baseline.activeSelection.code === prediction.tipCode;
};

/**
 * Keeps a real model direction visible when it misses the formal publication
 * gate. This lane is deliberately reference-only: it never changes the
 * recommendation action, never enters the formal record, and never feeds a
 * bet slip. The purpose is to avoid replacing an already calculated BEST
 * direction with a generic "watch" card.
 */
export const isDirectionalAnalysisReferenceEligible = (
  match: ModelOnlyReferenceMatch | null | undefined,
  prediction: ModelOnlyReferencePrediction | null | undefined,
  now = Date.now()
) => {
  if (!prediction || !isPreMatchReferenceWindowOpen(match, now)) return false;
  if (prediction.marketType !== 'BEST' || prediction.recommendationAction !== 'reference') return false;
  if (!isDirection(prediction.tipCode)) return false;
  if (prediction.oddsPoolCode && prediction.oddsPoolCode !== 'HAD' && prediction.oddsPoolCode !== 'HHAD') return false;
  if (!String(prediction.recommendationTier || '').includes('multi-factor')) return false;

  const model = match?.probabilityModel;
  const posterior = model?.unifiedPosterior;
  const posteriorPool = posterior?.selectedMarket;
  if (
    (posteriorPool !== 'HAD' && posteriorPool !== 'HHAD')
    || (prediction.oddsPoolCode && prediction.oddsPoolCode !== posteriorPool)
  ) return false;
  const selectedProbability = normalizeProbability(posterior?.selectedProbability);
  const generatedAt = Date.parse(typeof posterior?.generatedAt === 'string' ? posterior.generatedAt : '');
  const evidence = prediction.multiFactorEvidence;
  const evidenceScore = normalizeFiniteNumber(evidence?.evidenceScore);
  const modelProbability = normalizeProbability(evidence?.modelProbability);
  const modelGap = normalizeProbability(evidence?.modelGap);
  const expectedValue = normalizeFiniteNumber(evidence?.expectedValue);
  const dataQuality = normalizeProbability(evidence?.dataQuality);
  const supportingFactors = Array.isArray(evidence?.supportingFactors) ? evidence.supportingFactors : [];
  const blockers = Array.isArray(evidence?.blockers)
    ? evidence.blockers.filter((value): value is string => typeof value === 'string')
    : [];
  const hasHardBlocker = blockers.some((blocker) => DIRECTIONAL_REFERENCE_HARD_BLOCKERS.has(blocker));
  const minimumModelProbability = posteriorPool === 'HHAD' ? 0.45 : 0.42;
  return model?.inputSufficiency?.sufficient === true
    && model?.publicDecision?.directionPublished !== false
    && (posteriorPool === 'HAD' || posteriorPool === 'HHAD')
    && posterior?.selectedCode === prediction.tipCode
    && selectedProbability !== null
    && selectedProbability >= minimumModelProbability
    && evidenceScore !== null
    && evidenceScore >= DIRECTIONAL_REFERENCE_MIN_EVIDENCE_SCORE
    && modelProbability !== null
    && modelProbability >= minimumModelProbability
    && modelGap !== null
    && modelGap >= DIRECTIONAL_REFERENCE_MIN_MODEL_GAP
    && expectedValue !== null
    && expectedValue >= DIRECTIONAL_REFERENCE_MIN_EXPECTED_VALUE
    && dataQuality !== null
    && dataQuality >= DIRECTIONAL_REFERENCE_MIN_DATA_QUALITY
    && supportingFactors.length >= 3
    && evidence?.diagnostics?.scoreAligned === true
    && evidence?.diagnostics?.crossMarketCompatible !== false
    && evidence?.diagnostics?.externalMarketContradicted !== true
    && Number(evidence?.diagnostics?.severeMissingCount || 0) <= 1
    && !hasHardBlocker
    && Number.isFinite(generatedAt)
    && generatedAt <= now + MODEL_ONLY_MAX_FUTURE_SKEW_MS
    && now - generatedAt <= DIRECTIONAL_REFERENCE_MAX_AGE_MS;
};

export const isModelOnlyAnalysisReferenceEligible = (
  match: ModelOnlyReferenceMatch | null | undefined,
  prediction: ModelOnlyReferencePrediction | null | undefined,
  now = Date.now()
) => {
  if (!prediction || !isPreMatchReferenceWindowOpen(match, now)) return false;
  if (prediction.marketType !== 'BEST') return false;
  if (prediction.recommendationAction !== 'reference') return false;
  if (prediction.recommendationTier !== 'model-only-watch') return false;
  if (!isDirection(prediction.tipCode)) return false;
  if (prediction.oddsPoolCode && prediction.oddsPoolCode !== 'HAD') return false;

  const model = match?.probabilityModel;
  const posterior = model?.unifiedPosterior;
  const selectedProbability = normalizeProbability(posterior?.selectedProbability);
  const generatedAt = Date.parse(typeof posterior?.generatedAt === 'string' ? posterior.generatedAt : '');
  const coverageScore = normalizeFiniteNumber(model?.contextSignals?.dataGaps?.coverageScore);
  const severeMissingCount = normalizeFiniteNumber(model?.contextSignals?.dataGaps?.severeMissingCount);
  return posterior?.selectedMarket === 'MODEL_ONLY_1X2'
    && posterior.selectedCode === prediction.tipCode
    && String(posterior.policy || '').includes('observation-only')
    && selectedProbability !== null
    && selectedProbability >= 0.60
    && Number.isFinite(generatedAt)
    && generatedAt <= now + MODEL_ONLY_MAX_FUTURE_SKEW_MS
    && now - generatedAt <= MODEL_ONLY_MAX_AGE_MS
    && coverageScore !== null
    && coverageScore >= 60
    && severeMissingCount !== null
    && severeMissingCount >= 0
    && severeMissingCount <= 1
    && model?.inputSufficiency?.sufficient === true
    && model?.publicDecision?.directionPublished !== false;
};
