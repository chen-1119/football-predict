'use strict';
// Normal code-only cutover admission. Worker convergence remains a separate,
// unchanged observation; only the persisted signed repair pair can differ.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { assertSamePublication: same } = require('./codeReleaseAcceptance.cjs');
const { assessServingRepair, verifyCommittedArchives, withBoundPointerPair } = require('./committedGenerationRecoveryServingCore.cjs');
const APP = '/opt/football-predict', STORE = '/var/lib/football-predict';

function assertNormalState(state, transaction, sha, marker, finalized, seed, input) {
  assert.match(sha, /^[a-f0-9]{64}$/);
  assert.equal(state.version, 'native-release-preparation-v1');
  assert.equal(state.sha, sha); assert.equal(marker, sha);
  assert.equal(state.kind, 'runtime-only'); assert.equal(state.dataPlane, 'code-only');
  assert.equal(state.candidateDatabase, 'football'); assert.equal(state.candidateOid, state.oldDatabaseOid);
  assert.match(state.oldSha, /^[a-f0-9]{64}$/); assert.match(state.key, /^[a-f0-9]{64}$/);
  assert.equal(state.coldRecoveryAuthorizationId, undefined, 'cold recovery is not a normal cutover');
  assert.equal(transaction?.bundleSha, sha); assert.equal(transaction.phase, 'swap-complete');
  assert.ok(transaction.newIdentity); assert.deepEqual(transaction.native?.contract, state.contract);
  assert.ok(state.contract); assert.match(state.schemaCatalogHash, /^[a-f0-9]{64}$/);
  assert.equal(finalized.ok, true); assert.equal(finalized.sha, sha);
  assert.equal(finalized.kind, 'runtime-only'); assert.equal(finalized.databaseOid, state.oldDatabaseOid);
  assert.equal(finalized.databaseWrites, 0); assert.equal(finalized.databaseRenames, 0);
  assert.equal(seed.ok, true); assert.equal(seed.sha, sha); assert.equal(seed.dataPlane, 'code-only');
  assert.equal(seed.databaseCopies, 0); assert.equal(input.sha, sha);
  same(seed.identity, finalized.publication); same(input.identity, finalized.publication);
}

function assessServing({ healthReport, identity, pair, workerObservation }) {
  assert.equal(healthReport.ok, true, 'native serving health rejected');
  same(healthReport.storage.publication, identity);
  if (pair) return assessServingRepair({ healthReport,
    healthPublication: healthReport.storage.publication, identity, pair, workerObservation });
  assert.equal(workerObservation.ready, true, 'ordinary code release requires worker publication affinity');
  assert.deepEqual(workerObservation.blockers, []);
  same(workerObservation.postgres, identity); same(workerObservation.generation, identity);
  return { ok: true, originalWorkerReadiness: true, originalWorkerBlockers: [],
    naturalCycleAcceptance: false, newSourceFreshnessAccepted: false, productionDataWrites: 0 };
}

// Dependency injection is confined to this testable orchestration function.
// The CLI below supplies only fixed local production readers.
async function verifyServingSession(ops) {
  let session;
  try {
    ops.assertPersistent(); ops.verifyClock();
    const before = await ops.health();
    const workerObservation = await ops.worker();
    session = await ops.openSession();
    await session.guardedFinals();
    const transaction = (await session.client.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0];
    assert.equal(transaction.readonly, 'on'); assert.equal(transaction.isolation, 'repeatable read');
    same(ops.finalized.publication, session.identity);
    const checkPair = ops.bindPair(session), pair = checkPair();
    const result = assessServing({ healthReport: before, identity: session.identity, pair, workerObservation });
    // All 601 original archive contracts execute against the same retained
    // committed generation and protected PostgreSQL snapshot as serving health.
    const archives = await ops.archives(session);
    assert.equal(archives.ok, true, 'committed archive verification rejected');
    const after = await ops.health(); assert.equal(after.ok, true);
    same(after.storage.publication, session.identity);
    await session.guardedFinals();
    assert.deepEqual(checkPair(), pair, 'publication pair changed during serving verification');
    ops.assertPersistent(); ops.verifyClock();
    return { ...result, verifier: 'normal-code-serving-v1', checkedAt: new Date().toISOString(),
      storage: after.storage, projectionCounts: after.projectionCounts, archives,
      signedPair: pair, originalWorkerObservation: workerObservation, readonlyTransaction: transaction,
      recommendationAdoptionAccepted: false };
  } finally { await session?.close(); }
}

