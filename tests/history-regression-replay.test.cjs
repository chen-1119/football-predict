"use strict";

// ALL fixtures in this file are synthetic unit-test records. Passing these
// tests is software validation, never evidence of production model quality.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  score, probabilities, marketProbabilities, pairedDayBootstrap,
  runHistoryRegressionReplay, summarizePublishedHistory, frequencyBaseline,
} = require("../scripts/historyRegressionReplay.cjs");

function day(value) { return `2026-01-${String(value).padStart(2, "0")}`; }
function syntheticRow(value, id = `${value}-a`, outcome = "home") {
  return {
    matchId: `synthetic-${id}`, market: "HAD", league: value % 2 ? "Synthetic A" : "Synthetic B",
    kickoffAt: `${day(value)}T12:00:00+08:00`,
    decision: { id: `synthetic-decision-${id}`, at: `${day(value)}T10:00:00+08:00`, modelVersion: "synthetic-original-v1", probabilities: { home: 0.5, draw: 0.25, away: 0.25 } },
    officialOdds: { sp: { home: 2, draw: 4, away: 4 } },
    result: { outcome, observedAt: `${day(value)}T15:00:00+08:00` },
    features: { form: value % 2 ? { value: 0.2 } : { status: "missing" }, lineup: null },
  };
}
function syntheticRows(last = 8) {
  return Array.from({ length: last }, (_, i) => [syntheticRow(i + 1, `${i + 1}-a`), syntheticRow(i + 1, `${i + 1}-b`, "draw")]).flat();
}
function config(extra = {}) {
  return {
    windows: { train: { start: day(1), end: day(3) }, calibration: { start: day(3), end: day(5) }, validation: { start: day(5), end: day(7) }, finalTest: { start: day(7), end: day(9) } },
    minimumRows: { training: 1, calibration: 1, validation: 1, finalTest: 1 },
    bootstrap: { iterations: 200, minBlocks: 2, minRows: 2, seed: 123 },
    source: { fixture: "SYNTHETIC_UNIT_TEST_ONLY" },
    ...extra,
  };
}

