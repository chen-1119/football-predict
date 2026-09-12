'use strict';

// Transaction/contract tests against an in-memory pg-shaped double. No real
// PostgreSQL, environment credentials, network connections or production writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const store = require('./store.cjs');
const clone = value => structuredClone(value);
const at = delta => new Date(Date.now() + delta).toISOString();

class MemoryPool {
  constructor() {
    this.data = { runs: [], observations: [], latest: [] };
    this.calls = []; this.released = 0; this.failLatestWrite = false;
    this.meta = [
      { key: 'sync_meta_updated_at', value: at(-60000), updated_at: at(-60000) },
      { key: 'data_generation_id', value: 'generation-real-shape' },
      { key: 'manifest_hash', value: 'a'.repeat(64) },
    ];
    this.fixtures = [{ payload: { id: 'sporttery_2041418', eventVersion: at(3600000), kickoffTime: at(3600000), homeTeamName: '阿斯顿维拉', awayTeamName: '诺丁汉森林' } }];
  }
  async connect() {
    const pool = this;
    const client = {
      snapshot: null,
      async query(sql, args = []) {
        const query = sql.replace(/\s+/g, ' ').trim();
        pool.calls.push({ sql: query, args: clone(args), via: 'client' });
        if (query.startsWith('BEGIN')) { client.snapshot = clone(pool.data); return { rows: [] }; }
        if (query === 'ROLLBACK') { if (client.snapshot) pool.data = client.snapshot; client.snapshot = null; return { rows: [] }; }
        if (query === 'COMMIT') { client.snapshot = null; return { rows: [] }; }
        return pool.execute(query, args);
      },
      release() { pool.released++; },
    };
    return client;
  }
  async query(sql, args = []) {
    const query = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql: query, args: clone(args), via: 'pool' });
    return this.execute(query, args);
  }
  execute(sql, args) {
    if (sql.includes('CREATE SCHEMA IF NOT EXISTS leisu_prematch')) return { rows: [] };
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('INSERT INTO leisu_prematch.runs')) { this.data.runs.push({ run_id: args[0], started_at: at(0), ended_at: null, status: 'running' }); return { rows: [] }; }
    if (sql.startsWith('UPDATE leisu_prematch.runs')) {
      const run = this.data.runs.find(row => row.run_id === args[0] && row.ended_at === null);
      if (!run) return { rows: [] }; run.ended_at = at(0); run.status = args[1]; return { rows: [clone(run)] };
    }
    if (sql.startsWith('SELECT run_id FROM leisu_prematch.runs')) return { rows: clone(this.data.runs.filter(row => row.run_id === args[0] && row.ended_at === null)) };
    if (sql.startsWith('INSERT INTO leisu_prematch.observations')) {
      const [observation_id, run_id, site_match_id, event_version, provider_match_id, kind, task_key, received_at, source_url, status, payload, content_hash] = args;
      if (this.data.observations.some(row => row.run_id === run_id && row.task_key === task_key && row.kind === kind)) return { rows: [] };
      this.data.observations.push({ observation_id, run_id, site_match_id, event_version, provider_match_id, kind, task_key, received_at, source_url, status, payload: payload === null ? null : JSON.parse(payload), content_hash });
      return { rows: [{ observation_id }] };
    }
    if (sql.startsWith('SELECT observation_id, content_hash')) return { rows: clone(this.data.observations.filter(row => row.run_id === args[0] && row.task_key === args[1] && row.kind === args[2])) };
    if (sql.startsWith('SELECT o.received_at FROM leisu_prematch.latest_valid')) {
      const latest = this.data.latest.find(row => row.site_match_id === args[0] && row.event_version === args[1] && row.kind === args[2]);
      return { rows: latest ? [{ received_at: this.data.observations.find(row => row.observation_id === latest.observation_id).received_at }] : [] };
    }
    if (sql.startsWith('INSERT INTO leisu_prematch.latest_valid')) {
      if (this.failLatestWrite) throw new Error('Injected latest pointer write failure');
      const [site_match_id, event_version, kind, observation_id] = args;
      const found = this.data.latest.find(row => row.site_match_id === site_match_id && row.event_version === event_version && row.kind === kind);
      if (found) found.observation_id = observation_id; else this.data.latest.push({ site_match_id, event_version, kind, observation_id }); return { rows: [] };
    }
    if (sql.includes('FROM unnest($1::text[], $2::text[]) AS requested')) {
      const key = row => JSON.stringify([row.site_match_id, row.event_version]);
      const requested = new Set(args[0].map((site, index) => JSON.stringify([site, args[1][index]])));
      if (sql.startsWith('SELECT o.*')) {
        const latest = this.data.latest.filter(row => requested.has(key(row)));
        return { rows: clone(latest.flatMap(pointer => this.data.observations.filter(row =>
          row.observation_id === pointer.observation_id && key(row) === key(pointer)
          && row.kind === pointer.kind && row.status === 'available'))) };
      }
      if (sql.startsWith('SELECT DISTINCT ON (o.site_match_id, o.event_version, o.kind)')) {
        const seen = new Set();
        const rows = this.data.observations.filter(row => requested.has(key(row))).sort((a, b) =>
          Date.parse(b.received_at) - Date.parse(a.received_at) || b.observation_id.localeCompare(a.observation_id));
        return { rows: clone(rows.filter(row => {
          const identityKind = JSON.stringify([row.site_match_id, row.event_version, row.kind]);
          if (seen.has(identityKind)) return false;
          seen.add(identityKind); return true;
        })) };
      }
    }
    if (sql.startsWith('SELECT o.* FROM leisu_prematch.latest_valid')) {
      const ids = this.data.latest.filter(row => row.site_match_id === args[0] && row.event_version === args[1]).map(row => row.observation_id);
      return { rows: clone(this.data.observations.filter(row => ids.includes(row.observation_id) && row.status === 'available')) };
    }
    if (sql.startsWith('SELECT DISTINCT ON (kind)')) {
      const selected = this.data.observations.filter(row => row.site_match_id === args[0] && row.event_version === args[1]).sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
      return { rows: clone(['injuries', 'lineup'].map(kind => selected.find(row => row.kind === kind)).filter(Boolean)) };
    }
    if (sql.startsWith('SELECT task_key, status, received_at')) return { rows: clone(this.data.observations.filter(row => Date.parse(row.received_at) >= Date.now() - 3 * 86400000).sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))) };
    if (sql.includes('FROM football.projection_meta')) return { rows: clone(this.meta) };
    if (sql.includes('FROM football.match_snapshots')) return { rows: clone(this.fixtures) };
    throw new Error('Unexpected mock query: ' + sql);
  }
}

