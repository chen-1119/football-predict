"use strict";

const assert = require("node:assert/strict");
const { evaluateHistoricalRecommendationGuard } = require("../src/services/recommendationHistoricalGuard.cjs");
const { evaluateMultiFactorRecommendation } = require("../src/services/multiFactorRecommendation.cjs");

const base = {
  market: "HAD", code: "1", handicapLine: 0,
  modelProbability: 0.59, marketProbability: 0.52, modelGap: 0.12, dataQuality: 0.78,
  scoreAligned: true, crossMarketCompatible: true, handicapAligned: true,
  marketLeaderAligned: true, trendSupports: true, trendContradicts: false,
  externalMarketAligned: true, externalMarketContradicted: false,
  upstreamRecommended: true, upstreamAligned: true, globalRiskTier: "stable",
  severeMissingCount: 0, riskTagsCount: 0, trustPenalty: 0, riskPenalty: 0,
};

const lowMid = evaluateHistoricalRecommendationGuard({ ...base, odds: 1.64 });
assert.equal(lowMid.blockers.length, 0);
assert.equal(lowMid.tier, "standard");

const high = evaluateHistoricalRecommendationGuard({ ...base, odds: 2.18, probabilityEdge: 0.07 });
assert.equal(high.blockers.length, 0, "strong high-SP evidence may remain eligible");
assert.equal(high.tier, "tight");

const weakHigh = evaluateHistoricalRecommendationGuard({
  ...base, odds: 2.18, modelProbability: 0.49, modelGap: 0.07,
  probabilityEdge: 0.01, marketLeaderAligned: false, externalMarketAligned: false,
});
assert.ok(weakHigh.blockers.includes("high-sp-model-probability-too-low"));
assert.ok(weakHigh.blockers.includes("high-sp-model-separation-too-thin"));
assert.ok(weakHigh.blockers.includes("high-sp-market-confirmation-missing"));

const veryHigh = evaluateHistoricalRecommendationGuard({ ...base, odds: 2.75 });
assert.ok(veryHigh.blockers.includes("historical-high-sp-cooling"));
assert.equal(veryHigh.tier, "reference-only");

const weakHhad = evaluateHistoricalRecommendationGuard({
  ...base, market: "HHAD", odds: 1.85, modelProbability: 0.51,
  modelGap: 0.08, dataQuality: 0.58, marketLeaderAligned: false,
  externalMarketAligned: false,
});
assert.ok(weakHhad.blockers.includes("hhad-model-probability-too-low"));
assert.ok(weakHhad.blockers.includes("hhad-data-quality-too-low"));
assert.ok(weakHhad.blockers.includes("hhad-market-confirmation-missing"));

const formalLowMid = evaluateMultiFactorRecommendation({ ...base, odds: 1.64 });
assert.equal(formalLowMid.historicalGuard.tier, "standard");

const formalVeryHigh = evaluateMultiFactorRecommendation({ ...base, odds: 2.75 });
assert.equal(formalVeryHigh.eligible, false);
assert.ok(formalVeryHigh.blockers.includes("historical-high-sp-cooling"));

console.log(JSON.stringify({ ok: true, policy: formalLowMid.version, checks: 7 }, null, 2));
