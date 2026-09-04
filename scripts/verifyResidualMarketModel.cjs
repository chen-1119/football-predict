const assert = require("node:assert/strict");
const {
  OUTCOMES,
  fit,
  metrics,
  predict,
} = require("./residualMarketModel.cjs");

const clone = (value) => JSON.parse(JSON.stringify(value));

const tripletFor = (actual, correct, wrong, remaining) => {
  const actualIndex = OUTCOMES.indexOf(actual);
  const wrongOutcome = OUTCOMES[(actualIndex + 1) % OUTCOMES.length];
  const remainingOutcome = OUTCOMES[(actualIndex + 2) % OUTCOMES.length];
  return {
    [actual]: correct,
    [wrongOutcome]: wrong,
    [remainingOutcome]: remaining,
  };
};

const buildRow = (index) => {
  const day = Date.parse("2025-01-01T12:00:00.000Z") + index * 24 * 60 * 60 * 1000;
  const actual = OUTCOMES[index % OUTCOMES.length];
  return {
    sourceMatchId: `residual-synthetic-${String(index + 1).padStart(4, "0")}`,
    forecastTime: new Date(day).toISOString(),
    kickoffTime: new Date(day + 2 * 60 * 60 * 1000).toISOString(),
    resultObservedAt: new Date(day + 4 * 60 * 60 * 1000).toISOString(),
    resultObservedAtFallback: false,
    actual,
    marketProbabilities: tripletFor(actual, 0.25, 0.6, 0.15),
    currentModelProbabilities: tripletFor(actual, 0.7, 0.18, 0.12),
    historicalModelProbabilities: tripletFor(actual, 0.53, 0.29, 0.18),
    openingMarketProbabilities: tripletFor(actual, 0.18, 0.67, 0.15),
  };
};

const trainingCount = 180;
const futureCount = 60;
const holdoutCount = 90;
const allChronologicalRows = Array.from(
  { length: trainingCount + futureCount + holdoutCount },
  (_, index) => buildRow(index),
);
const trainingRows = allChronologicalRows.slice(0, trainingCount);
const futureRows = allChronologicalRows.slice(trainingCount, trainingCount + futureCount);
const holdoutRows = allChronologicalRows.slice(trainingCount + futureCount);
const evaluationTime = new Date(Date.parse(trainingRows.at(-1).resultObservedAt) + 1).toISOString();

const fallbackRow = {
  ...clone(trainingRows[0]),
  sourceMatchId: "residual-explicit-fallback",
  resultObservedAtFallback: true,
};
const missingProvenanceRow = {
  ...clone(trainingRows[1]),
  sourceMatchId: "residual-missing-provenance",
};
delete missingProvenanceRow.resultObservedAtFallback;

const fitOptions = {
  evaluationTime,
  minRows: 90,
  iterations: 900,
  learningRate: 0.03,
  l2: 0.02,
};
const mixedRows = [...trainingRows, ...futureRows, fallbackRow, missingProvenanceRow];
const model = fit(mixedRows, fitOptions);

assert.equal(model.eligible, true);
assert.equal(model.status, "trained-shadow");
assert.equal(model.sample.acceptedRows, trainingCount);
assert.equal(model.sample.rejectedByReason["fallback-result-observation"], 1);
assert.equal(model.sample.rejectedByReason["result-observation-provenance-missing"], 1);
assert.equal(model.sample.rejectedByReason["result-observed-after-evaluation-start"], futureCount);
assert.equal(model.trainedThrough, trainingRows.at(-1).resultObservedAt);
assert.ok(Date.parse(model.trainedThrough) < Date.parse(model.evaluationTime));
assert.match(model.dataHash, /^[a-f0-9]{64}$/);
assert.match(model.modelHash, /^[a-f0-9]{64}$/);
assert.match(model.featureSchemaHash, /^[a-f0-9]{64}$/);