async function inputFor(pool, kind = 'injuries') {
  const kickoffUtc = at(3600000);
  const fixture = { siteMatchId: 'sporttery_2041418', eventVersion: kickoffUtc, kickoffUtc, homeName: '阿斯顿维拉', awayName: '诺丁汉森林' };
  const data = { providerMatchId: '4558535', homeName: fixture.homeName, awayName: fixture.awayName, kickoffUtc: fixture.kickoffUtc };
  if (kind === 'injuries') data.injuries = [{ side: 'home', name: '测试球员', providerPlayerId: '40056', reasonAsDisplayed: '膝关节受伤', positionAsDisplayed: '未知', returnDateAsDisplayed: '-' }];
  else data.teams = ['home', 'away'].map((side, teamIndex) => ({
    side, name: side === 'home' ? fixture.homeName : fixture.awayName,
    formation: '4-2-3-1', coach: '测试教练',
    starters: Array.from({ length: 11 }, (_, index) => ({ id: String(1000 + teamIndex * 100 + index), jersey: String(index + 1), name: '测试球员' + teamIndex + '-' + index })),
    substitutes: [{ id: String(1090 + teamIndex * 100), jersey: '90', name: '测试替补' + teamIndex }],
  }));
  return { runId: await store.startRun(pool), taskKey: 'test-task', fixture, providerMatchId: '4558535', kind, receivedAt: at(-30000), sourceUrl: `https://live.leisu.com/${kind === 'injuries' ? 'shujufenxi' : 'detail'}-4558535`, status: 'available', data };
}

