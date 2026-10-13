'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observedNumber, formNeedPressureFromSnapshot } = require('../src/services/formNeedPressure.cjs');

test('missing/invalid observations remain unknown rather than zero', () => {
  for (const value of [null, undefined, '', ' ', false, true, [], {}, NaN, Infinity, 'unknown']) {
    assert.equal(observedNumber(value), null);
    assert.equal(formNeedPressureFromSnapshot({sampleSize: 3, restDays: value}), 0);
  }
});
test('actual zero and numeric provider text retain their meaning', () => {
  assert.equal(observedNumber(0), 0);
  assert.equal(observedNumber(' 3 '), 3);
  assert.equal(formNeedPressureFromSnapshot({sampleSize: '3', restDays: 0}), 2);
  assert.equal(formNeedPressureFromSnapshot({sampleSize: 3, restDays: '3'}), 2);
  assert.equal(formNeedPressureFromSnapshot({sampleSize: 3, restDays: 3.01}), 0);
  assert.equal(formNeedPressureFromSnapshot({sampleSize: 3, restDays: -1}), 0);
});
test('missing points and goal difference do not manufacture poor form', () => {
  assert.equal(formNeedPressureFromSnapshot({sampleSize: 4, pointsPerMatch: null, goalDiffAvg: null, restDays: null}), 0);
  assert.equal(formNeedPressureFromSnapshot({sampleSize: 4, pointsPerMatch: 0, goalDiffAvg: -1, restDays: 3}), 10);
  assert.equal(formNeedPressureFromSnapshot({sampleSize: 4, pointsPerMatch: 2.2, goalDiffAvg: 1, restDays: 5}), -3);
  assert.equal(formNeedPressureFromSnapshot({sampleSize: 4, pointsPerMatch: 4}), 0);
});
test('sparse or invalid sample counts cannot apply pressure', () => {
  for (const sampleSize of [null, undefined, '', false, 0, 2, 2.9, 'invalid']) {
    assert.equal(formNeedPressureFromSnapshot({sampleSize, pointsPerMatch: 0, goalDiffAvg: -1, restDays: 0}), 0);
  }
});
