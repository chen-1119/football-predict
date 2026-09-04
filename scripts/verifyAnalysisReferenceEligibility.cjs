"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isCalibratedMarketAnalysisReferenceEligible,
  isDirectionalAnalysisReferenceEligible,
  isModelOnlyAnalysisReferenceEligible,
} = require("../src/services/analysisReferenceEligibility.cjs");

const now = Date.parse("2026-07-21T08:00:00+08:00");
const baseMatch = {
  status: "SCHEDULED",
  kickoffTime: "2026-07-21T18:30:00+08:00",
  buyEndTime: "2026-07-21T18:20:00+08:00",
  probabilityModel: {
    inputSufficiency: { sufficient: true },
    publicDecision: { directionPublished: true },
    contextSignals: {
      dataGaps: {
        coverageScore: 60,
        severeMissingCount: 1,
      },
    },
    unifiedPosterior: {
      generatedAt: "2026-07-21T07:00:00+08:00",
      selectedMarket: "MODEL_ONLY_1X2",
      selectedCode: "1",
      selectedProbability: 0.60,
      policy: "observation-only; excluded-until-official-sp-opens",
    },
  },
};
const basePrediction = {
  marketType: "BEST",
  tipCode: "1",
  recommendationAction: "reference",
  recommendationTier: "model-only-watch",
};

const withModelOnlyEvidence = ({ posterior = {}, dataGaps = {} } = {}) => ({
  ...baseMatch,
  probabilityModel: {
    ...baseMatch.probabilityModel,
    contextSignals: {
      ...baseMatch.probabilityModel.contextSignals,
      dataGaps: {
        ...baseMatch.probabilityModel.contextSignals.dataGaps,
        ...dataGaps,
      },
    },
    unifiedPosterior: {
      ...baseMatch.probabilityModel.unifiedPosterior,
      ...posterior,
    },
  },
});

const fixtures = [
  { name: "audited model-only direction", match: baseMatch, prediction: basePrediction, at: now, expected: true },
  { name: "model-only percentage probability is normalized", match: withModelOnlyEvidence({ posterior: { selectedProbability: 60 } }), prediction: basePrediction, at: now, expected: true },
  { name: "model-only probability below 60 percent is rejected", match: withModelOnlyEvidence({ posterior: { selectedProbability: 0.5999 } }), prediction: basePrediction, at: now, expected: false },
  { name: "Korean weak model probability 40.9 percent is rejected", match: withModelOnlyEvidence({ posterior: { selectedProbability: 40.9 } }), prediction: basePrediction, at: now, expected: false },
  { name: "Korean weak model probability 45.3 percent is rejected", match: withModelOnlyEvidence({ posterior: { selectedProbability: 45.3 } }), prediction: basePrediction, at: now, expected: false },
  { name: "Korean weak model probability 42.5 percent is rejected", match: withModelOnlyEvidence({ posterior: { selectedProbability: 42.5 } }), prediction: basePrediction, at: now, expected: false },
  { name: "model-only evidence at the 12-hour boundary remains valid", match: withModelOnlyEvidence({ posterior: { generatedAt: "2026-07-20T20:00:00+08:00" } }), prediction: basePrediction, at: now, expected: true },
  { name: "model-only evidence older than 12 hours is rejected", match: withModelOnlyEvidence({ posterior: { generatedAt: "2026-07-20T19:59:59+08:00" } }), prediction: basePrediction, at: now, expected: false },
  { name: "model-only evidence at the five-minute future-skew boundary remains valid", match: withModelOnlyEvidence({ posterior: { generatedAt: "2026-07-21T08:05:00+08:00" } }), prediction: basePrediction, at: now, expected: true },
  { name: "model-only evidence over five minutes in the future is rejected", match: withModelOnlyEvidence({ posterior: { generatedAt: "2026-07-21T08:05:01+08:00" } }), prediction: basePrediction, at: now, expected: false },
  { name: "invalid model-only generation time is rejected", match: withModelOnlyEvidence({ posterior: { generatedAt: "not-a-time" } }), prediction: basePrediction, at: now, expected: false },
  { name: "coverage below 60 is rejected", match: withModelOnlyEvidence({ dataGaps: { coverageScore: 59.9 } }), prediction: basePrediction, at: now, expected: false },
  { name: "missing coverage fails closed", match: withModelOnlyEvidence({ dataGaps: { coverageScore: null } }), prediction: basePrediction, at: now, expected: false },
  { name: "more than one severe missing input is rejected", match: withModelOnlyEvidence({ dataGaps: { severeMissingCount: 2 } }), prediction: basePrediction, at: now, expected: false },
  { name: "missing severe count fails closed", match: withModelOnlyEvidence({ dataGaps: { severeMissingCount: null } }), prediction: basePrediction, at: now, expected: false },
  { name: "invalid evaluation clock fails closed", match: baseMatch, prediction: basePrediction, at: Number.NaN, expected: false },
  { name: "WATCH has no direction", match: baseMatch, prediction: { ...basePrediction, tipCode: "WATCH" }, at: now, expected: false },
  { name: "formal action cannot enter reference lane", match: baseMatch, prediction: { ...basePrediction, recommendationAction: "recommend" }, at: now, expected: false },
  { name: "input-insufficient tier cannot enter", match: baseMatch, prediction: { ...basePrediction, recommendationTier: "input-insufficient-watch" }, at: now, expected: false },
  { name: "unknown tier fails closed", match: baseMatch, prediction: { ...basePrediction, recommendationTier: "legacy-watch" }, at: now, expected: false },
  { name: "HHAD cannot masquerade as model-only 1X2", match: baseMatch, prediction: { ...basePrediction, oddsPoolCode: "HHAD" }, at: now, expected: false },
  { name: "void match rejected", match: { ...baseMatch, resultDisposition: "VOID" }, prediction: basePrediction, at: now, expected: false },
  { name: "live match rejected", match: { ...baseMatch, status: "LIVE" }, prediction: basePrediction, at: now, expected: false },
  { name: "finished match rejected", match: { ...baseMatch, status: "FINISHED" }, prediction: basePrediction, at: now, expected: false },
  { name: "buy-end cutoff rejected", match: baseMatch, prediction: basePrediction, at: Date.parse(baseMatch.buyEndTime), expected: false },
  { name: "kickoff cutoff rejected", match: baseMatch, prediction: basePrediction, at: Date.parse(baseMatch.kickoffTime), expected: false },
  { name: "insufficient input rejected", match: { ...baseMatch, probabilityModel: { ...baseMatch.probabilityModel, inputSufficiency: { sufficient: false } } }, prediction: basePrediction, at: now, expected: false },
  { name: "posterior direction mismatch rejected", match: baseMatch, prediction: { ...basePrediction, tipCode: "2" }, at: now, expected: false },
  { name: "non-model-only posterior rejected", match: { ...baseMatch, probabilityModel: { ...baseMatch.probabilityModel, unifiedPosterior: { ...baseMatch.probabilityModel.unifiedPosterior, selectedMarket: "HAD" } } }, prediction: basePrediction, at: now, expected: false },
  { name: "suppressed public direction rejected", match: { ...baseMatch, probabilityModel: { ...baseMatch.probabilityModel, publicDecision: { directionPublished: false } } }, prediction: basePrediction, at: now, expected: false },
];

