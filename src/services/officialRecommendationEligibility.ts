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

export const OFFICIAL_RECOMMENDATION_POLICY_VERSION = 'multi-factor-market-evidence-v2';

const BLOCKED_TIER_PATTERN = /reference|model[-_ ]?only|watch/i;

// Browser-native mirror of the dependency-free CJS server/script policy.
// Keep behavior aligned without importing CommonJS into the Vite runtime.

export const parseHandicapLine = (value: unknown): number | null => {
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

const recommendationLineForPool = (pool: string | undefined, value: unknown) => {
  if (pool === 'HAD' && (value === null || value === undefined || String(value).trim() === '')) return 0;
  return parseHandicapLine(value);
};

export const recommendationLinesMatch = (
  prediction: OfficialRecommendationCandidate | null | undefined,
  evidence: OfficialRecommendationCandidate['multiFactorEvidence'],
  currentOfficialHandicapLine: unknown,
) => {
  const pool = prediction?.oddsPoolCode;
  const predictionLine = recommendationLineForPool(pool, prediction?.handicapLine);
  const evidenceLine = recommendationLineForPool(pool, evidence?.handicapLine);
  const officialLine = recommendationLineForPool(pool, currentOfficialHandicapLine);
  if (pool === 'HAD') return predictionLine === 0 && evidenceLine === 0 && officialLine === 0;
  return pool === 'HHAD'
    && predictionLine !== null
    && evidenceLine !== null
    && officialLine !== null
    && predictionLine === evidenceLine
    && evidenceLine === officialLine;
};

export const isOfficialRecommendationEligible = (
  prediction: OfficialRecommendationCandidate | null | undefined,
  officialOdds: number,
  currentOfficialHandicapLine?: string | number | null,
) => {
  const odds = Number(officialOdds);
  const tier = String(prediction?.recommendationTier || '');
  const evidence = prediction?.multiFactorEvidence;
  const evidenceOdds = Number(evidence?.odds);
  return Boolean(
    prediction
    && prediction.marketType === 'BEST'
    && prediction.recommendationAction === 'recommend'
    && (prediction.oddsPoolCode === 'HAD' || prediction.oddsPoolCode === 'HHAD')
    && (prediction.tipCode === '1' || prediction.tipCode === 'X' || prediction.tipCode === '2')
    && !BLOCKED_TIER_PATTERN.test(tier)
    && Number.isFinite(odds)
    && odds > 1
    && evidence?.version === OFFICIAL_RECOMMENDATION_POLICY_VERSION
    && evidence?.eligible === true
    && evidence?.market === prediction.oddsPoolCode
    && evidence?.code === prediction.tipCode
    && recommendationLinesMatch(prediction, evidence, currentOfficialHandicapLine)
    && Array.isArray(evidence?.blockers)
    && evidence.blockers.length === 0
    && Number.isFinite(evidenceOdds)
    && Math.abs(evidenceOdds - odds) <= 0.001
  );
};

export const isServerOfficialRecommendationEligible = (
  prediction: OfficialRecommendationCandidate | null | undefined,
  officialOdds: number,
  context: {
    officialSource?: boolean;
    globalRiskTier?: string;
    officialHandicapLine?: string | number | null;
  } | null | undefined,
) => Boolean(
  isOfficialRecommendationEligible(prediction, officialOdds, context?.officialHandicapLine)
  && context?.officialSource === true
  && String(context?.globalRiskTier || '').toLowerCase() === 'stable'
);
