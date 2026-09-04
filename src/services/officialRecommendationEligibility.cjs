const OFFICIAL_RECOMMENDATION_POLICY_VERSION = 'multi-factor-market-evidence-v2';

const BLOCKED_TIER_PATTERN = /reference|model[-_ ]?only|watch/i;

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

const recommendationLineForPool = (pool, value) => {
  if (pool === 'HAD' && (value === null || value === undefined || String(value).trim() === '')) return 0;
  return parseHandicapLine(value);
};

const recommendationLinesMatch = (prediction, evidence, currentOfficialHandicapLine) => {
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

/**
 * Canonical eligibility gate for the production server and Node verification
 * scripts. The browser uses the independent TypeScript sibling with identical
 * behavior so Vite never imports this CommonJS module at runtime. Keeping this
 * module dependency-free lets signed releases verify the policy after
 * development dependencies are pruned.
 *
 * @param {{
 *   marketType?: string;
 *   oddsPoolCode?: string;
 *   tipCode?: string;
 *   recommendationAction?: string;
 *   recommendationTier?: string;
 *   multiFactorEvidence?: {
 *     version?: string;
 *     eligible?: boolean;
 *     market?: string;
 *     code?: string;
 *     handicapLine?: string | number;
 *     odds?: number;
 *     blockers?: string[];
 *   };
 *   handicapLine?: string | number;
 * } | null | undefined} prediction
 * @param {number} officialOdds
 * @param {string | number | null | undefined} currentOfficialHandicapLine
 */
const isOfficialRecommendationEligible = (prediction, officialOdds, currentOfficialHandicapLine) => {
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

/**
 * Production-server boundary. Browser eligibility remains presentation-only;
 * the server additionally requires a verified Sporttery source and a stable
 * global model-risk tier before any executable recommendation can leave the
 * API.
 *
 * @param {Parameters<typeof isOfficialRecommendationEligible>[0]} prediction
 * @param {number} officialOdds
 * @param {{ officialSource?: boolean; globalRiskTier?: string; officialHandicapLine?: string | number | null } | null | undefined} context
 */
const isServerOfficialRecommendationEligible = (prediction, officialOdds, context) => Boolean(
  isOfficialRecommendationEligible(prediction, officialOdds, context?.officialHandicapLine)
  && context?.officialSource === true
  && String(context?.globalRiskTier || '').toLowerCase() === 'stable'
);

module.exports = {
  OFFICIAL_RECOMMENDATION_POLICY_VERSION,
  isOfficialRecommendationEligible,
  isServerOfficialRecommendationEligible,
  parseHandicapLine,
  recommendationLinesMatch
};