for (const fixture of fixtures) {
  assert.equal(
    isModelOnlyAnalysisReferenceEligible(fixture.match, fixture.prediction, fixture.at),
    fixture.expected,
    fixture.name
  );
}

const calibratedMatch = {
  status: "SCHEDULED",
  kickoffTime: "2026-07-21T18:30:00+08:00",
  buyEndTime: "2026-07-21T18:20:00+08:00",
  probabilityModel: {
    unifiedPosterior: {
      selectedMarket: "HAD",
      selectedCode: "1",
      selectionPolicy: "calibrated-had-market-baseline",
      marketBaseline: {
        applied: true,
        minimumLeaderProbability: 0.60,
        leaderCode: "1",
        leaderProbability: 0.61,
        rawSelection: { market: "HHAD", code: "2" },
        activeSelection: { market: "HAD", code: "1" },
      },
    },
  },
};
const calibratedPrediction = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  tipCode: "1",
  recommendationAction: "reference",
  recommendationTier: "calibrated-had-market-reference",
};

const withCalibratedPosterior = (patch) => ({
  ...calibratedMatch,
  probabilityModel: {
    ...calibratedMatch.probabilityModel,
    unifiedPosterior: {
      ...calibratedMatch.probabilityModel.unifiedPosterior,
      ...patch,
      marketBaseline: {
        ...calibratedMatch.probabilityModel.unifiedPosterior.marketBaseline,
        ...(patch.marketBaseline || {}),
      },
    },
  },
});

