'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const repair = require('../scripts/releaseWorkerCodeRepair.cjs');
const {
  R941_BASELINE_TARGET_HASHES,
  buildR941ObservationProbe,
  mintR941WorkerCodeRepairAuthorization,
} = require('../scripts/buildR941WorkerCodeRepairAuthorization.cjs');
const { inlineFailure } = require('../scripts/inlineRowIncidentEvidence.cjs');
const { packTimeoutJournal } = require('../scripts/workerTimeoutIncident.cjs');
const workerPreflight = require('../scripts/releaseWorkerPreflight.cjs');
const generations = require('../server/dataGenerationStore.cjs');

const hex = (ch) => String(ch).repeat(64).slice(0, 64);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createCandidateRootFixture(baseDir) {
  const candidateRoot = path.join(baseDir, 'candidate');
  fs.mkdirSync(candidateRoot, { recursive: true });
  for (const rel of repair.R941_STABILITY_TARGETS) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// candidate-r941-fix:${rel}\n`, 'utf8');
  }
  for (const rel of repair.R941_STABILITY_ADDED) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// candidate-r941-added:${rel}\n`, 'utf8');
  }
  for (const rel of repair.R941_STABILITY_UNCHANGED) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// r941-unchanged:${rel}\n`, 'utf8');
  }
  for (const rel of [...repair.DATA_FILES, 'server/postgres/migrations/001_core.sql']) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `-- data-contract:${rel}\n`, 'utf8');
  }
  return candidateRoot;
}

function buildPublicationFixture(nowMs) {
  const mk = (seed, agoMs) => ({
    mode: 'active-generation',
    generationId: 'g-' + hex(seed),
    manifestHash: hex(seed),
    sourceCycleId: `sporttery-full-sync:${new Date(nowMs - agoMs - 60000).toISOString()}`,
    committedAt: new Date(nowMs - agoMs).toISOString(),
  });
  return {
    databaseOid: '28598409',
    committed: mk('1', 3600_000),
    rawPrevious: mk('2', 1200_000),
    rawCurrent: mk('3', 300_000),
  };
}

function buildInlineObservation(nowMs) {
  const publication = buildPublicationFixture(nowMs);
  const workerStartedAt = new Date(new Date(nowMs - 7200_000).toUTCString()).toISOString();
  const cycleStartedAt = new Date(nowMs - 120_000).toISOString();
  const cycleFinishedAt = new Date(nowMs - 10_000).toISOString();
  const frameText = JSON.stringify(inlineFailure(), null, 2);
  const journalTimestampUs = String((nowMs - 10_500) * 1000);
  const anchor = {
    version: 'external-inline-incident-v1',
    workerMainPid: '3163101',
    workerStartedAt,
    cycleStartedAt,
    cycleFinishedAt,
    journalPid: '3463215',
    journalTimestampUs,
    journalMessageSha256: sha256(frameText),
  };
  const source = {
    version: 'external-inline-source-v1',
    table: 'source_snapshots',
    id: 'external-signals:current',
    column: 'payload',
    inlineLimit: 134217728,
    rawBytes: 216873800,
    rawSha256: hex('a'),
    canonicalMapValuesBytesLowerBound: 134877377,
    generationId: publication.rawCurrent.generationId,
    manifestHash: publication.rawCurrent.manifestHash,
    sourceCycleId: publication.rawCurrent.sourceCycleId,
    committedAt: publication.rawCurrent.committedAt,
    stableIdentity: true,
  };
  return {
    version: 'r941-stability-incident-observation-v1',
    observedAt: new Date(nowMs).toISOString(),
    workerHealthy: false,
    publication,
    incident: {
      kind: 'external-inline-row-limit',
      anchor,
      source,
    },
    productionWrites: 0,
  };
}

