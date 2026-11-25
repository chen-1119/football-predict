'use strict';
// Offline / read-only builder for worker-code-repair-v11 on installed r941.
// Never connects over SSH, modifies worker state, or relaxes release gates.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repair = require('./releaseWorkerCodeRepair.cjs');
const dataPlanePolicy = require('./releaseDataPlanePolicy.cjs');
const { collectWorkerPreflight, evaluateWorkerPreflight } = require('./releaseWorkerPreflight.cjs');
const { streamInlineObjectEntries } = require('./streamedInlineObjectEntries.cjs');
const {
  inlineFailure,
  validateInlineAnchor,
  inlineIncidentAnchor,
  validateInlineSource,
  canonicalMapValuesLowerBound,
  readInlineSource,
} = require('./inlineRowIncidentEvidence.cjs');
const {
  validateTimeoutAnchor,
  verifyTimeoutFrame,
  readTimeoutAttempt,
} = require('./workerTimeoutIncident.cjs');

const R941_BASELINE_TARGET_HASHES = Object.freeze({
  'scripts/postgresGenerationSource.cjs': 'eb481dc1fa900309f3b24d2e6a8a45fdb33db265f036b34a4b4e7e500f74f8b9',
  'scripts/postgresProjectionSync.cjs': '7db30386887da68e33ad3ff0acb0169fa89d2f5b69ea6ee7242ec9e73e6d4f80',
  'scripts/syncPostgresProjection.cjs': '40b5848e952306cdde5f736c617e0268e0022591b4b62e5091751bca053172c6',
  'server/postgresProjectionStore.cjs': '2c576884f3769745040aff0d5857f9a2bd7f182a8eb1342024750fe25f1c684e',
  'scripts/runSyncWorker.cjs': '2bd126fbce42dc0b6216bc47e2a21abf938b606cfbc3a4973569a4fea6dc0738',
  'server/selectedJsonObjectFile.cjs': '350de1857fec4a1a92bb1347c159d9a48900d9b02d7febd72104d42cd8b4a7fc',
  'server/collectorQuorumEvidence.cjs': '7d13ef85828a48c15522b0c6ef25c7367c3877a58d515a93a3bd496da2ae5ea0',
  'scripts/candidateProspectiveLedger.cjs': 'c27abeec204f71b9917a103a484350a12c27d0de6af6f538e5b7f6f772e779f0',
  'scripts/captureCandidateProspectiveDeadline.cjs': 'e6900ae35aeb98bd2ef165d214421441cb7eec80578f76b70313fd8fb5b37c51',
  'scripts/releaseWorkerCodeRepair.cjs': '7aa23148afdc9636434b540763aa581f806ff080be8caed516951bfdc08c48f8',
  'scripts/nativeCodeReleaseDataPlane.cjs': '38edd0a0571e8083beb55e62f9b2ce21eff57a38ce231cd779221dd8bc3610f5',
  'scripts/runReleaseWorkerPreflight.cjs': '7e6bb042c531367883ea67e52897a3d402d121ff1098abd8641620dff7e7df2d',
  'scripts/deployReleaseBundle.cjs': 'c627eb5fe3d41e05ff3b72e072747a32c40b3842e933706c210569257be9ea12',
  'scripts/staticVerificationReceipts.cjs': '5ac706e8552c9573b4e90441053898b36d75c889f5b5e75cbc13e34ea4d1db59',
  'scripts/verifyStaticVerificationReceipts.cjs': '53121dc7a6a31816a072450791272d39e75562c17c877bf5399a8a2b4d426a42',
});

const sha256File = (filePath) => crypto
  .createHash('sha256')
  .update(fs.readFileSync(filePath))
  .digest('hex');

