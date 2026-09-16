"use strict";

const PRECISION_POLICY_VERSION = "formal-recommendation-precision-v1";

const POLICY = Object.freeze({
  HAD: Object.freeze({
    maxOdds: 2.05,
    minModelProbability: 0.48,
    minModelGap: 0.08,
    minDataQuality: 0.55,
    minSupportingFactors: 5,
    minEvidenceScore: 72,
    maxSevereMissingCount: 0,
    maxRiskPenalty: 0.08,
    maxRiskTagsCount: 2,
    minExpectedValue: 0.01,
    minProbabilityEdge: -0.01,
    requireMarketLeaderAlignment: false,
    requireHandicapAlignment: false,
  }),
  HHAD: Object.freeze({
    maxOdds: 1.85,
    minModelProbability: 0.55,
    minModelGap: 0.10,
    minDataQuality: 0.65,
    minSupportingFactors: 6,
    minEvidenceScore: 78,
    maxSevereMissingCount: 0,
    maxRiskPenalty: 0.05,
    maxRiskTagsCount: 1,
    minExpectedValue: 0.02,
    minProbabilityEdge: 0,
    requireMarketLeaderAlignment: true,
    requireHandicapAlignment: true,
  }),
});

const finite = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

function precisionPolicyFor(market) {
  return POLICY[String(market || "").toUpperCase()] || null;
}

function evaluateRecommendationPrecision(input = {}) {
  const market = String(input.market || "").toUpperCase();
  const policy = precisionPolicyFor(market);
  if (!policy) {
    return {
      version: PRECISION_POLICY_VERSION,
      eligible: false,
      market,
      blockers: ["precision-unsupported-market"],
      policy: null,
    };
  }

  const odds = finite(input.odds);
  const modelProbability = finite(input.modelProbability);
  const modelGap = finite(input.modelGap);
  const dataQuality = finite(input.dataQuality);
  const expectedValue = finite(input.expectedValue);
  const probabilityEdge = finite(input.probabilityEdge);
  const evidenceScore = finite(input.evidenceScore);
  const supportingFactors = Math.max(0, Math.trunc(finite(input.supportingFactors) || 0));
  const severeMissingCount = Math.max(0, Math.trunc(finite(input.severeMissingCount) || 0));
  const riskPenalty = Math.max(0, finite(input.riskPenalty) || 0);
  const riskTagsCount = Math.max(0, Math.trunc(finite(input.riskTagsCount) || 0));

  const blockers = [];
  if (odds === null || odds <= 1 || odds > policy.maxOdds) blockers.push("precision-odds-outside-high-hit-band");
  if (modelProbability === null || modelProbability < policy.minModelProbability) blockers.push("precision-model-probability-too-low");
  if (modelGap === null || modelGap < policy.minModelGap) blockers.push("precision-model-separation-too-thin");
  if (dataQuality === null || dataQuality < policy.minDataQuality) blockers.push("precision-data-quality-too-low");
  if (expectedValue === null || expectedValue < policy.minExpectedValue) blockers.push("precision-expected-value-too-low");
  if (probabilityEdge === null || probabilityEdge < policy.minProbabilityEdge) blockers.push("precision-market-edge-too-weak");
  if (evidenceScore === null || evidenceScore < policy.minEvidenceScore) blockers.push("precision-evidence-score-too-low");
  if (supportingFactors < policy.minSupportingFactors) blockers.push("precision-independent-support-too-thin");
  if (severeMissingCount > policy.maxSevereMissingCount) blockers.push("precision-severe-data-gap");
  if (riskPenalty > policy.maxRiskPenalty) blockers.push("precision-risk-penalty-too-high");
  if (riskTagsCount > policy.maxRiskTagsCount) blockers.push("precision-too-many-risk-tags");
  if (policy.requireMarketLeaderAlignment && input.marketLeaderAligned !== true) blockers.push("precision-market-leader-not-aligned");
  if (policy.requireHandicapAlignment && input.handicapAligned !== true) blockers.push("precision-handicap-not-aligned");
  if (input.trendContradicts === true) blockers.push("precision-market-movement-contradiction");
  if (input.externalMarketContradicted === true) blockers.push("precision-external-market-contradiction");

  const resultBlockers = unique(blockers);
  return {
    version: PRECISION_POLICY_VERSION,
    eligible: resultBlockers.length === 0,
    market,
    blockers: resultBlockers,
    policy,
  };
}

module.exports = {
  PRECISION_POLICY_VERSION,
  PRECISION_POLICY: POLICY,
  precisionPolicyFor,
  evaluateRecommendationPrecision,
};
