const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  RESIDUAL_MARKET_WALK_FORWARD_VERSION,
  evaluateResidualMarketWalkForward,
  verifyManifestHash,
} = require("./residualMarketWalkForward.cjs");
const {
  FEATURE_SCHEMA_VERSION,
  predict,
  stableHash,
} = require("./residualMarketModel.cjs");

const backtestSource = fs.readFileSync(path.join(__dirname, "runModelBacktest.cjs"), "utf8");
assert.match(backtestSource, /evaluateResidualMarketWalkForward\(/);
assert.match(backtestSource, /residualMarketWalkForward,/);
assert.match(backtestSource, /residualLearning:/);

const DAY_MS = 24 * 60 * 60 * 1000;
const OUTCOME_INDEX = Object.freeze({ "1": 0, X: 1, "2": 2 });

const shiftedTriplet = (base, shiftOne, shiftDraw) => ({
  "1": Math.max(0.05, base["1"] + shiftOne),
  X: Math.max(0.05, base.X + shiftDraw),
  "2": Math.max(0.05, base["2"] - shiftOne - shiftDraw),
});

const syntheticRows = (count = 205) => {
  const start = Date.parse("2024-01-01T08:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const forecastMs = start + index * DAY_MS;
    const market = {
      "1": 0.39 + (index % 5) * 0.012,
      X: 0.29 + (index % 3) * 0.008,
      "2": 0.32 - (index % 5) * 0.012 - (index % 3) * 0.008,
    };
    const signalOutcome = ["1", "X", "2"][(index * 5 + Math.floor(index / 3)) % 3];
    const actual = index % 9 === 0
      ? ["1", "X", "2"][(OUTCOME_INDEX[signalOutcome] + 1) % 3]
      : signalOutcome;
    return {
      sourceMatchId: `wf-${String(index).padStart(4, "0")}`,
      forecastTime: new Date(forecastMs).toISOString(),
      featureObservedAt: new Date(forecastMs - 60 * 60 * 1000).toISOString(),
      kickoffTime: new Date(forecastMs + 2 * 60 * 60 * 1000).toISOString(),
      resultObservedAt: new Date(forecastMs + 5 * 60 * 60 * 1000).toISOString(),
      resultObservedAtFallback: false,
      actual,
      marketProbabilities: market,
      currentModelProbabilities: shiftedTriplet(
        market,
        signalOutcome === "1" ? 0.07 : -0.025,
        signalOutcome === "X" ? 0.055 : -0.015,
      ),
      historicalModelProbabilities: shiftedTriplet(
        market,
        signalOutcome === "1" ? 0.035 : -0.012,
        signalOutcome === "X" ? 0.025 : -0.008,
      ),
      openingMarketProbabilities: shiftedTriplet(market, -0.015, 0.008),
    };
  });
};

const options = { iterations: 90 };
const rows = syntheticRows();
const baseline = evaluateResidualMarketWalkForward(rows, options);

