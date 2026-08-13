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

export const DIRECTIONAL_REFERENCE_MIN_EVIDENCE_SCORE: 52;
export const DIRECTIONAL_REFERENCE_MIN_MODEL_GAP: 0.03;
export const DIRECTIONAL_REFERENCE_MIN_EXPECTED_VALUE: -0.01;
export const DIRECTIONAL_REFERENCE_MIN_DATA_QUALITY: 0.50;

export function isCalibratedMarketAnalysisReferenceEligible(
  match: ModelOnlyReferenceMatch | null | undefined,
  prediction: ModelOnlyReferencePrediction | null | undefined,
  now?: number
): boolean;

export function isDirectionalAnalysisReferenceEligible(
  match: ModelOnlyReferenceMatch | null | undefined,
  prediction: ModelOnlyReferencePrediction | null | undefined,
  now?: number
): boolean;

export function isModelOnlyAnalysisReferenceEligible(
  match: ModelOnlyReferenceMatch | null | undefined,
  prediction: ModelOnlyReferencePrediction | null | undefined,
  now?: number
): boolean;
