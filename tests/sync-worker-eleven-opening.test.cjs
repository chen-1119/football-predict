'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Only an empty synthetic store is visible to module initialization. No real
// collector, worker cycle, database, release configuration or old match file
// is used by these scheduling tests.
const store = fs.mkdtempSync(path.join(os.tmpdir(), 'football-eleven-wake-'));
const envNames = ['SERVER_STORE_DIR', 'DATA_STORE_DIR', 'FOOTBALL_STORAGE_MODE'];
const previous = Object.fromEntries(envNames.map(k => [k, process.env[k]]));
process.env.SERVER_STORE_DIR = store;
process.env.DATA_STORE_DIR = store;
process.env.FOOTBALL_STORAGE_MODE = 'hybrid';
const { scheduledCycleWake, waitForNextCycle } = require('../scripts/runSyncWorker.cjs');
for (const k of envNames) {
  if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
}
after(() => {
  assert.equal(path.dirname(path.resolve(store)), path.resolve(os.tmpdir()));
  assert.match(path.basename(store), /^football-eleven-wake-/);
  fs.rmSync(store, { recursive: true, force: true });
});

const at = s => Date.parse(s);
const opening = at('2026-10-08T03:00:00.000Z'); // Beijing 11:00.
const baseline = { exists: true, token: 'synthetic-unchanged' };
function clockFrom(start, hook) {
  let value = start;
  const sleeps = [];
  return {
    now: () => value,
    sleep: async ms => { sleeps.push(ms); value += ms; if (hook) hook({ value, sleeps }); },
    sleeps,
  };
}

test('base cadence with relay wake disabled sleeps only to the Beijing opening', async () => {
  const clock = clockFrom(opening - 60000);
  const result = await waitForNextCycle(300000, { ...clock, enabled: false, baseline });
  assert.equal(result.reason, 'sporttery-eleven-opening');
  assert.equal(result.openingAt, '2026-10-08T03:00:00.000Z');
  assert.equal(result.waitedMs, 60000);
  assert.deepEqual(clock.sleeps, [60000]);
  assert.equal(clock.now(), opening);
});

test('polling sleeps clip the final poll rather than crossing the opening', async () => {
  const clock = clockFrom(opening - 2500);
  const result = await waitForNextCycle(90000, {
    ...clock, enabled: true, pollMs: 2000, baseline, readFingerprint: () => baseline,
  });
  assert.deepEqual(clock.sleeps, [2000, 500]);
  assert.equal(result.reason, 'sporttery-eleven-opening');
  assert.equal(clock.now(), opening);
});

test('an earlier ordinary interval or zero interval remains unchanged', async () => {
  for (const delay of [0, 20000]) {
    const start = opening - 60000, clock = clockFrom(start);
    const result = await waitForNextCycle(delay, { ...clock, enabled: false, baseline });
    assert.equal(result.reason, 'interval-elapsed');
    assert.equal(result.waitedMs, delay);
    assert.equal(Object.hasOwn(result, 'openingAt'), false);
    assert.equal(clock.now(), start + delay);
  }
});

test('a wake at opening is not repeated by the next wait or an exact-boundary restart', async () => {
  const clock = clockFrom(opening - 1);
  const first = await waitForNextCycle(300000, { ...clock, enabled: false, baseline });
  const second = await waitForNextCycle(30000, { ...clock, enabled: false, baseline });
  assert.equal(first.reason, 'sporttery-eleven-opening');
  assert.equal(second.reason, 'interval-elapsed');
  assert.equal(second.waitedMs, 30000);
  assert.deepEqual(clock.sleeps, [1, 30000]);
  for (const start of [opening, opening + 1]) {
    const restarted = clockFrom(start);
    const result = await waitForNextCycle(30000, { ...restarted, enabled: false, baseline });
    assert.equal(result.reason, 'interval-elapsed');
    assert.deepEqual(restarted.sleeps, [30000]);
  }
});

test('after opening a long sleep selects tomorrow, including Beijing midnight', () => {
  assert.deepEqual(scheduledCycleWake(30 * 3600000, opening), {
    deadlineMs: opening + 24 * 3600000, openingAt: '2026-10-09T03:00:00.000Z',
  });
  assert.deepEqual(scheduledCycleWake(12 * 3600000, at('2026-10-08T16:00:00.000Z')), {
    deadlineMs: opening + 24 * 3600000, openingAt: '2026-10-09T03:00:00.000Z',
  });
});

test('year and leap-day transitions use the shared business-date boundary', () => {
  for (const [start, expected] of [
    ['2026-12-31T04:00:00.000Z', '2027-01-01T03:00:00.000Z'],
    ['2024-02-28T04:00:00.000Z', '2024-02-29T03:00:00.000Z'],
    ['2024-02-29T04:00:00.000Z', '2024-03-01T03:00:00.000Z'],
  ]) {
    assert.deepEqual(scheduledCycleWake(24 * 3600000, at(start)), {
      deadlineMs: at(expected), openingAt: expected,
    });
  }
});

test('external shutdown or release compensation wake keeps its original priority', async () => {
  for (const reason of ['runtime-shutdown-requested', 'background-slow-phase-settled-official-compensation']) {
    const clock = clockFrom(opening - 1000);
    const result = await waitForNextCycle(300000, {
      ...clock, enabled: false, baseline, wakePromise: Promise.resolve({ reason }),
    });
    assert.equal(result.reason, reason);
    assert.equal(result.waitedMs, 0);
    assert.deepEqual(clock.sleeps, []);
    assert.equal(Object.hasOwn(result, 'openingAt'), false);
  }
});

test('a real relay change still wakes before opening without cancelling that future boundary', async () => {
  let token = baseline.token;
  const clock = clockFrom(opening - 10000, () => { token = 'synthetic-new-result'; });
  const result = await waitForNextCycle(300000, {
    ...clock, enabled: true, pollMs: 1000, baseline,
    readFingerprint: () => ({ exists: true, token }),
  });
  assert.equal(result.reason, 'relay-snapshot-updated');
  assert.equal(result.waitedMs, 1000);
  assert.equal(Object.hasOwn(result, 'openingAt'), false);
  assert.deepEqual(scheduledCycleWake(300000, clock.now()), {
    deadlineMs: opening, openingAt: '2026-10-08T03:00:00.000Z',
  });
});

test('result-only midnight intervals and existing retry budgets are not enlarged', async () => {
  const midnight = at('2026-10-07T16:00:00.000Z');
  const clock = clockFrom(midnight);
  const result = await waitForNextCycle(300000, { ...clock, enabled: false, baseline });
  assert.equal(result.reason, 'interval-elapsed');
  assert.equal(result.waitedMs, 300000);
  assert.equal(scheduledCycleWake(15000, opening - 30000).deadlineMs, opening - 15000);
});

test('the scheduling helper never converts invalid wall clocks into an opening permission', () => {
  for (const start of [NaN, Infinity, 1.5]) assert.equal(scheduledCycleWake(300000, start).openingAt, null);
});