async function verify(sha) {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(process.version, 'v22.22.1'); assert.match(sha || '', /^[a-f0-9]{64}$/);
  assert.equal(path.resolve(__dirname, '..'), APP, 'normal gate must run from installed candidate');
  const driver = require('./nativeReleaseDataPlane.cjs');
  const code = require('./nativeCodeReleaseDataPlane.cjs');
  const recovery = require('../deploy/light-server/football-release-recovery.cjs');
  const directory = '/var/lib/football-release/native/' + sha;
  const state = driver.read(path.join(directory, 'state.json'));
  const finalized = driver.read(path.join(directory, 'data-finalized.json'));
  const seed = driver.read(path.join(directory, 'seed-accepted.json'));
  const input = driver.read(path.join(directory, 'code-lease-input.json'));
  const assertPersistent = () => {
    assert.deepEqual(driver.read(path.join(directory, 'state.json')), state);
    assert.deepEqual(driver.read(path.join(directory, 'data-finalized.json')), finalized);
    assert.deepEqual(driver.read(path.join(directory, 'seed-accepted.json')), seed);
    assert.deepEqual(driver.read(path.join(directory, 'code-lease-input.json')), input);
    assertNormalState(state, recovery.loadTransaction(), sha,
      fs.readFileSync(APP + '/.release-bundle-sha256', 'utf8').trim(), finalized, seed, input);
    const unit = cp.execFileSync('/usr/bin/systemctl', ['show', 'football-sync-worker.service', '--property=MainPID,ActiveState', '--no-pager'],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
    assert(/^MainPID=0$/m.test(unit) && /^ActiveState=(inactive|failed)$/m.test(unit), 'normal worker must remain stopped');
  };
  assertPersistent();
  code.verifyCodeCutoverCompletionClock(state, directory);
  await code.verifySchema(state);
  const { NativeReleasePostgresPool } = require('./nativeReleasePostgresTransport.cjs');
  const pool = new NativeReleasePostgresPool({ database: 'football', databaseOid: state.oldDatabaseOid, clusterId: state.clusterId });
  const generations = require('../server/dataGenerationStore.cjs');
  try {
    return await verifyServingSession({ finalized, assertPersistent,
      verifyClock: () => code.verifyCodeCutoverCompletionClock(state, directory),
      health: async () => {
        const response = await fetch('http://127.0.0.1:8788/api/v1/health', { signal: AbortSignal.timeout(15000) });
        assert.equal(response.status, 200);
        const health = await response.json(), core = require('./verifyNativeDeploymentCore.cjs');
        core.requireHealth(health); return core.assessHealth(health);
      },
      worker: () => require('./postgresWorkerObservation.cjs').readPostgresWorkerObservation({
        pool, storeDir: STORE, publicDataDir: APP + '/public/data', validationStep: { ok: true },
        generationStep: { ok: true }, projectionStep: { ok: true } }),
      openSession: () => require('./postgresRuntimeReadSession.cjs').openPostgresRuntimeReadSession({
        pool, storeDir: STORE, publicDataDir: APP + '/public/data', protectReceipt: true }),
      bindPair: session => {
        if (!state.committedGenerationRepairAuthorizationHash) {
          return () => { code.assertCodeCurrentPublication(session, STORE); return null; };
        }
        const file = APP + '/deploy/light-server/worker-code-repair-authorization.json';
        const bytes = fs.readFileSync(file), authorizationHash = crypto.createHash('sha256').update(bytes).digest('hex');
        const authorization = require('./releaseWorkerCodeRepair.cjs').candidateAuthorization(APP, JSON.parse(bytes));
        assert.equal(authorizationHash, state.committedGenerationRepairAuthorizationHash);
        const capture = authorization.version === 'worker-code-repair-v6'
          ? code.readFreshRepairCapture(state, authorization, authorizationHash) : null;
        // Validate immutable bytes before taking the short global pointer lock.
        const current = generations.resolveCurrentGeneration({ storeDir: STORE });
        const previous = generations.resolvePreviousGeneration({ storeDir: STORE });
        return () => {
          assert.deepEqual(fs.readFileSync(file), bytes, 'repair authorization changed');
          if (capture) assert.deepEqual(code.readFreshRepairCapture(state, authorization, authorizationHash), capture);
          return withBoundPointerPair(generations, STORE, current, previous,
            () => code.assertRepairPair(state, session, current, previous, authorization, authorizationHash, capture));
        };
      },
      archives: session => verifyCommittedArchives({ session, generations,
        archive: require('./verifyReleaseArchiveSuccessor.cjs'), releaseSha: sha }),
    });
  } finally { await pool.end(); }
}
module.exports = { assertNormalState, assessServing, verifyServingSession, verify };
if (require.main === module) {
  assert.equal(process.argv.length, 3);
  verify(process.argv[2]).then(report => console.log(JSON.stringify(report))).catch(error => {
    console.error(JSON.stringify({ ok: false, verifier: 'normal-code-serving-v1', error: String(error.message).slice(0,500), productionDataWrites: 0 }));
    process.exitCode = 1;
  });
}