const firstPrediction = predict(model, holdoutRows[0]);
const probabilitySum = OUTCOMES.reduce((sum, outcome) => sum + firstPrediction.probabilities[outcome], 0);
assert.ok(Math.abs(probabilitySum - 1) < 1e-9, `probability sum must be 1, received ${probabilitySum}`);
assert.ok(OUTCOMES.every((outcome) => (
  firstPrediction.probabilities[outcome] >= 0 && firstPrediction.probabilities[outcome] <= 1
)));

const modelMetrics = metrics(holdoutRows, model);
const marketMetrics = metrics(holdoutRows.map((row) => ({
  actual: row.actual,
  probabilities: row.marketProbabilities,
})));
assert.equal(modelMetrics.rows, holdoutCount);
assert.equal(marketMetrics.rows, holdoutCount);
assert.ok(modelMetrics.logLoss < marketMetrics.logLoss - 0.2, JSON.stringify({ modelMetrics, marketMetrics }));
assert.ok(modelMetrics.brier < marketMetrics.brier - 0.1, JSON.stringify({ modelMetrics, marketMetrics }));
assert.ok(modelMetrics.accuracy > marketMetrics.accuracy, JSON.stringify({ modelMetrics, marketMetrics }));

const trainingOnlyModel = fit(trainingRows, fitOptions);
assert.equal(model.dataHash, trainingOnlyModel.dataHash, "excluded fallback/future rows must not enter dataHash");
assert.equal(model.modelHash, trainingOnlyModel.modelHash, "excluded fallback/future rows must not change model");
assert.deepEqual(model.parameters, trainingOnlyModel.parameters);

const reversedModel = fit([...mixedRows].reverse(), fitOptions);
assert.equal(model.dataHash, reversedModel.dataHash, "dataHash must be invariant to input order");
assert.equal(model.modelHash, reversedModel.modelHash, "deterministic training must be invariant to input order");
assert.deepEqual(model.parameters, reversedModel.parameters);

const tamperedModel = clone(model);
tamperedModel.parameters.coefficients.currentModelResidual += 0.01;
assert.throws(
  () => predict(tamperedModel, holdoutRows[0]),
  /model hash mismatch/,
  "mutated parameters must invalidate the committed model hash",
);

const changedFutureLabels = clone(mixedRows);
for (const row of changedFutureLabels) {
  if (Date.parse(row.resultObservedAt) >= Date.parse(evaluationTime)) {
    row.actual = OUTCOMES[(OUTCOMES.indexOf(row.actual) + 1) % OUTCOMES.length];
  }
}
const futurePoisonedModel = fit(changedFutureLabels, fitOptions);
assert.equal(model.dataHash, futurePoisonedModel.dataHash, "future labels must not enter an early fold commitment");
assert.equal(model.modelHash, futurePoisonedModel.modelHash, "future labels must not affect an early model");
assert.deepEqual(model.parameters, futurePoisonedModel.parameters);

const insufficient = fit(trainingRows.slice(0, 20), {
  ...fitOptions,
  minRows: 60,
});
assert.equal(insufficient.eligible, false);
assert.equal(insufficient.status, "blocked");
assert.equal(insufficient.parameters, null);
assert.ok(insufficient.blockers.includes("residual-market-min-training-rows:20<60"));
assert.throws(
  () => predict(insufficient, holdoutRows[0]),
  /not eligible for prediction/,
  "an under-sampled artifact must fail closed at prediction time",
);

console.log(JSON.stringify({
  ok: true,
  version: model.version,
  acceptedTrainingRows: model.sample.acceptedRows,
  excludedFutureRows: model.sample.rejectedByReason["result-observed-after-evaluation-start"],
  dataHash: model.dataHash,
  modelHash: model.modelHash,
  trainedThrough: model.trainedThrough,
  holdout: {
    rows: holdoutCount,
    residualModel: modelMetrics,
    biasedMarket: marketMetrics,
  },
  learnedCoefficients: model.parameters.coefficients,
  insufficientSampleBlockers: insufficient.blockers,
}, null, 2));