test("synthetic: Brier uses sum of three classes; log loss and direction are explicit", () => {
  const metric = score({ home: 0.5, draw: 0.25, away: 0.25 }, "home");
  assert.equal(metric.brier, 0.375);
  assert.equal(metric.logLoss, Math.log(2));
  assert.equal(metric.accuracy, 1);
  assert.equal(score({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, "draw").accuracy, 0);
  assert.equal(score({ home: 0, draw: 1, away: 0 }, "home").logLoss, -Math.log(1e-15));
  assert.throws(() => probabilities({ home: 50, draw: 25, away: 25 }), /invalid probability/);
  assert.throws(() => probabilities({ home: 0.5, draw: 0.3, away: 0.3 }), /sum to 1/);
  assert.deepEqual(marketProbabilities(syntheticRow(1)), { home: 0.5, draw: 0.25, away: 0.25 });
});

test("synthetic: all match-day members remain together and reliability/group counts reconcile", () => {
  const report = runHistoryRegressionReplay(syntheticRows(), config());
  const fold = report.folds[0];
  assert.deepEqual(fold.counts, { train: { input: 4, used: 4 }, calibration: { input: 4, used: 4 }, validation: { input: 4, used: 4 } });
  const sets = Object.values(fold.membership).map((rows) => new Set(rows.map((row) => row.matchDay)));
  for (let i = 0; i < sets.length; i += 1) for (let j = i + 1; j < sets.length; j += 1) assert.equal([...sets[i]].some((value) => sets[j].has(value)), false);
  assert.equal(report.validation.metrics.publishedModel.n, 4);
  assert.equal(report.validation.metrics.publishedModel.coverage, 1);
  assert.equal(report.validation.metrics.publishedModel.reliability.home[5].n, 4);
  assert.equal(report.validation.metrics.publishedModel.reliability.home[5].observedFrequency, 0.5);
  assert.equal(report.validation.groups.publishedModel.actualOutcome.draw.n, 2);
  assert.equal(report.validation.groups.publishedModel.featureMissing.form.missing.n, 2);
  assert.equal(report.validation.groups.publishedModel.featureMissing.lineup.missing.n, 4);
  assert.equal(report.validation.groups.publishedModel.favoriteSpBand["[2,3)"].n, 4);
  assert.equal(report.productionEligible, false);
  assert.equal(report.selection.selectedCandidate, null);
  assert.equal(report.evaluationKinds[frequencyBaseline.id], "simple-baseline-replay");
});

test("synthetic: one late training label excludes its entire match day", () => {
  const rows = syntheticRows();
  rows[2].result.observedAt = `${day(3)}T00:00:00+08:00`;
  const report = runHistoryRegressionReplay(rows, config());
  assert.equal(report.folds[0].counts.train.used, 2);
  const exclusions = report.folds[0].exclusions.filter((row) => row.stage === "train");
  assert.equal(exclusions.length, 2);
  assert.ok(exclusions.every((row) => row.matchDay === day(2)));
  assert.equal(exclusions[0].requiredBefore, "2026-01-02T16:00:00.000Z");
});

test("synthetic: earliest prediction time takes precedence over nominal calendar start", () => {
  const rows = syntheticRows();
  rows[4].decision.at = `${day(2)}T11:00:00+08:00`;
  const report = runHistoryRegressionReplay(rows, config());
  assert.equal(report.folds[0].counts.train.used, 2);
  assert.equal(report.folds[0].context.trainingResultBefore, "2026-01-02T03:00:00.000Z");
});

test("synthetic: late calibration and validation labels cannot leak to following stages", () => {
  const rows = syntheticRows();
  rows[6].result.observedAt = `${day(5)}T00:00:00+08:00`;
  rows[10].result.observedAt = `${day(7)}T00:00:00+08:00`;
  const report = runHistoryRegressionReplay(rows, config());
  assert.equal(report.folds[0].counts.calibration.used, 2);
  assert.equal(report.folds[0].counts.validation.used, 2);
  assert.equal(report.folds[0].exclusions.length, 4);
  assert.equal(report.validation.pairedAgainstMarket.publishedModel.intervalAvailable, false);
});

test("synthetic: plugin receives only distinct past fit/calibration labels and no prediction labels", () => {
  const observed = { train: [], calibration: [], predicted: [] };
  const candidate = {
    id: "synthetic-audited-candidate", version: "1", requiresCalibration: true,
    fit(rows, context) {
      observed.train = rows.map((row) => row.matchId);
      assert.ok(Object.isFrozen(rows) && Object.isFrozen(rows[0].result));
      assert.ok(rows.every((row) => Date.parse(row.result.observedAt) < Date.parse(context.trainingResultBefore)));
      return { probabilities: { home: 0.4, draw: 0.4, away: 0.2 } };
    },
    calibrate(state, rows, context) {
      observed.calibration = rows.map((row) => row.matchId);
      assert.ok(rows.every((row) => Date.parse(row.result.observedAt) < Date.parse(context.calibrationResultBefore)));
      assert.equal(rows.some((row) => observed.train.includes(row.matchId)), false);
      return state;
    },
    predict(state, row) {
      assert.equal("result" in row, false);
      assert.equal("actual" in row, false);
      assert.ok(Object.isFrozen(row.features));
      observed.predicted.push(row.matchId);
      return state.probabilities;
    },
  };
  const report = runHistoryRegressionReplay(syntheticRows(), config({ candidates: [candidate] }));
  assert.equal(observed.train.length, 4);
  assert.equal(observed.calibration.length, 4);
  assert.equal(observed.predicted.length, 8);
  assert.equal(report.selection.selectedCandidate, candidate.id);
  assert.equal(report.selection.finalTestUsedForSelection, false);
  assert.equal(report.finalTest.pluginStatus.find((entry) => entry.id === candidate.id).stateHash, report.selection.candidateStateHash);
  assert.equal(report.evaluationKinds.candidate, "candidateReplay-not-original-prediction");
});

test("synthetic: final outcomes never choose candidates, and losing candidates do not see final rows", () => {
  const calls = { home: [], away: [] };
  const plugins = ["home", "away"].map((side) => ({
    id: `synthetic-${side}`, version: "1", fit: () => ({ home: side === "home" ? 0.8 : 0.1, draw: 0.1, away: side === "away" ? 0.8 : 0.1 }),
    predict(state, row) { calls[side].push(row.matchId); return state; },
  }));
  const rows = Array.from({ length: 8 }, (_, i) => syntheticRow(i + 1, `${i + 1}`, i < 6 ? "home" : "away"));
  const report = runHistoryRegressionReplay(rows, config({ candidates: plugins }));
  assert.equal(report.selection.selectedCandidate, "synthetic-home");
  assert.equal(calls.away.length, 2);
  assert.equal(calls.home.length, 4);
  assert.equal(report.finalTest.metrics["synthetic-home"].accuracy, 0);
  assert.equal("synthetic-away" in report.finalTest.metrics, false);
});

test("synthetic: candidate abstentions are visible and cannot cherry-pick validation rows", () => {
  const candidate = { id: "synthetic-selective", version: "1", fit: () => ({}), predict: (_, row) => row.matchId.endsWith("a") ? { home: 1, draw: 0, away: 0 } : null };
  const report = runHistoryRegressionReplay(syntheticRows(), config({ candidates: [candidate] }));
  assert.equal(report.validation.metrics[candidate.id].coverage, 0.5);
  assert.equal(report.validation.metrics[candidate.id].n, 2);
  assert.equal(report.selection.selectedCandidate, null);
  assert.equal(report.folds[0].pluginStatus.find((entry) => entry.id === candidate.id).failures.length, 2);
});

test("synthetic: bootstrap uses whole days, paired metrics, deterministic seed, and small-sample refusal", () => {
  const rows = syntheticRows().map((row) => ({ matchDay: row.kickoffAt.slice(0, 10), actual: row.result.outcome, predictions: { a: row.decision.probabilities, b: marketProbabilities(row) } }));
  const options = { iterations: 200, minBlocks: 2, minRows: 2, seed: 3 };
  const result = pairedDayBootstrap(rows, "a", "b", options);
  assert.equal(result.matchDayBlocks, 8);
  assert.equal(result.pairedRows, 16);
  assert.deepEqual(result.metrics.brier.interval, [0, 0]);
  assert.deepEqual(result, pairedDayBootstrap(rows, "a", "b", options));
  const insufficient = pairedDayBootstrap(rows.slice(0, 2), "a", "b", options);
  assert.equal(insufficient.intervalAvailable, false);
  assert.equal(insufficient.metrics.brier.interval, null);
  assert.equal(insufficient.matchDayBlocks, 1);
  rows[0].predictions.a = null;
  assert.equal(pairedDayBootstrap(rows, "a", "b", options).pairedRows, 15);
});

test("synthetic: chronological non-overlapping rolling validation and one reserved final holdout", () => {
  const folds = [
    { id: "early", train: { start: day(1), end: day(3) }, calibration: { start: day(3), end: day(5) }, validation: { start: day(5), end: day(7) } },
    { id: "later", train: { start: day(1), end: day(5) }, calibration: { start: day(5), end: day(7) }, validation: { start: day(7), end: day(9) } },
  ];
  const report = runHistoryRegressionReplay(syntheticRows(10), config({ folds, finalTest: { start: day(9), end: day(11) } }));
  assert.equal(report.folds.length, 2);
  assert.equal(report.validation.rows, 8);
  assert.equal(report.finalTest.rows, 4);
  assert.equal(report.selection.stateFromFold, "later");
  const finalIds = new Set(report.finalTest.perMatch.map((row) => row.matchId));
  assert.equal(report.folds.some((fold) => Object.values(fold.membership).flat().some((row) => finalIds.has(row.matchId))), false);
  folds[1].validation.start = day(6);
  folds[1].calibration.end = day(6);
  assert.throws(() => runHistoryRegressionReplay(syntheticRows(10), config({ folds, finalTest: { start: day(9), end: day(11) } })), /validation days/);
});

test("synthetic: duplicate matches, malformed clocks and windows fail closed", () => {
  const rows = syntheticRows();
  assert.throws(() => runHistoryRegressionReplay([...rows, rows[0]], config()), /duplicate match/);
  const malformed = structuredClone(rows);
  malformed[0].decision.at = "2026-01-01T10:00:00";
  assert.throws(() => runHistoryRegressionReplay(malformed, config()), /explicit timezone/);
  const invalid = config();
  invalid.windows.calibration.start = day(2);
  assert.throws(() => runHistoryRegressionReplay(rows, invalid), /ordered and non-overlapping/);
  assert.throws(() => runHistoryRegressionReplay(rows, config({ timeZone: "Europe/London" })), /UTC or Asia/);
});

test("synthetic: empty admitted evidence never manufactures predictions or improvement", () => {
  const report = runHistoryRegressionReplay([], config());
  assert.equal(report.input.records, 0);
  assert.equal(report.validation.metrics.publishedModel.brier, null);
  assert.equal(report.finalTest.metrics[frequencyBaseline.id].coverage, null);
  assert.equal(report.selection.selectedCandidate, null);
  assert.equal(report.finalTest.sufficientRows, false);
  assert.equal(report.productionEligible, false);
  assert.ok(report.folds[0].pluginStatus.every((entry) => entry.status === "blocked-shadow"));
});

test("synthetic: frozen inputs cannot be mutated by adapters", () => {
  const rows = syntheticRows();
  const before = JSON.stringify(rows);
  const candidate = { id: "synthetic-mutating", version: "1", fit(train) { train[0].result.outcome = "away"; return {}; }, predict: () => ({ home: 1, draw: 0, away: 0 }) };
  const report = runHistoryRegressionReplay(rows, config({ candidates: [candidate] }));
  assert.equal(JSON.stringify(rows), before);
  assert.equal(report.folds[0].pluginStatus.find((entry) => entry.id === candidate.id).status, "blocked-shadow");
  assert.equal(report.selection.selectedCandidate, null);
});

test("synthetic: original frozen review covers all admitted rows without training-window prerequisites", () => {
  const rows = syntheticRows();
  const report = summarizePublishedHistory(rows, config());
  assert.equal(report.rows, 16);
  assert.equal(report.metrics.publishedModel.n, 16);
  assert.equal(report.metrics.sameDecisionMarket.n, 16);
  assert.equal(report.pairedAgainstMarket.publishedModel.metrics.brier.delta, 0);
  assert.equal(report.evaluationKind, "original-frozen-prediction-review");
  assert.equal(report.productionEligible, false);
  assert.equal(report.perMatch.length, 16);
});

test("synthetic: unknown result and closing fields cannot pass through prediction inputs", () => {
  const rows = syntheticRows().map((row) => ({
    ...row, actual: "SECRET_OUTCOME", finalScore: { home: 4, away: 0 }, closingOdds: { home: 1.1 },
    league: { name: "Synthetic League", result: "SECRET_OUTCOME" },
    decision: { ...row.decision, result: "SECRET_OUTCOME", probabilities: { ...row.decision.probabilities, actual: "SECRET_OUTCOME" } },
    officialOdds: { ...row.officialOdds, closing: "SECRET_OUTCOME", sp: { ...row.officialOdds.sp, actual: "SECRET_OUTCOME" } },
    result: { ...row.result, extraFuture: "SECRET_OUTCOME" },
    features: { form: { value: 0.2, result: "SECRET_OUTCOME" }, result: "SECRET_OUTCOME", candidateEligible: false },
  }));
  const candidate = {
    id: "synthetic-projection-audit", version: "1",
    fit(train) { assert.equal(JSON.stringify(train).includes("SECRET_OUTCOME"), false); return { home: 0.5, draw: 0.25, away: 0.25 }; },
    predict(state, row) {
      assert.equal(JSON.stringify(row).includes("SECRET_OUTCOME"), false);
      assert.deepEqual(Object.keys(row).sort(), ["decision", "features", "kickoffAt", "league", "market", "matchId", "officialOdds"]);
      assert.deepEqual(row.features, {});
      return state;
    },
  };
  const report = runHistoryRegressionReplay(rows, config({ candidates: [candidate] }));
  assert.equal(report.selection.selectedCandidate, candidate.id);
});

test("synthetic: declared features require finite values, source/hash and decision-time availability", () => {
  const rows = syntheticRows().map((row) => ({ ...row, features: { candidateEligible: true, values: { form: { value: 0.3, source: "synthetic-source", payloadSha256: "a".repeat(64), providerObservedAt: row.decision.at, receivedAt: row.decision.at, availableAt: row.decision.at, extraFuture: "SECRET_OUTCOME" } } } }));
  const candidate = {
    id: "synthetic-feature-audit", version: "1", requiredFeatures: ["form"],
    fit(train) { assert.equal(JSON.stringify(train).includes("SECRET_OUTCOME"), false); return { home: 0.5, draw: 0.25, away: 0.25 }; },
    predict(state, row) { assert.equal(row.features.form.value, 0.3); assert.equal("extraFuture" in row.features.form, false); return state; },
  };
  assert.equal(runHistoryRegressionReplay(rows, config({ candidates: [candidate] })).selection.selectedCandidate, candidate.id);
  const future = structuredClone(rows);
  future[8].features.values.form.availableAt = future[8].result.observedAt;
  const futureReport = runHistoryRegressionReplay(future, config({ candidates: [candidate] }));
  assert.equal(futureReport.selection.selectedCandidate, null);
  assert.match(futureReport.folds[0].pluginStatus.find((entry) => entry.id === candidate.id).failures[0].reason, /unavailable at decision/);
  for (const value of [NaN, Infinity, null]) {
    const invalid = structuredClone(rows);
    invalid[0].features.values.form.value = value;
    const report = runHistoryRegressionReplay(invalid, config({ candidates: [candidate] }));
    assert.equal(report.folds[0].pluginStatus.find((entry) => entry.id === candidate.id).status, "blocked-shadow");
  }
  const diagnosticOnly = structuredClone(rows);
  diagnosticOnly[0].features.candidateEligible = false;
  assert.equal(runHistoryRegressionReplay(diagnosticOnly, config({ candidates: [candidate] })).selection.selectedCandidate, null);
  const noSource = structuredClone(rows);
  delete noSource[0].features.values.form.payloadSha256;
  assert.equal(runHistoryRegressionReplay(noSource, config({ candidates: [candidate] })).selection.selectedCandidate, null);
});

test("synthetic: future-week kickoff with earlier forecast cannot consume later training labels", () => {
  const rows = syntheticRows();
  rows[4].decision.at = "2025-12-26T10:00:00+08:00";
  const report = runHistoryRegressionReplay(rows, config());
  assert.equal(report.folds[0].counts.train.used, 0);
  assert.equal(report.folds[0].context.trainingResultBefore, "2025-12-26T02:00:00.000Z");
  assert.equal(report.folds[0].pluginStatus[0].status, "blocked-shadow");
  assert.equal(report.finalTest.metrics[frequencyBaseline.id].n, 0);
});

test("synthetic: malformed original probabilities and SP fail closed before JSON copying", () => {
  for (const value of [NaN, Infinity, -0.1, 1.1, "0.5", null]) {
    const rows = syntheticRows();
    rows[0].decision.probabilities.home = value;
    assert.throws(() => summarizePublishedHistory(rows), /invalid probability/);
  }
  const badOdds = syntheticRows();
  badOdds[0].officialOdds.sp.home = NaN;
  assert.throws(() => runHistoryRegressionReplay(badOdds, config()), /invalid official SP/);
  const rounding = probabilities({ home: 0.500001, draw: 0.25, away: 0.25 });
  assert.ok(Math.abs(Object.values(rounding).reduce((a, b) => a + b) - 1) < 1e-12);
  assert.throws(() => probabilities({ home: 0.5001, draw: 0.25, away: 0.25 }), /sum to 1/);
});

test("synthetic: bootstrap empty or missing-market cases expose zero pairs and no interval", () => {
  const options = { iterations: 200, minBlocks: 2, minRows: 2 };
  for (const rows of [[], [{ matchDay: day(1), actual: "home", predictions: { model: { home: 0.5, draw: 0.25, away: 0.25 } } }]]) {
    const result = pairedDayBootstrap(rows, "model", "market", options);
    assert.equal(result.pairedRows, 0);
    assert.equal(result.intervalAvailable, false);
    assert.equal(result.metrics.brier.delta, null);
    assert.equal(result.metrics.brier.interval, null);
  }
  assert.throws(() => pairedDayBootstrap([], "model", "market", { ...options, seed: NaN }), /unsigned 32-bit/);
});

test("synthetic: upstream diagnostic groups report availability without becoming model features", () => {
  const rows = syntheticRows().map((row) => ({ ...row, features: { present: true, bound: true, timeValid: true, groups: { elo: { available: true, status: "frozen-value-requires-field-source-audit", candidateEligible: false }, xg: { available: false, candidateEligible: false } }, missing: ["xg"], candidateEligible: false } }));
  const report = summarizePublishedHistory(rows, config());
  assert.deepEqual(Object.keys(report.groups.publishedModel.featureMissing).sort(), ["elo", "xg"]);
  assert.equal(report.groups.publishedModel.featureMissing.elo.present.n, 16);
  assert.equal(report.groups.publishedModel.featureMissing.xg.missing.n, 16);
});