assert.equal(baseline.version, RESIDUAL_MARKET_WALK_FORWARD_VERSION);
assert.equal(baseline.status, "evaluated-shadow");
assert.equal(baseline.shadowOnly, true);
assert.equal(baseline.productionEligible, false);
assert.equal(baseline.eligibleForProduction, false);
assert.equal(baseline.candidateReady, true);
assert.deepEqual(baseline.internalCandidateBlockers, []);
assert.equal(baseline.config.minTrainingRows, 120);
assert.equal(baseline.config.holdoutRows, 20);
assert.equal(baseline.config.minFolds, 3);
assert.ok(baseline.folds.length >= 3);
assert.ok(verifyManifestHash(baseline));
assert.match(baseline.manifestHash, /^[a-f0-9]{64}$/);
assert.ok(baseline.finalCandidate, "complete OOS evaluation must persist one final residual candidate");
assert.equal(baseline.finalCandidate.candidateReady, true);
assert.equal(baseline.finalCandidate.shadowOnly, true);
assert.equal(baseline.finalCandidate.productionEligible, false);
assert.equal(baseline.finalCandidate.candidateType, "market-residual-shadow");
assert.equal(baseline.finalCandidate.featureSchema.version, FEATURE_SCHEMA_VERSION);
assert.equal(
  baseline.finalCandidate.featureSchemaHash,
  stableHash(baseline.finalCandidate.featureSchema),
  "the persisted schema bytes must match their hash",
);
assert.ok(baseline.finalCandidate.parameters);
assert.equal(
  baseline.finalCandidate.parametersHash,
  stableHash(baseline.finalCandidate.parameters),
  "the persisted parameter bytes must match their hash",
);
assert.match(baseline.finalCandidate.modelHash, /^[a-f0-9]{64}$/);
assert.match(baseline.finalCandidate.dataHash, /^[a-f0-9]{64}$/);
assert.match(baseline.finalCandidate.parametersHash, /^[a-f0-9]{64}$/);
assert.match(baseline.finalCandidate.candidateId, new RegExp(`^residual-market:${baseline.finalCandidate.modelHash}$`));
assert.equal(baseline.finalCandidate.sample.acceptedRows, rows.length);
assert.equal(
  baseline.finalCandidate.trainedThrough,
  rows[rows.length - 1].resultObservedAt,
  "the final fit must consume every canonical row through the latest explicit result watermark",
);
const finalPrediction = predict(baseline.finalCandidate, rows[rows.length - 1]);
assert.equal(finalPrediction.modelHash, baseline.finalCandidate.modelHash);
assert.ok(Math.abs(Object.values(finalPrediction.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-8);
const tamperedManifest = JSON.parse(JSON.stringify(baseline));
tamperedManifest.aggregate.rows += 1;
assert.equal(verifyManifestHash(tamperedManifest), false, "manifest hash must detect evidence tampering");

const reversed = evaluateResidualMarketWalkForward([...rows].reverse(), options);
assert.deepEqual(reversed, baseline, "input order must not affect folds, models, metrics, or manifest hash");

const pollutedRows = rows.map((row) => ({ ...row }));
pollutedRows[190] = {
  ...pollutedRows[190],
  actual: pollutedRows[190].actual === "1" ? "2" : "1",
};
const polluted = evaluateResidualMarketWalkForward(pollutedRows, options);
assert.equal(polluted.status, "evaluated-shadow");
assert.deepEqual(
  polluted.folds[0],
  baseline.folds[0],
  "a label in a later holdout must not alter an earlier fold fit or evaluation",
);
assert.notEqual(polluted.manifestHash, baseline.manifestHash);

for (let index = 0; index < baseline.folds.length; index += 1) {
  const fold = baseline.folds[index];
  assert.equal(fold.shadowOnly, true);
  assert.equal(fold.productionEligible, false);
  assert.equal(fold.training.strictWatermark, true);
  assert.ok(
    Date.parse(fold.training.trainedThrough) < Date.parse(fold.window.startForecastTime),
    `fold ${fold.fold} must train only through a strict pre-window watermark`,
  );
  assert.equal(fold.sampleGates.minimumTrainingRows, true);
  assert.equal(fold.sampleGates.completeHoldout, true);
  assert.equal(fold.sampleGates.completePredictionCoverage, true);
  assert.equal(fold.sampleGates.strictWatermark, true);
  assert.equal(fold.probabilityAudit.invalidRows, 0);
  assert.ok(fold.probabilityAudit.maximumSumError <= baseline.config.probabilityTolerance);
  assert.ok(fold.probabilityAudit.minimum >= 0);
  assert.ok(fold.probabilityAudit.maximum <= 1);
  assert.match(fold.modelHash, /^[a-f0-9]{64}$/);
  assert.match(fold.dataHash, /^[a-f0-9]{64}$/);
  assert.match(fold.holdoutDataHash, /^[a-f0-9]{64}$/);
  assert.match(fold.foldManifestHash, /^[a-f0-9]{64}$/);
  if (index > 0) {
    const previous = baseline.folds[index - 1];
    assert.equal(fold.window.startIndex, previous.window.endIndex + 1);
    assert.equal(fold.window.contiguousWithPrevious, true);
    assert.ok(fold.training.rows >= previous.training.rows, "expanding training rows cannot shrink");
  }
}
assert.equal(
  new Set(baseline.folds.map((fold) => fold.modelHash)).size,
  baseline.folds.length,
  "each fold must carry its own freshly fitted model commitment",
);
assert.equal(
  new Set(baseline.folds.map((fold) => fold.dataHash)).size,
  baseline.folds.length,
  "each expanding fold must carry its own training-data commitment",
);

const insufficient = evaluateResidualMarketWalkForward(rows.slice(0, 169), options);
assert.equal(insufficient.status, "blocked-shadow");
assert.equal(insufficient.productionEligible, false);
assert.equal(insufficient.candidateReady, false);
assert.equal(insufficient.finalCandidate, null);
assert.ok(insufficient.blockers.some((blocker) => blocker.startsWith("residual-walk-forward-min-folds:")));
assert.ok(verifyManifestHash(insufficient));

const zeroSample = evaluateResidualMarketWalkForward([], options);
assert.equal(zeroSample.status, "blocked-shadow");
assert.equal(zeroSample.shadowOnly, true);
assert.equal(zeroSample.productionEligible, false);
assert.equal(zeroSample.candidateReady, false);
assert.equal(zeroSample.finalCandidate, null);
assert.ok(zeroSample.internalCandidateBlockers.some((blocker) => blocker.startsWith("residual-walk-forward-min-training-rows:")));
assert.ok(verifyManifestHash(zeroSample));

const marketPerfectRows = rows.map((row, index) => {
  const actual = ["1", "X", "2"][index % 3];
  const marketProbabilities = actual === "1"
    ? { "1": 0.98, X: 0.01, "2": 0.01 }
    : actual === "X"
      ? { "1": 0.01, X: 0.98, "2": 0.01 }
      : { "1": 0.01, X: 0.01, "2": 0.98 };
  return {
    ...row,
    actual,
    marketProbabilities,
    currentModelProbabilities: marketProbabilities,
    historicalModelProbabilities: marketProbabilities,
    openingMarketProbabilities: marketProbabilities,
  };
});
const noImprovement = evaluateResidualMarketWalkForward(marketPerfectRows, options);
assert.equal(noImprovement.status, "evaluated-shadow");
assert.equal(noImprovement.productionEligible, false);
assert.equal(noImprovement.candidateReady, false, "a complete final fit cannot become ready without OOS gain");
assert.ok(noImprovement.finalCandidate?.parameters, "a blocked candidate must still persist its fitted parameters for audit");
assert.equal(noImprovement.finalCandidate?.candidateReady, false);
assert.ok(
  noImprovement.internalCandidateBlockers.includes("residual-final-candidate-oos-brier-not-improved")
    || noImprovement.internalCandidateBlockers.includes("residual-final-candidate-oos-logloss-not-improved"),
  "non-improving OOS evidence must produce an explicit internal blocker",
);
assert.ok(verifyManifestHash(noImprovement));

const coverageGapRows = rows.map((row) => ({ ...row }));
delete coverageGapRows[150].forecastTime;
const coverageGap = evaluateResidualMarketWalkForward(coverageGapRows, options);
assert.equal(coverageGap.status, "blocked-shadow");
assert.ok(coverageGap.blockers.some((blocker) => blocker.startsWith("residual-walk-forward-coverage-gap-invalid-rows:")));
assert.equal(coverageGap.input.rejectedByReason["forecast-time-missing"], 1);

const conflictingRows = [
  ...rows,
  {
    ...rows[40],
    actual: rows[40].actual === "1" ? "X" : "1",
  },
];
const conflict = evaluateResidualMarketWalkForward(conflictingRows, options);
assert.equal(conflict.status, "blocked-shadow");
assert.equal(conflict.input.conflictingKeys, 1);
assert.ok(conflict.blockers.some((blocker) => blocker.startsWith("residual-walk-forward-conflicting-keys:")));
assert.ok(verifyManifestHash(conflict));

const cadenceGapRows = rows.map((row, index) => (
  index < 160
    ? { ...row }
    : {
      ...row,
      forecastTime: new Date(Date.parse(row.forecastTime) + 10 * DAY_MS).toISOString(),
      featureObservedAt: new Date(Date.parse(row.featureObservedAt) + 10 * DAY_MS).toISOString(),
      kickoffTime: new Date(Date.parse(row.kickoffTime) + 10 * DAY_MS).toISOString(),
      resultObservedAt: new Date(Date.parse(row.resultObservedAt) + 10 * DAY_MS).toISOString(),
    }
));
const cadenceGap = evaluateResidualMarketWalkForward(cadenceGapRows, {
  ...options,
  maximumForecastGapMs: 2 * DAY_MS,
});
assert.equal(cadenceGap.status, "blocked-shadow");
assert.ok(cadenceGap.blockers.some((blocker) => blocker.startsWith("residual-walk-forward-coverage-gap-forecast:")));

console.log(JSON.stringify({
  ok: true,
  version: baseline.version,
  folds: baseline.folds.length,
  evaluatedRows: baseline.aggregate.rows,
  firstFold: {
    modelHash: baseline.folds[0].modelHash,
    dataHash: baseline.folds[0].dataHash,
    trainedThrough: baseline.folds[0].training.trainedThrough,
  },
  aggregate: baseline.aggregate,
  manifestHash: baseline.manifestHash,
  assertions: {
    futureLabelIsolation: true,
    reversedInputDeterminism: true,
    strictFoldWatermarks: true,
    coverageAndSampleFailClosed: true,
    conflictFailClosed: true,
    normalizedProbabilities: true,
    finalModelParametersBound: true,
    candidateReadinessFailClosed: true,
    zeroSampleShadow: true,
    shadowOnly: true,
  },
}, null, 2));
