'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { buildAsianHandicapTimeline, verifyAsianHandicapTimeline, settleAsianHandicap, priceAsianHandicap }
  = require('../src/services/asianHandicapEvidenceV3.cjs');
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item) ?? 'null').join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const event = { sourceMatchId: 'synthetic-event', eventVersion: '2026-10-06T14:00:00Z',
  kickoffTime: '2026-10-06T14:00:00Z', cutoffAt: '2026-10-06T13:45:00Z', homeTeamId: 'synthetic-home', awayTeamId: 'synthetic-away' };
const asOf = '2026-10-06T13:00:00Z';
function observation(minute = 0, changes = {}) {
  const at = `2026-10-06T12:${String(minute).padStart(2, '0')}:00Z`;
  return { ...event, market: 'AH', source: 'synthetic-source', company: 'synthetic-company', homeLine: -0.5,
    oddsFormat: 'hong-kong', rawPrices: { home: 0.9, away: 1.05 }, providerObservedAt: at,
    receivedAt: at, rawPayloadHash: hash({ minute, changes }), ...changes };
}
const build = observations => buildAsianHandicapTimeline({ event, asOf, observations });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function distribution(masses) {
  const maxHome = Math.max(...masses.map(row => row.home)), maxAway = Math.max(...masses.map(row => row.away));
  const rows = [];
  for (let home = 0; home <= maxHome; home++) for (let away = 0; away <= maxAway; away++) {
    rows.push({ home, away, probability: masses.find(row => row.home === home && row.away === away)?.probability || 0 });
  }
  return { complete: true, tailMass: 0, rows };
}

