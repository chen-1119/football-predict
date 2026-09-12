'use strict';

const { performance } = require('node:perf_hooks');

function prioritizeTasks(tasks) {
  return [...tasks].sort((left, right) => {
    const kindOrder = Number(left.kind !== 'lineup') - Number(right.kind !== 'lineup');
    return kindOrder || Date.parse(left.fixture.kickoffUtc) - Date.parse(right.fixture.kickoffUtc)
      || left.taskKey.localeCompare(right.taskKey);
  });
}

function createRunPolicy({ maxPages = 12, maxRunSeconds = 480 } = {}, clock = () => performance.now()) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid page budget: expected an integer from 1 to 100');
  if (!Number.isInteger(maxRunSeconds) || maxRunSeconds < 60 || maxRunSeconds > 480) throw new Error('Invalid run budget: expected an integer from 60 to 480 seconds');
  const startedAt = clock();
  let pagesStarted = 0, cancellation = null;
  const elapsedMs = () => Math.max(0, clock() - startedAt);
  const interruptionReason = () => cancellation || (elapsedMs() >= maxRunSeconds * 1000 ? 'time-budget' : null);
  const stopReason = () => interruptionReason() || (pagesStarted >= maxPages ? 'page-budget' : null);
  return {
    interruptionReason,
    stopReason,
    cancel(reason = 'cancelled') { cancellation ||= reason; },
    remainingMs: () => Math.max(0, maxRunSeconds * 1000 - elapsedMs()),
    tryStartPage() {
      if (stopReason()) return false;
      pagesStarted++;
      return true;
    },
    snapshot: () => ({ maxPages, maxRunSeconds, pagesStarted, elapsedSeconds: Math.round(elapsedMs() / 1000), stopReason: stopReason() }),
  };
}

module.exports = { prioritizeTasks, createRunPolicy };
