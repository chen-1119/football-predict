'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prioritizeTasks, createRunPolicy } = require('./runtime-policy.cjs');

test('lineups take priority, then the earliest kickoff; input order is not mutated', () => {
  const task = (kind, hour, key) => ({ kind, fixture: { kickoffUtc: `2026-09-12T${hour}:00:00Z` }, taskKey: key });
  const tasks = [task('injuries', '12', 'a'), task('lineup', '14', 'b'), task('lineup', '13', 'c'), task('injuries', '15', 'd')];
  assert.deepEqual(prioritizeTasks(tasks).map(item => item.taskKey), ['c', 'b', 'a', 'd']);
  assert.deepEqual(tasks.map(item => item.taskKey), ['a', 'b', 'c', 'd']);
});

test('page exhaustion prevents another start without interrupting the final permitted page', () => {
  const budget = createRunPolicy({ maxPages: 2 }, () => 0);
  assert.equal(budget.tryStartPage(), true);
  assert.equal(budget.tryStartPage(), true);
  assert.equal(budget.stopReason(), 'page-budget');
  assert.equal(budget.interruptionReason(), null);
  assert.equal(budget.tryStartPage(), false);
  assert.equal(budget.snapshot().pagesStarted, 2);
});

test('elapsed budget and cancellation prevent new page starts', () => {
  let now = 0;
  const budget = createRunPolicy({ maxRunSeconds: 60 }, () => now);
  now = 59999;
  assert.equal(budget.tryStartPage(), true);
  now = 60000;
  assert.equal(budget.interruptionReason(), 'time-budget');
  assert.equal(budget.tryStartPage(), false);
  const cancelled = createRunPolicy({}, () => 0);
  cancelled.cancel('SIGTERM');
  assert.equal(cancelled.tryStartPage(), false);
  assert.equal(cancelled.interruptionReason(), 'SIGTERM');
  assert.equal(cancelled.snapshot().pagesStarted, 0);
});
