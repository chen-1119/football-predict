'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { officialRoster, dueMatches } = require('./syncDailyPrematchApi.cjs');
const now = Date.parse('2026-09-14T02:00:00Z');
const raw = { matchId: 123, businessDate: '2026-09-14', matchDate: '2026-09-15', matchTime: '03:00', matchStatus: 'Selling', homeTeamAllName: '利兹联', awayTeamAllName: '纽卡斯尔联', leagueAllName: '英格兰超级联赛', matchNumStr: '周一010' };
const payload = rows => ({ success: true, value: { matchInfoList: [{ businessDate: '2026-09-14', subMatchList: rows }] } });
test('official betting day includes following morning and excludes another day', () => {
 const result = officialRoster(payload([raw]), ['2026-09-14']);
 assert.equal(result.length, 1); assert.equal(result[0].kickoffTime, '2026-09-15T03:00:00+08:00');
 assert.equal(officialRoster(payload([raw]), ['2026-09-15']).length, 0);
 assert.equal(dueMatches(result, {}, {}, now).length, 1);
});
test('failed or malformed official response cannot become an empty success', () => {
 assert.throws(() => officialRoster({ success: false }, ['2026-09-14']));
 assert.throws(() => officialRoster(payload([{ ...raw, businessDate: '2026-09-13' }]), ['2026-09-13']));
});
test('cancelled, started, conflicting and invalid fixtures generate no requests', () => {
 for (const item of [{ ...raw, matchStatus: 'Cancelled' }, { ...raw, matchDate: '2026-09-14', matchTime: '09:00' }, { ...raw, matchTime: '27:99' }]) {
  assert.equal(dueMatches(officialRoster(payload([item]), ['2026-09-14']), {}, {}, now).length, 0);
 }
 assert.equal(dueMatches(officialRoster(payload([raw, { ...raw, awayTeamAllName: 'Other' }]), ['2026-09-14']), {}, {}, now).length, 0);
});
test('reuse full official-id cache; request lineups only within an hour', () => {
 const rows = officialRoster(payload([raw]), ['2026-09-14']), row = rows[0];
 const cache = { fixtureMap: { [row.id]: { fixtureId: 999, fixtureDate: row.kickoffTime } }, fixtureSignals: { 999: { injuriesFetchedAt: new Date(now).toISOString() } } };
 assert.equal(dueMatches(rows, cache, {}, now).length, 0);
 const near = Date.parse(row.kickoffTime) - 50 * 60000;
 cache.fixtureSignals[999].injuriesFetchedAt = new Date(near).toISOString();
 assert.equal(dueMatches(rows, cache, {}, near).length, 1);
 cache.fixtureSignals[999].lineupsFetchedAt = new Date(near).toISOString();
 assert.equal(dueMatches(rows, cache, {}, near).length, 0);
 assert.equal(dueMatches(rows, cache, {}, near + 31 * 60000).length, 1);
});
test('unknown mapping waits six hours; over-eight match rosters remain complete', () => {
 const rows = officialRoster(payload(Array.from({ length: 20 }, (_, n) => ({ ...raw, matchId: n + 1 }))), ['2026-09-14']);
 assert.equal(dueMatches(rows, {}, {}, now).length, 20);
 assert.equal(dueMatches(rows, {}, { sporttery_1: new Date(now).toISOString() }, now).length, 19);
});
test('scoped aliases require both exact provider identity and the official competition', () => {
 const { scopedTeamAliases } = require('./apiFootballScopedAliases.cjs');
 const match = { leagueName: '芬兰超级联赛', homeTeamName: '国际图尔库' };
 const fixture = { league: { id: 244, season: 2026 }, teams: { home: { id: 1164, name: 'Inter Turku' } } };
 assert.deepEqual(scopedTeamAliases(match, 'home', fixture, ['veikkausliiga']), ['Inter Turku']);
 assert.deepEqual(scopedTeamAliases({ ...match, leagueName: '瑞典超级联赛' }, 'home', fixture, ['veikkausliiga']), []);
 assert.deepEqual(scopedTeamAliases(match, 'home', { ...fixture, teams: { home: { id: 1165, name: 'Inter Turku' } } }, ['veikkausliiga']), []);
 assert.deepEqual(scopedTeamAliases(match, 'home', { ...fixture, teams: { home: { id: 1164, name: 'Inter Turku II' } } }, ['veikkausliiga']), []);
});
