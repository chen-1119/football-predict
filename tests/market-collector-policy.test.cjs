'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../collectors/market/policy.cjs');
const at = Date.parse('2026-09-14T12:00:00Z');
const row = () => ({ signal: { sourceMatchId: '12', fixtureId: '34', homeTeamName: 'Home', awayTeamName: 'Away',
  kickoffTime: '2026-09-14T13:00:00+00:00', handicapLine: '-1', bookmakerOdds: {
    had: { odds1: 1.82, oddsX: 3.45, odds2: 4.2 }, hhad: { odds1: 3.1, oddsX: 3.55, odds2: 1.95 } } } });
const receipt = new Date(at).toISOString();
test('invalid env values fail closed, instead of NaN triggering tight loops', () => {
  for (const value of ['bad', '0', '1.5', '-1', 'Infinity', ' ']) assert.throws(() => p.config({ MARKET_COLLECTOR_MIN_SECONDS: value }));
  assert.throws(() => p.config({ MARKET_COLLECTOR_MIN_SECONDS: '2000', MARKET_COLLECTOR_MAX_SECONDS: '100' }));
});
test('source URL allowlist refuses credentials, redirects to other hosts and non-HTTPS', () => {
  for (const url of ['http://trade.500.com/jczq/', 'https://localhost/jczq/', 'https://user:pass@trade.500.com/jczq/', 'https://trade.500.com/a'])
    assert.throws(() => p.config({ FIVE_HUNDRED_JCZQ_URL: url }));
  assert.ok(p.config({ FIVE_HUNDRED_JCZQ_URL: 'https://trade.500.com/jczq/index.php?playid=312&g=2' }));
});
test('hash excludes receipt time while preserving event identity and market separation', () => {
  const a = p.marketsFromParsedRows([row()], receipt), b = p.marketsFromParsedRows([row()], '2026-09-14T12:01:00Z');
  assert.equal(a.length, 2); assert.equal(a[0].contentHash, b[0].contentHash);
  assert.notEqual(a[0].contentHash, a[1].contentHash);
  const changed = row(); changed.signal.kickoffTime = '2026-09-15T13:00:00Z';
  assert.notEqual(p.marketsFromParsedRows([changed], receipt)[0].contentHash, a[0].contentHash);
});
test('duplicate rows are deduplicated, conflicting batch prices reject the batch', () => {
  assert.equal(p.marketsFromParsedRows([row(), row()], receipt).length, 2);
  const bad = row(); bad.signal.bookmakerOdds.had.odds1 = 2.2;
  assert.throws(() => p.marketsFromParsedRows([row(), bad], receipt), { code: 'CONFLICTING_MARKETS' });
});
test('unknown HHAD line does not become zero and invalid prices do not enter PG', () => {
  const value = row(); delete value.signal.handicapLine;
  const result = p.normalizeRows([value], receipt);
  assert.deepEqual(result.markets.map(m => m.pool), ['had']); assert.equal(result.rejected[0].reason, 'unknown-handicap');
  for (const price of [0, 1, '', null, [], true, '1a']) {
    const bad = row(); bad.signal.bookmakerOdds.had.odds1 = price;
    assert.deepEqual(p.marketsFromParsedRows([bad], receipt).map(m => m.pool), ['hhad']);
  }
});
test('malformed fixtures and impossible calendar days are quarantined', () => {
  for (const date of ['2026-02-30T10:00:00Z', '2026-09-14T24:00:00Z', '2026-09-14 12:00']) {
    const value = row(); value.signal.kickoffTime = date;
    assert.equal(p.normalizeRows([value], receipt).markets.length, 0);
  }
});
test('all adaptive intervals, including the empty schedule, respect both bounds', () => {
  for (const [minutes, seconds] of [[10,60],[30,120],[90,300],[240,600],[720,600],[1800,1800]])
    assert.equal(p.adaptivePollSeconds([{ kickoffTime: new Date(at + minutes * 60000).toISOString() }], at, p.config({})), seconds);
  assert.equal(p.adaptivePollSeconds([], at, p.config({ MARKET_COLLECTOR_MIN_SECONDS: '1200' })), 1200);
  assert.equal(p.jitteredDelayMs(1800, () => 1, p.config({})), 1800000);
});
test('Retry-After supports seconds and HTTP dates and is not capped by normal polling', () => {
  assert.equal(p.retryAfterSeconds('7200', at), 7200);
  assert.equal(p.retryAfterSeconds('Mon, 14 Sep 2026 14:00:00 GMT', at), 7200);
  assert.equal(p.failureDelaySeconds({ code: 'SOURCE_BLOCKED', retryAfterSeconds: 86400 }), 86400);
  assert.equal(p.failureDelaySeconds({ code: 'SOURCE_BLOCKED' }), 21600);
  assert.ok(p.failureDelaySeconds({}, 5) > p.failureDelaySeconds({}, 1));
});