function buildDeadlineTimeoutObservation(nowMs) {
  const publication = buildPublicationFixture(nowMs);
  const workerStartedAt = new Date(new Date(nowMs - 7200_000).toUTCString()).toISOString();
  const cycleStartedAt = new Date(nowMs - 120_000).toISOString();
  const cycleFinishedAt = new Date(nowMs - 10_000).toISOString();
  const attemptObj = {
    version: 'candidate-prospective-capture-attempt-v1',
    startedAt: new Date(nowMs - 54_200).toISOString(),
    finishedAt: new Date(nowMs - 10_100).toISOString(),
    ok: false,
    skipped: false,
    reason: 'candidate-deadline-capture-failed',
    statusAdvanced: false,
    publishedEvaluatedAt: new Date(nowMs - 600_000).toISOString(),
    publishedStatusReason: 'settlement-heartbeat',
    publishedStatusOk: true,
    error: '/opt/node-v22.22.1/bin/node /opt/football-predict/scripts/captureCandidateProspectiveDeadline.cjs --deadline-only timed out after 44000ms',
    errorCode: 'SYNC_WORKER_COMMAND_TIMEOUT',
    exitCode: null,
    signal: 'SIGTERM',
    attemptKind: 'preemptive-recovery',
    timeoutMs: 45000,
    childExecutionTimeoutMs: 44000,
    terminateGraceMs: 500,
    forceSettleMs: 500,
  };
  const attemptRaw = JSON.stringify(attemptObj, null, 2);
  const errorMsg = 'candidate deadline heartbeat is not exact: candidate-deadline-capture-failed';
  const lastCycle = {
    ok: false,
    phase: 'official-result-failed',
    startedAt: cycleStartedAt,
    finishedAt: cycleFinishedAt,
    durationMs: Date.parse(cycleFinishedAt) - Date.parse(cycleStartedAt),
    error: errorMsg,
    errorCode: 'CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT',
    timeoutMs: null,
  };
  const frameObj = {
    type: 'sync-worker-failed',
    pid: 3163101,
    ok: false,
    phase: 'failed',
    error: errorMsg,
    errorCode: 'CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT',
    timeoutMs: null,
    eventCycle: lastCycle,
    lastCycle,
    lastError: {
      at: cycleFinishedAt,
      message: errorMsg,
      code: 'CANDIDATE_DEADLINE_HEARTBEAT_NOT_EXACT',
      command: null,
      args: null,
      timeoutMs: null,
      exitCode: null,
      signal: null,
    },
  };
  const lines = JSON.stringify(frameObj, null, 2).split('\n');
  const startUs = (nowMs - 10_000) * 1000 + 100;
  const rows = lines.map((message, idx) => ({
    _SYSTEMD_UNIT: 'football-sync-worker.service',
    _PID: '3163101',
    _BOOT_ID: 'b'.repeat(32),
    _SYSTEMD_INVOCATION_ID: 'c'.repeat(32),
    __REALTIME_TIMESTAMP: String(startUs + idx),
    __CURSOR: `s=1;i=${1000 + idx}`,
    MESSAGE: message,
  }));
  const incident = {
    kind: 'deadline-recovery',
    workerMainPid: '3163101',
    workerStartedAt,
    cycleStartedAt,
    cycleFinishedAt,
    bootId: 'b'.repeat(32),
    invocationId: 'c'.repeat(32),
    journalStartUs: rows[0].__REALTIME_TIMESTAMP,
    journalEndUs: rows.at(-1).__REALTIME_TIMESTAMP,
    journalStartCursor: rows[0].__CURSOR,
    journalEndCursor: rows.at(-1).__CURSOR,
    journalRows: rows.length,
    journalMessageSha256: sha256(lines.join('\n')),
    originalRecoveryAttempt: attemptRaw,
    attemptSha256: sha256(attemptRaw),
  };
  return {
    observation: {
      version: 'r941-stability-incident-observation-v1',
      observedAt: new Date(nowMs).toISOString(),
      workerHealthy: false,
      publication,
      incident,
      productionWrites: 0,
    },
    frameRows: rows,
    lastCycle,
    attemptRaw,
  };
}

