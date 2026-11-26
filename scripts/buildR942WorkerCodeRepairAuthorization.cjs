'use strict';
// Offline / read-only builder for worker-code-repair-v12 on installed r942.
// Never connects over SSH, modifies worker state, or relaxes release gates.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repair = require('./releaseWorkerCodeRepair.cjs');
const dataPlanePolicy = require('./releaseDataPlanePolicy.cjs');
const { collectWorkerPreflight, evaluateWorkerPreflight } = require('./releaseWorkerPreflight.cjs');

const R942_BASELINE_TARGET_HASHES = Object.freeze({
  'scripts/syncData.cjs': '374b96721793b3f9b69133ed76852ffb16729c708303dfbe147dbdd26c20bfb0',
  'scripts/verifyMatchLifecycleReconciliation.cjs': '8b47f5bec4075b9234ffcc4676aa3887d34806e1cfcab1d9f065b7a45e8bda9a',
  'scripts/releaseWorkerCodeRepair.cjs': '05a4caa82d196ef139c1ba71877f007630741115c971498fe905e80804f092ce',
  'scripts/nativeCodeReleaseDataPlane.cjs': '612225f2579e776e079642c2162135bdc7a666f4302ac0b407a53effb0df548b',
  'scripts/runReleaseWorkerPreflight.cjs': '173084cb4495b3610cc942b06cbe2b595456dbeec4019c97845349403d033fe7',
  'scripts/deployReleaseBundle.cjs': 'd1559188f1d243b113311fe88201185221222c4f59a7bc6d8dc57a0c0ac1361e',
  'scripts/createReleaseBundle.cjs': 'fe9d878770d0ee22186f4225815757d9a0fd1e14c24539ffbdc805138a847472',
  'scripts/verifyReleaseBundleSafety.cjs': 'c989c5af66fb3d1d488a55f9b00c7cd321ff9e3ecf8ab449c0161b1fb5c1fa92',
  'scripts/verifyReleaseVerifierContracts.cjs': 'd73a08a2181163a8e7f26a9fd4cb3ef5585ab256bc3e93b56f6363bae55343d9',
});

const sha256File = (filePath) => crypto
  .createHash('sha256')
  .update(fs.readFileSync(filePath))
  .digest('hex');

function collectLiveR942IncidentObservation() {
  const fs = require('node:fs');
  const assert = require('node:assert/strict');
  const cp = require('node:child_process');
  const crypto = require('node:crypto');
  const root = '/opt/football-predict';
  assert.equal(fs.realpathSync(root), root);
  const bundleMarker = fs.readFileSync(root + '/.release-bundle-sha256', 'utf8').trim();
  const liveMarker = fs.readFileSync(root + '/.release-live-complete', 'utf8').trim();
  assert.equal(bundleMarker, R942_BASE_RUNTIME_SHA256);
  assert.equal(liveMarker, R942_BASE_RUNTIME_SHA256);

  const worker = collectWorkerPreflight();
  const preflight = evaluateWorkerPreflight(worker);
  if (preflight.ok) {
    return {
      version: 'r942-result-identity-incident-observation-v1',
      workerHealthy: true,
      preflight,
      publication: null,
      incident: null,
      productionWrites: 0,
    };
  }
  const keys = ['data_publication_mode', 'data_generation_id', 'manifest_hash', 'data_generation_source_cycle_id', 'committed_at'];
  const sql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='2s'; SELECT json_build_object('databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'readOnly',current_setting('transaction_read_only'),'meta',(SELECT json_object_agg(key,value) FROM football.projection_meta WHERE key IN ('data_publication_mode','data_generation_id','manifest_hash','data_generation_source_cycle_id','committed_at'))); ROLLBACK;";
  const pgOut = cp.execFileSync('/usr/sbin/runuser', ['-u', 'postgres', '--', '/usr/bin/psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', 'football', '-c', sql], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16384,
    env: { PATH: '/usr/bin:/bin', PGHOST: '/var/run/postgresql', PGUSER: 'postgres', PGCONNECT_TIMEOUT: '5' },
  });
  const pg = JSON.parse(pgOut.trim());
  assert.equal(pg.readOnly, 'on');
  const committed = Object.fromEntries(['mode', 'generationId', 'manifestHash', 'sourceCycleId', 'committedAt'].map((k, i) => [k, pg.meta[keys[i]]]));
  const readPointer = (name) => {
    const file = '/var/lib/football-predict/data-generations/' + name + '.json';
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(row.schemaVersion, 1);
    return {
      mode: 'active-generation',
      generationId: row.generationId,
      manifestHash: row.manifestHash,
      sourceCycleId: row.sourceCycleId,
      committedAt: row.committedAt,
    };
  };
  const publication = repair.validateRepairPublication({
    databaseOid: pg.databaseOid,
    committed,
    rawCurrent: readPointer('current'),
    rawPrevious: readPointer('previous'),
  }, true);

  const cycle = worker.status.lastCycle;
  assert.equal(cycle?.ok, false);
  assert.equal(cycle?.phase, 'official-result-failed');
  assert.equal(cycle?.errorCode, 'SYNC_WORKER_COMMAND_FAILED');
  assert.equal(cycle?.error, 'npm run postgres:sync exited with 1');

  const codeLine = '  "code": "POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE",';
  const located = cp.execFileSync('/usr/bin/journalctl', [
    '--unit=football-sync-worker.service',
    '--since=' + cycle.startedAt,
    '--until=' + cycle.finishedAt,
    '--grep=^' + codeLine + '$',
    '--lines=64',
    '--output=json',
    '--no-pager',
  ], { encoding: 'utf8', timeout: 8000, maxBuffer: 128 * 1024 });
  const locRows = located.trim() ? located.trim().split('\n').map((l) => JSON.parse(l)) : [];
  assert.equal(locRows.length, 1, 'expected one POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE journal locator');
  const tsUs = locRows[0].__REALTIME_TIMESTAMP;
  const epoch = (us) => '@' + (us / 1000000n).toString() + '.' + (us % 1000000n).toString().padStart(6, '0');
  const frameOut = cp.execFileSync('/usr/bin/journalctl', [
    '--unit=football-sync-worker.service',
    '--since=' + epoch(BigInt(tsUs)),
    '--until=' + epoch(BigInt(tsUs) + 1n),
    '--lines=64',
    '--output=json',
    '--no-pager',
  ], { encoding: 'utf8', timeout: 8000, maxBuffer: 128 * 1024 });
  const journal = frameOut.trim().split('\n').map((line) => {
    const r = JSON.parse(line);
    return {
      unit: r._SYSTEMD_UNIT,
      pid: r._PID,
      message: r.MESSAGE,
      timestampUs: r.__REALTIME_TIMESTAMP,
      timestampMs: Number(r.__REALTIME_TIMESTAMP) / 1000,
    };
  }).filter((r) => r.timestampUs === tsUs);
  assert.equal(journal.length, 24, 'expected 24-line result identity failure frame');
  const rawMessage = journal.map((r) => r.message).join('\n');
  const failure = JSON.parse(rawMessage);
  const incident = repair.validateResultIdentityIncident({
    workerMainPid: String(worker.serviceAfter.MainPID),
    workerStartedAt: new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),
    cycleStartedAt: cycle.startedAt,
    cycleFinishedAt: cycle.finishedAt,
    journalPid: journal[0].pid,
    journalTimestampUs: tsUs,
    journalMessageSha256: crypto.createHash('sha256').update(rawMessage).digest('hex'),
    failure,
  });
  repair.assertResultIdentityJournal(incident, journal);
  return {
    version: 'r942-result-identity-incident-observation-v1',
    observedAt: worker.checkedAt,
    workerHealthy: false,
    preflight,
    publication,
    incident,
    productionWrites: 0,
  };
}

