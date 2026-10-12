'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRepository, date, cursor, limit, validateIdentity } = require('../services/read-api/repository.cjs');
const { createServer } = require('../services/read-api/server.cjs');
const { createAuthorization, loopbackOrigin } = require('../services/read-api/authorization.cjs');
const { readOnlyPool } = require('../services/read-api/readOnlyPool.cjs');
const { loadFixtures, loadMatch } = require('../apps/web/lib/data.cjs');
const { rolePlan } = require('../services/tasks/roles.cjs');
const { runTask } = require('../services/tasks/run.cjs');
const { plan } = require('../services/release/componentPolicy.cjs');
const NOW = Date.parse('2026-10-12T00:00:00Z'), digest = 'a'.repeat(64);
const metadata = [ ['data_publication_mode', 'active-generation'], ['data_generation_id', 'g-' + digest],
  ['manifest_hash', digest], ['data_generation_source_cycle_id', 'official:committed'], ['committed_at', '2026-10-11T15:00:00Z'] ].map(([key, value]) => ({ key, value }));
const match = { id: 'sporttery_2041866', sourceMatchId: '2041866', matchNo: '周日004', businessDate: '2026-10-11',
  homeTeamName: '主队', awayTeamName: '客队', kickoffTime: '2026-10-12T10:00:00Z', buyEndTime: '2026-10-12T09:00:00Z',
  odds: { odds1: 1.5, oddsX: 3.4, odds2: 4.2 }, oddsUpdatedAt: '2026-10-11T15:01:00Z', privateSecret: 'never-send' };
