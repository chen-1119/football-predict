'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { buildReferenceExport, selectReference } = require('./api-football-reference.cjs');
const { createWebsiteReader } = require('./website-reader.cjs');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const now = Date.parse('2026-09-12T16:15:00Z');
const match = { id: 'sporttery_2041426', sourceMatchId: '2041426', homeTeamName: '托特纳姆热刺', awayTeamName: '埃弗顿',
  kickoffTime: '2026-09-13T00:30:00+08:00', status: 'SCHEDULED' };
function cache() {
  const metadata = { source: 'api-football', observedAt: '2026-09-12T16:14:00.000Z', providerFixtureId: 1557406,
    provenance: { fetchedAt: '2026-09-12T16:14:00.000Z' }, temporalEligibility: { eligible: false },
    clockEvidence: { version: 'api-football-clock-evidence-v2', sourceTimeStatus: 'missing' } };
  const team = (id, offset) => ({ teamId: id, formation: '4-2-3-1',
    startXI: Array.from({ length: 11 }, (_, i) => ({ playerId: offset + i, name: '球员' + (offset + i) })), substitutes: [] });
  return { fixtureMap: { [match.id]: { fixtureId: 1557406, homeTeamId: 47, awayTeamId: 45 } },
    fixtureSignals: { 1557406: { injuries: { ...metadata, players: [{ name: '球员甲', fixtureId: 1557406, teamId: 47, side: 'home', reason: '膝伤' }] },
      lineups: { ...metadata, home: team(47, 100), away: team(45, 200) } } } };
}
const build = c => buildReferenceExport([match], c, new Set([match.id]), now);
test('current verified collection is visible as reference after model cutoff', () => {
  const doc = build(cache()), result = selectReference(doc, match, now);
  assert.equal(result.provider, 'api-football'); assert.equal(result.predictionEligible, false);
  assert.equal(result.sections.injuries.data.players.length, 1);
  assert.equal(result.sections.lineup.data.teams[0].starters.length, 11);
  assert.equal(buildReferenceExport([match], cache(), new Set(), now).items.length, 0);
  assert.equal(selectReference(doc, { ...match, status: 'LIVE' }, Date.parse('2026-09-12T16:31:00Z')).status, 'ok');
  assert.equal(selectReference(doc, { ...match, status: 'POSTPONED' }, now), null);
});
test('identity, receipt and lineup conflicts never become reference content', () => {
  const doc = build(cache());
  assert.equal(selectReference(doc, { ...match, awayTeamName: '另一队' }, now), null);
  assert.equal(selectReference(doc, { ...match, kickoffTime: '2026-09-13T01:30:00+08:00' }, now), null);
  assert.equal(selectReference({ ...doc, predictionEligible: true }, match, now), null);
  const c = cache(); c.fixtureSignals[1557406].lineups.home.startXI[1].playerId = 100;
  assert.equal(build(c).items[0].sections.lineup.data, null);
  const future = cache(); for (const p of Object.values(future.fixtureSignals[1557406])) p.observedAt = '2026-09-12T16:31:00.000Z';
  assert.equal(build(future).items.length, 0);
});
test('authenticated reader can show independent reference content while original source is blocked', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-prematch-reference-'));
  t.after(async () => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); });
  const reference = path.join(dir, 'reference.json'); await fs.writeFile(reference, JSON.stringify(build(cache())));
  await fs.writeFile(path.join(dir, 'collection-status.json'), JSON.stringify({ version: 'prematch-scheduler-v1', predictionEligible: false,
    state: 'blocked', enabled: true, checkedAt: new Date(now).toISOString(), sourceAccess: { state: 'blocked', httpStatus: 405 } }));
  const read = createWebsiteReader({ exportPath: path.join(dir, 'missing-leisu-export.json'), apiFootballReferencePath: reference,
    readFixture: async () => match, now: () => now });
  const result = await read(match.id);
  assert.equal(result.status, 'ok'); assert.equal(result.collection.sourceHttpStatus, 405);
  assert.equal(result.provider, 'api-football'); assert.equal(result.predictionEligible, false);
  assert.ok(!/providerFixtureId|https?:|fixtureMap|provenance/.test(JSON.stringify(result)));
});
