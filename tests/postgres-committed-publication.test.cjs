'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const store = require('../server/dataGenerationStore.cjs');
const bundles = require('../server/dataGenerationBundle.cjs');

function fixture(run, full = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-committed-publication-'));
  const publicDataDir = path.join(directory, 'public'); fs.mkdirSync(publicDataDir);
  const commit = (cycle, second) => {
    const values = full ? {
      'matches-current.json': [], 'matches-history.json': [],
      'sync-meta.json': { sourceCycleId: cycle, updatedAt: '2030-01-01T00:00:00.000Z' },
      'external-signals.json': { matches: {} }, 'odds-history.json': { rows: [] },
      'prediction-snapshots.json': { rows: [] }, 'model-calibration.json': { version: 'fixture', generatedAt: '2030-01-01T00:00:00.000Z' },
    } : { 'matches-current.json': [{ id: cycle }] };
    return store.commitDataGeneration({ storeDir: directory, sourceCycleId: cycle,
      committedAt: `2030-01-01T00:00:0${second}.000Z`, coreFiles: Object.keys(values),
      files: Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
        { bytes: JSON.stringify(value), rows: Array.isArray(value) ? value.length : 0 }])) });
  };
  const accepted = commit('database-committed', 0);
  const previous = commit('raw-not-projected-1', 1);
  const current = commit('raw-not-projected-2', 2);
  const identity = { mode: 'active-generation', ...accepted.pointer }; delete identity.schemaVersion;
  const options = { storeDir: directory, publicDataDir, postgresIdentity: identity, validatePayloadSemantics: full };
  const resolve = change => bundles.resolveCommittedPostgresPublication({ ...options, ...change });
  const cleanup = () => {
    assert.equal(fs.realpathSync(directory).toLowerCase(), path.resolve(directory).toLowerCase());
    assert(path.basename(directory).startsWith('pg-committed-publication-'));
    fs.rmSync(directory, { recursive: true });
  };
  try {
    const result = run({ directory, publicDataDir, accepted, previous, current, identity, options,
      resolve, paths: store.storePaths(directory) });
    if (result?.then) return result.finally(cleanup);
    cleanup(); return result;
  } catch (error) { cleanup(); throw error; }
}

test('two raw advances cannot displace the exact committed PostgreSQL generation', () => fixture(x => {
  assert.throws(() => bundles.resolveServingPublicationForSqliteIdentity({
    ...x.options, sqliteIdentity: x.identity, allowPrevious: true }), /identity matches neither/);
  const before = [x.paths.currentPointer, x.paths.previousPointer].map(file => fs.readFileSync(file));
  const publication = x.resolve();
  assert.equal(publication.identity.generationId, x.accepted.pointer.generationId);
  assert.equal(publication.identity.committedAt, x.identity.committedAt);
  assert.equal(publication.context.pointerPath, null);
  assert.equal(publication.pairing.clockAuthority, 'postgres-projection-meta');
  assert.deepEqual(bundles.readPublicationJson(publication, 'matches-current.json'), [{ id: 'database-committed' }]);
  assert.deepEqual([x.paths.currentPointer, x.paths.previousPointer].map(file => fs.readFileSync(file)), before);
}));

test('PostgreSQL commit clock is preserved independently of the raw publish clock', () => fixture(x => {
  const clock = '2030-01-01T00:00:00.500Z';
  const publication = x.resolve({ postgresIdentity: { ...x.identity, committedAt: clock } });
  assert.equal(publication.identity.committedAt, clock);
  assert.equal(publication.context.pointer.committedAt, clock);
}));

for (const change of [
  { mode: 'legacy-bootstrap' }, { generationId: '../outside' }, { generationId: 'g-' + '0'.repeat(64) },
  { manifestHash: '0'.repeat(64) }, { sourceCycleId: null }, { sourceCycleId: '' },
  { sourceCycleId: 'x'.repeat(2049) }, { committedAt: null }, { committedAt: 'invalid' },
  { committedAt: '2030-01-01' },
]) test('invalid committed metadata is refused: ' + Object.keys(change)[0] + ':' + String(Object.values(change)[0]).slice(0, 20),
  () => fixture(x => assert.throws(() => x.resolve({ postgresIdentity: { ...x.identity, ...change } }),
    error => error.code === 'POSTGRES_PUBLICATION_IDENTITY_INVALID')));

