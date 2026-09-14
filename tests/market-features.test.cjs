'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { deriveMarketFeature } = require('../scripts/marketFeatureLogic.cjs');
function row(time, home, options = {}) {
  return { first_seen_at: `2026-09-14T${time}:00Z`, last_seen_at: `2026-09-14T${time}:00Z`,
    payload: { source: '500.com:jczq', sourceMatchId: '1', bookmaker: 'sporttery', pool: 'had',
      kickoffTime: '2026-09-14T13:00:00Z', handicapLine: null, odds1: home, oddsX: 3.4, odds2: 4.2, ...options } };
}
const at = '2026-09-14T12:00:00Z';
test('A-B-A keeps three observed states and records a reversal even when net change is zero', () => {
  const f = deriveMarketFeature([row('10:00',1.8),row('10:10',1.7),row('10:20',1.8)], at);
  assert.equal(f.sampleSize, 3); assert.equal(f.absoluteDelta.odds1, 0);
  assert.equal(f.reversalFlags.odds1, true); assert.equal(f.payload.reversals.odds1, 1);
  assert.equal(f.payload.priceChangeCount, 2); assert.equal(f.strongestShortening, null);
});
test('different source/match/pool/bookmaker streams cannot be blended', () => {
  for (const changes of [{ source: 'other' }, { sourceMatchId: '2' }, { bookmaker: 'other' }, { pool: 'hhad', handicapLine: -1 }])
    assert.throws(() => deriveMarketFeature([row('10:00',1.8),row('10:10',1.7,changes)], at), { code: 'MIXED_MARKETS' });
});
test('a changed kickoff begins a new event, rather than carrying its initial odds forward', () => {
  const f = deriveMarketFeature([row('10:00',1.8),row('10:10',1.7,{ kickoffTime: '2026-09-15T13:00:00Z' })], at);
  assert.equal(f.sampleSize, 1); assert.equal(f.openingOdds.odds1, 1.7);
});
test('changing a handicap and then returning does not join disconnected segments', () => {
  const f = deriveMarketFeature([row('10:00',1.8,{ pool: 'hhad', handicapLine: -1 }),
    row('10:10',1.7,{ pool: 'hhad', handicapLine: -2 }), row('10:20',1.9,{ pool: 'hhad', handicapLine: -1 })], at);
  assert.equal(f.sampleSize, 1); assert.equal(f.absoluteDelta.odds1, 0);
});
test('historical as-of excludes later quotes and does not invent a cutoff-time receipt from future last_seen', () => {
  const a = row('10:00',1.8); a.last_seen_at = '2026-09-14T11:00:00Z';
  const f = deriveMarketFeature([a,row('11:10',1.7)], '2026-09-14T10:30:00Z');
  assert.equal(f.sampleSize, 1); assert.equal(f.lastObservedAt, '2026-09-14T10:00:00.000Z');
});
test('future-only rows and empty input return no feature', () => {
  assert.equal(deriveMarketFeature([],at), null);
  assert.equal(deriveMarketFeature([row('12:10',1.8)],at), null);
});
test('invalid intervals, invalid prices and ambiguous same-time changes fail closed', () => {
  const bad = row('10:00',1.8); bad.last_seen_at = '2026-09-14T09:00:00Z';
  assert.throws(() => deriveMarketFeature([bad],at));
  assert.throws(() => deriveMarketFeature([row('10:00',null)],at));
  assert.throws(() => deriveMarketFeature([row('10:00',1.8),row('10:00',1.7)],at), { code: 'CONFLICTING_FEATURE_TIME' });
});
test('first observation and inverse-odds probabilities remain explicitly descriptive', () => {
  const f = deriveMarketFeature([row('10:00',1.8),row('10:10',1.7)],at);
  assert.equal(f.payload.openingIsOfficial, false); assert.equal(f.payload.predictionEligible, false);
  assert.equal(f.payload.continuousObservation, false);
  assert.ok(Math.abs(Object.values(f.latestImplied).reduce((a,b) => a+b,0) - 1) < 0.000002);
});
