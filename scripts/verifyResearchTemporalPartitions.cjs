"use strict";
const assert = require("node:assert/strict");
const { stableHash } = require("./historicalAsOfFeatureBuilder.cjs");
const { nestedWalkForward } = require("./historicalMarketResearch.cjs");
let checks = 0;
const test = (name, fn) => { fn(); checks++; };
const day = n => new Date(Date.UTC(2020, 0, 1 + n)).toISOString();
const options = { minimumTrainingRows: 150, holdoutRows: 50, minimumFolds: 4,
  modelWeights: [0, 0.2], temperatures: [1], outcomeBiasStrengths: [0, 0.5] };
const rows = Array.from({ length: 600 }, (_, i) => ({ sourceEventId: `synthetic-${i}`,
  date: day(i).slice(0, 10), availableAt: day(i + 1), featureHash: stableHash({ feature: i }), labelHash: stableHash({ label: i }),
  market: { "1": 0.5, X: 0.25, "2": 0.25 }, model: { "1": 0.45, X: 0.3, "2": 0.25 }, actual: ["1", "X", "2"][i % 3] }));
const baseline = nestedWalkForward(rows, options);
test("date and availability boundaries hold in every inner and outer partition", () => {
  assert.ok(baseline.folds.length >= 4);
  for (const fold of baseline.folds) {
    assert.ok(fold.selection.fit.endDate < fold.selection.validation.startDate);
    assert.ok(Date.parse(fold.selection.fit.latestAvailableAt) < Date.parse(fold.selection.validation.startDate));
    assert.ok(Date.parse(fold.training.latestAvailableAt) < Date.parse(fold.window.startDate));
    assert.ok(Date.parse(fold.selection.validation.latestAvailableAt) < Date.parse(fold.window.startDate));
    assert.ok(fold.training.excludedUnavailableRows > 0, "equal-boundary result is excluded");
  }
});
test("input order does not change temporal partitions", () => assert.deepEqual(nestedWalkForward([...rows].reverse(), options), baseline));
test("late-observed outcomes cannot select or fit earlier candidates", () => {
  const late = rows.map((row, i) => i < 20 ? { ...row, availableAt: day(900) } : row);
  const evaluated = nestedWalkForward(late, options);
  const changed = late.map((row, i) => i < 20 ? { ...row, actual: "X", labelHash: stableHash({ changed: i }) } : row);
  assert.deepEqual(nestedWalkForward(changed, options).folds[0], evaluated.folds[0]);
  assert.ok(evaluated.folds[0].training.excludedUnavailableRows >= 20);
});
test("single training date is skipped, never split across fit and validation", () => {
  const batches = rows.map((row, i) => i < 150 ? { ...row, date: day(0).slice(0, 10), availableAt: day(1) } : row);
  const evaluated = nestedWalkForward(batches, options);
  assert.equal(evaluated.skippedWindows[0].reason, "inner-date-split-insufficient");
  assert.ok(evaluated.folds.length > 0);
  for (const fold of evaluated.folds) assert.ok(fold.selection.fit.endDate < fold.selection.validation.startDate);
});
test("incomplete final window and skipped windows remain in coverage denominator", () => {
  const evaluated = nestedWalkForward(rows.slice(0, 583), options);
  assert.equal(evaluated.skippedWindows.at(-1).reason, "holdout-rows-insufficient");
  const c = evaluated.coverage;
  assert.equal(c.initialTrainingRows + c.evaluatedRows + c.skippedRows, c.inputRows);
  assert.equal(evaluated.aggregate.market.rows, c.evaluatedRows);
});
test("duplicate event snapshots cannot leak across partitions", () => {
  assert.throws(() => nestedWalkForward([...rows, { ...rows[0], date: day(999).slice(0, 10), availableAt: day(1000) }], options), { code: "DUPLICATE_RESEARCH_EVENT" });
});
for (const availableAt of [null, "", "invalid", day(0)]) test(`invalid availability ${String(availableAt)}`, () => {
  assert.throws(() => nestedWalkForward([{ ...rows[0], availableAt }, ...rows.slice(1)], options), { code: "INVALID_RESEARCH_AVAILABILITY" });
});
test("future test outcomes do not alter past fitted parameters or completed windows", () => {
  const changed = rows.map((row, i) => i >= 500 ? { ...row, actual: "X", labelHash: stableHash({ future: i }) } : row);
  assert.deepEqual(nestedWalkForward(changed, options).folds[0], baseline.folds[0]);
});
test("no eligible folds report blocked research with empty metrics", () => {
  const unavailable = rows.map(row => ({ ...row, availableAt: day(900) }));
  const evaluated = nestedWalkForward(unavailable, options);
  assert.equal(evaluated.status, "blocked-research-shadow");
  assert.equal(evaluated.aggregate.market.rows, 0);
  assert.equal(evaluated.aggregate.market.accuracy, null);
  assert.ok(evaluated.skippedWindows.length > 0);
});
console.log(JSON.stringify({ ok: true, checks, scope: "synthetic temporal leakage regression only; no production or nomination change" }, null, 2));
