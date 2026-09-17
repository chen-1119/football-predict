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

// Keep the historical publication contract identifier stable. Producer
// versions are a separate concern; accepting them never creates a publication.
export const OFFICIAL_RECOMMENDATION_POLICY_VERSION = 'multi-factor-market-evidence-v2';
export const SUPPORTED_RECOMMENDATION_EVIDENCE_VERSIONS: readonly string[] = Object.freeze([
  OFFICIAL_RECOMMENDATION_POLICY_VERSION,
  'multi-factor-dynamic-evidence-v3',
  'multi-factor-dynamic-evidence-v4',
]);
const BLOCKED_TIER_PATTERN = /reference|model[-_ ]?only|watch|shadow/i;

export const parseHandicapLine = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\uFF0B/g, '+').replace(/[\uFF0D\u2212\u2013\u2014]/g, '-');
  if (/^(?:\u4E0D\u8BA9\u7403|\u4E0D\u8BA9|\u5E73\u624B|HAD)$/i.test(normalized)) return 0;
  const match = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isFinite(line) ? (line === 0 ? 0 : line) : null;
};
const recommendationLineForPool = (pool: string | undefined, value: unknown) => {
  if (pool === 'HAD' && (value === null || value === undefined || String(value).trim() === '')) return 0;
  return parseHandicapLine(value);
};
export const recommendationLinesMatch = (
  prediction: OfficialRecommendationCandidate | null | undefined,
  evidence: OfficialRecommendationCandidate['multiFactorEvidence'],
  currentOfficialHandicapLine: unknown,
): boolean => {
  const pool = prediction?.oddsPoolCode;
  const line = recommendationLineForPool(pool, prediction?.handicapLine);
  const evidenceLine = recommendationLineForPool(pool, evidence?.handicapLine);
  const officialLine = recommendationLineForPool(pool, currentOfficialHandicapLine);
  if (pool === 'HAD') return line === 0 && evidenceLine === 0 && officialLine === 0;
  return pool === 'HHAD' && line !== null && evidenceLine !== null && officialLine !== null
    && line === evidenceLine && evidenceLine === officialLine;
};
export function recommendationEligibilityReasons(
  prediction: OfficialRecommendationCandidate | null | undefined,
  officialOdds: number,
  currentOfficialHandicapLine?: string | number | null,
): string[] {
  if (!prediction) return ['prediction-missing'];
  const evidence = prediction.multiFactorEvidence;
  const odds = Number(officialOdds), evidenceOdds = Number(evidence?.odds);
  const reasons: string[] = [];
  if (prediction.marketType !== 'BEST') reasons.push('selection-role-not-best');
  if (prediction.recommendationAction !== 'recommend') reasons.push('not-a-published-recommendation-action');
  if (BLOCKED_TIER_PATTERN.test(prediction.recommendationTier || '')) reasons.push('reference-or-shadow-tier');
  if (!['HAD', 'HHAD'].includes(prediction.oddsPoolCode || '')) reasons.push('unsupported-market');
  if (!['1', 'X', '2'].includes(prediction.tipCode || '')) reasons.push('unsupported-direction');
  if (!Number.isFinite(odds) || odds <= 1) reasons.push('official-sp-missing');
  if (!SUPPORTED_RECOMMENDATION_EVIDENCE_VERSIONS.includes(evidence?.version || '')) reasons.push('unsupported-evidence-version');
  if (evidence?.eligible !== true) reasons.push('evidence-not-eligible');
  if (evidence?.market !== prediction.oddsPoolCode || evidence?.code !== prediction.tipCode) reasons.push('evidence-selection-mismatch');
  if (!recommendationLinesMatch(prediction, evidence, currentOfficialHandicapLine)) reasons.push('handicap-line-mismatch');
  if (!Array.isArray(evidence?.blockers) || evidence.blockers.length !== 0) reasons.push('evidence-has-blockers');
  if (!Number.isFinite(evidenceOdds) || Math.abs(evidenceOdds - odds) > 0.001) reasons.push('evidence-sp-mismatch');
  return reasons;
}
export const isOfficialRecommendationEligible = (
  prediction: OfficialRecommendationCandidate | null | undefined,
  officialOdds: number,
  currentOfficialHandicapLine?: string | number | null,
): boolean => recommendationEligibilityReasons(prediction, officialOdds, currentOfficialHandicapLine).length === 0;

export const isServerOfficialRecommendationEligible = (
  prediction: OfficialRecommendationCandidate | null | undefined,
  officialOdds: number,
  context: { officialSource?: boolean; globalRiskTier?: string; officialHandicapLine?: string | number | null } | null | undefined,
): boolean => isOfficialRecommendationEligible(prediction, officialOdds, context?.officialHandicapLine)
  && context?.officialSource === true
  && String(context?.globalRiskTier || '').toLowerCase() === 'stable';
