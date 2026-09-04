const assert = require("node:assert/strict");
const {
  WALK_FORWARD_PROTOCOL_VERSION,
  WALK_FORWARD_VALIDATION_VERSION,
  buildWalkForwardValidation,
  candidateUsesModelSignal,
  deepValidateWalkForwardArtifact,
  hasNonNegativeImprovementPair,
} = require("./walkForwardValidation.cjs");

const softmaxTriplet = (actual, confidence) => {
  const rest = (1 - confidence) / 2;
  return {
    "1": actual === "1" ? confidence : rest,
    X: actual === "X" ? confidence : rest,
    "2": actual === "2" ? confidence : rest,
  };
};

const buildFixture = (count, spacingHours = 24) => {
  const start = Date.parse("2025-01-01T00:00:00.000Z");
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const kickoff = start + index * spacingHours * 60 * 60 * 1000;
    const actual = ["1", "X", "2"][index % 3];
    rows.push({
      sourceMatchId: `wf-${index + 1}`,
      kickoffTime: new Date(kickoff).toISOString(),
      forecastTime: new Date(kickoff - 2 * 60 * 60 * 1000).toISOString(),
      resultObservedAt: new Date(kickoff + 3 * 60 * 60 * 1000).toISOString(),
      actual,
      marketProbabilities: softmaxTriplet(actual, 0.55),
    });
  }
  return rows;
};

