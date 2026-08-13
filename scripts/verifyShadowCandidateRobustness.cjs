"use strict";

const assert = require("node:assert/strict");
const {
  NOMINATION_SELECTION_VERSION,
  NOMINATION_SELECTION_POLICY,
  VERSION,
  buildShadowCandidateRobustness,
  nominationSelectionPolicyCommitment,
  pairedCircularBlockBootstrap,
  rankShadowCandidatesForNomination,
  scoreDeltaForRow,
  temperatureGridAudit,
} = require("./shadowCandidateRobustness.cjs");

assert.deepEqual(
  nominationSelectionPolicyCommitment(),
  NOMINATION_SELECTION_POLICY,
);

const makeRows = (count, candidateProbability = 0.72) => Array.from({ length: count }, (_, index) => ({
  matchId: `m-${index + 1}`,
  kickoffTime: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(),
  league: `league-${(index % 6) + 1}`,
  actual: "1",
  probabilities: {
    "1": candidateProbability,
    X: (1 - candidateProbability) * 0.55,
    "2": (1 - candidateProbability) * 0.45,
  },
  marketProbabilities: {
    "1": 0.6,
    X: 0.22,
    "2": 0.18,
  },
  market: {
    odds: {
      "1": 1.62,
      X: 3.7,
      "2": 4.4,
    },
  },
}));

const candidate = (id, temperature, rows, role = "shadow-feature-candidate") => ({
  id,
  role,
  featureSet: ["sporttery-market", "temperature-calibration"],
  weights: {
    market: 1,
    model: 0,
    ...(temperature ? { temperature } : {}),
  },
  metrics: { rows: rows.length },
  comparison: {
    rows: rows.length,
    logLossImprovement: 0.02,
    brierImprovement: 0.01,
  },
  rolling: {
    windows: 6,
    passed: 6,
    passRate: 1,
  },
  _rows: rows,
});

const rows = makeRows(600);
const candidates = [
  candidate("market-baseline", null, rows, "baseline"),
  candidate("market-temperature-1_1", 1.1, rows),
  candidate("market-temperature-1_25", 1.25, rows),
  candidate("market-temperature-1_5", 1.5, rows),
];

const delta = scoreDeltaForRow(rows[0]);
assert.ok(delta.logLossImprovement > 0, "stronger correct probability should improve log loss");
assert.ok(delta.brierImprovement > 0, "stronger correct probability should improve Brier");

const firstBootstrap = pairedCircularBlockBootstrap(rows, {
  candidateId: "market-temperature-1_25",
  testedCandidateCount: 3,
  iterations: 1200,
});
const secondBootstrap = pairedCircularBlockBootstrap(rows, {
  candidateId: "market-temperature-1_25",
  testedCandidateCount: 3,
  iterations: 1200,
});
assert.deepEqual(firstBootstrap, secondBootstrap, "bootstrap must be deterministic");
assert.ok(
  firstBootstrap.familyWiseAdjusted.logLossImprovement.lower
    <= firstBootstrap.unadjusted95.logLossImprovement.lower,
  "family-wise lower bound must be no more optimistic than unadjusted lower bound",
);
assert.ok(
  firstBootstrap.familyWiseAdjusted.brierImprovement.lower
    <= firstBootstrap.unadjusted95.brierImprovement.lower,
  "family-wise Brier lower bound must be no more optimistic than unadjusted lower bound",
);

const temperature = temperatureGridAudit(candidates, "market-temperature-1_25");
assert.equal(temperature.grid.length, 3);
assert.equal(temperature.selected.temperature, 1.25);
assert.equal(temperature.neighbors.length, 2);
assert.match(temperature.gridHash, /^[a-f0-9]{64}$/);

const audit = buildShadowCandidateRobustness({
  candidates,
  bestCandidateId: "market-temperature-1_25",
});
assert.equal(audit.version, VERSION);
assert.equal(audit.family.candidateCount, 4);
assert.equal(audit.family.testedCandidateCount, 3);
assert.match(audit.family.inventoryHash, /^[a-f0-9]{64}$/);
assert.equal(audit.selectedCandidate.id, "market-temperature-1_25");
assert.equal(audit.candidateReadyForProspectiveTest, true);
assert.equal(audit.formalPromotionEligible, false);
assert.deepEqual(audit.nominationBlockers, []);
assert.deepEqual(audit.nominationThresholds, {
  minimumRows: 150,
  minimumIndependentWindows: 4,
  minimumRollingPassRate: 0.6,
  requirePositivePointEstimates: true,
  onlineEffect: false,
});
assert.deepEqual(audit.blockers, ["candidate-selected-on-same-retrospective-sample"]);
assert.equal(audit.selectedCandidate.stratification.byLeague["league-1"].rows, 100);