test('worker-code-repair-v11 mints, validates, and enforces candidate hashes for both r941 incident kinds', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r941-repair-v11-'));
  try {
    const candidateRoot = createCandidateRootFixture(tmp);
    const nowMs = Date.now();
    const inlineObs = buildInlineObservation(nowMs);
    const inlineAuth = mintR941WorkerCodeRepairAuthorization({
      candidateRoot,
      observation: inlineObs,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    });
    assert.equal(inlineAuth.version, 'worker-code-repair-v11');
    assert.equal(inlineAuth.baseRuntimeSha256, 'd922357040c5f5fbedc19ec9d5a49a7bd5c3c674089df88b7037f6b98cf64db5');
    assert.equal(inlineAuth.bindingPolicy, 'fresh-r941-stability-incident-before-lease-v1');
    assert.equal(inlineAuth.reason, 'external-inline-row-limit');
    assert.deepEqual(repair.candidateAuthorization(candidateRoot, inlineAuth), inlineAuth);

    const { observation: deadlineObs } = buildDeadlineTimeoutObservation(nowMs);
    const deadlineAuth = mintR941WorkerCodeRepairAuthorization({
      candidateRoot,
      observation: deadlineObs,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    });
    assert.equal(deadlineAuth.reason, 'deadline-recovery');
    assert.deepEqual(repair.candidateAuthorization(candidateRoot, deadlineAuth), deadlineAuth);

    // Rejects wrong baseline runtime sha, expired TTL, >2h TTL, inline bytes <= 128MiB, or modified candidate file
    for (const mutate of [
      (a) => { a.baseRuntimeSha256 = '5de9c543933c37b1b086c41862a17456f83227f555b7613b2058318d848a498c'; },
      (a) => { a.bindingPolicy = 'fresh-r938-timeout-incident-before-lease-v1'; },
      (a) => { a.expiresAt = new Date(nowMs - 1).toISOString(); },
      (a) => { a.expiresAt = new Date(nowMs + 3 * 3600_000).toISOString(); },
      (a) => { a.incident.source.rawBytes = 134217728; },
      (a) => { a.incident.source.canonicalMapValuesBytesLowerBound = 134217728; },
      (a) => { a.incident.source.generationId = 'g-' + hex('9'); },
      (a) => { a.files[0].afterSha256 = a.files[0].beforeSha256; },
      (a) => { a.addedSources.pop(); },
      (a) => { a.unchangedSources[0].sha256 = hex('9'); },
    ]) {
      const broken = structuredClone(inlineAuth);
      mutate(broken);
      assert.throws(() => repair.candidateAuthorization(candidateRoot, broken));
    }

    // Rejects primary (non-recovery) deadline timeout attempt or relaxed child timeout
    for (const mutateAttempt of [
      (obj) => { obj.attemptKind = 'primary'; },
      (obj) => { obj.childExecutionTimeoutMs = 60000; obj.timeoutMs = 61000; },
      (obj) => { obj.statusAdvanced = true; },
    ]) {
      const broken = structuredClone(deadlineAuth);
      const parsedAttempt = JSON.parse(broken.incident.originalRecoveryAttempt);
      mutateAttempt(parsedAttempt);
      broken.incident.originalRecoveryAttempt = JSON.stringify(parsedAttempt, null, 2);
      broken.incident.attemptSha256 = sha256(broken.incident.originalRecoveryAttempt);
      const service = {
        ActiveState: 'active',
        MainPID: '3163101',
        ExecMainStartTimestamp: new Date(deadlineAuth.incident.workerStartedAt).toUTCString(),
      };
      const worker = {
        checkedAt: new Date(nowMs).toISOString(),
        serviceBefore: service,
        serviceAfter: service,
        processMatches: true,
        status: {
          pid: 3163101,
          checkedAt: new Date(nowMs - 1000).toISOString(),
          ok: true,
          phase: 'official-result',
          lastCycle: buildDeadlineTimeoutObservation(nowMs).lastCycle,
        },
      };
      const { frameRows } = buildDeadlineTimeoutObservation(nowMs);
      const observed = {
        runtimeSha256: broken.baseRuntimeSha256,
        completeSha256: broken.baseRuntimeSha256,
        recoveryPending: false,
        files: broken.files.map((r) => ({ path: r.path, sha256: r.beforeSha256 })),
        dataContract: broken.dataContract,
        migrationNames: ['001_core.sql'],
        publication: broken.publication,
        unchangedSources: broken.unchangedSources,
        addedSourcesAbsent: repair.R941_STABILITY_ADDED,
        journal: { original: packTimeoutJournal(frameRows), repeated: null },
        meta: broken.incident.originalRecoveryAttempt,
      };
      assert.equal(repair.evaluateWorkerCodeRepair(broken, worker, observed).ok, false);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('serialized worker-code-repair-v11 probe executes cleanly on simulated r941 host without pre-existing added files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r941-probe-vm-'));
  try {
    const candidateRoot = createCandidateRootFixture(tmp);
    const nowMs = Date.now();
    const { observation: deadlineObs, frameRows, lastCycle, attemptRaw } = buildDeadlineTimeoutObservation(nowMs);
    const deadlineAuth = mintR941WorkerCodeRepairAuthorization({
      candidateRoot,
      observation: deadlineObs,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    });
    const probeSource = repair.buildWorkerCodeRepairProbe(deadlineAuth);
    // Probe must embed streamInlineObjectEntries so old r941 host does not need new file on disk
    assert.ok(probeSource.includes('function streamInlineObjectEntries('));
    assert.ok(!probeSource.includes('systemctl",["start'));

    const runDeadlineProbe = ({ recovered = false, wrongRuntime = false } = {}) => {
      const files = new Map();
      const markerSha = wrongRuntime ? hex('f') : deadlineAuth.baseRuntimeSha256;
      files.set('/opt/football-predict/.release-bundle-sha256', Buffer.from(markerSha + '\n'));
      files.set('/opt/football-predict/.release-live-complete', Buffer.from(markerSha + '\n'));
      for (const r of deadlineAuth.files) {
        files.set('/opt/football-predict/' + r.path, Buffer.from('old:' + r.path));
        r.beforeSha256 = sha256(files.get('/opt/football-predict/' + r.path));
      }
      for (const r of deadlineAuth.unchangedSources) {
        files.set('/opt/football-predict/' + r.path, Buffer.from('// r941-unchanged:' + r.path + '\n'));
      }
      for (const r of deadlineAuth.dataContract) {
        files.set('/opt/football-predict/' + r.path, Buffer.from('-- data-contract:' + r.path + '\n'));
      }
      const status = recovered
        ? {
          pid: 3163101,
          checkedAt: new Date(nowMs - 1_000).toISOString(),
          ok: true,
          phase: 'official-result',
          lastCycle: { ...lastCycle, ok: true, phase: 'official-result-published', error: null, errorCode: null },
        }
        : {
          pid: 3163101,
          checkedAt: new Date(nowMs - 1_000).toISOString(),
          ok: false,
          phase: 'failed',
          error: lastCycle.error,
          errorCode: lastCycle.errorCode,
          eventCycle: lastCycle,
          lastCycle,
        };
      files.set('/var/lib/football-predict/sync-worker-status.json', Buffer.from(JSON.stringify(status)));
      files.set('/var/lib/football-predict/candidate-prospective-capture-attempt-status.json', Buffer.from(attemptRaw));
      for (const [name, key] of [['current', 'rawCurrent'], ['previous', 'rawPrevious']]) {
        files.set(`/var/lib/football-predict/data-generations/${name}.json`, Buffer.from(JSON.stringify({
          schemaVersion: 1,
          ...deadlineAuth.publication[key],
        })));
      }
      files.set('/proc/3163101/cmdline', Buffer.from('/opt/node-v22.22.1/bin/node\0/opt/football-predict/scripts/runSyncWorker.cjs\0--loop\0'));

      const fixtureFs = {
        constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
        realpathSync: (f) => f,
        readlinkSync: () => '/opt/node-v22.22.1/bin/node',
        openSync: (f) => { assert(files.has(f), `missing ${f}`); return f; },
        closeSync: () => {},
        readFileSync: (f, enc) => (enc ? files.get(f).toString('utf8') : files.get(f)),
        fstatSync: (f) => ({ isFile: () => true, nlink: 1, size: files.get(f).length, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1 }),
        lstatSync: (f) => {
          if (f.startsWith('/var/lib/football-release/') || repair.R941_STABILITY_ADDED.some((a) => f.endsWith('/' + a))) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
          if (files.has(f)) {
            return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, size: files.get(f).length, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1 };
          }
          return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
        },
        readdirSync: () => ['001_core.sql'],
      };
      const fixtureChild = {
        execFileSync: (cmd) => {
          if (cmd === 'systemctl') {
            return `ActiveState=active\nMainPID=3163101\nExecMainStartTimestamp=${new Date(deadlineAuth.incident.workerStartedAt).toUTCString()}\n`;
          }
          assert.equal(recovered, false, 'recovered worker must not query incident journal or pg');
          if (cmd === '/usr/sbin/runuser') {
            const c = deadlineAuth.publication.committed;
            return JSON.stringify({
              databaseOid: deadlineAuth.publication.databaseOid,
              readOnly: 'on',
              meta: {
                data_publication_mode: c.mode,
                data_generation_id: c.generationId,
                manifest_hash: c.manifestHash,
                data_generation_source_cycle_id: c.sourceCycleId,
                committed_at: c.committedAt,
              },
            });
          }
          assert.equal(cmd, '/usr/bin/journalctl');
          return frameRows.map((r) => JSON.stringify(r)).join('\n') + '\n';
        },
      };
      const fixtureRequire = (spec) => (
        spec === 'node:fs' ? fixtureFs
          : spec === 'node:child_process' ? fixtureChild
            : spec === 'node:path' ? path.posix
              : require(spec)
      );
      const out = [];
      const proc = { exitCode: 0 };
      const freshSource = repair.buildWorkerCodeRepairProbe(deadlineAuth);
      new vm.Script(freshSource).runInNewContext({
        require: fixtureRequire,
        process: proc,
        console: { log: (line) => out.push(line) },
        Date,
      });
      return { exitCode: proc.exitCode, report: JSON.parse(out[0]) };
    };

    const failedRun = runDeadlineProbe();
    assert.equal(failedRun.exitCode, 0);
    assert.equal(failedRun.report.ok, true);
    assert.equal(failedRun.report.repairPreparationAllowed, true);
    assert.equal(failedRun.report.workerHealthy, false);
    assert.equal(failedRun.report.readyToCutover, false);
    assert.equal(failedRun.report.productionWrites, 0);

    const recoveredRun = runDeadlineProbe({ recovered: true });
    assert.equal(recoveredRun.exitCode, 0);
    assert.equal(recoveredRun.report.ok, true);
    assert.equal(recoveredRun.report.readyToCutover, false);

    const wrongRuntimeRun = runDeadlineProbe({ wrongRuntime: true });
    assert.equal(wrongRuntimeRun.exitCode, 1);
    assert.equal(wrongRuntimeRun.report.ok, false);

    // Also verify external-inline-row-limit probe runs in bare VM context ({require,process,console,Date}) without host Buffer/TextDecoder globals
    const chunkValue = 'x'.repeat(15 * 1024 * 1024);
    const largeMatches = {};
    for (let i = 0; i < 9; i += 1) largeMatches[`m${i}`] = chunkValue;
    const externalSignalsBytes = Buffer.from(JSON.stringify({ matches: largeMatches }));
    const rawManifest = generations.buildManifest({
      sourceCycleId: `sporttery-full-sync:${new Date(nowMs - 360_000).toISOString()}`,
      files: [{ relativePath: 'external-signals.json', bytes: externalSignalsBytes, rows: 9 }],
      coreFiles: ['external-signals.json'],
    });
    const inlineObs = buildInlineObservation(nowMs);
    inlineObs.publication.rawCurrent = {
      mode: 'active-generation',
      generationId: rawManifest.generationId,
      manifestHash: rawManifest.manifestHash,
      sourceCycleId: rawManifest.sourceCycleId,
      committedAt: new Date(nowMs - 300_000).toISOString(),
    };
    const expectedLowerBound = 2 + Object.values(largeMatches).reduce(
      (sum, v, idx) => sum + Buffer.byteLength(JSON.stringify(v)) + (idx > 0 ? 1 : 0),
      0,
    );
    inlineObs.incident.source = {
      ...inlineObs.incident.source,
      rawBytes: externalSignalsBytes.length,
      rawSha256: sha256(externalSignalsBytes),
      canonicalMapValuesBytesLowerBound: expectedLowerBound,
      ...Object.fromEntries(['generationId', 'manifestHash', 'sourceCycleId', 'committedAt'].map((k) => [k, inlineObs.publication.rawCurrent[k]])),
    };
    const inlineAuth = mintR941WorkerCodeRepairAuthorization({
      candidateRoot,
      observation: inlineObs,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    });
    const inlineFiles = new Map();
    inlineFiles.set('/opt/football-predict/.release-bundle-sha256', Buffer.from(inlineAuth.baseRuntimeSha256 + '\n'));
    inlineFiles.set('/opt/football-predict/.release-live-complete', Buffer.from(inlineAuth.baseRuntimeSha256 + '\n'));
    for (const r of inlineAuth.files) {
      inlineFiles.set('/opt/football-predict/' + r.path, Buffer.from('old-inline:' + r.path));
      r.beforeSha256 = sha256(inlineFiles.get('/opt/football-predict/' + r.path));
    }
    for (const r of inlineAuth.unchangedSources) {
      inlineFiles.set('/opt/football-predict/' + r.path, Buffer.from('// r941-unchanged:' + r.path + '\n'));
    }
    for (const r of inlineAuth.dataContract) {
      inlineFiles.set('/opt/football-predict/' + r.path, Buffer.from('-- data-contract:' + r.path + '\n'));
    }
    const inlineLastCycle = {
      ok: false,
      phase: 'official-result-failed',
      startedAt: inlineAuth.incident.anchor.cycleStartedAt,
      finishedAt: inlineAuth.incident.anchor.cycleFinishedAt,
      error: 'npm run postgres:sync exited with 1',
      errorCode: 'SYNC_WORKER_COMMAND_FAILED',
    };
    inlineFiles.set('/var/lib/football-predict/sync-worker-status.json', Buffer.from(JSON.stringify({
      pid: 3163101,
      checkedAt: new Date(nowMs - 1_000).toISOString(),
      ok: false,
      phase: 'failed',
      error: inlineLastCycle.error,
      errorCode: inlineLastCycle.errorCode,
      eventCycle: inlineLastCycle,
      lastCycle: inlineLastCycle,
    })));
    for (const [name, key] of [['current', 'rawCurrent'], ['previous', 'rawPrevious']]) {
      inlineFiles.set(`/var/lib/football-predict/data-generations/${name}.json`, Buffer.from(JSON.stringify({
        schemaVersion: 1,
        ...inlineAuth.publication[key],
      })));
    }
    const genDir = `/var/lib/football-predict/data-generations/generations/${rawManifest.generationId}`;
    inlineFiles.set(`${genDir}/manifest.json`, Buffer.from(JSON.stringify(rawManifest)));
    inlineFiles.set(`${genDir}/external-signals.json`, externalSignalsBytes);
    inlineFiles.set('/proc/3163101/cmdline', Buffer.from('/opt/node-v22.22.1/bin/node\0/opt/football-predict/scripts/runSyncWorker.cjs\0--loop\0'));

    const openHandles = new Map();
    let nextFd = 10;
    const mkStat = (size, isDir, bigint = false) => (bigint
      ? {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
        nlink: 1n,
        size: BigInt(size),
        dev: 1n,
        ino: 1n,
        mtimeNs: 1n,
        ctimeNs: 1n,
      }
      : {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
        nlink: 1,
        size,
        dev: 1,
        ino: 1,
        mtimeMs: 1,
        ctimeMs: 1,
      });
    const inlineFs = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
      realpathSync: (f) => f,
      readlinkSync: () => '/opt/node-v22.22.1/bin/node',
      openSync: (f) => {
        assert(inlineFiles.has(f), `missing ${f}`);
        const fd = nextFd++;
        openHandles.set(fd, { file: f, pos: 0 });
        return fd;
      },
      closeSync: (fd) => { openHandles.delete(fd); },
      readFileSync: (fdOrFile, enc) => {
        const f = typeof fdOrFile === 'number' ? openHandles.get(fdOrFile).file : fdOrFile;
        return enc ? inlineFiles.get(f).toString('utf8') : inlineFiles.get(f);
      },
      readSync: (fd, buf, offset, length, position) => {
        const h = openHandles.get(fd);
        const src = inlineFiles.get(h.file);
        const start = position === null ? h.pos : position;
        if (start >= src.length) return 0;
        const n = Math.min(length, src.length - start);
        src.copy(buf, offset, start, start + n);
        if (position === null) h.pos += n;
        return n;
      },
      fstatSync: (fd, opts) => mkStat(inlineFiles.get(openHandles.get(fd).file).length, false, Boolean(opts?.bigint)),
      lstatSync: (f, opts) => {
        if (f.startsWith('/var/lib/football-release/') || repair.R941_STABILITY_ADDED.some((a) => f.endsWith('/' + a))) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (inlineFiles.has(f)) return mkStat(inlineFiles.get(f).length, false, Boolean(opts?.bigint));
        return mkStat(0, true, Boolean(opts?.bigint));
      },
      readdirSync: () => ['001_core.sql'],
    };
    const inlineJournalRows = JSON.stringify(inlineFailure(), null, 2).split('\n').map((MESSAGE) => ({
      _SYSTEMD_UNIT: 'football-sync-worker.service',
      _PID: inlineAuth.incident.anchor.journalPid,
      __REALTIME_TIMESTAMP: inlineAuth.incident.anchor.journalTimestampUs,
      MESSAGE,
    }));
    const inlineChild = {
      execFileSync: (cmd, args) => {
        if (cmd === 'systemctl') {
          return `ActiveState=active\nMainPID=3163101\nExecMainStartTimestamp=${new Date(inlineAuth.incident.anchor.workerStartedAt).toUTCString()}\n`;
        }
        if (cmd === '/usr/sbin/runuser') {
          const c = inlineAuth.publication.committed;
          return JSON.stringify({
            databaseOid: inlineAuth.publication.databaseOid,
            readOnly: 'on',
            meta: {
              data_publication_mode: c.mode,
              data_generation_id: c.generationId,
              manifest_hash: c.manifestHash,
              data_generation_source_cycle_id: c.sourceCycleId,
              committed_at: c.committedAt,
            },
          });
        }
        assert.equal(cmd, '/usr/bin/journalctl');
        if (args.some((x) => x.startsWith('--grep='))) {
          return JSON.stringify(inlineJournalRows.find((r) => r.MESSAGE === '  "code": "POSTGRES_INLINE_ROW_LIMIT",')) + '\n';
        }
        return inlineJournalRows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      },
    };
    const inlineRequire = (spec) => (
      spec === 'node:fs' ? inlineFs
        : spec === 'node:child_process' ? inlineChild
          : spec === 'node:path' ? path.posix
            : spec === '/opt/football-predict/server/dataGenerationStore.cjs' ? generations
              : require(spec)
    );
    const inlineOut = [];
    const inlineProc = { exitCode: 0 };
    new vm.Script(repair.buildWorkerCodeRepairProbe(inlineAuth)).runInNewContext({
      require: inlineRequire,
      process: inlineProc,
      console: { log: (line) => inlineOut.push(line) },
      Date,
    });
    const inlineReport = JSON.parse(inlineOut[0]);
    assert.equal(inlineProc.exitCode, 0);
    assert.equal(inlineReport.ok, true);
    assert.equal(inlineReport.repairPreparationAllowed, true);
    assert.equal(inlineReport.readyToCutover, false);
    assert.equal(inlineReport.productionWrites, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nativeCodeReleaseDataPlane requiresFreshRepairCapture and captureFreshRepairPair bind worker-code-repair-v11 before lease', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r941-native-capture-'));
  try {
    const candidateRoot = createCandidateRootFixture(tmp);
    const nowMs = Date.now();
    const inlineObs = buildInlineObservation(nowMs);
    const inlineAuth = mintR941WorkerCodeRepairAuthorization({
      candidateRoot,
      observation: inlineObs,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    });
    const code = require('../scripts/nativeCodeReleaseDataPlane.cjs');
    // Verify requiresFreshRepairCapture directly on v11 and rejects wrong baseRuntimeSha256
    const stateHash = hex('9');
    const contexts = {};
    for (const [name, ptr] of [
      ['committed', inlineAuth.publication.committed],
      ['rawPrevious', inlineAuth.publication.rawPrevious],
      ['rawCurrent', inlineAuth.publication.rawCurrent],
    ]) {
      const payload = Buffer.from(JSON.stringify({ matches: [], name }));
      const manifest = generations.buildManifest({
        sourceCycleId: ptr.sourceCycleId,
        files: [{ relativePath: 'matches-current.json', bytes: payload, rows: 0 }],
        coreFiles: ['matches-current.json'],
      });
      const dir = path.join(tmp, manifest.generationId);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, generations.MANIFEST_FILE), JSON.stringify(manifest));
      fs.writeFileSync(path.join(dir, 'matches-current.json'), payload);
      contexts[name] = {
        ...generations.validateGenerationDirectory({ generationDir: dir }),
        pointer: {
          schemaVersion: 1,
          generationId: manifest.generationId,
          manifestHash: manifest.manifestHash,
          sourceCycleId: manifest.sourceCycleId,
          committedAt: ptr.committedAt,
        },
      };
    }

    // Bind minted auth to real validated test generation pointers
    const pubFromCtx = (c) => ({
      mode: 'active-generation',
      generationId: c.pointer.generationId,
      manifestHash: c.pointer.manifestHash,
      sourceCycleId: c.pointer.sourceCycleId,
      committedAt: c.pointer.committedAt,
    });
    const boundObs = buildInlineObservation(nowMs);
    boundObs.publication = {
      databaseOid: '28598409',
      committed: pubFromCtx(contexts.committed),
      rawPrevious: pubFromCtx(contexts.rawPrevious),
      rawCurrent: pubFromCtx(contexts.rawCurrent),
    };
    Object.assign(boundObs.incident.source, {
      generationId: boundObs.publication.rawCurrent.generationId,
      manifestHash: boundObs.publication.rawCurrent.manifestHash,
      sourceCycleId: boundObs.publication.rawCurrent.sourceCycleId,
      committedAt: boundObs.publication.rawCurrent.committedAt,
    });
    const boundAuth = mintR941WorkerCodeRepairAuthorization({
      candidateRoot,
      observation: boundObs,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    });
    const authBytes = Buffer.from(JSON.stringify(boundAuth));
    const authHash = sha256(authBytes);
    const state = {
      dataPlane: 'code-only',
      sha: hex('d'),
      oldSha: boundAuth.baseRuntimeSha256,
      oldDatabaseOid: '28598409',
      key: hex('e'),
      createdAt: new Date(nowMs - 4_000).toISOString(),
      committedGenerationRepairAuthorizationHash: authHash,
      repairCapturePolicy: boundAuth.bindingPolicy,
    };

    const nativeSource = fs.readFileSync(path.join(__dirname, '../scripts/nativeCodeReleaseDataPlane.cjs'), 'utf8');
    const policySource = fs.readFileSync(path.join(__dirname, '../scripts/releaseWorkerCodeRepair.cjs'), 'utf8');
    const driverSource = fs.readFileSync(path.join(__dirname, '../scripts/nativeReleaseDataPlane.cjs'), 'utf8');
    const rootFunctions = driverSource.slice(driverSource.indexOf('function secureDirectory('), driverSource.indexOf('function topology('));

    const directory = '/var/lib/football-release/native/' + state.sha;
    const authFile = '/candidate/deploy/light-server/worker-code-repair-authorization.json';
    const vfs = new Map([
      [directory + '/state.json', Buffer.from(JSON.stringify(state))],
      [authFile, authBytes],
    ]);
    let held = false;
    const stat = (f) => {
      if (vfs.has(f)) {
        return { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, uid: 0, nlink: 1, mode: 0o600, size: vfs.get(f).length, ino: 1, dev: 1 };
      }
      if (f.endsWith('.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false, uid: 0, mode: 0o700 };
    };
    const fixtureFs = {
      constants: fs.constants,
      lstatSync: stat,
      fstatSync: (fd) => stat(fd.file),
      existsSync: (f) => vfs.has(f),
      readFileSync: (fd, enc) => {
        const b = vfs.get(typeof fd === 'string' ? fd : fd.file);
        assert(b);
        return enc ? b.toString() : b;
      },
      openSync: (f, flag, mode) => {
        if (flag === 'wx') {
          assert(!vfs.has(f));
          assert.equal(mode, 0o600);
          vfs.set(f, Buffer.alloc(0));
        } else stat(f);
        return { file: f };
      },
      writeFileSync: (fd, val) => { vfs.set(fd.file, Buffer.from(val)); },
      fsyncSync: () => {},
      closeSync: () => {},
    };
    const context = vm.createContext({ Buffer, Date, process: {}, console });
    const realm = (val) => {
      context.tmpJson = JSON.stringify(val);
      return new vm.Script('JSON.parse(tmpJson)').runInContext(context);
    };
    let fixturePolicy;
    let fixtureWorker;
    let fixtureDriver;
    const fixtureGenerations = {
      ...generations,
      resolveCurrentGeneration: () => {
        assert.equal(held, false);
        return { ...generations.validateGenerationDirectory({ generationDir: contexts.rawCurrent.generationDir }), pointer: contexts.rawCurrent.pointer };
      },
      resolvePreviousGeneration: () => {
        assert.equal(held, false);
        return { ...generations.validateGenerationDirectory({ generationDir: contexts.rawPrevious.generationDir }), pointer: contexts.rawPrevious.pointer };
      },
      storePaths: () => ({ currentPointer: 'current', previousPointer: 'previous', pointerLockDir: 'lock' }),
      acquirePointerCommitLock: () => {
        assert.equal(held, false);
        held = true;
        return { release: () => { held = false; } };
      },
      readPointer: (f) => {
        assert.equal(held, true);
        return contexts[f === 'current' ? 'rawCurrent' : 'rawPrevious'].pointer;
      },
    };
    const compiledModules = new Map();
    const compile = (src, name) => {
      const mod = { exports: {} };
      new vm.Script(`(function(require,module,exports,__dirname){${src}\n})`, { filename: name })
        .runInContext(context)(fixtureRequire, mod, mod.exports, '/candidate/scripts');
      return mod.exports;
    };
    const compileLocalScript = (spec) => {
      const full = path.resolve(path.join(__dirname, '../scripts'), spec);
      if (compiledModules.has(full)) return compiledModules.get(full);
      const loaded = compile(fs.readFileSync(full, 'utf8'), path.basename(full));
      compiledModules.set(full, loaded);
      return loaded;
    };
    const fixtureRequire = (spec) => (
      spec === 'node:fs' ? fixtureFs
        : spec === 'node:path' ? path.posix
          : spec === './releaseWorkerCodeRepair.cjs' ? fixturePolicy
            : spec === './releaseWorkerPreflight.cjs' ? fixtureWorker
              : spec === './nativeReleaseDataPlane.cjs' ? fixtureDriver
                : spec === '../server/dataGenerationStore.cjs' ? fixtureGenerations
                  : (spec.startsWith('./') || spec.startsWith('../')) && fs.existsSync(path.resolve(path.join(__dirname, '../scripts'), spec))
                    ? compileLocalScript(spec)
                    : require(spec)
    );
    context.require = fixtureRequire;
    const service = {
      ActiveState: 'active',
      MainPID: '3163101',
      ExecMainStartTimestamp: new Date(boundAuth.incident.anchor.workerStartedAt).toUTCString(),
    };
    const liveWorker = {
      checkedAt: new Date(nowMs - 500).toISOString(),
      serviceBefore: service,
      serviceAfter: service,
      processMatches: true,
      status: {
        pid: 3163101,
        checkedAt: new Date(nowMs - 1_000).toISOString(),
        ok: true,
        phase: 'official-result',
        lastCycle: {
          ok: false,
          phase: 'official-result-failed',
          startedAt: boundAuth.incident.anchor.cycleStartedAt,
          finishedAt: boundAuth.incident.anchor.cycleFinishedAt,
          errorCode: 'SYNC_WORKER_COMMAND_FAILED',
          error: 'npm run postgres:sync exited with 1',
        },
      },
    };
    fixtureWorker = {
      evaluateWorkerPreflight: new vm.Script(`(${workerPreflight.evaluateWorkerPreflight.toString()})`).runInContext(context),
      collectWorkerPreflight: () => realm(liveWorker),
      buildReadOnlyWorkerProbe: () => '',
    };
    fixturePolicy = compile(policySource, 'policy.cjs');
    fixturePolicy.candidateAuthorization = (_r, a) => fixturePolicy.validateWorkerCodeRepairAuthorization(a, Date.now());
    const inlineJournal = JSON.stringify(inlineFailure(), null, 2).split('\n').map((message) => ({
      unit: 'football-sync-worker.service',
      pid: boundAuth.incident.anchor.journalPid,
      timestampUs: boundAuth.incident.anchor.journalTimestampUs,
      timestampMs: Number(boundAuth.incident.anchor.journalTimestampUs) / 1000,
      message,
    }));
    fixturePolicy.collectWorkerCodeRepair = () => realm({
      runtimeSha256: boundAuth.baseRuntimeSha256,
      completeSha256: boundAuth.baseRuntimeSha256,
      recoveryPending: false,
      files: boundAuth.files.map((r) => ({ path: r.path, sha256: r.beforeSha256 })),
      dataContract: boundAuth.dataContract,
      migrationNames: ['001_core.sql'],
      publication: boundAuth.publication,
      journal: inlineJournal,
      meta: boundAuth.incident.source,
      unchangedSources: boundAuth.unchangedSources,
      addedSourcesAbsent: repair.R941_STABILITY_ADDED,
    });
    fixtureDriver = compile(
      "const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');"
      + rootFunctions + '\nmodule.exports={secureDirectory,read,write};',
      'driver.cjs',
    );
    const subject = compile(nativeSource, 'native-code.cjs');
    const session = {
      identity: boundAuth.publication.committed,
      publication: {
        context: structuredClone(contexts.committed),
        pairing: { reason: 'exact-committed-postgres-generation' },
      },
    };
    const captured = subject.captureFreshRepairPair(realm(state), realm(session), directory, tmp);
    assert.equal(captured.capture.body.route, 'repair');
    assert.equal(captured.incidentPair.bindingPolicy, 'fresh-r941-stability-incident-before-lease-v1');
    assert.equal(captured.incidentPair.productionWrites, 0);
    assert.throws(() => subject.captureFreshRepairPair(realm(state), realm(session), directory, tmp), /re-capture is forbidden/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('read-only r941 observation probe compiles cleanly and preflight/deploy entrypoints wire worker-code-repair-v11', () => {
  const obsProbe = buildR941ObservationProbe();
  new vm.Script(obsProbe);
  assert.ok(!obsProbe.includes('writeFileSync'));
  assert.ok(obsProbe.includes('READ ONLY'));

  const preflightSrc = fs.readFileSync(path.join(__dirname, '../scripts/runReleaseWorkerPreflight.cjs'), 'utf8');
  assert.ok(preflightSrc.includes("auth.version==='worker-code-repair-v11'"));
  assert.ok(preflightSrc.includes("'/run/lock/football-release.lock'"));

  const deploySrc = fs.readFileSync(path.join(__dirname, '../scripts/deployReleaseBundle.cjs'), 'utf8');
  assert.ok(deploySrc.includes("parsedAuthorization.version === 'worker-code-repair-v11'"));
  assert.ok(deploySrc.includes('repairPolicy.R941_STABILITY_ADDED'));
  assert.ok(deploySrc.includes('repairPolicy.R941_STABILITY_UNCHANGED'));
});