function collectLiveR941IncidentObservation() {
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const cp = require('node:child_process');
  const crypto = require('node:crypto');
  const root = '/opt/football-predict';
  assert.equal(fs.realpathSync(root), root);
  const bundleMarker = fs.readFileSync(root + '/.release-bundle-sha256', 'utf8').trim();
  const liveMarker = fs.readFileSync(root + '/.release-live-complete', 'utf8').trim();
  assert.equal(bundleMarker, R941_BASE_RUNTIME_SHA256);
  assert.equal(liveMarker, R941_BASE_RUNTIME_SHA256);

  const worker = collectWorkerPreflight();
  const preflight = evaluateWorkerPreflight(worker);
  if (preflight.ok) {
    return {
      version: 'r941-stability-incident-observation-v1',
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
  let incident;
  if (cycle?.errorCode === 'SYNC_WORKER_COMMAND_FAILED' && cycle?.error === 'npm run postgres:sync exited with 1') {
    const codeLine = '  "code": "POSTGRES_INLINE_ROW_LIMIT",';
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
    assert.equal(locRows.length, 1, 'expected one POSTGRES_INLINE_ROW_LIMIT journal locator');
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
    const anchor = inlineIncidentAnchor(worker, journal);
    const source = readInlineSource(root);
    incident = { kind: 'external-inline-row-limit', anchor, source };
  } else if (cycle?.errorCode === 'CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT') {
    const endMs = Date.parse(cycle.finishedAt);
    const asEpoch = (ms) => '@' + (ms / 1000).toFixed(3);
    const text = cp.execFileSync('/usr/bin/journalctl', [
      '--unit=football-sync-worker.service',
      '_PID=' + worker.serviceAfter.MainPID,
      '--since=' + asEpoch(endMs),
      '--until=' + asEpoch(endMs + 5000),
      '--no-pager',
      '--output=json',
      '--lines=2049',
      '--output-fields=MESSAGE,_PID,_SYSTEMD_UNIT,_SYSTEMD_INVOCATION_ID,_BOOT_ID',
    ], { encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
    const rows = text.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert(rows.length < 2049);
    const matches = [];
    let s = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].MESSAGE === '{') s = i;
      if (rows[i].MESSAGE !== '}' || s < 0) continue;
      const frameRows = rows.slice(s, i + 1);
      s = -1;
      const frame = JSON.parse(frameRows.map((r) => r.MESSAGE).join('\n'));
      if (frame.type === 'sync-worker-failed' && frame.lastCycle?.finishedAt === cycle.finishedAt && frame.lastCycle?.startedAt === cycle.startedAt) {
        matches.push(frameRows);
      }
    }
    assert.equal(matches.length, 1);
    const frameRows = matches[0];
    const attemptRaw = readTimeoutAttempt({ kind: 'deadline-recovery' });
    const candidateAnchor = {
      kind: 'deadline-recovery',
      workerMainPid: worker.serviceAfter.MainPID,
      workerStartedAt: new Date(worker.serviceAfter.ExecMainStartTimestamp).toISOString(),
      cycleStartedAt: cycle.startedAt,
      cycleFinishedAt: cycle.finishedAt,
      bootId: frameRows[0]._BOOT_ID,
      invocationId: frameRows[0]._SYSTEMD_INVOCATION_ID,
      journalStartUs: frameRows[0].__REALTIME_TIMESTAMP,
      journalEndUs: frameRows.at(-1).__REALTIME_TIMESTAMP,
      journalStartCursor: frameRows[0].__CURSOR,
      journalEndCursor: frameRows.at(-1).__CURSOR,
      journalRows: frameRows.length,
      journalMessageSha256: crypto.createHash('sha256').update(frameRows.map((r) => r.MESSAGE).join('\n')).digest('hex'),
      originalRecoveryAttempt: attemptRaw,
      attemptSha256: crypto.createHash('sha256').update(attemptRaw).digest('hex'),
    };
    verifyTimeoutFrame(candidateAnchor, frameRows, attemptRaw);
    incident = candidateAnchor;
  } else {
    throw new Error(`unqualified r941 worker failure: ${cycle?.errorCode || 'unknown'}: ${cycle?.error || ''}`);
  }
  return {
    version: 'r941-stability-incident-observation-v1',
    observedAt: worker.checkedAt,
    workerHealthy: false,
    preflight,
    publication,
    incident,
    productionWrites: 0,
  };
}

function buildR941ObservationProbe() {
  return "'use strict';\n"
    + 'const R941_BASE_RUNTIME_SHA256=' + JSON.stringify(repair.R941_BASE_RUNTIME_SHA256) + ';\n'
    + 'const repair={validateRepairPublication:' + repair.validateRepairPublication.toString() + '};\n'
    + [
      collectWorkerPreflight,
      evaluateWorkerPreflight,
      streamInlineObjectEntries,
      inlineFailure,
      validateInlineAnchor,
      inlineIncidentAnchor,
      validateInlineSource,
      canonicalMapValuesLowerBound,
      readInlineSource,
      validateTimeoutAnchor,
      verifyTimeoutFrame,
      readTimeoutAttempt,
      collectLiveR941IncidentObservation,
    ].map((fn) => fn.toString()).join('\n')
    + '\nconsole.log(JSON.stringify(collectLiveR941IncidentObservation()));\n';
}

function mintR941WorkerCodeRepairAuthorization({
  candidateRoot,
  observation,
  baselineHashes = R941_BASELINE_TARGET_HASHES,
  createdAt = new Date().toISOString(),
  ttlSeconds = 5400,
} = {}) {
  assert(candidateRoot && fs.statSync(candidateRoot).isDirectory(), 'candidateRoot directory required');
  assert(observation?.version === 'r941-stability-incident-observation-v1', 'valid r941 observation required');
  assert.equal(observation.workerHealthy, false, 'worker is already healthy; use ordinary release without repair authorization');
  assert(Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 60 && ttlSeconds <= 7200, 'ttlSeconds must be within 60..7200');
  const createdMs = Date.parse(createdAt);
  assert(Number.isFinite(createdMs), 'invalid createdAt');
  const expiresAt = new Date(createdMs + ttlSeconds * 1000).toISOString();

  const files = repair.R941_STABILITY_TARGETS.map((relPath) => {
    const beforeSha256 = baselineHashes[relPath];
    assert.match(beforeSha256 || '', /^[a-f0-9]{64}$/, `missing r941 baseline sha256 for ${relPath}`);
    const afterSha256 = sha256File(path.join(candidateRoot, relPath));
    assert.notEqual(beforeSha256, afterSha256, `candidate target unchanged from r941 baseline: ${relPath}`);
    return { path: relPath, beforeSha256, afterSha256 };
  });
  const addedSources = repair.R941_STABILITY_ADDED.map((relPath) => ({
    path: relPath,
    sha256: sha256File(path.join(candidateRoot, relPath)),
  }));
  const unchangedSources = repair.R941_STABILITY_UNCHANGED.map((relPath) => ({
    path: relPath,
    sha256: sha256File(path.join(candidateRoot, relPath)),
  }));
  const dataContract = dataPlanePolicy.capture(candidateRoot).entries;

  const auth = {
    version: 'worker-code-repair-v11',
    reason: observation.incident.kind,
    bindingPolicy: repair.R941_BINDING_POLICY,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt,
    baseRuntimeSha256: repair.R941_BASE_RUNTIME_SHA256,
    publication: observation.publication,
    incident: observation.incident,
    files,
    addedSources,
    unchangedSources,
    dataContract,
  };
  repair.validateWorkerCodeRepairAuthorization(auth, createdMs);
  return auth;
}

module.exports = {
  R941_BASELINE_TARGET_HASHES,
  buildR941ObservationProbe,
  mintR941WorkerCodeRepairAuthorization,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--print-readonly-probe')) {
    process.stdout.write(buildR941ObservationProbe());
  } else {
    const obsIdx = args.indexOf('--observation');
    const rootIdx = args.indexOf('--candidate-root');
    const outIdx = args.indexOf('--out');
    if (obsIdx < 0 || !args[obsIdx + 1]) {
      throw new Error('Usage: node scripts/buildR941WorkerCodeRepairAuthorization.cjs --print-readonly-probe | --observation <observation.json> [--candidate-root <dir>] [--out <file>]');
    }
    const candidateRoot = path.resolve(rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : path.join(__dirname, '..'));
    const observation = JSON.parse(fs.readFileSync(path.resolve(args[obsIdx + 1]), 'utf8'));
    const auth = mintR941WorkerCodeRepairAuthorization({ candidateRoot, observation });
    repair.candidateAuthorization(candidateRoot, auth);
    const serialized = `${JSON.stringify(auth, null, 2)}\n`;
    if (outIdx >= 0 && args[outIdx + 1]) {
      const target = path.resolve(args[outIdx + 1]);
      fs.writeFileSync(target, serialized, { mode: 0o600 });
    }
    process.stdout.write(serialized);
  }
}