const smallRows = makeRows(100);
const smallAudit = buildShadowCandidateRobustness({
  candidates: [
    candidate("market-baseline", null, smallRows, "baseline"),
    candidate("market-temperature-1_25", 1.25, smallRows),
  ],
  bestCandidateId: "market-temperature-1_25",
});
assert.equal(smallAudit.candidateReadyForProspectiveTest, false);
assert.ok(smallAudit.blockers.includes("paired-rows:100<500"));
assert.ok(smallAudit.nominationBlockers.includes("nomination-paired-rows:100<150"));
assert.equal(smallAudit.formalPromotionEligible, false);

const negativeRows = makeRows(164, 0.5);
const negativeAudit = buildShadowCandidateRobustness({
  candidates: [
    candidate("market-baseline", null, negativeRows, "baseline"),
    candidate("market-temperature-1_25", 1.25, negativeRows),
  ],
  bestCandidateId: "market-temperature-1_25",
});
assert.equal(negativeAudit.candidateReadyForProspectiveTest, false);
assert.ok(
  negativeAudit.nominationBlockers.includes("nomination-point-estimates-not-positive"),
  "a point-estimate loser must never be nominated for prospective capture",
);

const expandedAudit = buildShadowCandidateRobustness({
  candidates: [
    ...candidates,
    candidate("another-tested-candidate", 1.75, rows),
  ],
  bestCandidateId: "market-temperature-1_25",
});
assert.notEqual(
  expandedAudit.family.inventoryHash,
  audit.family.inventoryHash,
  "candidate inventory commitment must change when another candidate is tested",
);
assert.ok(
  expandedAudit.selectedCandidate.bootstrap.familyWiseAdjusted.adjustedTailAlpha
    < audit.selectedCandidate.bootstrap.familyWiseAdjusted.adjustedTailAlpha,
  "testing more candidates must make the multiplicity correction stricter",
);

const aggregateWinner = {
  ...candidate("aggregate-winner", 0.9, rows),
  metrics: { rows: 168, logLoss: 0.9, brier: 0.53 },
  comparison: { rows: 168, logLossImprovement: 0.01, brierImprovement: 0.003 },
  rolling: { windows: 4, passed: 3, passRate: 0.75 },
};
const stableWinner = {
  ...candidate("stable-winner", 1, rows),
  metrics: { rows: 168, logLoss: 0.902, brier: 0.531 },
  comparison: { rows: 168, logLossImprovement: 0.008, brierImprovement: 0.002 },
  rolling: { windows: 4, passed: 4, passRate: 1 },
};
const incompleteWinner = {
  ...candidate("incomplete-winner", 1.1, rows),
  metrics: { rows: 120, logLoss: 0.85, brier: 0.5 },
  comparison: { rows: 120, logLossImprovement: 0.03, brierImprovement: 0.02 },
  rolling: { windows: 3, passed: 3, passRate: 1 },
};
const stabilityRanking = rankShadowCandidatesForNomination([
  aggregateWinner,
  stableWinner,
  incompleteWinner,
]);
assert.equal(stabilityRanking.version, NOMINATION_SELECTION_VERSION);
assert.equal(stabilityRanking.stabilityApplied, true);
assert.equal(stabilityRanking.maximumComparableRows, 168);
assert.equal(stabilityRanking.maximumComparableWindows, 4);
assert.equal(
  stabilityRanking.ranked[0]?.id,
  "stable-winner",
  "a full-coverage 4/4 candidate must outrank a marginal aggregate winner that only wins 3/4 windows",
);
assert.equal(
  stabilityRanking.ranked.some((row) => row.id === "incomplete-winner"),
  false,
  "a lower-coverage candidate must not win nomination by looking strong on fewer rows/windows",
);

const earlyRanking = rankShadowCandidatesForNomination([
  {
    ...aggregateWinner,
    rolling: { windows: 3, passed: 2, passRate: 2 / 3 },
  },
  {
    ...stableWinner,
    rolling: { windows: 3, passed: 3, passRate: 1 },
  },
]);
assert.equal(earlyRanking.stabilityApplied, false);
assert.equal(
  earlyRanking.ranked[0]?.id,
  "aggregate-winner",
  "before four windows exist the deterministic aggregate fallback must remain in force",
);

console.log(JSON.stringify({
  ok: true,
  verifier: "shadow-candidate-robustness",
  version: VERSION,
  checks: 33,
  sample: {
    rows: audit.selectedCandidate.rows,
    candidates: audit.family.candidateCount,
    adjustedTailAlpha: audit.selectedCandidate.bootstrap.familyWiseAdjusted.adjustedTailAlpha,
  },
}, null, 2));
