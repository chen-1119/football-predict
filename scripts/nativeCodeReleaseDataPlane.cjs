'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const policy = require('./releaseDataPlanePolicy.cjs');
const { NativeReleasePostgresPool } = require('./nativeReleasePostgresTransport.cjs');
const LIVE = '/opt/football-predict', STORE = '/var/lib/football-predict';
const pool = (s, name, oid) => new NativeReleasePostgresPool({ database: name, databaseOid: oid, clusterId: s.clusterId });
const driver = () => require('./nativeReleaseDataPlane.cjs');
const WAKE_TRIGGER_DEFINITION_SHA = 'b0a62d41d43b46a2b76a0745b3d1781f8348645b0e5a2d95a18482ebfe6a1e31';
async function restrictKnownWakeTrigger(source, role, directory) {
  const unsafe = (await source.query(`SELECT p.oid::text AS oid,n.nspname,p.proname,pg_get_userbyid(p.proowner) AS owner,
    p.pronargs,p.prorettype::regtype::text AS returns,p.proconfig,p.proacl,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')`, [role])).rows;
  if (!unsafe.length) return;
  // A trigger function is NOT harmless: a reader could attach it to its own
  // TEMP table. Remove PUBLIC EXECUTE only for the exact reviewed notifier;
  // unknown definer functions or changed bodies still fail before mutation.
  assert.equal(unsafe.length, 1, 'unknown callable security-definer functions');
  const f = unsafe[0]; assert.match(f.oid, /^[1-9][0-9]*$/);
  assert.equal(f.nspname, 'football'); assert.equal(f.proname, 'wake_recommendation_workers');
  assert.equal(f.owner, 'football'); assert.equal(f.pronargs, 0); assert.equal(f.returns, 'trigger');
  assert.deepEqual(f.proconfig, ['search_path=pg_catalog']);
  assert.equal(crypto.createHash('sha256').update(f.definition).digest('hex'), WAKE_TRIGGER_DEFINITION_SHA, 'notifier definition drift');
  driver().write(path.join(directory, 'candidate-function-hardening-intent.json'), { role, oid: f.oid,
    function: 'football.wake_recommendation_workers()', definitionSha256: WAKE_TRIGGER_DEFINITION_SHA, previousAcl: f.proacl,
    operation: 'REVOKE EXECUTE FROM PUBLIC', persistentPermissionHardening: true, businessRowsChanged: 0 });
  await source.query('REVOKE EXECUTE ON FUNCTION football.wake_recommendation_workers() FROM PUBLIC');
  const after = (await source.query(`SELECT pg_get_functiondef($1::oid) AS definition,
    has_function_privilege($2,$1::oid,'EXECUTE') AS candidate_execute,
    has_function_privilege('football',$1::oid,'EXECUTE') AS owner_execute`, [f.oid, role])).rows[0];
  assert.equal(after.definition, f.definition); assert.equal(after.candidate_execute, false); assert.equal(after.owner_execute, true);
  driver().write(path.join(directory, 'candidate-function-hardened.json'), { ok: true, oid: f.oid,
    definitionSha256: WAKE_TRIGGER_DEFINITION_SHA, candidateExecute: false, productionOwnerExecute: true,
    persistentPermissionHardening: true, businessRowsChanged: 0 });
}
async function verifySchema(state) {
  const p = pool(state, 'football', state.oldDatabaseOid);
  try {
    await require('../server/postgresStore.cjs').verifyPostgresSchemaCurrent(p);
    const client = await p.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const catalog = await require('./postgresReleaseMirror.cjs').assertMirrorSourceCatalog(client);
      if (state.schemaCatalogHash) assert.equal(catalog.catalogHash, state.schemaCatalogHash, 'code release schema changed since allocation');
      await client.query('ROLLBACK');
      return { ok: true, databaseOid: state.oldDatabaseOid, catalogHash: catalog.catalogHash, databaseWrites: 0 };
    } finally { client.release(); }
  } finally { await p.end(); }
}
async function tryAllocate(sha, directory) {
  const candidateRoot = path.resolve(__dirname, '..');
  const plan = policy.classify(policy.capture(LIVE), policy.capture(candidateRoot));
  if (plan.mode !== 'code-only') return null;
  const d = driver(), oldIdentity = d.readOldRuntimeIdentity();
  assert.equal(oldIdentity.bundleMarker, oldIdentity.liveMarker, 'code release requires completed baseline');
  assert(/^FOOTBALL_STORAGE_MODE=postgres-only\s*$/m.test(fs.readFileSync('/etc/football-predict/env', 'utf8')));
  const before = d.topology();
  const state = { version: 'native-release-preparation-v1', sha, oldSha: oldIdentity.bundleMarker,
    kind: 'runtime-only', dataPlane: 'code-only', compatibility: plan, clusterId: before.clusterId,
    maintenanceOid: before.databases.postgres, oldDatabaseOid: before.databases.football,
    candidateDatabase: 'football', candidateOid: before.databases.football, archiveDatabase: null,
    accessSuffix: sha.slice(0, 12) + '_' + Math.floor(Date.now() / 1000),
    legacyBaselineSha256: null, key: crypto.randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
  state.schemaCatalogHash = (await verifySchema(state)).catalogHash;
  const capacity = require('./nativeReleaseCapacity.cjs').assertNativeReleaseCapacity('code-only');
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 }); d.secureDirectory(path.dirname(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  state.contract = require('./nativeReleaseJournal.cjs').contractFor({ kind: 'runtime-only', oldIdentity,
    topology: before, nativeAlreadyActive: true });
  d.write(path.join(directory, 'capacity-before-allocation.json'), capacity);
  d.write(path.join(directory, 'allocation-intent.json'), state);
  d.write(path.join(directory, 'state.json'), state);
  // Build gets no database connection or serving credential. Prebuilt dist is
  // mandatory; npm ci/prune run with ignored lifecycle scripts in the sandbox.
  fs.writeFileSync(path.join(directory, 'build.env'), 'FOOTBALL_STORAGE_MODE=postgres-only\n', { flag: 'wx', mode: 0o600 });
  return { ok: true, directory, kind: state.kind, dataPlane: state.dataPlane,
    candidateDatabasesCreated: 0, databaseCopies: 0, productionWrites: 0 };
}
function leaseCurrent(session) {
  const context = session.publication?.context, identity = session.identity;
  assert.equal(identity?.mode, 'active-generation');
  for (const key of ['generationId', 'manifestHash', 'sourceCycleId'])
    assert.equal(context?.manifest?.[key], identity[key], 'lease generation identity mismatch');
  const entry = context.manifest.files.find(row => row.path === 'matches-current.json');
  assert(entry && entry.bytes > 0 && entry.bytes <= 32 * 1024 * 1024, 'lease current bound');
  return require('../server/dataGenerationStore.cjs').readGenerationFile(context, 'matches-current.json', { parseJson: true });
}
async function captureLeaseInput(state, directory) {
  assert.equal(state.dataPlane, 'code-only');
  const old = driver().readOldRuntimeIdentity();
  assert.equal(old.bundleMarker, state.oldSha); assert.equal(old.liveMarker, state.oldSha);
  const source = pool(state, 'football', state.oldDatabaseOid); let session;
  try {
    session = await require('./postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({ pool: source,
      storeDir: STORE, publicDataDir: LIVE + '/public/data', protectReceipt: true });
    await session.guardedFinals();
    const current = leaseCurrent(session);
    // The lease and seed must describe the same PostgreSQL-bound immutable
    // generation. The mutable APP projection may have different cutoff clocks.
    driver().write(path.join(directory, 'code-lease-current.json'), current);
    const proof = { sha: state.sha, identity: session.identity,
      currentHash: crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex'), capturedAt: new Date().toISOString() };
    driver().write(path.join(directory, 'code-lease-input.json'), proof);
    return { ok: true, identity: session.identity, productionWrites: 0 };
  } finally { if (session) await session.close(); await source.end(); }
}
async function seed(state, directory) {
  assert.equal(state.dataPlane, 'code-only');
  await verifySchema(state);
  const source = pool(state, 'football', state.oldDatabaseOid); let session;
  try {
    session = await require('./postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({ pool: source,
      storeDir: STORE, publicDataDir: LIVE + '/public/data', protectReceipt: true });
    await session.guardedFinals();
    const leaseInput = driver().read(path.join(directory, 'code-lease-input.json'));
    assert.equal(leaseInput.sha, state.sha);
    require('./codeReleaseAcceptance.cjs').assertSamePublication(leaseInput.identity, session.identity);
    const store = path.join(directory, 'code-seed-store');
    const generation = await driver().copyGenerationAsService(session.identity, store);
    const proof = { ok: true, sha: state.sha, seed: true, dataPlane: 'code-only', store,
      identity: session.identity, generation, backup: null, mirror: null,
      databaseCopies: 0, productionWrites: 0, completedAt: new Date().toISOString() };
    driver().write(path.join(directory, 'seed-accepted.json'), proof); return proof;
  } finally { if (session) await session.close(); await source.end(); }
}
async function candidateAccess(state, directory) {
  assert.equal(state.dataPlane, 'code-only');
  const role = 'football_candidate_' + state.accessSuffix;
  assert.match(role, /^football_candidate_[a-f0-9]{12}_[0-9]{1,10}$/);
  const password = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const admin = pool(state, 'postgres', state.maintenanceOid), source = pool(state, 'football', state.oldDatabaseOid);
  // Commit the cleanup identity BEFORE any role mutation. Failure after a grant
  // still leaves enough information for deterministic retirement.
  driver().write(path.join(directory, 'candidate-access-intent.json'), { role, database: 'football', expiresAt });
  try {
    assert.equal((await admin.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n, 0);
    await admin.query(`SET password_encryption='scram-sha-256'; CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '${password}' VALID UNTIL '${expiresAt}'`);
    await admin.query(`GRANT CONNECT ON DATABASE football TO "${role}"; ALTER ROLE "${role}" SET default_transaction_read_only=on; ALTER ROLE "${role}" SET statement_timeout='120s'`);
    await source.query(`GRANT USAGE ON SCHEMA football TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA football TO "${role}"`);
    // Defense beyond default_transaction_read_only: a caller may SET it off.
    const unsafe = (await source.query(`SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='football' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`, [role])).rows[0].n;
    assert.equal(unsafe, 0, 'candidate acquired production write privileges');
    await restrictKnownWakeTrigger(source, role, directory);
    const funcs = (await source.query(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')`, [role])).rows[0].n;
    assert.equal(funcs, 0, 'candidate can execute custom security-definer function');
    const environmentFile = path.join(directory, 'candidate.env');
    const lines = Object.entries(require('./nativeReleaseJournal.cjs').NATIVE_SELECTORS).map(([k, v]) => k + '=' + v);
    lines.push('FOOTBALL_POSTGRES_URL=postgresql://' + role + ':' + password + '@127.0.0.1:5432/football', 'FOOTBALL_POSTGRES_SSL_MODE=disable');
    fs.writeFileSync(environmentFile, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    const proof = { ok: true, role, database: 'football', environmentFile, readOnly: true, expiresAt, productionWritePrivileges: 0 };
    driver().write(path.join(directory, 'candidate-access.json'), proof); return proof;
  } finally { await source.end(); await admin.end(); }
}
async function retire(state, directory) {
  assert.equal(state.dataPlane, 'code-only'); const file = path.join(directory, 'candidate-access-intent.json');
  if (!fs.existsSync(file)) return { ok: true, roleCreated: false };
  const { role } = driver().read(file); assert.equal(role, 'football_candidate_' + state.accessSuffix);
  const admin = pool(state, 'postgres', state.maintenanceOid), source = pool(state, 'football', state.oldDatabaseOid);
  try {
    assert.equal((await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1', [role])).rows[0].n, 0, 'candidate sessions remain');
    if ((await admin.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1', [role])).rows[0].n) {
      // Never DROP OWNED in the serving database. Unexpected dependencies fail
      // the ordinary DROP ROLE and remain as evidence for recovery.
      await source.query(`REVOKE SELECT ON ALL TABLES IN SCHEMA football FROM "${role}"; REVOKE USAGE ON SCHEMA football FROM "${role}"`);
      await admin.query(`REVOKE CONNECT ON DATABASE football FROM "${role}"; DROP ROLE "${role}"`);
    }
    const proof = { ok: true, role, terminatedConnections: 0, databaseRowsChanged: 0 };
    const receipt = path.join(directory, 'candidate-access-dropped.json');
    if (!fs.existsSync(receipt)) driver().write(receipt, proof);
    return proof;
  } finally { await source.end(); await admin.end(); }
}
function retireSeed(sha) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0); assert.match(sha, /^[a-f0-9]{64}$/);
  const d = driver(), directory = '/var/lib/football-release/native/' + sha;
  const state = d.read(path.join(directory, 'state.json'));
  assert.equal(state.sha, sha); assert.equal(state.dataPlane, 'code-only');
  const live = d.readOldRuntimeIdentity(); assert.equal(live.bundleMarker, sha); assert.equal(live.liveMarker, sha);
  assert.equal(fs.existsSync('/var/lib/football-release/recovery/current'), false, 'recovery still active');
  assert.equal(d.read(path.join(directory, 'candidate-access-dropped.json')).ok, true);
  const proof = d.read(path.join(directory, 'seed-accepted.json')), target = path.join(directory, 'code-seed-store');
  assert.equal(proof.store, target); assert.equal(proof.dataPlane, 'code-only');
  assert.equal(fs.realpathSync(target), target); d.secureDirectory(target);
  const before = fs.lstatSync(target), entries = []; let bytes = 0;
  function visit(file) {
    const s = fs.lstatSync(file); assert(!s.isSymbolicLink() && s.dev === before.dev && s.uid === 0 && !(s.mode & 0o022));
    assert(entries.length < 100000); entries.push([path.relative(target, file), s.ino, s.size, s.mtimeMs]);
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else { assert(s.isFile() && s.nlink === 1); bytes += s.size; }
  }
  visit(target);
  const intent = { sha, target, entries: entries.length, bytes, metadataHash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
  d.write(path.join(directory, 'code-seed-retirement-intent.json'), intent);
  assert.equal(fs.lstatSync(target).ino, before.ino);
  // Root-owned disposable snapshot only. Database, signatures, state, frozen
  // records and recovery evidence are outside this exact directory.
  fs.rmSync(target, { recursive: true });
  d.write(path.join(directory, 'code-seed-retired.json'), { ...intent, removed: true, completedAt: new Date().toISOString() });
  return { ok: true, bytes, removed: true };
}
module.exports = { tryAllocate, verifySchema, seed, candidateAccess, retire, retireSeed, restrictKnownWakeTrigger, leaseCurrent, captureLeaseInput };
if (require.main === module) {
  (async () => {
    assert.equal(process.argv.length, 4); const action = process.argv[2], sha = process.argv[3];
    assert(['retire-seed', 'lease-input'].includes(action)); assert.match(sha, /^[a-f0-9]{64}$/);
    if (action === 'retire-seed') return retireSeed(sha);
    assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
    const directory = '/var/lib/football-release/native/' + sha, state = driver().read(path.join(directory, 'state.json'));
    assert.equal(state.sha, sha); return captureLeaseInput(state, directory);
  })().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