test('available insert and failure attempts preserve the latest valid payload and receipt time', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  const saved = await store.saveObservation(pool, input);
  assert.equal(saved.latestUpdated, true); assert.equal(saved.predictionEligible, false);
  for (const [index, status] of ['source_empty', 'login_required', 'blocked', 'parse_error', 'conflict'].entries()) {
    const failed = await store.saveObservation(pool, { ...input, taskKey: 'failure-' + status, status, data: null, receivedAt: at(-20000 + index * 1000) });
    assert.equal(failed.latestUpdated, false);
  }
  const result = await store.getEvidence(pool, input.fixture.siteMatchId, input.fixture.eventVersion);
  assert.equal(result.predictionEligible, false);
  assert.equal(result.sections.injuries.latestValid.observationId, saved.observationId);
  assert.equal(result.sections.injuries.latestValid.receivedAt, input.receivedAt);
  assert.equal(result.sections.injuries.latestValid.sourcePublishedAt, null);
  assert.equal(result.sections.injuries.latestAttempt.status, 'conflict');
  assert.equal(result.sections.lineup.latestValid, null);
  assert.equal(pool.data.observations.length, 6);
});

test('duplicate replay is idempotent; conflicting replay rolls back; older receipt does not regress latest', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool); const saved = await store.saveObservation(pool, input);
  const replay = await store.saveObservation(pool, clone(input));
  assert.equal(replay.replayed, true); assert.equal(replay.observationId, saved.observationId); assert.equal(pool.data.observations.length, 1);
  const changed = clone(input); changed.data.injuries[0].reasonAsDisplayed = '另一伤情';
  await assert.rejects(store.saveObservation(pool, changed), /Conflicting replay/);
  assert.equal(pool.data.observations.length, 1);
  const older = await store.saveObservation(pool, { ...input, taskKey: 'older', receivedAt: at(-120000) });
  assert.equal(older.latestUpdated, false); assert.equal(pool.data.observations.length, 2);
  assert.equal(pool.data.latest[0].observation_id, saved.observationId);
});

test('latest pointer failure rolls back the newly inserted observation and releases client', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool); pool.failLatestWrite = true;
  await assert.rejects(store.saveObservation(pool, input), /Injected latest pointer/);
  assert.equal(pool.data.observations.length, 0); assert.equal(pool.data.latest.length, 0); assert.equal(pool.released, 1);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});

test('identity, empty injuries and invalid IDs are rejected before any observation write', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  const cases = [
    x => { x.data.providerMatchId = '4558537'; },
    x => { x.data.homeName = '另一球队'; },
    x => { x.data.kickoffUtc = at(7200000); },
    x => { x.data.injuries = []; },
    x => { x.data.injuries[0].providerPlayerId = 'unknown'; },
    x => { x.data.injuries.push(clone(x.data.injuries[0])); },
    x => { x.status = 'source_empty'; },
  ];
  for (const mutate of cases) { const bad = clone(input); mutate(bad); await assert.rejects(store.saveObservation(pool, bad)); }
  assert.equal(pool.data.observations.length, 0);
});

test('available rejects post-kickoff receipt, late backfill and clock skew; valid lineup enforces both teams and unique IDs', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool, 'lineup');
  const future = clone(input); future.receivedAt = at(6 * 60000);
  await assert.rejects(store.saveObservation(pool, future), /future/);
  const after = clone(input); after.fixture.kickoffUtc = at(60000); after.fixture.eventVersion = after.fixture.kickoffUtc; after.data.kickoffUtc = after.fixture.kickoffUtc; after.receivedAt = at(120000);
  await assert.rejects(store.saveObservation(pool, after), /after kickoff/);
  const backfill = clone(input); backfill.fixture.kickoffUtc = at(-10000); backfill.fixture.eventVersion = backfill.fixture.kickoffUtc; backfill.data.kickoffUtc = backfill.fixture.kickoffUtc;
  await assert.rejects(store.saveObservation(pool, backfill), /after kickoff/);
  const short = clone(input); short.data.teams[0].starters.pop();
  await assert.rejects(store.saveObservation(pool, short), /11 starters/);
  const duplicate = clone(input); duplicate.data.teams[1].substitutes[0].id = duplicate.data.teams[0].starters[0].id;
  await assert.rejects(store.saveObservation(pool, duplicate), /Duplicate player/);
  const wrongTeam = clone(input); wrongTeam.data.teams[1].name = input.fixture.homeName;
  await assert.rejects(store.saveObservation(pool, wrongTeam), /team name conflict/);
  const valid = await store.saveObservation(pool, input); assert.equal(valid.latestUpdated, true);
});

