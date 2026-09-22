'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { eligibleFixture, createRefreshHandler } = require('../server/prematchRefresh.cjs');
const { dueMatches, attemptedMatches, coverageFor } = require('../scripts/syncDailyPrematchApi.cjs');
const now = Date.parse('2026-09-22T06:00:00Z');
const match = (id = 1, hours = 4) => ({ id: 'sporttery_' + id, sourceMatchId: String(id), businessDate: '2026-09-22',
  homeTeamName: 'home', awayTeamName: 'away', status: 'SCHEDULED', kickoffTime: new Date(now + hours * 3600000).toISOString() });
test('priority accepts official betting day including next calendar day, excludes finished, tomorrow and conflicting identity', () => {
  assert(eligibleFixture(match(1, 12), now));
  for (const overrides of [{ businessDate: '2026-09-23' }, { status: 'FINISHED' }, { effectiveStatus: 'FINISHED' }, { sourceMatchId: '2' }, { eventVersion: '2026-09-23T12:00:00Z' }, { kickoffTime: new Date(now).toISOString() }]) assert.equal(eligibleFixture({ ...match(), ...overrides }, now), null);
});
test('priority rechecks missing mappings but respects short cooldown and changed event identity', () => {
  const rows = [match(1, 3), match(2, 4)], attempts = { sporttery_2: new Date(now - 3600000).toISOString() };
  const priorities = [{ match_id: 'sporttery_2', event_version: rows[1].kickoffTime }];
  assert.deepEqual(dueMatches(rows, {}, attempts, now).map(x => x.id), ['sporttery_1']);
  assert.deepEqual(dueMatches(rows, {}, attempts, now, priorities).map(x => x.id), ['sporttery_2','sporttery_1']);
  assert.deepEqual(dueMatches(rows, {}, { sporttery_2: new Date(now - 60000).toISOString() }, now, priorities).map(x => x.id), ['sporttery_1']);
  assert.deepEqual(dueMatches(rows, {}, attempts, now, [{ ...priorities[0], event_version: new Date(now + 6 * 3600000).toISOString() }]).map(x => x.id), ['sporttery_1']);
});
test('queue cannot force refresh of fresh fields or early lineups', () => {
  const m = match(), cache = { fixtureMap: { [m.id]: { fixtureId: 9, fixtureDate: m.kickoffTime } }, fixtureSignals: { 9: { injuriesFetchedAt: new Date(now - 60000).toISOString() } } };
  assert.deepEqual(dueMatches([m], cache, {}, now, [{ match_id: m.id, event_version: m.kickoffTime }]), []);
  assert.equal(dueMatches([{ ...m, kickoffTime: new Date(now + 30 * 60000).toISOString() }], { ...cache, fixtureMap: { [m.id]: { fixtureId: 9, fixtureDate: new Date(now + 30 * 60000).toISOString() } } }, {}, now).length, 1);
});
test('budget-starved candidates and mapping-only successes do not get false injury cooldown', () => {
  const rows = [match(1),match(2),match(3),match(4)];
  const cache = { fixtureMap: { sporttery_2: { lastSearchAt: new Date(now + 1).toISOString() }, sporttery_3: { fixtureId: 3, lastSearchAt: new Date(now + 1).toISOString() }, sporttery_4: { fixtureId: 4 } }, fixtureSignals: { 4: { injuriesFetchedAt: new Date(now + 1).toISOString() } } };
  assert.deepEqual([...attemptedMatches(rows, cache, now)], ['sporttery_2','sporttery_4']);
});
test('source-empty requires actual fresh empty provider response, not normalized zero or unmapped data', () => {
  const m = match(), reference = { items: [] }, verified = new Set([m.id]);
  const cache = { fixtureMap: { [m.id]: { fixtureId: 9 } }, fixtureSignals: { 9: { injuriesFetchedAt: new Date(now).toISOString(), injuriesRows: 0 } } };
  assert.equal(coverageFor([m], reference, verified, cache, now)[0].injuries, 'missing');
  cache.fixtureSignals[9].injuriesResponseRows = 0;
  assert.equal(coverageFor([m], reference, verified, cache, now)[0].injuries, 'source_empty');
  assert.equal(coverageFor([m], reference, new Set(), cache, now)[0].injuries, 'unmapped');
  assert.equal(coverageFor([m], reference, verified, cache, now + 7 * 3600000)[0].injuries, 'missing');
  assert.equal(coverageFor([m], reference, verified, cache, now)[0].lineup, 'not-due');
});
async function call(overrides, authorized = true) {
  let queries = 0, reads = 0;
  const handler = createRefreshHandler({ pool: { connect: () => { queries++; throw Error('must not reach database'); } }, readFixture: () => { reads++; return match(); }, authorize: async () => authorized, origin: 'https://app.example', clock: () => now });
  const req = { method: 'POST', headers: { origin: 'https://app.example', 'x-prematch-request': '1' }, ...overrides };
  let body; const res = { setHeader() {}, end(value) { body = JSON.parse(value); } };
  await handler(req, res, 'sporttery_1'); return { status: res.statusCode, body, queries, reads };
}
test('priority route rejects unauthenticated, cross-origin and simple-form requests before database mutation', async () => {
  for (const [args, authorized, status] of [[{ method: 'GET' },true,405], [{},false,401], [{ headers: { origin: 'https://evil.example','x-prematch-request':'1' } },true,403], [{ headers: { origin:'https://app.example' } },true,403], [{ headers: { origin:'https://app.example','x-prematch-request':'1','sec-fetch-site':'cross-site' } },true,403]]) {
    const result = await call(args, authorized); assert.equal(result.status, status); assert.equal(result.queries, 0); assert.equal(result.reads, 0);
  }
});
