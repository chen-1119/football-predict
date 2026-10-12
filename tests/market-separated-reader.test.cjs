'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const reader = require('../scripts/readMarketSeparatedRegression.cjs');
const range = { from: '2026-09-23', through: '2026-10-07' };
const response = () => ({ version: reader.VERSION, database: 'football', observedAt: '2026-10-07T12:00:00.000001Z',
  readOnly: 'on', isolation: 'repeatable read', productionWrites: 0, ...range, maxEvents: 500, latestPerEvent: true,
  runtime: { runtimeSha: 'a'.repeat(64), completeSha: 'a'.repeat(64), stable: true },
  generation: { data_publication_mode: 'active-generation', data_generation_id: 'g-' + 'b'.repeat(64),
    manifest_hash: 'c'.repeat(64), committed_at: '2026-10-07T11:00:00Z' },
  decisions: [{ sourceMatchId: '123', eventVersion: '2026-10-08T06:30:00+08:00', businessDate: '2026-10-07', publishedAt: '2026-10-07T11:50:00Z' }],
  resultHeads: [], resultEvidenceRows: [] });
test('rejects invalid calendar, injected SQL and an overlong export window', () => {
  for (const from of ['2026-02-30', "2026-09-23';DELETE", '2026-10-08']) assert.throws(() => reader.buildSql(from, range.through));
  assert.throws(() => reader.buildSql('2026-08-01', range.through), /RANGE_OVER/);
  assert.throws(() => reader.parseArgs(['--from', range.from, '--through', range.through, '--output', 'x', '--from', range.from]), /ARGUMENTS/);
});
test('export transaction is repeatable and read-only with sentinel row bounds', () => {
  const sql = reader.buildSql(range.from, range.through);
  assert.match(sql, /REPEATABLE READ READ ONLY/); assert.match(sql, /LIMIT 501/); assert.match(sql, /LIMIT 1001/);
  assert.match(sql, /ROLLBACK;/); assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CALL|COPY|CREATE|DROP)\b/i);
  assert.match(sql, /e\.source_match_id=h\.source_match_id AND e\.event_version=h\.event_version/);
  new vm.Script(reader.buildRemoteReader(range.from, range.through));
});
test('rejects write transactions, incomplete runtime pairs and partial overflow exports', () => {
  for (const mutate of [r => r.readOnly = 'off', r => r.productionWrites = 1,
    r => r.runtime.completeSha = 'd'.repeat(64), r => r.runtime.stable = false,
    r => r.decisions = Array(501).fill(r.decisions[0]), r => r.resultEvidenceRows = Array(1001).fill({})]) {
    const r = response(); mutate(r); assert.throws(() => reader.validateResponse(r, range));
  }
  assert.equal(reader.validateResponse(response(), range).readOnly, 'on');
});
test('nanosecond clocks and UTC-equivalent event IDs cannot hide future or duplicate rows', () => {
  let r = response(); r.decisions[0].publishedAt = '2026-10-07T12:00:00.000002Z';
  assert.throws(() => reader.validateResponse(r, range), /CLOCK/);
  r = response(); r.decisions.push({ ...r.decisions[0], eventVersion: '2026-10-07T22:30:00Z' });
  assert.throws(() => reader.validateResponse(r, range), /DUPLICATE/);
});
test('results must belong to the same exported event and precede real observation', () => {
  for (const h of [
    { sourceMatchId: '999', eventVersion: '2026-10-08T06:30:00+08:00', observedAt: '2026-10-07T11:59:00Z' },
    { sourceMatchId: '123', eventVersion: '2026-10-08T06:30:00+08:00', observedAt: '2026-10-07T12:00:00.000002Z' },
  ]) { const r = response(); r.resultHeads = [h]; assert.throws(() => reader.validateResponse(r, range)); }
});
test('remote observation must belong to this real bounded transport, allowing only stated clock skew', () => {
  const start = '2026-10-07T12:00:00Z', end = '2026-10-07T12:00:02Z';
  assert.equal(reader.validateTransportClock('2026-10-07T12:00:01Z', start, end).observedMinusStartedMs, 1000);
  for (const observed of ['2026-10-07T11:50:00Z', '2026-10-07T12:00:07.000000001Z'])
    assert.throws(() => reader.validateTransportClock(observed, start, end), /OUTSIDE_TRANSPORT/);
});