test('event versions stay isolated and finished runs reject further observations', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool); await store.saveObservation(pool, input);
  const otherVersion = await store.getEvidence(pool, input.fixture.siteMatchId, at(7200000));
  assert.equal(otherVersion.sections.injuries.latestValid, null);
  const finish = await store.finishRun(pool, input.runId, 'completed'); assert.equal(finish.status, 'completed');
  await assert.rejects(store.finishRun(pool, input.runId, 'completed'), /already finished/);
  await assert.rejects(store.saveObservation(pool, { ...input, taskKey: 'too-late' }), /active run/);
  assert.equal(pool.data.observations.length, 1);
});

test('attempts cover only recent three days and do not expose payloads', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  await store.saveObservation(pool, input);
  await store.saveObservation(pool, { ...input, taskKey: 'old-failure', receivedAt: at(-4 * 86400000), status: 'blocked', data: null });
  const attempts = await store.getAttempts(pool);
  assert.equal(attempts.length, 1); assert.deepEqual(Object.keys(attempts[0]).sort(), ['receivedAt','status','taskKey']);
});

test('fixture feed uses a single read-only repeatable snapshot and real key/value schema', async () => {
  const pool = new MemoryPool(); pool.fixtures.push({ payload: { id: 'old-incomplete-record' } });
  const result = await store.readFixtureFeed(pool);
  assert.equal(result.generationId, 'generation-real-shape'); assert.equal(result.manifestHash, 'a'.repeat(64)); assert.equal(result.matches.length, 2);
  assert.equal(pool.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(pool.calls[1].sql, /SELECT key, value, updated_at FROM football\.projection_meta/);
  assert.match(pool.calls[2].sql, /WHERE dataset = 'current'/);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT'); assert.equal(pool.calls.every(call => call.via === 'client'), true);
  assert.equal(pool.released, 1);
});

test('stale, future and incomplete publication identities fail closed with rollback', async () => {
  for (const mode of ['stale', 'future', 'identity']) {
    const pool = new MemoryPool();
    if (mode === 'stale') pool.meta[0].value = at(-61 * 60000);
    if (mode === 'future') pool.meta[0].value = at(6 * 60000);
    if (mode === 'identity') pool.meta.pop();
    await assert.rejects(store.readFixtureFeed(pool));
    assert.equal(pool.calls.some(call => call.sql.includes('FROM football.match_snapshots')), false);
    assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.equal(pool.released, 1);
  }
});

test('fixture feed rejects malformed payload shape and migration stays in dedicated schema', async () => {
  const pool = new MemoryPool(); pool.fixtures = [{ payload: [] }];
  await assert.rejects(store.readFixtureFeed(pool), /payload must be an object/);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8').replace(/--[^\n]*/g, '');
  assert.equal(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]*?football\./i.test(schema), false);
  assert.match(schema, /FOREIGN KEY \(observation_id, site_match_id, event_version, kind\)/);
  const migrationPool = new MemoryPool(); await store.migrate(migrationPool);
  assert.equal(migrationPool.calls[0].sql, 'BEGIN'); assert.equal(migrationPool.calls.at(-1).sql, 'COMMIT'); assert.equal(migrationPool.released, 1);
});

test('store independently rejects wrong source URL for both successful and failed observations', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  const wrongUrls = [
    'http://live.leisu.com/shujufenxi-4558535',
    'https://live.leisu.com/shujufenxi-4558535?mode=1',
    'https://live.leisu.com/shujufenxi-4558535#injuries',
    'https://live.leisu.com:443/shujufenxi-4558535',
    'https://live.leisu.com.attacker.invalid/shujufenxi-4558535',
    'https://other.invalid/shujufenxi-4558535',
    'https://live.leisu.com/detail-4558535',
    'https://live.leisu.com/shujufenxi-4558537',
    'https://live.leisu.com/shujufenxi-%344558535',
    'https://name:password@live.leisu.com/shujufenxi-4558535',
  ];
  for (const sourceUrl of wrongUrls) {
    await assert.rejects(store.saveObservation(pool, { ...input, sourceUrl }), /sourceUrl/);
    await assert.rejects(store.saveObservation(pool, { ...input, sourceUrl, status: 'blocked', data: null }), /sourceUrl/);
  }
  const lineup = await inputFor(pool, 'lineup');
  await assert.rejects(store.saveObservation(pool, { ...lineup, sourceUrl: input.sourceUrl }), /sourceUrl/);
  assert.equal(pool.data.observations.length, 0);
});

