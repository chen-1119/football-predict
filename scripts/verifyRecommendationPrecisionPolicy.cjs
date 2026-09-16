"use strict";

const assert = require("node:assert/strict");
const {
  evaluateRecommendationPrecision,
  precisionPolicyFor,
} = require("../src/services/recommendationPrecisionPolicy.cjs");
const {
  evaluateMultiFactorRecommendation,
} = require("../src/services/multiFactorRecommendation.cjs");

const hadPolicy = precisionPolicyFor("HAD");
const hhadPolicy = precisionPolicyFor("HHAD");
assert.equal(hadPolicy.maxOdds, 2.05);
assert.equal(hhadPolicy.maxOdds, 1.85);
assert.ok(hhadPolicy.minEvidenceScore > hadPolicy.minEvidenceScore);

const strongHad = evaluateRecommendationPrecision({
  market: "HAD",
  odds: 1.75,
  modelProbability: 0.62,
  modelGap: 0.14,
  dataQuality: 0.84,
  expectedValue: 0.085,
  probabilityEdge: 0.08,
  evidenceScore: 84,
  supportingFactors: 8,
  severeMissingCount: 0,
  riskPenalty: 0.02,
  riskTagsCount: 1,
  trendContradicts: false,
  externalMarketContradicted: false,
});
assert.equal(strongHad.eligible, true);

const highOddsHad = evaluateRecommendationPrecision({
  market: "HAD",
  odds: 2.25,
  modelProbability: 0.62,
  modelGap: 0.14,
  dataQuality: 0.84,
  expectedValue: 0.30,
  probabilityEdge: 0.08,
  evidenceScore: 88,
  supportingFactors: 9,
  severeMissingCount: 0,
  riskPenalty: 0.01,
  riskTagsCount: 0,
});
assert.equal(highOddsHad.eligible, false);
assert.ok(highOddsHad.blockers.includes("precision-odds-outside-high-hit-band"));

const weakHhad = evaluateRecommendationPrecision({
  market: "HHAD",
  odds: 1.78,
  modelProbability: 0.52,
  modelGap: 0.07,
  dataQuality: 0.58,
  expectedValue: 0.03,
  probabilityEdge: 0.01,
  evidenceScore: 73,
  supportingFactors: 5,
  severeMissingCount: 0,
  riskPenalty: 0.03,
  riskTagsCount: 1,
  marketLeaderAligned: false,
  handicapAligned: false,
});
assert.equal(weakHhad.eligible, false);
assert.ok(weakHhad.blockers.includes("precision-model-probability-too-low"));
assert.ok(weakHhad.blockers.includes("precision-market-leader-not-aligned"));
assert.ok(weakHhad.blockers.includes("precision-handicap-not-aligned"));

const strongIntegratedHad = evaluateMultiFactorRecommendation({
  market: "HAD",
  code: "1",
  handicapLine: 0,
  odds: 1.72,
  modelProbability: 0.63,
  marketProbability: 0.54,
  modelGap: 0.15,
  dataQuality: 0.88,
  trustPenalty: 0,
  riskPenalty: 0.01,
  severeMissingCount: 0,
  riskTagsCount: 1,
  scoreAligned: true,
  crossMarketCompatible: true,
  handicapAligned: true,
  marketLeaderAligned: true,
  trendSupports: true,
  trendContradicts: false,
  externalMarketAligned: true,
  externalMarketContradicted: false,
  externalMarketRisk: "low",
  upstreamRecommended: true,
  upstreamAligned: true,
  globalRiskTier: "stable",
});
assert.equal(strongIntegratedHad.eligible, true, JSON.stringify(strongIntegratedHad.blockers));
assert.equal(strongIntegratedHad.precision.eligible, true);
assert.ok(strongIntegratedHad.threshold >= 72);

const highOddsIntegratedHad = evaluateMultiFactorRecommendation({
  market: "HAD",
  code: "1",
  handicapLine: 0,
  odds: 2.30,
  modelProbability: 0.63,
  marketProbability: 0.43,
  modelGap: 0.15,
  dataQuality: 0.88,
  trustPenalty: 0,
  riskPenalty: 0.01,
  severeMissingCount: 0,
  riskTagsCount: 0,
  scoreAligned: true,
  crossMarketCompatible: true,
  handicapAligned: true,
  marketLeaderAligned: true,
  trendSupports: true,
  externalMarketAligned: true,
  upstreamRecommended: true,
  upstreamAligned: true,
  globalRiskTier: "stable",
});
assert.equal(highOddsIntegratedHad.eligible, false);
assert.ok(highOddsIntegratedHad.blockers.includes("precision-odds-outside-high-hit-band"));

console.log(JSON.stringify({
  ok: true,
  policy: "precision-first",
  checks: 15,
  hadMaxOdds: hadPolicy.maxOdds,
  hhadMaxOdds: hhadPolicy.maxOdds,
}, null, 2));
