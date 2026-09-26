'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildMatchDayWalkForwardResearch, buildWalkForwardValidation} = require('../scripts/walkForwardValidation.cjs');
const day = n => new Date(Date.UTC(2026, 8, n)).toISOString().slice(0, 10);
function fixture(dayCount = 6, perDay = 2) {
  const rows = Array.from({length: dayCount * perDay}, (_, index) => {
    const date = day(1 + Math.floor(index / perDay));
    return {sourceMatchId: `m${index}`, businessDate: date,
      forecastTime: `${date}T10:00:00Z`, kickoffTime: `${date}T12:00:00Z`,
      resultObservedAt: `${date}T14:00:00Z`, actual: '1',
      marketProbabilities: {'1': .5, X: .3, '2': .2}};
  });
  return {rows, candidates: [candidate('home', rows, {'1': .7, X: .2, '2': .1})],
    minimumTrainingRows: 2, minimumEvaluationRows: 2, requiredFolds: 2};
}
function candidate(id, rows, probabilities) {
  return {id, weights: {model: 1}, _rows: rows.map(row => ({...row, probabilities}))};
}

test('empty research never claims accuracy or promotion', () => {
  const report = buildMatchDayWalkForwardResearch();
  assert.equal(report.promotionEligible, false);
  assert.equal(report.status, 'blocked');
  assert.equal(report.sample.passRate, null);
  assert.deepEqual(report.folds, []);
});

test('row minima expand to complete business days without splitting or reusing evaluation days', () => {
  const input = {...fixture(5, 4), minimumTrainingRows: 3, minimumEvaluationRows: 5};
  const report = buildMatchDayWalkForwardResearch(input);
  assert.equal(report.status, 'research-complete');
  assert.equal(report.promotionEligible, false);
  assert.deepEqual(report.folds.map(fold => fold.evaluation.businessDates), [[day(2), day(3)], [day(4), day(5)]]);
  assert.deepEqual(report.folds.map(fold => fold.evaluation.rows), [8, 8]);
  assert.equal(report.folds[0].training.rows, 4);
  for (const fold of report.folds) {
    assert.ok(fold.watermark.noOverlapVerified);
    assert.equal(fold.evaluation.model.rows, fold.evaluation.market.rows);
    assert.ok(fold.training.businessDates.every(date => !fold.evaluation.businessDates.includes(date)));
  }
});

test('explicit Sporttery day groups matches across Beijing midnight', () => {
  const input = fixture(4);
  // This kickoff is September 3 at 02:00 Beijing, still Sporttery September 2.
  input.rows[3].kickoffTime = `${day(2)}T18:00:00Z`;
  input.rows[3].resultObservedAt = `${day(2)}T20:00:00Z`;
  input.candidates = [candidate('home', input.rows, {'1': .7, X: .2, '2': .1})];
  const report = buildMatchDayWalkForwardResearch(input);
  assert.deepEqual(report.folds[0].evaluation.businessDates, [day(2)]);
  assert.equal(report.folds[0].evaluation.rows, 2);
  assert.equal(report.sample.independentMatchDays, 4);
});

test('missing or invalid business dates block whole-day evidence instead of inferring kickoff dates', () => {
  for (const value of [undefined, null, '', '2026-02-30', '2026-9-01']) {
    const input = fixture();
    input.rows[0].businessDate = value;
    const report = buildMatchDayWalkForwardResearch(input);
    assert.equal(report.folds.length, 0);
    assert.equal(report.promotionEligible, false);
    assert.equal(report.exclusions.missingBusinessDate + report.exclusions.invalidBusinessDate, 1);
  }
});

test('one future result excludes the entire training day, not only the unavailable row', () => {
  const input = fixture(5);
  input.rows[1].resultObservedAt = `${day(10)}T14:00:00Z`;
  input.candidates = [candidate('home', input.rows, {'1': .7, X: .2, '2': .1})];
  const report = buildMatchDayWalkForwardResearch(input);
  assert.deepEqual(report.folds[0].training.businessDates, [day(2)]);
  assert.deepEqual(report.folds[0].training.excludedUnobservedDays, [day(1)]);
  assert.deepEqual(report.folds[0].evaluation.businessDates, [day(3)]);
  assert.equal(report.folds[0].training.rows, 2);
  assert.ok(report.folds.every(fold => !fold.training.businessDates.includes(day(1))));
});

test('candidate selection cannot inspect evaluation winners', () => {
  const input = fixture(3);
  input.rows.slice(2).forEach(row => {row.actual = '2';});
  input.candidates = [candidate('home', input.rows, {'1': .7, X: .2, '2': .1}),
    candidate('away', input.rows, {'1': .1, X: .2, '2': .7})];
  const report = buildMatchDayWalkForwardResearch(input);
  assert.equal(report.folds[0].selectedCandidateId, 'home');
  assert.equal(report.folds[0].training.model.accuracy, 1);
  assert.equal(report.folds[0].evaluation.model.accuracy, 0);
});