test('valid-looking but uncommitted manifest or source binding cannot select another generation', () => fixture(x => {
  assert.throws(() => x.resolve({ postgresIdentity: { ...x.identity, sourceCycleId: x.current.pointer.sourceCycleId } }),
    error => error.code === 'SOURCE_CYCLE_MISMATCH');
  assert.throws(() => x.resolve({ postgresIdentity: { ...x.identity,
    generationId: 'g-' + 'a'.repeat(64), manifestHash: 'a'.repeat(64) } }),
    error => error.code === 'POSTGRES_PUBLICATION_GENERATION_UNSAFE');
}));

for (const fault of ['missing', 'payload-tamper', 'manifest-tamper', 'manifest-oversize'])
  test('accepted generation fault remains a hard error: ' + fault, () => fixture(x => {
    const directory = path.join(x.paths.generationsDir, x.identity.generationId);
    if (fault === 'missing') fs.renameSync(directory, directory + '-removed');
    if (fault === 'payload-tamper') fs.appendFileSync(path.join(directory, 'matches-current.json'), ' ');
    if (fault === 'manifest-tamper') {
      const file = path.join(directory, 'manifest.json'), value = JSON.parse(fs.readFileSync(file));
      value.files[0].sha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(value));
    }
    if (fault === 'manifest-oversize') fs.appendFileSync(path.join(directory, 'manifest.json'), ' '.repeat(2 * 1024 * 1024));
    assert.throws(x.resolve);
  }));

test('linked generation directory is refused even with byte-identical payloads', () => fixture(x => {
  const directory = path.join(x.paths.generationsDir, x.identity.generationId), moved = path.join(x.directory, 'outside');
  fs.renameSync(directory, moved); fs.symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(x.resolve, error => error.code === 'POSTGRES_PUBLICATION_GENERATION_UNSAFE'); }
  finally { fs.unlinkSync(directory); }
}));

test('raw pointer damage neither substitutes an uncommitted generation nor hides accepted-file damage', () => fixture(x => {
  fs.writeFileSync(x.paths.currentPointer, '{broken'); fs.unlinkSync(x.paths.previousPointer);
  assert.equal(x.resolve().identity.generationId, x.identity.generationId);
  const file = path.join(x.paths.generationsDir, x.identity.generationId, 'matches-current.json');
  fs.appendFileSync(file, ' '); assert.throws(x.resolve);
}));

test('semantic validation remains the default for model and API readers', () => fixture(x => {
  const { validatePayloadSemantics: _deferred, ...options } = x.options;
  assert.equal(bundles.resolveCommittedPostgresPublication(options).identity.generationId, x.identity.generationId);
  assert.throws(() => x.resolve({ validatePayloadSemantics: 'false' }), /must be boolean/);
}, true));

test('deferring unrelated payload parsing does not disable default semantic rejection', () => fixture(x => {
  assert.equal(x.resolve().identity.generationId, x.identity.generationId);
  const { validatePayloadSemantics: _deferred, ...options } = x.options;
  assert.throws(() => bundles.resolveCommittedPostgresPublication(options));
}));

