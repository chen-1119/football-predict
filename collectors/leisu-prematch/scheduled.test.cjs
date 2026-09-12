'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { tick, STRATEGY } = require('./scheduled.cjs');
const { readCollectionStatus } = require('./website-reader.cjs');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prematch-scheduled-'));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  let clock = Date.parse('2026-09-12T04:00:00Z'), pages = 0, collections = 0;
  const writes = [], env = { LEISU_ENABLED: '1', LEISU_STATE_DIR: dir, LEISU_PUBLIC_DIR: path.join(dir, 'public'),
    LEISU_DATABASE_URL: 'postgresql://test', LEISU_FIXTURE_DATABASE_URL: 'postgresql://test',
    LEISU_LEAGUE_URLS_JSON: '["https://www.leisu.com/data/zuqiu/comp-82"]' };
  const dependencies = { now: () => clock,
    createPool: () => ({ query: async (sql, values) => { writes.push(values); return { rows: [] }; }, end: async () => {} }),
    readFeed: async () => { throw Error('Fixture feed is stale'); },
    openBrowser: async () => ({ close: async () => {} }),
    collectLeague: async () => { pages++; return { status: 'blocked', httpStatus: 405 }; },
    collect: async () => { collections++; return { status: 'completed', results: [] }; } };
  return { dir, env, dependencies, writes, pages: () => pages, collections: () => collections, advance: ms => { clock += ms; } };
}
test('the deployed strategy contains both days and every configured lineup check', () => {
  assert.equal(STRATEGY.days, 2); assert.equal(STRATEGY.checkMinutes, 5); assert.equal(STRATEGY.injuriesEveryHours, 6);
  assert.deepEqual(STRATEGY.lineupMinutesBeforeKickoff, [90, 60, 30, 20, 10]); assert.equal(STRATEGY.automaticOdds, false);
});
test('a real source failure is recorded once and the timer does not hammer it every five minutes', async t => {
  const s = setup(t), first = await tick(s.env, s.dependencies);
  assert.equal(first.state, 'blocked'); assert.equal(first.fixtureInput.state, 'stale'); assert.equal(s.writes.length, 1);
  assert.equal(first.predictionEligible, false); assert.equal(s.collections(), 0);
  s.advance(5 * 60000); await tick(s.env, s.dependencies);
  assert.equal(s.pages(), 1); assert.equal(s.writes.length, 1);
  s.advance(6 * 3600000); await tick(s.env, s.dependencies); assert.equal(s.pages(), 2);
});
test('an empty valid fixture window opens no browser', async t => {
  const s = setup(t); s.dependencies.readFeed = async () => ({ matches: [], generatedAt: '2026-09-12T04:00:00Z' });
  const result = await tick(s.env, s.dependencies); assert.equal(result.state, 'no-due-tasks'); assert.equal(s.pages(), 0);
  assert.equal(s.writes.length, 1);
});

test('provider backoff still refreshes fixture input without inventing a source attempt', async t => {
  const s = setup(t), first = await tick(s.env, s.dependencies);
  s.advance(5 * 60000);
  s.dependencies.readFeed = async () => ({ matches: [], generatedAt: '2026-09-12T04:04:00Z' });
  const refreshed = await tick(s.env, s.dependencies);
  assert.equal(refreshed.fixtureInput.state, 'available');
  assert.equal(refreshed.fixtureInput.generatedAt, '2026-09-12T04:04:00Z');
  assert.equal(refreshed.state, 'blocked'); assert.equal(refreshed.sourceAccess.httpStatus, 405);
  assert.equal(refreshed.lastRunAt, first.lastRunAt); assert.equal(refreshed.nextAttemptAt, first.nextAttemptAt);
  assert.equal(refreshed.lastSuccessAt, null); assert.equal(s.pages(), 1); assert.equal(s.writes.length, 1);
  s.dependencies.readFeed = async () => { throw Error('connection refused'); };
  const failed = await tick(s.env, s.dependencies);
  assert.equal(failed.fixtureInput.state, 'unavailable'); assert.equal(s.pages(), 1);
  assert.equal(fs.existsSync(path.join(s.dir, 'scheduled.lock')), false);
});
test('stale fixture input never reaches collection even if browser access works', async t => {
  const s = setup(t); s.dependencies.collectLeague = async () => ({ status: 'available', httpStatus: 200 });
  const result = await tick(s.env, s.dependencies); assert.equal(result.state, 'fixture-stale'); assert.equal(s.collections(), 0);
});
test('status publication removes internal fields and rejects oversized records', async t => {
  const s = setup(t); await tick(s.env, s.dependencies);
  const file = path.join(s.env.LEISU_PUBLIC_DIR, 'collection-status.json');
  const data = JSON.parse(fs.readFileSync(file)); data.sourceUrl = 'https://private.example'; data.databaseUrl = 'postgresql://private';
  fs.writeFileSync(file, JSON.stringify(data)); const result = await readCollectionStatus(file, s.dependencies.now());
  assert.equal(result.enabled, true); assert.equal(result.sourceHttpStatus, 405); assert.equal(result.fixtureState, 'stale');
  assert.ok(!/https:|postgresql:/.test(JSON.stringify(result)));
  fs.writeFileSync(file, ' '.repeat(17000)); assert.equal(await readCollectionStatus(file, s.dependencies.now()), null);
});
test('source failure retains the last successful evidence file', async t => {
  const s = setup(t); fs.mkdirSync(s.env.LEISU_PUBLIC_DIR);
  const file = path.join(s.env.LEISU_PUBLIC_DIR, 'latest-evidence.json'); fs.writeFileSync(file, '{"previous":"retained"}');
  await tick(s.env, s.dependencies); assert.equal(fs.readFileSync(file, 'utf8'), '{"previous":"retained"}');
});