function buildR942ObservationProbe() {
  return "'use strict';\n"
    + 'const R942_BASE_RUNTIME_SHA256=' + JSON.stringify(repair.R942_BASE_RUNTIME_SHA256) + ';\n'
    + 'const repair={validateRepairPublication:' + repair.validateRepairPublication.toString()
    + ',validateResultIdentityIncident:' + repair.validateResultIdentityIncident.toString()
    + ',assertResultIdentityJournal:' + repair.assertResultIdentityJournal.toString() + '};\n'
    + [
      collectWorkerPreflight,
      evaluateWorkerPreflight,
      collectLiveR942IncidentObservation,
    ].map((fn) => fn.toString()).join('\n')
    + '\nconsole.log(JSON.stringify(collectLiveR942IncidentObservation()));\n';
}

function mintR942WorkerCodeRepairAuthorization({
  candidateRoot,
  observation,
  baselineHashes = R942_BASELINE_TARGET_HASHES,
  createdAt = new Date().toISOString(),
  ttlSeconds = 5400,
} = {}) {
  assert(candidateRoot && fs.statSync(candidateRoot).isDirectory(), 'candidateRoot directory required');
  assert(observation?.version === 'r942-result-identity-incident-observation-v1', 'valid r942 observation required');
  assert.equal(observation.workerHealthy, false, 'worker is already healthy; use ordinary release without repair authorization');
  assert(Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 7200, 'ttlSeconds must be within 60..7200');
  const createdMs = Date.parse(createdAt);
  assert(Number.isFinite(createdMs), 'invalid createdAt');
  const expiresAt = new Date(createdMs + ttlSeconds * 1000).toISOString();

  const files = repair.R942_RESULT_IDENTITY_TARGETS.map((relPath) => {
    const beforeSha256 = baselineHashes[relPath];
    assert.match(beforeSha256 || '', /^[a-f0-9]{64}$/, `missing r942 baseline sha256 for ${relPath}`);
    const afterSha256 = sha256File(path.join(candidateRoot, relPath));
    assert.notEqual(beforeSha256, afterSha256, `candidate target unchanged from r942 baseline: ${relPath}`);
    return { path: relPath, beforeSha256, afterSha256 };
  });
  const addedSources = repair.R942_RESULT_IDENTITY_ADDED.map((relPath) => ({
    path: relPath,
    sha256: sha256File(path.join(candidateRoot, relPath)),
  }));
  const unchangedSources = repair.R942_RESULT_IDENTITY_UNCHANGED.map((relPath) => ({
    path: relPath,
    sha256: sha256File(path.join(candidateRoot, relPath)),
  }));
  const contract = dataPlanePolicy.capture(candidateRoot);
  const auth = {
    version: 'worker-code-repair-v12',
    reason: 'official-result-post-cutoff-gate-identity-regression',
    bindingPolicy: repair.R942_BINDING_POLICY,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt,
    baseRuntimeSha256: repair.R942_BASE_RUNTIME_SHA256,
    files,
    addedSources,
    unchangedSources,
    dataContract: contract.entries,
    publication: observation.publication,
    incident: observation.incident,
  };
  repair.validateWorkerCodeRepairAuthorization(auth, createdMs);
  repair.candidateAuthorization(candidateRoot, auth);
  return auth;
}

module.exports = {
  R942_BASELINE_TARGET_HASHES,
  collectLiveR942IncidentObservation,
  buildR942ObservationProbe,
  mintR942WorkerCodeRepairAuthorization,
};
