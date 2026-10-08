'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { planCapacity } = require('../scripts/nativeReleaseCapacity.cjs');
const G = 1024 ** 3;
const input = (free = 50 * G) => ({ databaseBytes: 7 * G, generationBytes: G, applicationBytes: G,
  volumes: Object.fromEntries(['postgres', 'native', 'application'].map(k => [k, { device: '1', availableBytes: free }])) });
test('same disk aggregates DB restore, mirror/WAL, dump, copies and reserve once', () => {
  const p = planCapacity(input()); assert.equal(p.checks.length, 1); assert.equal(p.checks[0].requiredBytes, 40 * G); assert(p.ok);
});
test('r811-like 4 GB free rejects before candidate allocation', () => { assert.equal(planCapacity(input(4 * G)).ok, false); });
test('distinct disks must each pass instead of using total free space', () => {
  const x = input(); x.volumes.postgres = { device: '2', availableBytes: 25 * G };
  const p = planCapacity(x); assert.equal(p.ok, false); assert.equal(p.checks.length, 2);
});
test('same-device samples use smallest free value', () => { const x = input(); x.volumes.native.availableBytes = G; assert(!planCapacity(x).ok); });
test('invalid or overflowing inputs never approve capacity', () => {
  for (const v of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => planCapacity({ ...input(), databaseBytes: v }));
});
test('allocation guard precedes directory and database creation', () => {
  const s = require('node:fs').readFileSync(require('node:path').join(__dirname, '../scripts/nativeReleaseDataPlane.cjs'), 'utf8');
  const body = s.slice(s.indexOf('async function allocate('), s.indexOf('async function postgresCli('));
  assert(body.indexOf('assertNativeReleaseCapacity()') < body.indexOf('fs.mkdirSync'));
  assert(body.indexOf('assertNativeReleaseCapacity()') < body.indexOf('CREATE DATABASE'));
});