function pool(rows = [{ id: 'row1', fixture: match }], failure = null) {
  const calls = [], state = { released: false };
  const client = { async query(sql, args) {
    calls.push({ sql, args });
    if (/FROM football.projection_meta/.test(sql)) return { rows: structuredClone(metadata) };
    if (/FROM football.match_snapshots/.test(sql)) { if (failure) throw failure; return { rows }; }
    return { rows: [] };
  }, release(error) { state.released = true; state.releaseError = error; } };
  return { connect: async () => client, calls, state };
}
test('read API uses one read-only committed database snapshot, with no raw pointer dependency or private DTO leakage', async () => {
  const db = pool(), result = await createRepository({ pool: db, now: () => NOW }).fixtures();
  assert.equal(result.publication.generationId, 'g-' + digest);
  assert.equal(result.publication.committedAt, metadata[4].value);
  assert.equal(result.stale, true); assert.equal(result.matches[0].quoteStatus, 'expired');
  assert(!Object.hasOwn(result.matches[0], 'privateSecret')); assert(db.state.released);
  assert.equal(db.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
  assert(!db.calls.some(row => /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(row.sql)));
  assert(!db.calls.some(row => /SELECT payload\s+FROM/.test(row.sql)));
});
test('dedicated pool enforces read-only defaults before account or repository SQL and discards a failed connection', async () => {
  const calls = [], released = [];
  const client = { query: async sql => { calls.push(sql); return { rows: [] }; }, release: error => released.push(error) };
  const wrapped = readOnlyPool({ connect: async () => client, end: async () => {} });
  await wrapped.query('SELECT token_hash FROM football.account_sessions LIMIT 1');
  assert.deepEqual(calls, ['SET default_transaction_read_only=on', 'SELECT token_hash FROM football.account_sessions LIMIT 1']);
  assert.equal(released.length, 1);
  const failed = new Error('read-only setup failed');
  const broken = readOnlyPool({ connect: async () => ({ query: async () => { throw failed; }, release: error => released.push(error) }), end: async () => {} });
  await assert.rejects(broken.connect(), failed); assert.equal(released.at(-1), failed);
});
test('health proves database identity and the actual read-only transaction', async () => {
  for (const readOnly of ['on', 'off']) {
    const db = pool(), originalConnect = db.connect;
    db.connect = async () => {
      const client = await originalConnect(), query = client.query.bind(client);
      return { ...client, query: async (sql, args) => /FROM pg_database/.test(sql)
        ? { rows: [{ oid: '28598409', read_only: readOnly }] } : query(sql, args) };
    };
    const repo = createRepository({ pool: db, now: () => NOW });
    if (readOnly === 'on') assert.deepEqual((await repo.health()).database, { oid: '28598409', transactionReadOnly: true });
    else await assert.rejects(repo.health(), { code: 'READ_ONLY_DATABASE_UNPROVEN' });
    assert(db.state.released);
  }
});
test('pagination is bounded and pinned to the database generation and exact date', async () => {
  const db = pool([{ id: 'one', fixture: match }, { id: 'two', fixture: match }]);
  const repo = createRepository({ pool: db, now: () => NOW });
  const page = await repo.fixtures({ date: '2026-10-11', limit: '1' });
  assert.equal(page.matches.length, 1); assert.equal(cursor(page.nextCursor).id, 'one');
  assert.deepEqual(db.calls.find(row => /FROM football.match_snapshots/.test(row.sql)).args, ['2026-10-11', null, 2]);
  await assert.rejects(repo.fixtures({ date: '2026-10-12', cursor: page.nextCursor }), { code: 'INVALID_CURSOR' });
  const changed = Buffer.from(JSON.stringify({ generation: 'g-' + 'b'.repeat(64), date: null, id: 'one' })).toString('base64url');
  await assert.rejects(repo.fixtures({ cursor: changed }), { code: 'CURSOR_GENERATION_CHANGED' });
});
test('every stored provider fixture link resolves its exact detail without granting a suffix alias', async t => {
  for (const prefix of ['sporttery', 'fivehundred']) {
    const fixture = { ...match, id: prefix + '_2041866' };
    const db = pool();
    const connect = db.connect;
    db.connect = async () => {
      const client = await connect(), query = client.query.bind(client);
      return { ...client, query: async (sql, args) => /WHERE match_id=\$1/.test(sql)
        ? { rows: args[0] === fixture.id ? [{ fixture }] : [] } : query(sql, args) };
    };
    const api = createServer({ repository: createRepository({ pool: db, now: () => NOW }) });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { api.close(resolve); api.closeAllConnections(); }));
    const base = 'http://127.0.0.1:' + api.address().port;
    const detail = await fetch(base + '/api/v2/matches/' + fixture.id);
    assert.equal(detail.status, 200); assert.equal((await detail.json()).match.id, fixture.id);
    const alternate = (prefix === 'sporttery' ? 'fivehundred' : 'sporttery') + '_2041866';
    assert.equal((await fetch(base + '/api/v2/matches/' + alternate)).status, 404);
    const value = await loadMatch(fixture.id, { fetchImpl: async url => fetch(base + new URL(url).pathname) });
    assert.equal(value.match.id, fixture.id);
    const wrongIdentity = { ok: true, storage: 'postgres', match: { ...fixture, id: alternate } };
    assert.equal(await loadMatch(fixture.id, { fetchImpl: async () => new Response(JSON.stringify(wrongIdentity), { headers: { 'content-type': 'application/json' } }) }), null);
  }
  await assert.rejects(createRepository({ pool: pool(), now: () => NOW }).match('fivehundred_2041867'), { code: 'FIXTURE_IDENTITY_MISMATCH' });
});
test('an unavailable projection cannot be replaced with files or an empty success response', async () => {
  const db = pool([], Object.assign(new Error('failed source'), { code: '57014' }));
  await assert.rejects(createRepository({ pool: db, now: () => NOW }).fixtures());
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK'); assert(db.state.released);
});
test('identity mismatch, future clock and malformed query parameters are rejected', () => {
  assert.throws(() => validateIdentity(metadata.map(row => row.key === 'manifest_hash' ? { ...row, value: 'b'.repeat(64) } : row), NOW));
  assert.throws(() => validateIdentity(metadata, NOW - 48 * 3600_000));
  for (const value of ['0', '-1', '101', '1.2', '1 OR true']) assert.throws(() => limit(value));
  for (const value of ['2026-02-30', "2026-01-01'", '2026-13-01']) assert.throws(() => date(value));
  assert.throws(() => cursor('@@')); assert.equal(limit(null), 100);
});
test('HTTP auth precedes private reads; invalid requests and writes never call PostgreSQL', async t => {
  let reads = 0;
  const api = createServer({ repository: { health: async () => ({ ok: true }), fixtures: async () => ({ ok: true, matches: [] }), recommendations: async () => { reads++; return { ok: true }; } } });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { api.close(resolve); api.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + api.address().port;
  assert.equal((await fetch(base + '/api/v2/recommendations')).status, 401); assert.equal(reads, 0);
  assert.equal((await fetch(base + '/api/v2/fixtures?limit=1&limit=2')).status, 400);
  assert.equal((await fetch(base + '/api/v2/fixtures', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/v2/health')).status, 200);
});
test('collector failure has no effect on serving the last committed database row', async t => {
  const db = pool(), repo = createRepository({ pool: db, now: () => NOW });
  const api = createServer({ repository: repo });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { api.close(resolve); api.closeAllConnections(); }));
  const before = await (await fetch('http://127.0.0.1:' + api.address().port + '/api/v2/fixtures')).json();
  const { spawn } = require('node:child_process');
  let exit;
  const ended = new Promise(resolve => { exit = resolve; });
  const task = runTask('market', { env: { FOOTBALL_SERVICE_LAYOUT: 'separated-v1' }, spawnImpl(executable, args, options) {
    assert.equal(options.shell, false); assert(args[0].endsWith('runMarketCollector.cjs'));
    // Real isolated source subprocess fails. No network or production writer
    // is started, and the already-listening API must continue serving.
    const child = spawn(executable, ['-e', 'process.exit(1)'], { stdio: 'ignore', windowsHide: true });
    child.once('exit', exit); return child;
  } });
  assert.equal(await ended, 1); task.stop(); process.exitCode = 0;
  const after = await (await fetch('http://127.0.0.1:' + api.address().port + '/api/v2/fixtures')).json();
  assert.deepEqual(after, before); assert.equal(after.matches.length, 1);
});
test('server-rendered public page keeps only its previously successful public snapshot on API outage', async () => {
  const value = { ok: true, matches: [{ ...match, quoteStatus: 'recent' }], storage: 'postgres', publication: { generationId: 'g-' + digest } };
  const response = () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const at = NOW + 10_000;
  const initial = await loadFixtures({ date: '2026-10-11' }, { fetchImpl: async () => response(), now: () => at });
  const failure = async () => { throw new Error('API down'); };
  const saved = await loadFixtures({ date: '2026-10-11' }, { fetchImpl: failure, now: () => at + 1000 });
  assert.equal(initial.availability, 'available'); assert.equal(saved.availability, 'last-committed-snapshot');
  assert.equal(saved.stale, true); assert.equal(saved.matches[0].quoteStatus, 'expired');
  assert.equal((await loadFixtures({ date: '2026-10-12' }, { fetchImpl: failure, now: () => at + 1000 })).matches.length, 0);
  assert.equal((await loadFixtures({ date: '2026-10-11' }, { fetchImpl: failure, now: () => at + 25 * 3600_000 })).ok, false);
});
test('blocked or malformed account session cannot fall back to a valid shared code', async () => {
  let bridgeCalls = 0;
  const auth = createAuthorization({ pool: { connect: async () => ({}), query: async () => ({ rows: [] }) },
    env: { ACCESS_CODE_SECRET: 'x'.repeat(40), ACCOUNT_PUBLIC_ORIGIN: 'https://example.com' },
    fetchImpl: async () => { bridgeCalls++; return new Response('{"ok":true,"authorized":true}', { headers: { 'content-type': 'application/json' } }); } });
  assert.equal(await auth({ headers: { cookie: '__Host-football_session=invalid' } }), false);
  assert.equal(bridgeCalls, 0);
  assert.equal(await auth({ headers: {} }), true); assert.equal(bridgeCalls, 1);
});
test('a changed generation requires restarting pagination and cannot reuse a cached cursor page', async () => {
  const value = { ok: true, matches: [match], storage: 'postgres', publication: { generationId: 'g-' + digest } };
  const query = { cursor: 'old-cursor-page' };
  await loadFixtures(query, { fetchImpl: async () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }), now: () => NOW });
  const changed = await loadFixtures(query, { fetchImpl: async () => new Response('{"error":"CURSOR_GENERATION_CHANGED"}', { status: 409, headers: { 'content-type': 'application/json' } }), now: () => NOW + 1 });
  assert.equal(changed.availability, 'generation-changed'); assert.equal(changed.ok, false); assert.equal(changed.matches.length, 0);
});
test('auth bridge does not send credentials to arbitrary origins', () => {
  for (const value of ['https://example.com', 'http://user:pw@127.0.0.1:8788', 'http://127.0.0.1:8788/path', 'http://127.0.0.1:8788?x=1']) assert.throws(() => loopbackOrigin(value));
  assert.equal(loopbackOrigin('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
});
test('each independently released component preserves database and frontend ownership', () => {
  for (const component of ['web', 'read-api', 'collector', 'recommendation']) {
    const value = plan(component); assert.equal(value.databaseCopies, 0); assert.equal(value.migrations, false); assert(value.requiresSignedActivation);
    assert.equal(value.frontendRestart, component === 'web');
  }
  assert.equal(rolePlan('official').env.ENABLE_TEAM_EVIDENCE_SYNC, '0');
  assert(rolePlan('recommendation').script.endsWith('dailyFeaturedComboLedger.cjs'));
  assert(rolePlan('team').intervalMs >= 30 * 60_000); assert.throws(() => rolePlan('arbitrary-shell'));
});
