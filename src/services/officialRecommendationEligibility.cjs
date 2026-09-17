// Generated from the TypeScript sibling; checked for behavioral parity.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isServerOfficialRecommendationEligible = exports.isOfficialRecommendationEligible = exports.recommendationLinesMatch = exports.parseHandicapLine = exports.SUPPORTED_RECOMMENDATION_EVIDENCE_VERSIONS = exports.OFFICIAL_RECOMMENDATION_POLICY_VERSION = void 0;
exports.recommendationEligibilityReasons = recommendationEligibilityReasons;
// Keep the historical publication contract identifier stable. Producer
// versions are a separate concern; accepting them never creates a publication.
exports.OFFICIAL_RECOMMENDATION_POLICY_VERSION = 'multi-factor-market-evidence-v2';
exports.SUPPORTED_RECOMMENDATION_EVIDENCE_VERSIONS = Object.freeze([
    exports.OFFICIAL_RECOMMENDATION_POLICY_VERSION,
    'multi-factor-dynamic-evidence-v3',
    'multi-factor-dynamic-evidence-v4',
]);
const BLOCKED_TIER_PATTERN = /reference|model[-_ ]?only|watch|shadow/i;
const parseHandicapLine = (value) => {
    if (typeof value === 'number')
        return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().replace(/\uFF0B/g, '+').replace(/[\uFF0D\u2212\u2013\u2014]/g, '-');
    if (/^(?:\u4E0D\u8BA9\u7403|\u4E0D\u8BA9|\u5E73\u624B|HAD)$/i.test(normalized))
        return 0;
    const match = normalized.match(/^(?:(?:\u8BA9\u7403|HHAD|handicap)\s*[:\uFF1A]?\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*\u7403)?$/i);
    if (!match)
        return null;
    const line = Number(match[1]);
    return Number.isFinite(line) ? (line === 0 ? 0 : line) : null;
};
exports.parseHandicapLine = parseHandicapLine;
const recommendationLineForPool = (pool, value) => {
    if (pool === 'HAD' && (value === null || value === undefined || String(value).trim() === ''))
        return 0;
    return (0, exports.parseHandicapLine)(value);
};
const recommendationLinesMatch = (prediction, evidence, currentOfficialHandicapLine) => {
    const pool = prediction?.oddsPoolCode;
    const line = recommendationLineForPool(pool, prediction?.handicapLine);
    const evidenceLine = recommendationLineForPool(pool, evidence?.handicapLine);
    const officialLine = recommendationLineForPool(pool, currentOfficialHandicapLine);
    if (pool === 'HAD')
        return line === 0 && evidenceLine === 0 && officialLine === 0;
    return pool === 'HHAD' && line !== null && evidenceLine !== null && officialLine !== null
        && line === evidenceLine && evidenceLine === officialLine;
};
exports.recommendationLinesMatch = recommendationLinesMatch;
function recommendationEligibilityReasons(prediction, officialOdds, currentOfficialHandicapLine) {
    if (!prediction)
        return ['prediction-missing'];
    const evidence = prediction.multiFactorEvidence;
    const odds = Number(officialOdds), evidenceOdds = Number(evidence?.odds);
    const reasons = [];
    if (prediction.marketType !== 'BEST')
        reasons.push('selection-role-not-best');
    if (prediction.recommendationAction !== 'recommend')
        reasons.push('not-a-published-recommendation-action');
    if (BLOCKED_TIER_PATTERN.test(prediction.recommendationTier || ''))
        reasons.push('reference-or-shadow-tier');
    if (!['HAD', 'HHAD'].includes(prediction.oddsPoolCode || ''))
        reasons.push('unsupported-market');
    if (!['1', 'X', '2'].includes(prediction.tipCode || ''))
        reasons.push('unsupported-direction');
    if (!Number.isFinite(odds) || odds <= 1)
        reasons.push('official-sp-missing');
    if (!exports.SUPPORTED_RECOMMENDATION_EVIDENCE_VERSIONS.includes(evidence?.version || ''))
        reasons.push('unsupported-evidence-version');
    if (evidence?.eligible !== true)
        reasons.push('evidence-not-eligible');
    if (evidence?.market !== prediction.oddsPoolCode || evidence?.code !== prediction.tipCode)
        reasons.push('evidence-selection-mismatch');
    if (!(0, exports.recommendationLinesMatch)(prediction, evidence, currentOfficialHandicapLine))
        reasons.push('handicap-line-mismatch');
    if (!Array.isArray(evidence?.blockers) || evidence.blockers.length !== 0)
        reasons.push('evidence-has-blockers');
    if (!Number.isFinite(evidenceOdds) || Math.abs(evidenceOdds - odds) > 0.001)
        reasons.push('evidence-sp-mismatch');
    return reasons;
}
const isOfficialRecommendationEligible = (prediction, officialOdds, currentOfficialHandicapLine) => recommendationEligibilityReasons(prediction, officialOdds, currentOfficialHandicapLine).length === 0;
exports.isOfficialRecommendationEligible = isOfficialRecommendationEligible;
const isServerOfficialRecommendationEligible = (prediction, officialOdds, context) => (0, exports.isOfficialRecommendationEligible)(prediction, officialOdds, context?.officialHandicapLine)
    && context?.officialSource === true
    && String(context?.globalRiskTier || '').toLowerCase() === 'stable';
exports.isServerOfficialRecommendationEligible = isServerOfficialRecommendationEligible;