const candidate = (id, rows, confidence) => ({
  id,
  role: "shadow-model-candidate",
  weights: { market: 0.9, model: 0.1 },
  featureSet: ["sporttery-market", "independent-model"],
  rowsForValidation: rows.map((row) => ({
    ...row,
    probabilities: softmaxTriplet(row.actual, confidence),
  })),
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const rows = buildFixture(320);
const good = candidate("past-selected-good", rows, 0.64);
const weaker = candidate("past-selected-weaker", rows, 0.5);
const negativeResidual = {
  ...candidate("past-selected-negative-residual", rows, 0.64),
  weights: { market: 1.2, model: -0.2, temperature: 0.9 },
  featureSet: [
    "sporttery-market",
    "current-probability-model",
    "negative-model-residual",
    "temperature-calibration",
  ],
};
assert.equal(
  candidateUsesModelSignal(negativeResidual),
  true,
  "a negative non-zero model residual is still a model signal",
);
assert.equal(
  candidateUsesModelSignal({
    id: "market-only-zero-model",
    weights: { market: 1, model: 0 },
    featureSet: ["sporttery-market"],
  }),
  false,
  "a zero model weight without model features remains market-only",
);
const negativeResidualValidation = buildWalkForwardValidation({
  rows,
  candidates: [negativeResidual],
});
assert.equal(
  negativeResidualValidation.sample.candidateCount,
  1,
  "the frozen negative-residual candidate enters nested walk-forward validation",
);
assert.equal(negativeResidualValidation.sample.folds, 6);
const eligible = buildWalkForwardValidation({ rows, candidates: [weaker, good] });
const eligibleAudit = deepValidateWalkForwardArtifact(eligible);

assert.equal(eligible.version, WALK_FORWARD_VALIDATION_VERSION);
assert.equal(eligible.protocolVersion, WALK_FORWARD_PROTOCOL_VERSION);
assert.equal(eligible.eligible, true);
assert.equal(eligible.status, "validated");
assert.equal(eligible.sample.folds, 6);
assert.equal(eligible.sample.passedFolds, 6);
assert.equal(eligible.watermark.noOverlapVerified, true);
assert.equal(eligibleAudit.eligible, true);
assert.deepEqual(eligibleAudit.errors, []);
assert.ok(eligible.folds.every((fold) => fold.selectedCandidateId === good.id));
assert.ok(eligible.folds.every((fold) => (
  Date.parse(fold.watermark.trainingDataMaxObservedAt)
  < Date.parse(fold.watermark.evaluationWindowStartedAt)
)));
assert.ok(eligible.folds.every((fold) => {
  const training = new Set(fold.training.keyHashes);
  return fold.keySeparationVerified === true
    && !fold.evaluation.keyHashes.some((key) => training.has(key));
}));
assert.ok(eligible.folds.slice(1).every((fold, index) => (
  fold.offsetStart === eligible.folds[index].offsetEndExclusive
)));
assert.match(eligible.foldManifestHash, /^[a-f0-9]{64}$/);
assert.match(eligible.featureModelHash, /^[a-f0-9]{64}$/);
assert.match(eligible.inputDataset.hash, /^[a-f0-9]{64}$/);
assert.ok(eligible.folds.every((fold) => /^[a-f0-9]{64}$/.test(fold.foldHash)));

for (const missing of [null, undefined, "", "   "]) {
  assert.equal(
    hasNonNegativeImprovementPair({ logLossImprovement: missing, brierImprovement: 0 }),
    false,
    `${JSON.stringify(missing)} log-loss improvement must fail closed`,
  );
  assert.equal(
    hasNonNegativeImprovementPair({ logLossImprovement: 0, brierImprovement: missing }),
    false,
    `${JSON.stringify(missing)} Brier improvement must fail closed`,
  );
}
assert.equal(
  hasNonNegativeImprovementPair({ logLossImprovement: 0, brierImprovement: 0 }),
  true,
  "real numeric zero improvements remain valid",
);

const nullImprovement = clone(eligible);
nullImprovement.folds[0].evaluation.comparison.logLossImprovement = null;
const nullImprovementAudit = deepValidateWalkForwardArtifact(nullImprovement);
assert.equal(nullImprovementAudit.eligible, false);
assert.ok(nullImprovementAudit.errors.includes("fold-improvement-metrics-invalid:1"));
assert.ok(nullImprovementAudit.errors.includes("fold-pass-mismatch:1"));

const blankTrainingImprovement = clone(eligible);
blankTrainingImprovement.folds[0].training.comparison.brierImprovement = "   ";
const blankTrainingImprovementAudit = deepValidateWalkForwardArtifact(blankTrainingImprovement);
assert.equal(blankTrainingImprovementAudit.eligible, false);
assert.ok(blankTrainingImprovementAudit.errors.includes("fold-improvement-metrics-invalid:1"));
assert.ok(blankTrainingImprovementAudit.errors.includes("fold-balanced-candidate-mismatch:1"));

const mutatedMetrics = clone(eligible);
mutatedMetrics.folds[0].evaluation.comparison.logLossImprovement += 0.01;
const mutatedMetricsAudit = deepValidateWalkForwardArtifact(mutatedMetrics);
assert.equal(mutatedMetricsAudit.eligible, false);
assert.ok(mutatedMetricsAudit.errors.some((error) => error.startsWith("fold-metrics-hash-mismatch:")));

const mutatedIdentity = clone(eligible);
mutatedIdentity.folds[0].evaluation.keyHashes[0] = mutatedIdentity.folds[0].training.keyHashes[0];
const mutatedIdentityAudit = deepValidateWalkForwardArtifact(mutatedIdentity);
assert.equal(mutatedIdentityAudit.eligible, false);
assert.ok(mutatedIdentityAudit.errors.includes("fold-training-evaluation-overlap:1"));

const mutatedPrediction = clone(eligible);
mutatedPrediction.candidateManifest[0].predictionDataHash = "0".repeat(64);
const mutatedPredictionAudit = deepValidateWalkForwardArtifact(mutatedPrediction);
assert.equal(mutatedPredictionAudit.eligible, false);
assert.ok(mutatedPredictionAudit.errors.includes("feature-model-hash-mismatch"));

const mutatedResultCommitment = clone(eligible);
mutatedResultCommitment.inputDataset.rowCommitmentHashes[0] = "f".repeat(64);
const mutatedResultAudit = deepValidateWalkForwardArtifact(mutatedResultCommitment);
assert.equal(mutatedResultAudit.eligible, false);
assert.ok(mutatedResultAudit.errors.includes("input-dataset-manifest-mismatch"));

const shortRows = buildFixture(159);
const collecting = buildWalkForwardValidation({
  rows: shortRows,
  candidates: [candidate("short-good", shortRows, 0.64)],
});
const collectingAudit = deepValidateWalkForwardArtifact(collecting);
assert.equal(collecting.status, "collecting");
assert.equal(collecting.eligible, false);
assert.equal(collecting.sample.folds, 1);
assert.equal(collecting.watermark.noOverlapVerified, true);
assert.equal(collectingAudit.eligible, false);
assert.deepEqual(collectingAudit.errors, []);
assert.ok(collecting.blockers.includes("walk-forward-folds:1<6"));

const repeatedRow = buildFixture(1)[0];
const repeatedRows = Array.from({ length: 320 }, () => clone(repeatedRow));
const repeated = buildWalkForwardValidation({
  rows: repeatedRows,
  candidates: [candidate("repeated-good", repeatedRows, 0.64)],
});
assert.equal(repeated.sample.inputRows, 320);
assert.equal(repeated.sample.sourceRows, 1);
assert.equal(repeated.sample.duplicateRowsRemoved, 319);
assert.equal(repeated.sample.folds, 0);
assert.equal(repeated.eligible, false);

const conflictBase = buildFixture(1)[0];
const conflictingRows = [
  conflictBase,
  {
    ...clone(conflictBase),
    actual: "2",
    marketProbabilities: softmaxTriplet("2", 0.55),
  },
];
const conflicting = buildWalkForwardValidation({
  rows: conflictingRows,
  candidates: [candidate("conflicting-good", conflictingRows, 0.64)],
});
assert.equal(conflicting.eligible, false);
assert.equal(conflicting.integrity.baseRowConflicts, 1);
assert.ok(conflicting.blockers.includes("walk-forward-row-conflicts:1"));

const candidateConflict = candidate("candidate-conflict", rows, 0.64);
candidateConflict.rowsForValidation.push({
  ...clone(candidateConflict.rowsForValidation[0]),
  probabilities: softmaxTriplet(candidateConflict.rowsForValidation[0].actual, 0.4),
});
const conflictingCandidateArtifact = buildWalkForwardValidation({
  rows,
  candidates: [candidateConflict],
});
assert.equal(conflictingCandidateArtifact.eligible, false);
assert.equal(conflictingCandidateArtifact.integrity.candidateRowConflicts, 1);
assert.ok(conflictingCandidateArtifact.blockers.includes("walk-forward-candidate-row-conflicts:1"));

const incompleteCandidate = candidate("coverage-gap", rows, 0.64);
incompleteCandidate.rowsForValidation.splice(80, 1);
const coverageGap = buildWalkForwardValidation({ rows, candidates: [incompleteCandidate] });
assert.equal(coverageGap.eligible, false);
assert.equal(coverageGap.status, "blocked");
assert.equal(coverageGap.sample.folds, 0);
assert.equal(coverageGap.continuity.coverageGapWindows, 1);
assert.equal(coverageGap.boundaryAudit.outcomes["continuous-window-evaluation-coverage-incomplete"], 1);
assert.ok(coverageGap.blockers.includes("walk-forward-continuous-window-coverage-gaps:1"));

const poisonedRows = buildFixture(120).map((row, index, source) => ({
  ...row,
  resultObservedAt: index < 80
    ? source[80].forecastTime
    : row.resultObservedAt,
}));
const poisoned = buildWalkForwardValidation({
  rows: poisonedRows,
  candidates: [candidate("poisoned-good", poisonedRows, 0.64)],
});
assert.equal(poisoned.eligible, false);
assert.equal(poisoned.sample.folds, 0);
assert.ok(poisoned.blockers.includes("walk-forward-folds-missing"));
assert.ok(poisoned.blockers.includes("walk-forward-watermark-unverified"));

const noModelCandidate = buildWalkForwardValidation({
  rows,
  candidates: [{
    id: "market-only",
    role: "shadow-feature-candidate",
    weights: { market: 1, model: 0 },
    featureSet: ["sporttery-market"],
    rowsForValidation: good.rowsForValidation,
  }],
});
assert.equal(noModelCandidate.eligible, false);
assert.ok(noModelCandidate.blockers.includes("walk-forward-model-candidates-missing"));

const missingProbabilityFixtures = [
  {
    label: "null",
    triplet: { "1": 0.6, X: 0.4, "2": null, away: null },
  },
  {
    label: "undefined",
    triplet: { "1": 0.6, X: 0.4, "2": undefined, away: undefined },
  },
  {
    label: "empty-string",
    triplet: { "1": 0.6, X: 0.4, "2": "" },
  },
];

for (const fixture of missingProbabilityFixtures) {
  const baseRow = {
    ...clone(buildFixture(1)[0]),
    marketProbabilities: fixture.triplet,
  };
  const invalidBase = buildWalkForwardValidation({
    rows: [baseRow],
    candidates: [candidate(`missing-base-${fixture.label}`, [baseRow], 0.64)],
  });
  assert.equal(invalidBase.integrity.acceptedRows, 0, `${fixture.label} base probability must fail closed`);
  assert.equal(invalidBase.integrity.rejectedRows, 1, `${fixture.label} base probability must be rejected`);

  const validBase = clone(buildFixture(1)[0]);
  const invalidCandidate = candidate(`missing-candidate-${fixture.label}`, [validBase], 0.64);
  invalidCandidate.rowsForValidation[0].probabilities = fixture.triplet;
  const invalidCandidateArtifact = buildWalkForwardValidation({
    rows: [validBase],
    candidates: [invalidCandidate],
  });
  assert.equal(
    invalidCandidateArtifact.candidateManifest[0].predictionRows,
    0,
    `${fixture.label} candidate probability must not enter the manifest`,
  );
  assert.equal(
    invalidCandidateArtifact.candidateManifest[0].rejectedRows,
    1,
    `${fixture.label} candidate probability must be rejected`,
  );
}

console.log(JSON.stringify({
  ok: true,
  verifier: "walk-forward-validation",
  assertions: 89,
  validationVersion: WALK_FORWARD_VALIDATION_VERSION,
  protocolVersion: WALK_FORWARD_PROTOCOL_VERSION,
  eligible: {
    status: eligible.status,
    folds: eligible.sample.folds,
    passRate: eligible.sample.passRate,
    watermark: eligible.watermark,
    foldManifestHash: eligible.foldManifestHash,
    featureModelHash: eligible.featureModelHash,
  },
  collecting: {
    folds: collecting.sample.folds,
    blockers: collecting.blockers,
    watermarkVerified: collecting.watermark.noOverlapVerified,
  },
  duplicateAudit: repeated.integrity,
  coverageGap: coverageGap.continuity,
  mutationErrors: mutatedMetricsAudit.errors,
}, null, 2));
