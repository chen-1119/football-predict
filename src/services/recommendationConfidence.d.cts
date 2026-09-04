export interface DynamicRecommendationConfidenceInput {
  selectedProbability?: number | null;
  modelGap?: number | null;
  dataQuality?: number | null;
  evidenceCompleteness?: number | null;
  evidenceScore?: number | null;
  marketProbability?: number | null;
  marketAligned?: boolean | null;
  supportingFactorCount?: number | null;
  evidenceFamilyCount?: number | null;
  minimumEvidenceFamilies?: number | null;
  independentAgreement?: number | null;
  freshnessQuality?: number | null;
  freshnessEvidence?: {
    observedAt?: string | null;
    sourceUpdatedAt?: string | null;
    evaluatedAt?: string | null;
    source?: string | null;
  } | null;
  uncertaintyScore?: number | null;
  inputSparse?: boolean | null;
  blockerCount?: number | null;
  calibrationHitRate?: number | null;
  calibrationSample?: number | null;
  trustPenalty?: number | null;
  materialConflict?: boolean | null;
  formalRecommendation?: boolean | null;
}

export interface DynamicRecommendationConfidence {
  version: string;
  available: boolean;
  unavailableReasons: Array<
    | 'model-probability-missing'
    | 'data-quality-missing'
    | 'evidence-completeness-missing'
    | 'evidence-score-missing'
    | 'freshness-quality-missing'
  >;
  score: number;
  band: 'high' | 'medium' | 'cautious' | 'low' | 'unavailable';
  priceIndependent: true;
  components: Record<string, number>;
  penalties: Record<string, number>;
  publicMetrics: {
    modelProbability: number | null;
    evidenceCompleteness: number | null;
    evidenceCompletenessBasis: 'input-coverage-ratio' | 'unavailable';
    dataQuality: number | null;
    evidenceScore: number | null;
    marketConsistency: 'aligned' | 'conflicted' | 'unavailable';
    marketConsistencyBasis: 'auditable-market-leader' | 'unavailable';
    calibrationSample: number | null;
    freshnessQuality: number | null;
    freshnessObservedAt: string | null;
    freshnessSourceUpdatedAt: string | null;
    freshnessAsOf: string | null;
    freshnessEvaluatedAt: string | null;
    freshnessAgeSeconds: number | null;
    freshnessSource: string | null;
    freshnessBasis: 'observed-at' | 'source-updated-at' | 'unavailable';
  };
}

export const CONFIDENCE_POLICY_VERSION: string;
export function buildDynamicRecommendationConfidence(
  input?: DynamicRecommendationConfidenceInput,
): DynamicRecommendationConfidence;
export function confidenceReferenceTier(
  confidence: DynamicRecommendationConfidence,
  prefix?: string,
): string;
export function reliabilityFromHistory(hitRate?: number | null, sampleSize?: number | null): number;
