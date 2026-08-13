export interface OfficialRecommendationCandidate {
  marketType?: string;
  oddsPoolCode?: string;
  tipCode?: string;
  recommendationAction?: string;
  recommendationTier?: string;
  handicapLine?: string | number;
  multiFactorEvidence?: {
    version?: string;
    eligible?: boolean;
    market?: string;
    code?: string;
    handicapLine?: string | number;
    odds?: number;
    blockers?: string[];
  };
}

export const OFFICIAL_RECOMMENDATION_POLICY_VERSION: string;

export function isOfficialRecommendationEligible(
  prediction: OfficialRecommendationCandidate | null | undefined,
  officialOdds: number,
  currentOfficialHandicapLine?: string | number | null
): boolean;

export function isServerOfficialRecommendationEligible(
  prediction: OfficialRecommendationCandidate | null | undefined,
  officialOdds: number,
  context: {
    officialSource?: boolean;
    globalRiskTier?: string;
    officialHandicapLine?: string | number | null;
  } | null | undefined
): boolean;

export function parseHandicapLine(value: unknown): number | null;

export function recommendationLinesMatch(
  prediction: OfficialRecommendationCandidate | null | undefined,
  evidence: OfficialRecommendationCandidate['multiFactorEvidence'],
  currentOfficialHandicapLine: unknown
): boolean;
