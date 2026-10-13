'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const xg = require('../scripts/prematchXgCollectionAdapter.cjs');
const {stableHash} = require('../src/services/webConsensusEvidence.cjs');
const {buildPrematchTeamSnapshot} = require('../src/services/prematchTeamEvidenceV3.cjs');
const sha = b => createHash('sha256').update(b).digest('hex');
const stamp = body => ({...body, contentHash: stableHash(body)});
function fixture() {
  const xgRow = {key: 'expected_goals', title: 'Expected goals (xG)', type: 'text', rawStats: [{value: 1.39}, {value: 6.43}]};
  return {general: {matchId: '5181853', homeTeam: {id: 10155, name: 'Croatia'}, awayTeam: {id: 8491, name: 'England'},
    leagueId: 920743, leagueName: 'UEFA Nations League A Grp. 3', matchTimeUTCDate: '2026-10-03T16:00:00.000Z', finished: true, gender: 'male'},
  header: {teams: [{id: 10155, name: 'Croatia', score: 0}, {id: 8491, name: 'England', score: 7}],
    status: {utcTime: '2026-10-03T16:00:00.000Z', finished: true, started: true, cancelled: false, awarded: false,
      reason: {shortKey: 'fulltime_short', longKey: 'finished'}, whoLostOnPenalties: null,
      halfs: {firstHalfStarted: '03.10.2026 18:02:19', secondHalfStarted: '03.10.2026 19:04:53', secondHalfEnded: '03.10.2026 19:52:17',
        firstExtraHalfStarted: '', secondExtraHalfStarted: '', gameEnded: '03.10.2026 19:52:17'}}},
  content: {stats: {Periods: {All: {stats: [{key: 'top_stats', stats: [xgRow]}, {key: 'expected_goals', title: 'Expected goals (xG)', stats: [
    {key: 'expected_goals', title: 'Expected goals (xG)', type: 'title', rawStats: [null, null]}, xgRow]}]},
    FirstHalf: {stats: [{...xgRow, rawStats: [{value: 0.99}, {value: 3.6}]}]}, SecondHalf: {stats: []}}},
    shotmap: {shots: [...Array.from({length: 2}, (_, i) => ({teamId: 10155, period: i ? 'SecondHalf' : 'FirstHalf', expectedGoals: 0.695, isOwnGoal: false})),
      ...Array.from({length: 10}, (_, i) => ({teamId: 8491, period: i > 4 ? 'SecondHalf' : 'FirstHalf', expectedGoals: 0.643, isOwnGoal: false}))]}}};
}
const html = page => Buffer.from(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props: {pageProps: page}})}</script></html>`);
function packet(page = fixture(), known = '2026-10-06T08:00:00Z') {
  const bytes = html(page), facts = xg.parseObservedXgPage(bytes, xg.PILOT[0]);
  const receipt = stamp({version: xg.VERSION, requestedUrl: xg.PILOT[0].url, finalUrl: xg.PILOT[0].url, redirects: [], expectedEvent: xg.PILOT[0],
    requestStartedAt: '2026-10-06T07:59:59Z', collectorObservedAt: known, receivedAt: known, clockBasis: 'collector-response-body-completed',
    sourcePublishedAt: null, httpStatus: 200, contentType: 'text/html; charset=utf-8', rawRelativePath: 'synthetic.html',
    rawPayloadHash: sha(bytes), rawPayloadBytes: bytes.length, facts, factsHash: stableHash(facts), sourceVerification: 'unverified', formalEligible: false, productionWrites: 0});
  return {receipt, bytes};
}
const event = {sourceMatchId: '2041817', eventVersion: '2026-10-07T02:45:00+08:00', cutoffAt: '2026-10-06T22:00:00+08:00',
  homeTeamId: 'test-england', awayTeamId: 'test-czechia', homeTeamName: '英格兰', awayTeamName: '捷克', status: 'SCHEDULED', isOnSale: true};
const mapping = receipt => stamp({version: xg.MAPPING_VERSION, sourceVerification: 'unverified', formalEligible: false,
  sourceReceiptHash: receipt.contentHash, sourceMatchId: event.sourceMatchId, eventVersion: event.eventVersion,
  siteTeamId: event.homeTeamId, siteTeamName: event.homeTeamName, providerTeamId: '8491', providerTeamName: 'England', reviewedAt: '2026-10-06T08:00:01Z'});
const adapt = (input, options = {}) => xg.adaptObservedXgReceipt({...input, event, side: 'home', asOf: '2026-10-06T08:01:00Z', reviewedProviderMapping: mapping(input.receipt), ...options});

test('finished regulation All xG is read as a source measurement, never a forecast or a half', () => {
  const facts = xg.parseObservedXgPage(html(fixture()), xg.PILOT[0]);
  assert.equal(facts.status, 'observed');
  assert.equal(facts.home.observedXg, 1.39); assert.equal(facts.away.observedXg, 6.43);
  assert.equal(facts.endedAt, null); assert.equal(facts.sourcePublishedAt, null);
  assert.equal(facts.shotEvidence.shotCount, 12); assert.equal(facts.formalEligible, false);
});
test('extra time, penalties, awarded scores and non-final matches fail the observed measurement gate', () => {
  for (const modify of [p => {p.header.status.halfs.firstExtraHalfStarted = '03.10.2026 20:00:00';},
    p => {p.header.status.whoLostOnPenalties = 'home';}, p => {p.header.status.awarded = true;},
    p => {p.header.status.reason.shortKey = 'after_extra_time';}, p => {p.general.finished = false;}]) {
    const p = fixture(); modify(p); assert.equal(xg.parseObservedXgPage(html(p), xg.PILOT[0]).status, 'unavailable');
  }
});
test('absence of explicit no-extra-time fields or presence of extra periods is not accepted as 90 minutes', () => {
  const p = fixture(); delete p.header.status.halfs.firstExtraHalfStarted;
  assert.match(xg.parseObservedXgPage(html(p), xg.PILOT[0]).reason, /ninety-minute/);
  const q = fixture(); q.content.stats.Periods.ExtraFirstHalf = {stats: []};
  assert.match(xg.parseObservedXgPage(html(q), xg.PILOT[0]).reason, /ninety-minute/);
});
test('current pair page must still be the previously observed finished event', () => {
  const p = fixture(); p.general.matchTimeUTCDate = p.header.status.utcTime = '2026-11-15T19:45:00Z';
  assert.equal(xg.parseObservedXgPage(html(p), xg.PILOT[0]).reason, 'public-pair-page-now-points-to-another-event');
});
test('team IDs/names and duplicated All measurements must agree exactly', () => {
  const p = fixture(); p.header.teams[0].id = 8491;
  assert.equal(xg.parseObservedXgPage(html(p), xg.PILOT[0]).reason, 'header-team-conflict');
  const q = fixture(); q.content.stats.Periods.All.stats[1].stats[1] = {...q.content.stats.Periods.All.stats[1].stats[1], rawStats: [{value: 99}, {value: 0}]};
  assert.equal(xg.parseObservedXgPage(html(q), xg.PILOT[0]).reason, 'all-period-xg-row-invalid');
  q.content.stats.Periods.All.stats[1].stats[1].rawStats = [{value: 0.5}, {value: 6}];
  assert.equal(xg.parseObservedXgPage(html(q), xg.PILOT[0]).reason, 'all-period-xg-conflict');
});
test('only xGOT, pre-match top-scorer season xG or first-half xG cannot fill post-match All xG', () => {
  const p = fixture(); p.content.stats.Periods.All.stats = [{key: 'expected_goals_on_target', title: 'Expected goals on target (xGOT)', type: 'text', rawStats: [{value: 1}, {value: 7}]}];
  assert.equal(xg.parseObservedXgPage(html(p), xg.PILOT[0]).reason, 'observed-all-period-xg-missing');
  delete p.content.stats.Periods.All;
  assert.equal(xg.parseObservedXgPage(html(p), xg.PILOT[0]).reason, 'all-period-statistics-missing');
});
test('regulation shot events must agree with the source teams and aggregate xG', () => {
  const p = fixture(); p.content.shotmap.shots[0].teamId = 999;
  assert.match(xg.parseObservedXgPage(html(p), xg.PILOT[0]).reason, /shot-events/);
  const q = fixture(); q.content.shotmap.shots[0].expectedGoals = 0;
  assert.equal(xg.parseObservedXgPage(html(q), xg.PILOT[0]).reason, 'shot-sum-and-xg-statistics-conflict');
  q.content.shotmap.shots[0].expectedGoals = 1.1;
  assert.equal(xg.parseObservedXgPage(html(q), xg.PILOT[0]).reason, 'shot-xg-probability-invalid');
});
test('bounded public HTML parsing rejects malformed bytes, multiple scripts and missing payload', () => {
  assert.equal(xg.parseObservedXgPage(Buffer.from([0xff]), xg.PILOT[0]).status, 'unavailable');
  assert.equal(xg.parseObservedXgPage(Buffer.alloc(xg.MAX_BYTES + 1), xg.PILOT[0]).reason, 'body-size-invalid');
  assert.equal(xg.parseObservedXgPage(Buffer.from('<html>login</html>'), xg.PILOT[0]).status, 'unavailable');
  assert.equal(xg.parseObservedXgPage(Buffer.concat([html(fixture()), html(fixture())]), xg.PILOT[0]).status, 'unavailable');
});
test('only public fixed-host match paths, no credentials, API URLs, query tokens or fragments', () => {
  assert.equal(xg.publicMatchUrl(xg.PILOT[0].url), true);
  for (const url of ['http://www.fotmob.com/matches/a/b', 'https://evil.example/matches/a/b', 'https://www.fotmob.com/api/matchDetails?id=1',
    'https://user:pass@www.fotmob.com/matches/a/b', xg.PILOT[0].url + '?token=x', xg.PILOT[0].url + '#1']) assert.equal(xg.publicMatchUrl(url), false);
});
test('original bytes plus real acquisition clocks and entire semantic replay are verified', () => {
  const input = packet(); assert.equal(xg.verifyObservedXgReceipt(input.receipt, input.bytes), true);
  assert.equal(xg.verifyObservedXgReceipt(input.receipt, Buffer.concat([input.bytes, Buffer.from(' ')])), false);
  const modified = structuredClone(input.receipt); modified.facts.away.observedXg = 7; modified.factsHash = stableHash(modified.facts);
  const {contentHash, ...body} = modified; modified.contentHash = stableHash(body);
  assert.equal(xg.verifyObservedXgReceipt(modified, input.bytes), false);
});
test('transparent redirects keep exact source host/path and acquisition time ordering', () => {
  const input = packet(), receipt = structuredClone(input.receipt);
  receipt.finalUrl = 'https://www.fotmob.com/en-GB/matches/england-vs-croatia/2viayw';
  receipt.redirects = [{from: receipt.requestedUrl, to: receipt.finalUrl, httpStatus: 302, receivedAt: '2026-10-06T07:59:59.500Z'}];
  let {contentHash, ...body} = receipt; receipt.contentHash = stableHash(body);
  assert.equal(xg.verifyObservedXgReceipt(receipt, input.bytes), true);
  receipt.redirects[0].receivedAt = '2026-10-06T08:00:00.000000001Z';
  ({contentHash, ...body} = receipt); receipt.contentHash = stableHash(body);
  assert.equal(xg.verifyObservedXgReceipt(receipt, input.bytes), false);
});
test('first-seen current evidence becomes one precisely bound V3 prior xG row', () => {
  const input = packet(), adapted = adapt(input);
  assert.equal(adapted.status, 'captured'); assert.equal(adapted.teamObservations.length, 1);
  const observation = adapted.teamObservations[0];
  assert.equal(observation.data.rows[0].observedXgFor, 6.43); assert.equal(observation.data.rows[0].observedXgAgainst, 1.39);
  assert.equal(observation.providerObservedAt, input.receipt.collectorObservedAt);
  assert.equal(observation.data.rows[0].clockBasis, 'collector-response-body-completed');
  assert.equal(observation.data.rows[0].sourcePublishedAt, null);
  assert.equal(observation.data.rows[0].identityMappingHash, mapping(input.receipt).contentHash);
  assert.equal(observation.data.rows[0].identityMappingReviewedAt, mapping(input.receipt).reviewedAt);
  assert.equal(observation.identityMappingHash, mapping(input.receipt).contentHash);
  assert.equal(observation.identityMappingReviewedAt, mapping(input.receipt).reviewedAt);
  const snapshot = buildPrematchTeamSnapshot({event, asOf: '2026-10-06T08:01:00Z', observations: [observation]});
  assert.equal(snapshot.sides.home.xg.features.sampleCount, 1); assert.equal(snapshot.sides.home.xg.features.observedXgForPerMatch, 6.43);
  assert.equal(snapshot.formalEligible, false);
});
test('unreviewed, wrong provider IDs/names, current-event mismatch or future review cannot map by numbers alone', () => {
  const input = packet(); assert.equal(adapt(input, {reviewedProviderMapping: null}).status, 'blocked');
  for (const changes of [{providerTeamName: 'england'}, {providerTeamId: '10155'}, {siteTeamId: 'other'}, {siteTeamName: '克罗地亚'},
    {eventVersion: '2026-10-08T02:45:00+08:00'}, {reviewedAt: '2026-10-06T08:01:00.000000001Z'}]) {
    const review = mapping(input.receipt), {contentHash, ...body} = review;
    assert.equal(adapt(input, {reviewedProviderMapping: stamp({...body, ...changes})}).status, 'blocked');
  }
});
test('first-seen future by one nanosecond and closed sale cannot be historical backdated', () => {
  const input = packet();
  assert.equal(adapt(input, {asOf: '2026-10-06T07:59:59.999999999Z'}).status, 'blocked');
  assert.equal(adapt(input, {asOf: event.cutoffAt}).status, 'blocked');
  for (const changes of [{status: 'FINISHED'}, {isOnSale: false}, {saleStatus: 'CLOSED'}]) {
    assert.equal(adapt(input, {event: {...event, ...changes}}).reason, 'target-event-or-sale-ineligible');
  }
  assert.equal(adapt(input, {event: {...event, kickoffTime: '2026-10-07T02:45:00.000000001+08:00'}}).reason, 'target-event-clock-alias-conflict');
  assert.equal(adapt(input, {event: {...event, cutoffTime: '2026-10-06T22:00:00.000000001+08:00'}}).reason, 'target-event-clock-alias-conflict');
});
test('combining retains row source clocks, deduplicates prior events and never increases independent sample count', () => {
  const input = packet(), item = {...input, reviewedProviderMapping: mapping(input.receipt)};
  const combined = xg.combineObservedXgReceipts({items: [item, item], event, side: 'home', asOf: '2026-10-06T08:01:00Z'});
  assert.equal(combined.sampleCount, 1); assert.equal(combined.status, 'partial');
  assert.equal(combined.teamObservations[0].data.rows[0].receivedAt, input.receipt.receivedAt);
  assert.equal(combined.teamObservations[0].identityMappingReviewedAt, mapping(input.receipt).reviewedAt);
  assert.equal(combined.rejected[0].reason, 'duplicate-prior-event-not-another-sample');
});