test('AH is explicit, bound to source/company/event/teams, and never formally authenticated by a boolean', () => {
  const timeline = build([observation(0, { verified: true, formalEligible: true })]);
  assert.equal(timeline.available, true); assert.equal(timeline.formalEligible, false);
  assert.equal(timeline.streams[0].openingIsOfficial, false);
  assert.equal(timeline.streams[0].baselineKind, 'first-received-observation');
  assert.equal(timeline.latestQuotes[0].sourceAuthentication, 'not-established-by-this-contract');
  assert.equal(timeline.latestQuotes[0].formalEligible, false);
  assert.match(timeline.priceIndicatorMeaning, /not-asian-cover-or-win-probability/);
  assert.equal(verifyAsianHandicapTimeline(timeline), true);
  for (const change of [{ market: 'HHAD' }, { market: undefined }, { pool: 'HHAD' }, { company: '' }, { source: null },
    { sourceMatchId: 'other' }, { homeTeamId: event.awayTeamId }, { awayTeamId: event.homeTeamId },
    { eventVersion: '2026-10-06T15:00:00Z' }, { rawPayloadHash: 'invalid' }]) {
    assert.equal(build([observation(0, change)]).available, false, JSON.stringify(change));
  }
});
test('as-of uses explicit provider and receipt clocks and the earlier deadline', () => {
  const observations = [observation(0), observation(10), observation(20)];
  const timeline = buildAsianHandicapTimeline({ event, asOf: '2026-10-06T12:15:00Z', observations });
  assert.equal(timeline.observationCount, 2);
  assert.equal(timeline.latestQuotes[0].receivedAt, '2026-10-06T12:10:00Z');
  assert.equal(timeline.rejected[0].reason, 'future-observation');
  for (const change of [{ providerObservedAt: null }, { receivedAt: '' }, { providerObservedAt: '2026-10-06T12:01:00Z' },
    { receivedAt: '2026-10-06T12:00:00' }, { providerObservedAt: '2026-02-30T12:00:00Z' }]) {
    assert.equal(build([observation(0, change)]).available, false);
  }
  const cutoff = buildAsianHandicapTimeline({ event, asOf: '2026-10-06T15:00:00Z', observations: [observation(0,
    { receivedAt: event.cutoffAt, providerObservedAt: event.cutoffAt })] });
  assert.equal(cutoff.available, false); assert.equal(cutoff.rejected[0].reason, 'observation-at-or-after-cutoff');
  const earlierKickoff = { ...event, cutoffAt: '2026-10-06T15:00:00Z' };
  assert.equal(buildAsianHandicapTimeline({ event: earlierKickoff, asOf: '2026-10-06T15:00:00Z',
    observations: [observation(0, { receivedAt: event.kickoffTime, providerObservedAt: event.kickoffTime })] }).available, false);
});
test('event deadline aliases must agree and missing/invalid local clocks fail closed', () => {
  for (const changes of [{ cutoffAt: undefined }, { cutoffAt: '2026-10-06 13:45:00' },
    { cutoffTime: '2026-10-06T13:30:00Z' }, { kickoffTime: '2026-10-06T15:00:00Z' }, { homeTeamId: event.awayTeamId }]) {
    const timeline = buildAsianHandicapTimeline({ event: { ...event, ...changes }, asOf, observations: [observation()] });
    assert.equal(timeline.available, false); assert.equal(verifyAsianHandicapTimeline(timeline), false);
  }
  assert.equal(buildAsianHandicapTimeline({ event, asOf: '2026-10-06T13:00:00', observations: [] }).available, false);
});
test('nanosecond boundaries reject future receipts and event drift without truncating original clocks', () => {
  const nanosecond = '2026-10-06T12:00:00.000000001Z';
  const future = buildAsianHandicapTimeline({ event, asOf: '2026-10-06T12:00:00.000Z',
    observations: [observation(0, { receivedAt: nanosecond, providerObservedAt: nanosecond })] });
  assert.equal(future.available, false); assert.equal(future.rejected[0].reason, 'future-observation');
  assert.equal(build([observation(0, { providerObservedAt: nanosecond })]).rejected[0].reason, 'provider-clock-after-receipt');
  assert.equal(build([observation(0, { eventVersion: '2026-10-06T14:00:00.000000001Z' })]).rejected[0].reason, 'event-identity-conflict');
  assert.equal(buildAsianHandicapTimeline({ event: { ...event, eventVersion: '2026-10-06T14:00:00.000000001Z' }, asOf,
    observations: [] }).available, false);
  const second = '2026-10-06T12:00:00.000000002Z', third = '2026-10-06T12:00:00.000000003Z';
  const accepted = buildAsianHandicapTimeline({ event, asOf: third, observations: [
    observation(0, { receivedAt: second, providerObservedAt: second, rawPrices: { home: 0.8, away: 1.1 } }),
    observation(0, { receivedAt: nanosecond, providerObservedAt: nanosecond })] });
  assert.equal(accepted.observationCount, 2); assert.equal(accepted.rejected.length, 0);
  assert.deepEqual(accepted.streams[0].observations.map(row => row.receivedAt), [nanosecond, second]);
  assert.equal(accepted.streams[0].segments[0].priceChanges.length, 1);
  assert.equal(accepted.asOf, third); assert.equal(accepted.latestQuotes[0].receivedAt, second);
  close(accepted.latestQuotes[0].ageAtAsOfMs, 0.000001); assert.equal(verifyAsianHandicapTimeline(accepted), true);
});
test('cutoff and conflict grouping compare exact instants, including equivalent timezones', () => {
  const cutoffAt = '2026-10-06T12:00:00.000000005Z', before = '2026-10-06T12:00:00.000000004Z';
  const bounded = buildAsianHandicapTimeline({ event: { ...event, cutoffAt }, asOf: '2026-10-06T12:00:00.000000006Z', observations: [
    observation(0, { receivedAt: before, providerObservedAt: before }), observation(0, { receivedAt: cutoffAt, providerObservedAt: cutoffAt })] });
  assert.equal(bounded.observationCount, 1); assert.equal(bounded.cutoffAt, cutoffAt);
  assert.equal(bounded.rejected[0].reason, 'observation-at-or-after-cutoff');
  const utc = observation(0), equivalent = observation(0, { receivedAt: '2026-10-06T20:00:00.000000000+08:00',
    providerObservedAt: '2026-10-06T20:00:00+08:00', eventVersion: '2026-10-06T22:00:00+08:00' });
  const identical = build([utc, equivalent]); assert.equal(identical.observationCount, 2); assert.equal(identical.rejected.length, 0);
  assert.equal(identical.streams[0].observations[1].receivedAt, equivalent.receivedAt);
  const conflict = build([utc, { ...equivalent, homeLine: -1 }]);
  assert.equal(conflict.observationCount, 0); assert.equal(conflict.rejected.length, 2);
  assert.equal(conflict.rejected[0].reason, 'same-company-receipt-time-conflict');
});
test('all four odds formats convert explicitly with their signed format boundaries', () => {
  const cases = [ ['decimal', 1.9, 2.1, 1.9, 2.1], ['hong-kong', 0.9, 1.1, 1.9, 2.1],
    ['malay', 0.5, -0.5, 1.5, 3], ['malay', 1, -1, 2, 2],
    ['indonesian', 2, -2, 3, 1.5], ['indonesian', 1, -1, 2, 2] ];
  for (const [oddsFormat, home, away, expectedHome, expectedAway] of cases) {
    const quote = build([observation(0, { oddsFormat, rawPrices: { home, away } })]).latestQuotes[0];
    close(quote.decimalOdds.home, expectedHome); close(quote.decimalOdds.away, expectedAway);
    close(quote.priceIndicator.home + quote.priceIndicator.away, 1);
  }
  assert.equal(build([observation(0, { rawPrices: { home: '0.90', away: '1.05' } })]).available, true);
  for (const [oddsFormat, bad] of [['decimal', 1], ['decimal', 0.9], ['hong-kong', -0.5], ['hong-kong', 0],
    ['malay', 1.01], ['malay', -1.01], ['malay', 0], ['indonesian', 0.9], ['indonesian', -0.9], ['indonesian', 0]]) {
    assert.equal(build([observation(0, { oddsFormat, rawPrices: { home: bad, away: 2 } })]).available, false);
  }
  for (const oddsFormat of [undefined, null, '', 'HK', 'unknown']) assert.equal(build([observation(0, { oddsFormat })]).available, false);
  for (const raw of [null, undefined, '', ' ', false, NaN, Infinity, '1e3']) {
    assert.equal(build([observation(0, { rawPrices: { home: raw, away: 1 } })]).available, false);
  }
});
test('line null is not zero; signed quarter units are preserved', () => {
  for (const homeLine of [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.75, 1]) {
    assert.equal(build([observation(0, { homeLine })]).latestQuotes[0].homeLine, homeLine);
  }
  for (const homeLine of [null, '', '0', false, undefined, 0.1, Infinity]) {
    assert.equal(build([observation(0, { homeLine })]).available, false);
  }
});
test('A to B to A preserves separate contiguous line segments and same-line price changes', () => {
  const timeline = build([observation(0), observation(5, { rawPrices: { home: 0.8, away: 1.1 } }),
    observation(10, { homeLine: -0.75 }), observation(15, { homeLine: -1 }), observation(20, { homeLine: -0.5 })]);
  const stream = timeline.streams[0];
  assert.equal(stream.observationCount, 5);
  assert.deepEqual(stream.segments.map(segment => segment.homeLine), [-0.5, -0.75, -1, -0.5]);
  assert.equal(stream.segments[0].priceChanges.length, 1);
  assert.equal(stream.segments[3].priceChanges.length, 0);
  assert.deepEqual(stream.lineTransitions.map(change => change.lineDelta), [-0.25, -0.25, 0.5]);
  assert.equal(stream.lineTransitions[0].direction, 'home-line-decreased');
  assert.equal(stream.lineTransitions[2].direction, 'home-line-increased');
});
test('company and source changes never manufacture a line transition or average movement', () => {
  const timeline = build([observation(0), observation(10, { company: 'other-company', homeLine: -1 }),
    observation(20, { source: 'other-source', homeLine: 1 })]);
  assert.equal(timeline.streams.length, 3);
  for (const stream of timeline.streams) assert.equal(stream.lineTransitions.length, 0);
  assert.equal(Object.hasOwn(timeline, 'averageLineMovement'), false);
  assert.match(timeline.crossCompanyMovement, /not-computed/);
});
test('unordered receipts are sorted; conflicting same-company same-time prices are quarantined', () => {
  assert.deepEqual(build([observation(20), observation(0), observation(10)]).streams[0].observations.map(o => o.receivedAt),
    [0, 10, 20].map(minute => `2026-10-06T12:${String(minute).padStart(2, '0')}:00Z`));
  const timeline = build([observation(0), observation(10), observation(10, { homeLine: -1 })]);
  assert.equal(timeline.observationCount, 1); assert.equal(timeline.rejected.length, 2);
  assert.equal(timeline.rejected[0].reason, 'same-company-receipt-time-conflict');
  assert.equal(verifyAsianHandicapTimeline(timeline), true);
});
test('timeline verifier rebuilds arithmetic and rejects even rehashed forged outputs', () => {
  const original = build([observation()]);
  for (const mutate of [t => { t.formalEligible = true; }, t => { t.latestQuotes[0].decimalOdds.home = 9; },
    t => { t.streams[0].openingIsOfficial = true; }, t => { t.observationCount = 9; },
    t => { t.streams[0].observations[0].priceIndicator.home = 0.9; }]) {
    const timeline = structuredClone(original); mutate(timeline);
    const { contentHash, ...body } = timeline; timeline.contentHash = hash(body);
    assert.equal(verifyAsianHandicapTimeline(timeline), false);
  }
  const empty = build([]); assert.equal(empty.available, false); assert.equal(verifyAsianHandicapTimeline(empty), true);
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
  assert.equal(verifyAsianHandicapTimeline(reorder(JSON.parse(JSON.stringify(original)))), true);
});
test('negative and positive quarter lines split half stakes with win/push/loss correctly', () => {
  const cases = [ [0, 0, -0.25, 'home', 'halfLoss', -0.5], [0, 0, 0.25, 'home', 'halfWin', 0.5],
    [1, 0, -0.75, 'home', 'halfWin', 0.5], [0, 1, 0.75, 'home', 'halfLoss', -0.5],
    [0, 0, -0.25, 'away', 'halfWin', 0.5], [0, 0, 0.25, 'away', 'halfLoss', -0.5],
    [1, 0, -0.75, 'away', 'halfLoss', -0.5], [0, 1, 0.75, 'away', 'halfWin', 0.5] ];
  for (const [homeGoals, awayGoals, homeLine, side, outcome, net] of cases) {
    const result = settleAsianHandicap({ homeGoals, awayGoals, homeLine, decimalOdds: 2, side });
    assert.equal(result.outcome, outcome); assert.equal(result.legs.length, 2);
    close(result.netReturn, net); close(result.grossReturn, net + 1);
  }
});
test('whole lines push at the exact integer margin and both signs retain home perspective', () => {
  for (const side of ['home', 'away']) {
    for (const [homeGoals, awayGoals, homeLine] of [[1, 0, -1], [0, 1, 1], [0, 0, 0]]) {
      const result = settleAsianHandicap({ homeGoals, awayGoals, homeLine, decimalOdds: 1.9, side });
      assert.equal(result.outcome, 'push'); assert.equal(result.legs.length, 1);
      close(result.netReturn, 0); close(result.grossReturn, 1);
    }
  }
  assert.equal(settleAsianHandicap({ homeGoals: 2, awayGoals: 0, homeLine: -1, decimalOdds: 1.9, side: 'home' }).outcome, 'fullWin');
  assert.equal(settleAsianHandicap({ homeGoals: 0, awayGoals: 2, homeLine: 1, decimalOdds: 1.9, side: 'home' }).outcome, 'fullLoss');
});
test('invalid score, decimal price, side and handicap contracts cannot settle', () => {
  const good = { homeGoals: 1, awayGoals: 0, homeLine: -1, decimalOdds: 1.9, side: 'home' };
  for (const change of [{ homeGoals: null }, { awayGoals: '' }, { homeGoals: 0.5 }, { awayGoals: -1 },
    { homeLine: null }, { homeLine: -0.1 }, { decimalOdds: 0.9 }, { decimalOdds: null }, { side: 'HHAD' }, { side: null },
    { homeGoals: Number.MAX_SAFE_INTEGER }, { market: 'HHAD' }, { pool: 'HHAD' }]) {
    assert.equal(settleAsianHandicap({ ...good, ...change }).available, false);
  }
});
test('pricing sums settlement returns, including half and pushed stakes, instead of p times SP minus one', () => {
  const scoreDistribution = distribution([{ home: 0, away: 0, probability: 0.3 },
    { home: 1, away: 0, probability: 0.4 }, { home: 2, away: 0, probability: 0.3 }]);
  const result = priceAsianHandicap({ scoreDistribution, homeLine: -0.75, decimalOdds: 2.2, side: 'home' });
  assert.equal(result.available, true); assert.equal(result.formalEligible, false);
  close(result.probabilities.fullLoss, 0.3); close(result.probabilities.halfWin, 0.4); close(result.probabilities.fullWin, 0.3);
  close(result.expectedNetReturn, -0.3 + 0.4 * 0.6 + 0.3 * 1.2); close(result.expectedGrossReturn, 1.3);
  assert.notEqual(result.expectedNetReturn, (result.probabilities.fullWin + result.probabilities.halfWin) * 2.2 - 1);
  const push = priceAsianHandicap({ scoreDistribution, homeLine: -1, decimalOdds: 2.2, side: 'home' });
  close(push.probabilities.push, 0.4); close(push.expectedNetReturn, -0.3 + 0.3 * 1.2);
});
test('pricing handles positive quarter, away selections and all five settlement classes', () => {
  const scoreDistribution = distribution([{ home: 0, away: 0, probability: 0.5 }, { home: 0, away: 1, probability: 0.5 }]);
  const home = priceAsianHandicap({ scoreDistribution, homeLine: 0.75, decimalOdds: 2, side: 'home' });
  close(home.probabilities.fullWin, 0.5); close(home.probabilities.halfLoss, 0.5); close(home.expectedNetReturn, 0.25);
  assert.equal(priceAsianHandicap({ scoreDistribution, homeLine: 0.75, decimalOdds: 2, side: 'home', market: 'HHAD' }).available, false);
  const away = priceAsianHandicap({ scoreDistribution, homeLine: 0.75, decimalOdds: 2, side: 'away' });
  close(away.probabilities.fullLoss, 0.5); close(away.probabilities.halfWin, 0.5); close(away.expectedNetReturn, -0.25);
  assert.equal(Object.keys(home.probabilities).length, 5);
});
test('probability quality rejects top-K, missing/negative/future-like coercions and unrepresented mass', () => {
  const good = distribution([{ home: 0, away: 0, probability: 0.5 }, { home: 1, away: 0, probability: 0.5 }]);
  const rejects = [good.rows, { ...good, complete: undefined }, { ...good, tailMass: undefined },
    { ...good, tailMass: 0.1 }, { ...good, tailMass: -0.1 }, { ...good, rows: [{ home: 1, away: 0, probability: 1 }] },
    { ...good, rows: [...good.rows, good.rows[0]] }, { ...good, rows: good.rows.map(row => ({ ...row, probability: row.probability / 2 })) },
    { ...good, rows: good.rows.map(row => ({ ...row, probability: -0.5 })) },
    { ...good, rows: good.rows.map(row => ({ ...row, probability: '0.5' })) },
    { ...good, rows: good.rows.map(row => ({ ...row, probability: NaN })) },
    { ...good, rows: good.rows.map(row => ({ ...row, home: null })) },
    { ...good, rows: good.rows.map(row => ({ ...row, homeGoals: 2 })) } ];
  for (const scoreDistribution of rejects) {
    const result = priceAsianHandicap({ scoreDistribution, homeLine: 0.25, decimalOdds: 2, side: 'home' });
    assert.equal(result.available, false); assert.equal(result.reason, 'complete-score-distribution-required');
  }
});