test('training ties ignore evaluation-ranked input order and yield the same report hash', () => {
  const input = fixture(3);
  const evaluationWinner = candidate('z-winner', input.rows, {'1': .7, X: .2, '2': .1});
  const evaluationLoser = candidate('a-loser', input.rows, {'1': .7, X: .2, '2': .1});
  evaluationLoser._rows.slice(2).forEach(row => { row.probabilities = {'1': .1, X: .2, '2': .7}; });
  input.candidates = [evaluationWinner, evaluationLoser];
  const winnerFirst = buildMatchDayWalkForwardResearch(input);
  input.candidates.reverse();
  const loserFirst = buildMatchDayWalkForwardResearch(input);
  assert.equal(winnerFirst.folds[0].selectedCandidateId, 'a-loser');
  assert.equal(winnerFirst.folds[0].training.model.accuracy, 1);
  assert.equal(winnerFirst.folds[0].evaluation.model.accuracy, 0);
  assert.equal(loserFirst.folds[0].selectedCandidateId, winnerFirst.folds[0].selectedCandidateId);
  assert.equal(loserFirst.reportHash, winnerFirst.reportHash);
  assert.deepEqual(loserFirst, winnerFirst);
});

test('evaluation coverage gaps stop rather than skip a losing or uncovered day', () => {
  const input = fixture(5);
  input.candidates[0]._rows = input.candidates[0]._rows.filter(row => row.sourceMatchId !== 'm2');
  const report = buildMatchDayWalkForwardResearch(input);
  assert.equal(report.folds.length, 0);
  assert.ok(report.blockers.includes('evaluation-candidate-coverage-gap'));
  assert.equal(report.boundaries.at(-1).startBusinessDate, day(2));
});

test('training coverage gaps also stop and no partial target cohort is selected', () => {
  const input = fixture();
  input.candidates[0]._rows = input.candidates[0]._rows.filter(row => row.sourceMatchId !== 'm0');
  const report = buildMatchDayWalkForwardResearch(input);
  assert.equal(report.folds.length, 0);
  assert.ok(report.blockers.includes('training-candidate-coverage-gap'));
});

test('identical retries count once while conflicting business days fail closed', () => {
  const input = fixture();
  input.rows.push({...input.rows[0]});
  const retried = buildMatchDayWalkForwardResearch(input);
  assert.equal(retried.sample.duplicateRows, 1);
  assert.equal(retried.sample.acceptedRows, 12);
  input.rows.at(-1).businessDate = day(2);
  const conflict = buildMatchDayWalkForwardResearch(input);
  assert.equal(conflict.folds.length, 0);
  assert.ok(conflict.blockers.includes('business-date-conflict'));
});

test('defaults retain 80 training, 40 evaluation and six independent folds', () => {
  const input = fixture(16, 20);
  const report = buildMatchDayWalkForwardResearch({rows: input.rows, candidates: input.candidates});
  assert.equal(report.folds.length, 6);
  assert.equal(report.folds[0].training.rows, 80);
  assert.ok(report.folds.every(fold => fold.evaluation.rows === 40));
  assert.equal(report.sample.evaluationRows, 240);
  assert.equal(report.status, 'research-complete');
  assert.equal(report.promotionEligible, false);
});

test('explicit candidate business dates bind to the canonical day and change the report hash on conflict', () => {
  for (const invalidDate of [day(2), '2026-02-30', null, undefined, '']) {
    const input = fixture();
    const before = buildMatchDayWalkForwardResearch(input);
    assert.equal(before.status, 'research-complete');
    assert.equal(before.candidateDateBindings.conflicts, 0);
    input.candidates[0]._rows[0].businessDate = invalidDate;
    const after = buildMatchDayWalkForwardResearch(input);
    assert.equal(after.status, 'blocked');
    assert.equal(after.folds.length, 0);
    assert.equal(after.candidateDateBindings.conflicts, 1);
    assert.equal(after.candidateDateBindings.matched, input.rows.length - 1);
    assert.ok(after.blockers.includes('candidate-business-date-conflict'));
    assert.notEqual(after.reportHash, before.reportHash);
  }
});

test('candidate rows without a businessDate field inherit the canonical grouping for compatibility', () => {
  const input = fixture();
  const before = buildMatchDayWalkForwardResearch(input);
  input.candidates[0]._rows.forEach(row => { delete row.businessDate; });
  const after = buildMatchDayWalkForwardResearch(input);
  assert.equal(after.status, 'research-complete');
  assert.deepEqual(after.folds, before.folds);
  assert.deepEqual(after.candidateDateBindings, {explicit: 0, matched: 0, inherited: input.rows.length, conflicts: 0});
  assert.notEqual(after.reportHash, before.reportHash);
});

test('supplement does not alter inputs or the original v3 artifact', () => {
  const input = fixture(6, 20);
  const beforeInput = JSON.stringify(input);
  const before = buildWalkForwardValidation(input);
  buildMatchDayWalkForwardResearch(input);
  assert.equal(JSON.stringify(input), beforeInput);
  assert.deepEqual(buildWalkForwardValidation(input), before);
  assert.equal(before.version, 'walk-forward-promotion-validation-v3');
});
