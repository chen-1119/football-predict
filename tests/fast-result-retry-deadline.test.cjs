'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const runnerPath = path.resolve(__dirname, '../scripts/runSportteryFastResultLane.cjs');
const realRequire = createRequire(runnerPath);
const realHelpers = realRequire('./sportteryFastResultLane.cjs');
const startedAtMs = Date.parse('2026-10-02T17:52:00.000Z');

// Exercise the real runCycle control flow with isolated I/O and a clock which
// advances while collection runs. No provider requests, credentials or files.
async function cycle({ previous = {}, failure = 'collector-failed-unknown', heartbeatFails = false, unchanged = false } = {}) {
  let clockMs = startedAtMs;
  let collections = 0;
  let uploads = 0;
  const writes = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clockMs])); }
    static now() { return clockMs; }
  }
  const helpers = {
    ...realHelpers,
    runCollector: async () => {
      collections += 1;
      clockMs += 5_000;
      if (collections === 1 && !unchanged) throw new Error(failure);
      if (collections > 1 && heartbeatFails) throw new Error('collector-failed-unknown');
      return { endpoints: [] };
    },
    resultPageOneEndpoint: () => ({ method: 'result' }),
    resultFingerprint: () => 'unchanged-fingerprint',
    postSnapshot: async () => { uploads += 1; return { status: 200 }; },
    writeJsonAtomic: (_path, state) => writes.push(structuredClone(state)),
    cleanupFiles: async () => {},
  };
  const moduleObject = { exports: {} };
  const load = (id) => id === './sportteryFastResultLane.cjs'
    ? helpers
    : id === './syncCloudflareSportteryEvidence.cjs'
      ? { run: async () => { throw new Error('unexpected-cloudflare-request'); } }
      : realRequire(id);
  vm.runInNewContext(fs.readFileSync(runnerPath, 'utf8'), {
    require: load, module: moduleObject, exports: moduleObject.exports,
    Date: Clock, setTimeout, clearTimeout,
    process: { argv: ['node', runnerPath, '--once'], env: {}, pid: 1234 },
  }, { filename: runnerPath });
  const result = await moduleObject.exports.runCycle(previous);
  return { result, clockMs, collections, uploads, writes };
}

for (const [name, lastUploadOkAt] of [
  ['expired heartbeat', '2026-09-30T10:33:49.170Z'],
  ['missing heartbeat', undefined],
  ['malformed heartbeat', 'not-a-time'],
  ['heartbeat due before failure backoff', new Date(startedAtMs - 55_000).toISOString()],
]) {
  test(`${name} cannot cause immediate or shortened retries`, async () => {
    const { result, clockMs, collections, uploads, writes } = await cycle({
      previous: { lastUploadOkAt, consecutiveFailures: 12 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.delayMs, 300_000);
    assert.equal(Date.parse(result.state.nextAttemptAt), clockMs + result.delayMs);
    assert.equal(realHelpers.computeDelayFromCompletion({ nextAttemptAt: result.state.nextAttemptAt, nowMs: clockMs, fallbackMs: result.delayMs, maxMs: 1_800_000 }), result.delayMs);
    assert.equal(result.state.lastUploadOkAt, lastUploadOkAt);
    assert.equal(result.state.lastFailure.code, 'collector');
    assert.equal(result.state.currentHeartbeatUploaded, false);
    assert.equal(collections, 1);
    assert.equal(uploads, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].nextAttemptAt, result.state.nextAttemptAt);
  });
}

for (const heartbeatFails of [false, true]) {
  test(`WAF cooldown remains complete when companion ${heartbeatFails ? 'fails' : 'succeeds'}`, async () => {
    const staleUpload = '2026-09-30T10:33:49.170Z';
    const { result, clockMs, collections, uploads } = await cycle({
      previous: { lastUploadOkAt: staleUpload, consecutiveFailures: 12 },
      failure: 'collector-failed-waf-blocked HTTP 567 security policy blocked',
      heartbeatFails,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state.lastFailure.code, 'official-waf');
    assert.equal(result.delayMs, 1_800_000);
    assert.equal(Date.parse(result.state.nextAttemptAt), clockMs + 1_800_000);
    assert.equal(result.state.consecutiveFailures, 13);
    assert.equal(result.state.currentHeartbeatUploaded, !heartbeatFails);
    assert.equal(collections, 2);
    assert.equal(uploads, heartbeatFails ? 0 : 1);
    assert.equal(result.state.lastUploadOkAt, heartbeatFails ? staleUpload : new Date(clockMs).toISOString());
  });
}

test('first failure starts existing base backoff after collection completes', async () => {
  const { result, clockMs } = await cycle();
  assert.equal(clockMs, startedAtMs + 5_000);
  assert.ok(result.delayMs >= 30_000 && result.delayMs <= 33_000);
  assert.equal(Date.parse(result.state.nextAttemptAt), clockMs + result.delayMs);
  assert.equal(result.state.consecutiveFailures, 1);
});

test('healthy unchanged cycle keeps the existing normal interval and clears failure debt', async () => {
  const { result, clockMs, collections, uploads } = await cycle({
    unchanged: true,
    previous: { lastUploadOkAt: new Date(startedAtMs).toISOString(), lastUploadedResultFingerprint: 'unchanged-fingerprint', consecutiveFailures: 12 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.state.consecutiveFailures, 0);
  assert.equal(result.state.lastFailure, null);
  assert.equal(Date.parse(result.state.nextAttemptAt), clockMs + 15_000);
  assert.equal(collections, 1);
  assert.equal(uploads, 0);
});