test('runtime session uses one readonly transaction and protects the retained generation until close', () => fixture(async x => {
  const queries = []; let released = 0;
  const values = { data_publication_mode: x.identity.mode, data_generation_id: x.identity.generationId,
    manifest_hash: x.identity.manifestHash, data_generation_source_cycle_id: x.identity.sourceCycleId,
    committed_at: x.identity.committedAt };
  const pool = { connect: async () => ({ async query(sql) {
    queries.push(sql);
    if (sql.includes('projection_meta')) return { rows: Object.entries(values).map(([key, value]) => ({ key, value })) };
    return { rows: [] };
  }, release() { released++; } }) };
  const session = await require('../scripts/postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({ ...x.options, pool });
  assert.equal(session.identity.generationId, x.identity.generationId);
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(fs.readdirSync(path.join(x.paths.root, 'readers')).length, 1);
  await session.close(); await session.close();
  assert.equal(queries.at(-1), 'ROLLBACK'); assert.equal(released, 1);
  assert.equal(fs.readdirSync(path.join(x.paths.root, 'readers')).length, 0);
  assert(!queries.some(query => /INSERT|UPDATE|DELETE|ALTER|CREATE/.test(query)));
}));

test('ordinary code activation still refuses raw and PostgreSQL divergence', () => fixture(x => {
  const publication = x.resolve();
  assert.throws(() => require('../scripts/nativeCodeReleaseDataPlane.cjs').assertCodeCurrentPublication({
    identity: x.identity, publication }, x.directory));
  assert.equal(fs.existsSync(x.paths.pointerLockDir), false);
}));

test('model reader uses the same accepted identity while every paged table remains readonly', () => fixture(async x => {
  const queries = []; let released = 0;
  const values = { data_publication_mode: x.identity.mode, data_generation_id: x.identity.generationId,
    manifest_hash: x.identity.manifestHash, data_generation_source_cycle_id: x.identity.sourceCycleId,
    committed_at: x.identity.committedAt };
  const pool = { connect: async () => ({ async query(sql) {
    queries.push(sql);
    if (sql.includes('projection_meta')) return { rows: Object.entries(values).map(([key, value]) => ({ key, value })) };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    return { rows: [] };
  }, release() { released++; } }) };
  const input = await require('../scripts/postgresModelInput.cjs').readPostgresModelInput({ ...x.options, pool,
    publicationIdentity: x.identity, prediction_snapshots: { limit: 10 }, odds_snapshots: { limit: 10 },
    createCollector() { return { add() { assert.fail('empty cursor must not invent model input'); }, finish: () => [] }; } });
  assert.equal(input.publication.generationId, x.identity.generationId);
  assert.deepEqual(input.current, []); assert.deepEqual(input.history, []);
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1), 'COMMIT'); assert.equal(released, 1);
  assert(!queries.some(query => /INSERT|UPDATE|DELETE|ALTER|CREATE/.test(query)));
  assert.equal(fs.readdirSync(path.join(x.paths.root, 'readers')).length, 0);
}, true));

test('normal raw publication cleanup protects the accepted PG generation beyond four raw generations', () => fixture(async x => {
  for (let i = 3; i <= 6; i++) store.commitDataGeneration({ storeDir: x.directory, sourceCycleId: 'pending-' + i,
    committedAt: `2030-01-01T00:00:0${i}.000Z`, files: { 'matches-current.json': { bytes: '[]', rows: 0 } },
    coreFiles: ['matches-current.json'] });
  fs.utimesSync(x.accepted.context.generationDir, new Date('2020-01-01'), new Date('2020-01-01'));
  const queries = [], values = { data_publication_mode: x.identity.mode, data_generation_id: x.identity.generationId,
    manifest_hash: x.identity.manifestHash, data_generation_source_cycle_id: x.identity.sourceCycleId,
    committed_at: x.identity.committedAt };
  const pool = { connect: async () => ({ async query(sql) {
    queries.push(sql);
    if (sql.includes('pg_try_advisory_lock_shared')) return { rows: [{ acquired: true }] };
    if (sql.includes('projection_meta')) return { rows: Object.entries(values).map(([key, value]) => ({ key, value })) };
    return { rows: [] };
  }, release() {} }) };
  const env = { FOOTBALL_STORAGE_MODE: 'postgres-only', FOOTBALL_POSTGRES_MODE: 'primary',
    DATASTORE_READ_SOURCE: 'postgres', CURRENT_MATCH_SOURCE: 'postgres', ENABLE_SQLITE_EXPORT: '0',
    PRIVATE_MODEL_ARTIFACT_STORAGE: 'postgres', POSTGRES_PROJECTION_SOURCE: 'native-generation',
    FOOTBALL_POSTGRES_URL: 'postgres://fixture.invalid/football' };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const result = await require('../scripts/commitCurrentDataGeneration.cjs').cleanupCommittedDataGenerations({
      storeDir: x.directory, publicDataDir: x.publicDataDir, retainCount: 4, graceMs: 0 }, { pool });
    assert(result.deleted.length > 0);
    assert(!result.deleted.includes(x.identity.generationId));
    assert.equal(x.resolve().identity.generationId, x.identity.generationId);
    assert.equal(queries[0].startsWith('SELECT pg_try_advisory_lock_shared'), true);
    assert.equal(queries.at(-1).startsWith('SELECT pg_advisory_unlock_shared'), true);
    assert(!queries.some(query => /INSERT|UPDATE|DELETE|ALTER|CREATE/.test(query)));
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}));