test('store requires numeric Sporttery identity and timezone-explicit event version equal to kickoff', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  for (const siteMatchId of ['2041418', 'sporttery_unknown', 'leisu_4558535', 'sporttery_2041418 ']) {
    await assert.rejects(store.saveObservation(pool, { ...input, fixture: { ...input.fixture, siteMatchId } }), /siteMatchId/);
  }
  for (const eventVersion of ['kickoff-v1', input.fixture.kickoffUtc.slice(0, -1), at(7200000)]) {
    await assert.rejects(store.saveObservation(pool, { ...input, fixture: { ...input.fixture, eventVersion } }), /eventVersion/);
  }
  const explicitSameInstant = input.fixture.kickoffUtc.replace(/Z$/, '+00:00');
  const saved = await store.saveObservation(pool, { ...input, fixture: { ...input.fixture, eventVersion: explicitSameInstant } });
  assert.equal(saved.latestUpdated, true);
});

test('fixture feed rejects truncated and non-hex manifest identities before reading fixtures', async () => {
  for (const manifest of ['short', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(64) + '\n']) {
    const pool = new MemoryPool(); pool.meta[2].value = manifest;
    await assert.rejects(store.readFixtureFeed(pool), /64-character SHA-256/);
    assert.equal(pool.calls.some(call => call.sql.includes('FROM football.match_snapshots')), false);
    assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  }
});

test('identifier validators reject trailing line breaks at the store boundary', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  await assert.rejects(store.saveObservation(pool, { ...input, runId: input.runId + '\n' }), /runId/);
  await assert.rejects(store.finishRun(pool, input.runId + '\n', 'completed'), /runId/);
  await assert.rejects(store.saveObservation(pool, { ...input, fixture: { ...input.fixture, siteMatchId: input.fixture.siteMatchId + '\n' } }), /siteMatchId/);
  const providerNewline = clone(input); providerNewline.providerMatchId += '\n'; providerNewline.data.providerMatchId += '\n'; providerNewline.sourceUrl += '\n';
  await assert.rejects(store.saveObservation(pool, providerNewline), /providerMatchId/);
  const injuryNewline = clone(input); injuryNewline.data.injuries[0].providerPlayerId += '\n';
  await assert.rejects(store.saveObservation(pool, injuryNewline), /providerPlayerId/);
  const lineupNewline = await inputFor(pool, 'lineup'); lineupNewline.data.teams[0].starters[0].id += '\n';
  await assert.rejects(store.saveObservation(pool, lineupNewline), /player.id/);
  assert.equal(pool.data.observations.length, 0);
});

test('all received, fixture, event and publication timestamps reject impossible calendar dates', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  const impossible = '2030-02-30T14:00:00Z';
  const cases = [
    x => { x.receivedAt = impossible; },
    x => { x.fixture.kickoffUtc = impossible; },
    x => { x.fixture.eventVersion = impossible; },
    x => { x.data.kickoffUtc = impossible; },
    x => { x.data.sourcePublishedAt = impossible; },
  ];
  for (const mutate of cases) { const bad = clone(input); mutate(bad); await assert.rejects(store.saveObservation(pool, bad), /invalid calendar date/); }
  for (const receivedAt of ['2030-02-29T14:00:00Z', '2030-04-31T14:00:00Z', '2030-13-12T14:00:00Z', '2030-09-12T24:00:00Z', '2030-09-12T14:60:00Z', '2030-09-12T14:00:00+24:00', '2030-09-12T14:00:00+08:60', input.receivedAt + '\n', '2030-09-12Z']) {
    await assert.rejects(store.saveObservation(pool, { ...input, receivedAt }), /calendar|timezone|ISO/);
  }
  pool.meta[0].value = impossible;
  await assert.rejects(store.readFixtureFeed(pool), /invalid calendar date/);
  assert.equal(pool.calls.some(call => call.sql.includes('FROM football.match_snapshots')), false);
  assert.equal(pool.data.observations.length, 0);
});

