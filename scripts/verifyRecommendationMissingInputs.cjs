"use strict";
const assert = require("node:assert/strict");
const { evaluateMultiFactorRecommendation } = require("../src/services/multiFactorRecommendation.cjs");
const { buildCandidateDecisionSnapshot } = require("../src/services/decisionSnapshot.cjs");
const { dataGapProfile } = require("./syncData.cjs");
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
const input = { market: "HAD", code: "1", odds: 2.1, modelProbability: 0.62, marketProbability: 0.5,
  modelGap: 0.2, dataQuality: 0.85, severeMissingCount: 0, crossMarketCompatible: true,
  scoreAligned: true, handicapAligned: true, marketLeaderAligned: true, trendSupports: true,
  externalMarketAligned: true, upstreamRecommended: true, upstreamAligned: true, globalRiskTier: "stable" };
for (const field of ["modelProbability", "marketProbability", "modelGap", "dataQuality"]) {
  for (const value of [null, undefined, "", "  ", true, -1, 101]) check(`${field} rejects ${String(value)}`, () => {
    const result = evaluateMultiFactorRecommendation({ ...input, [field]: value });
    assert.equal(result.eligible, false);
    const blocker = { modelProbability: "missing-model-probability", marketProbability: "missing-devigged-market-probability",
      modelGap: "missing-model-separation", dataQuality: "missing-data-quality" }[field];
    assert.ok(result.blockers.includes(blocker));
  });
}
for (const value of [null, undefined, "", true, -1, 0.49, 1.49, "0.49", Number.MAX_SAFE_INTEGER + 1]) check(`unknown severe gaps remain blocked ${String(value)}`, () => {
  assert.ok(evaluateMultiFactorRecommendation({ ...input, severeMissingCount: value }).blockers.includes("missing-data-gap-assessment"));
  const candidate = buildCandidateDecisionSnapshot({ probabilityModel: { unifiedPosterior: {
    candidates: [{ market: "HAD", code: "1", probability: 0.62, odds: 2.1,
      multiFactorEvidence: { ...input, severeMissingCount: value } }],
  } } }, "2026-10-02T08:00:00Z").candidates[0];
  assert.ok(candidate.blockers.includes("missing-data-gap-assessment"));
});
for (const value of [null, undefined, "true", 0, 1]) check(`unknown market compatibility gains no credit ${String(value)}`, () => {
  const result = evaluateMultiFactorRecommendation({ ...input, crossMarketCompatible: value });
  assert.ok(result.blockers.includes("missing-cross-market-compatibility"));
  assert.equal(result.blockers.includes("had-hhad-conflict"), false);
  assert.equal(result.supportingFactors.includes("had-hhad-consistency"), false);
});
check("explicit incompatibility is a conflict", () => {
  assert.ok(evaluateMultiFactorRecommendation({ ...input, crossMarketCompatible: false }).blockers.includes("had-hhad-conflict"));
});
check("known zero gaps and compatible markets remain distinct from unknown", () => {
  const result = evaluateMultiFactorRecommendation(input);
  assert.equal(result.blockers.includes("missing-data-gap-assessment"), false);
  assert.equal(result.blockers.includes("missing-cross-market-compatibility"), false);
});
check("immutable canonical evidence preserves unknown assessments", () => {
  const snapshot = buildCandidateDecisionSnapshot({ probabilityModel: { unifiedPosterior: {
    candidates: [{ market: "HAD", code: "1", probability: null, odds: 2.1 }],
  } } }, "2026-10-02T08:00:00Z");
  const candidate = snapshot.candidates[0];
  assert.equal(candidate.modelProbability, null);
  assert.ok(candidate.blockers.includes("missing-model-probability"));
  assert.ok(candidate.blockers.includes("missing-data-gap-assessment"));
  assert.ok(candidate.blockers.includes("missing-cross-market-compatibility"));
});
// No real match data or online endpoint is involved in these contract checks.
void dataGapProfile;
console.log(JSON.stringify({ ok: true, checks, providerRequests: 0, productionDataTouched: false }, null, 2));