const calibratedFixtures = [
  { name: "audited calibrated HAD market baseline", match: calibratedMatch, prediction: calibratedPrediction, at: now, expected: true },
  { name: "legacy percentage leader probability is normalized", match: withCalibratedPosterior({ marketBaseline: { leaderProbability: 60 } }), prediction: calibratedPrediction, at: now, expected: true },
  { name: "numeric-string percentage leader probability is normalized", match: withCalibratedPosterior({ marketBaseline: { leaderProbability: "60" } }), prediction: calibratedPrediction, at: now, expected: true },
  { name: "percent-suffixed leader probability is normalized", match: withCalibratedPosterior({ marketBaseline: { leaderProbability: "60%" } }), prediction: calibratedPrediction, at: now, expected: true },
  { name: "boolean leader probability cannot bypass the threshold", match: withCalibratedPosterior({ marketBaseline: { leaderProbability: true } }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "leader probability below calibrated floor is rejected", match: withCalibratedPosterior({ marketBaseline: { leaderProbability: 0.5999 } }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "unapplied market baseline is rejected", match: withCalibratedPosterior({ marketBaseline: { applied: false } }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "unknown calibrated tier is rejected", match: calibratedMatch, prediction: { ...calibratedPrediction, recommendationTier: "posterior-reference" }, at: now, expected: false },
  { name: "formal action is rejected from calibrated reference lane", match: calibratedMatch, prediction: { ...calibratedPrediction, recommendationAction: "recommend" }, at: now, expected: false },
  { name: "HHAD prediction cannot use calibrated HAD baseline", match: calibratedMatch, prediction: { ...calibratedPrediction, oddsPoolCode: "HHAD" }, at: now, expected: false },
  { name: "WATCH is not an explicit direction", match: calibratedMatch, prediction: { ...calibratedPrediction, tipCode: "WATCH" }, at: now, expected: false },
  { name: "selection policy must match exactly", match: withCalibratedPosterior({ selectionPolicy: "calibrated-had-market-baseline-v2" }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "selected market must remain HAD", match: withCalibratedPosterior({ selectedMarket: "HHAD" }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "posterior code mismatch is rejected", match: withCalibratedPosterior({ selectedCode: "2" }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "leader code mismatch is rejected", match: withCalibratedPosterior({ marketBaseline: { leaderCode: "2" } }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "active selection code mismatch is rejected", match: withCalibratedPosterior({ marketBaseline: { activeSelection: { market: "HAD", code: "2" } } }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "active selection market mismatch is rejected", match: withCalibratedPosterior({ marketBaseline: { activeSelection: { market: "HHAD", code: "1" } } }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "missing active selection fails closed", match: withCalibratedPosterior({ marketBaseline: { activeSelection: null } }), prediction: calibratedPrediction, at: now, expected: false },
  { name: "void calibrated match is rejected", match: { ...calibratedMatch, resultDisposition: "VOID" }, prediction: calibratedPrediction, at: now, expected: false },
  { name: "live calibrated match is rejected", match: { ...calibratedMatch, status: "LIVE" }, prediction: calibratedPrediction, at: now, expected: false },
  { name: "calibrated reference expires at buy end", match: calibratedMatch, prediction: calibratedPrediction, at: Date.parse(calibratedMatch.buyEndTime), expected: false },
  { name: "calibrated reference expires at kickoff", match: calibratedMatch, prediction: calibratedPrediction, at: Date.parse(calibratedMatch.kickoffTime), expected: false },
];

for (const fixture of calibratedFixtures) {
  assert.equal(
    isCalibratedMarketAnalysisReferenceEligible(fixture.match, fixture.prediction, fixture.at),
    fixture.expected,
    fixture.name
  );
}

const directionalMatch = {
  status: "SCHEDULED",
  kickoffTime: "2026-07-21T18:30:00+08:00",
  buyEndTime: "2026-07-21T18:20:00+08:00",
  probabilityModel: {
    inputSufficiency: { sufficient: true },
    publicDecision: null,
    unifiedPosterior: {
      generatedAt: "2026-07-20T22:00:00+08:00",
      selectedMarket: "HAD",
      selectedCode: "1",
      selectedProbability: 0.54,
    },
  },
};
const directionalPrediction = {
  marketType: "BEST",
  oddsPoolCode: "HAD",
  tipCode: "1",
  recommendationAction: "reference",
  recommendationTier: "multi-factor-watch",
  multiFactorEvidence: {
    evidenceScore: 58,
    modelProbability: 0.54,
    modelGap: 0.08,
    expectedValue: 0.03,
    dataQuality: 0.72,
    supportingFactors: ["independent-model-probability", "model-separation", "score-matrix-alignment"],
    blockers: ["upstream-multi-factor-gate-not-passed", "model-risk-not-promotable"],
    diagnostics: {
      scoreAligned: true,
      crossMarketCompatible: true,
      externalMarketContradicted: false,
      severeMissingCount: 1,
    },
  },
};
const directionalFixtures = [
  { name: "strong directional multi-factor BEST remains visible as a reference pick", match: directionalMatch, prediction: directionalPrediction, expected: true },
  { name: "missing pool may inherit the exact posterior HAD market", match: directionalMatch, prediction: { ...directionalPrediction, oddsPoolCode: undefined }, expected: true },
  { name: "explicit HHAD prediction cannot masquerade as a HAD posterior", match: directionalMatch, prediction: { ...directionalPrediction, oddsPoolCode: "HHAD" }, expected: false },
  { name: "explicit HAD prediction cannot masquerade as a HHAD posterior", match: { ...directionalMatch, probabilityModel: { ...directionalMatch.probabilityModel, unifiedPosterior: { ...directionalMatch.probabilityModel.unifiedPosterior, selectedMarket: "HHAD" } } }, prediction: directionalPrediction, expected: false },
  { name: "missing pool may inherit the exact posterior HHAD market", match: { ...directionalMatch, probabilityModel: { ...directionalMatch.probabilityModel, unifiedPosterior: { ...directionalMatch.probabilityModel.unifiedPosterior, selectedMarket: "HHAD" } } }, prediction: { ...directionalPrediction, oddsPoolCode: undefined }, expected: true },
  { name: "weak evidence cannot masquerade as a reference pick", match: directionalMatch, prediction: { ...directionalPrediction, multiFactorEvidence: { ...directionalPrediction.multiFactorEvidence, evidenceScore: 23.2 } }, expected: false },
  { name: "zero model gap is rejected from the directional reference lane", match: directionalMatch, prediction: { ...directionalPrediction, multiFactorEvidence: { ...directionalPrediction.multiFactorEvidence, modelGap: 0 } }, expected: false },
  { name: "negative expected value is rejected from the directional reference lane", match: directionalMatch, prediction: { ...directionalPrediction, multiFactorEvidence: { ...directionalPrediction.multiFactorEvidence, expectedValue: -0.02, blockers: ["negative-expected-value"] } }, expected: false },
  { name: "severe data gaps reject the directional reference", match: directionalMatch, prediction: { ...directionalPrediction, multiFactorEvidence: { ...directionalPrediction.multiFactorEvidence, diagnostics: { ...directionalPrediction.multiFactorEvidence.diagnostics, severeMissingCount: 2 } } }, expected: false },
  { name: "score safeguard without market separation is rejected", match: { ...directionalMatch, probabilityModel: { ...directionalMatch.probabilityModel, unifiedPosterior: { ...directionalMatch.probabilityModel.unifiedPosterior, selectionPolicy: "score-draw-risk-safeguard", selectedCode: "X", selectedProbability: 0.31 } } }, prediction: { ...directionalPrediction, tipCode: "X", multiFactorEvidence: { ...directionalPrediction.multiFactorEvidence, modelProbability: 0.31, modelGap: 0 } }, expected: false },
  { name: "input-insufficient WATCH remains hidden", match: directionalMatch, prediction: { ...directionalPrediction, tipCode: "WATCH", recommendationTier: "input-insufficient-watch" }, expected: false },
  { name: "insufficient directional inputs fail closed", match: { ...directionalMatch, probabilityModel: { ...directionalMatch.probabilityModel, inputSufficiency: { sufficient: false } } }, prediction: directionalPrediction, expected: false },
  { name: "posterior direction mismatch fails closed", match: directionalMatch, prediction: { ...directionalPrediction, tipCode: "2" }, expected: false },
];
for (const fixture of directionalFixtures) {
  assert.equal(
    isDirectionalAnalysisReferenceEligible(fixture.match, fixture.prediction, now),
    fixture.expected,
    fixture.name
  );
}

const referenceSelectionSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "services", "analysisReferenceSelection.ts"),
  "utf8"
);
const calibratedGuardAt = referenceSelectionSource.indexOf(
  "isCalibratedMarketAnalysisReferenceEligible(match, storedBest, now)"
);
const directionalGuardAt = referenceSelectionSource.indexOf(
  "isDirectionalAnalysisReferenceEligible(match, storedBest, now)",
  calibratedGuardAt
);
const modelOnlyFallbackAt = referenceSelectionSource.indexOf(
  "isModelOnlyAnalysisReferenceEligible(match, storedBest, now)",
  directionalGuardAt
);
const fiveHundredFallbackAt = referenceSelectionSource.indexOf(
  "buildFiveHundredMarketReferencePresentation(match, now)",
  modelOnlyFallbackAt
);
assert.ok(calibratedGuardAt >= 0, "stored BEST must pass the calibrated market reference guard");
assert.ok(
  directionalGuardAt > calibratedGuardAt
    && modelOnlyFallbackAt > directionalGuardAt
    && fiveHundredFallbackAt > modelOnlyFallbackAt,
  "stored calibrated/strong/model directions must precede market-only fallbacks so fresh odds cannot rewrite an existing direction"
);
assert.doesNotMatch(
  referenceSelectionSource,
  /if \(storedBest && \['1', 'X', '2'\]\.includes\(storedBest\.tipCode\)\)/,
  "generic stored BEST direction must not bypass analysis reference eligibility"
);

console.log(JSON.stringify({
  ok: true,
  verifier: "analysis-reference-eligibility",
  fixtures: fixtures.length + calibratedFixtures.length + directionalFixtures.length,
  passed: fixtures.length + calibratedFixtures.length + directionalFixtures.length,
  staticChecks: 3,
}, null, 2));