test('pool resource limits are set without changing TLS or creating a database connection', () => {
  const Module = require('node:module'); const originalLoad = Module._load;
  const configs = [];
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'pg') return { Pool: class { constructor(config) { configs.push(config); } } };
      return originalLoad.call(this, request, parent, isMain);
    };
    store.createPool('postgresql://example.invalid/sample');
  } finally { Module._load = originalLoad; }
  assert.deepEqual(configs, [{ connectionString: 'postgresql://example.invalid/sample', max: 2, connectionTimeoutMillis: 10000, query_timeout: 30000 }]);
  assert.equal(Object.hasOwn(configs[0], 'ssl'), false);
});

test('batch evidence uses two SELECTs and one read-only snapshot regardless of batch size', async () => {
  for (const count of [1, 20, 500]) {
    const pool = new MemoryPool(); const eventVersion = at(3600000);
    const fixtures = Array.from({ length: count }, (_, index) => ({ siteMatchId: 'sporttery_' + (index + 1), eventVersion }));
    const result = await store.getEvidenceBatch(pool, fixtures);
    assert.equal(result.length, count);
    assert.equal(pool.calls.filter(call => call.sql.startsWith('SELECT')).length, 2);
    assert.equal(pool.calls.length, 4);
    assert.equal(pool.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(pool.calls.at(-1).sql, 'COMMIT');
    assert.equal(pool.calls.every(call => call.via === 'client'), true);
    assert.equal(pool.released, 1);
    const [latest, attempts] = pool.calls.slice(1, 3);
    assert.match(latest.sql, /l\.site_match_id=requested\.site_match_id AND l\.event_version=requested\.event_version/);
    assert.match(latest.sql, /o\.event_version=l\.event_version AND o\.kind=l\.kind/);
    assert.match(attempts.sql, /DISTINCT ON \(o\.site_match_id, o\.event_version, o\.kind\)/);
    assert.match(attempts.sql, /o\.site_match_id=requested\.site_match_id AND o\.event_version=requested\.event_version/);
    assert.match(attempts.sql, /ORDER BY o\.site_match_id, o\.event_version, o\.kind, o\.received_at DESC, o\.observation_id DESC$/);
    assert.deepEqual(latest.args, [fixtures.map(fixture => fixture.siteMatchId), fixtures.map(fixture => fixture.eventVersion)]);
    assert.deepEqual(attempts.args, latest.args);
    assert.equal(result.every(item => item.predictionEligible === false &&
      Object.values(item.sections).every(section => section.latestValid === null && section.latestAttempt === null)), true);
  }
});

test('batch evidence preserves order, versions, successes and duplicate inputs without cross-pair leakage', async () => {
  const pool = new MemoryPool(); const firstVersion = at(3600000), nextVersion = at(7200000);
  const seed = async (siteMatchId, eventVersion, kind = 'injuries') => {
    const input = await inputFor(pool, kind);
    input.fixture = { ...input.fixture, siteMatchId, eventVersion, kickoffUtc: eventVersion };
    input.data.kickoffUtc = eventVersion;
    const saved = await store.saveObservation(pool, input);
    return { input, saved };
  };
  const first = await seed('sporttery_1', firstVersion);
  await seed('sporttery_1', firstVersion, 'lineup');
  await store.saveObservation(pool, { ...first.input, taskKey: 'newer-failure', status: 'blocked', data: null, receivedAt: at(-10000) });
  await store.saveObservation(pool, { ...first.input, taskKey: 'older-failure', status: 'parse_error', data: null, receivedAt: at(-120000) });
  await seed('sporttery_1', nextVersion);
  await seed('sporttery_2', nextVersion);
  // This unrequested pair shares both a requested site and a requested version.
  // Independent ANY predicates would mistakenly return it.
  await seed('sporttery_2', firstVersion);
  const fixtures = [
    { siteMatchId: 'sporttery_2', eventVersion: nextVersion },
    { siteMatchId: 'sporttery_1', eventVersion: firstVersion },
    { siteMatchId: 'sporttery_1', eventVersion: nextVersion },
    { siteMatchId: 'sporttery_3', eventVersion: firstVersion },
    { siteMatchId: 'sporttery_1', eventVersion: firstVersion },
  ];
  const originalFixtures = clone(fixtures); const expected = [];
  for (const fixture of fixtures) expected.push(await store.getEvidence(pool, fixture.siteMatchId, fixture.eventVersion));
  pool.calls = []; pool.released = 0;
  const result = await store.getEvidenceBatch(pool, fixtures);
  assert.deepEqual(result, expected);
  assert.deepEqual(fixtures, originalFixtures);
  assert.equal(result[1].sections.injuries.latestValid.observationId, first.saved.observationId);
  assert.equal(result[1].sections.injuries.latestAttempt.status, 'blocked');
  assert.equal(result[1].sections.lineup.latestValid.status, 'available');
  assert.equal(result[2].sections.lineup.latestValid, null);
  assert.equal(result[3].sections.injuries.latestAttempt, null);
  assert.equal(pool.calls[1].args[0].length, 4);
  assert.equal(pool.calls.filter(call => call.sql.startsWith('SELECT')).length, 2);
  assert.equal(pool.released, 1);
  assert.notEqual(result[1], result[4]);
  result[1].sections.injuries.latestValid.data.injuries[0].name = 'caller mutation';
  assert.notEqual(result[4].sections.injuries.latestValid.data.injuries[0].name, 'caller mutation');
});

test('batch evidence validates every identity before connecting and accepts an empty batch without a pool', async () => {
  assert.deepEqual(await store.getEvidenceBatch(null, []), []);
  const pool = new MemoryPool(); const eventVersion = at(3600000);
  const valid = { siteMatchId: 'sporttery_1', eventVersion };
  const cases = [
    null, {}, 'fixtures', new Array(1), [null], [[]], [new Date()],
    ...['1', 'sporttery_0', 'sporttery_01', 'sporttery_-1', 'sporttery_1\n', 'sporttery_1 ', 1].map(siteMatchId => [{ ...valid, siteMatchId }]),
    ...['version-1', '2030-02-30T12:00:00Z', '2030-09-12T12:00:00', '2030-09-12T12:00:00+08:60', eventVersion + '\n', new Date(), null].map(value => [{ ...valid, eventVersion: value }]),
    [valid, { ...valid, siteMatchId: 'invalid' }],
    Array.from({ length: 501 }, () => valid), Array.from({ length: 1000 }, () => valid),
  ];
  for (const fixtures of cases) await assert.rejects(store.getEvidenceBatch(pool, fixtures));
  assert.deepEqual(pool.calls, []); assert.equal(pool.released, 0);
});

test('batch evidence keeps valid explicit-offset version identities unchanged', async () => {
  const pool = new MemoryPool(); const input = await inputFor(pool);
  input.fixture.eventVersion = input.fixture.eventVersion.replace('Z', '+00:00');
  const saved = await store.saveObservation(pool, input);
  const [result] = await store.getEvidenceBatch(pool, [input.fixture]);
  assert.equal(result.eventVersion, input.fixture.eventVersion);
  assert.equal(result.sections.injuries.latestValid.observationId, saved.observationId);
});

test('batch read query or decoding failures roll back and always release the client', async () => {
  for (const failure of ['latest', 'attempts', 'bad-row', 'foreign-row']) {
    const pool = new MemoryPool(); const input = await inputFor(pool); await store.saveObservation(pool, input);
    const execute = pool.execute.bind(pool);
    pool.execute = (sql, args) => {
      if (failure === 'latest' && sql.startsWith('SELECT o.* FROM unnest')) throw new Error('Injected latest read failure');
      if (failure === 'attempts' && sql.startsWith('SELECT DISTINCT ON (o.site_match_id')) throw new Error('Injected attempts read failure');
      const result = execute(sql, args);
      if (sql.startsWith('SELECT o.* FROM unnest')) {
        if (failure === 'bad-row') result.rows[0].received_at = 'not-a-date';
        if (failure === 'foreign-row') result.rows[0].event_version = at(7200000);
      }
      return result;
    };
    const before = clone(pool.data); pool.calls = []; pool.released = 0;
    await assert.rejects(store.getEvidenceBatch(pool, [input.fixture]));
    assert.equal(pool.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
    assert.equal(pool.released, 1); assert.deepEqual(pool.data, before);
  }
});
