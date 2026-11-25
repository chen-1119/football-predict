'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const repair = require('../scripts/releaseWorkerCodeRepair.cjs');
const base = require('../scripts/releaseWorkerPreflight.cjs');
const code = require('../scripts/nativeCodeReleaseDataPlane.cjs');
const {
  R942_BASELINE_TARGET_HASHES,
  buildR942ObservationProbe,
  mintR942WorkerCodeRepairAuthorization,
} = require('../scripts/buildR942WorkerCodeRepairAuthorization.cjs');

const hex = (ch) => String(ch).repeat(64).slice(0, 64);
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function createCandidateRootFixture(baseDir) {
  const candidateRoot = path.join(baseDir, 'candidate');
  fs.mkdirSync(candidateRoot, { recursive: true });
  for (const rel of repair.R942_RESULT_IDENTITY_TARGETS) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// candidate-r942-fix:${rel}\n`, 'utf8');
  }
  for (const rel of repair.R942_RESULT_IDENTITY_ADDED) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// candidate-r942-added:${rel}\n`, 'utf8');
  }
  for (const rel of repair.R942_RESULT_IDENTITY_UNCHANGED) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// r942-unchanged:${rel}\n`, 'utf8');
  }
  for (const rel of [...repair.DATA_FILES, 'server/postgres/migrations/001_core.sql']) {
    const full = path.join(candidateRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `-- data-contract:${rel}\n`, 'utf8');
  }
  return candidateRoot;
}

function buildObservationFixture(nowMs) {
  const mk = (seed, agoMs) => ({
    mode: 'active-generation',
    generationId: 'g-' + hex(seed),
    manifestHash: hex(seed),
    sourceCycleId: `sporttery-full-sync:${new Date(nowMs - agoMs - 60_000).toISOString()}`,
    committedAt: new Date(nowMs - agoMs).toISOString(),
  });
  const publication = {
    databaseOid: '28598409',
    committed: mk('1', 3_600_000),
    rawPrevious: mk('2', 1_200_000),
    rawCurrent: mk('3', 300_000),
  };
  const workerStartedAt = new Date(new Date(nowMs - 7_200_000).toUTCString()).toISOString();
  const cycleStartedAt = new Date(nowMs - 180_000).toISOString();
  const cycleFinishedAt = new Date(nowMs - 120_000).toISOString();
  const identity = {
    sourceMatchId: '2042994',
    eventVersion: '2026-11-24T10:00:00.000Z',
    resultIdentity: '3:2|sporttery:official-api',
    observedAt: '2026-11-24T12:24:15.152Z',
    settledAt: '2026-11-24T12:24:15.152Z',
  };
  const failure = {
    ok: false,
    code: 'POSTGRES_RESULT_ONLY_REVIEW_CONFLICT_UNSAFE',
    error: 'Existing stable review id is not a safe result-only canonical rebase',
    reviewId: 'review:0819ac5b0c889f63749e5f0cd3f1033768c7c743e1bd15ea54c72318a5138a36',
    existingMatchId: 'sporttery_2042994',
    incomingMatchId: 'fivehundred_2042994',
    existingObservationId: 'result:af81060809aa856872db955812b1c7da1db93cc9dec18d98c7f58a20c464e72e',
    incomingObservationId: 'result:a19a2cfc15faac6048d2944a5959b3d991634a3159e179694e6fccf3064c4961',
    existingIdentity: identity,
    incomingIdentity: { ...identity },
  };
  const frameText = JSON.stringify(failure, null, 2);
  const journalTimestampUs = String((nowMs - 120_050) * 1000);
  const incident = {
    workerMainPid: '3597946',
    workerStartedAt,
    cycleStartedAt,
    cycleFinishedAt,
    journalPid: '3603577',
    journalTimestampUs,
    journalMessageSha256: sha256(frameText),
    failure,
  };
  return {
    version: 'r942-result-identity-incident-observation-v1',
    observedAt: new Date(nowMs).toISOString(),
    workerHealthy: false,
    publication,
    incident,
    productionWrites: 0,
  };
}

test('worker-code-repair-v12 mints, validates, enforces r942 baseline/unchanged hashes, and handles sleeping or retrying workers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r942-repair-v12-'));
  try {
    const candidateRoot = createCandidateRootFixture(tmp);
    const nowMs = Date.now();
    const obs = buildObservationFixture(nowMs);
    const auth = mintR942WorkerCodeRepairAuthorization({
      candidateRoot,
      observation: obs,
      createdAt: new Date(nowMs - 5_000).toISOString(),
    });
    assert.equal(auth.version, 'worker-code-repair-v12');
    assert.equal(auth.baseRuntimeSha256, 'd4a33ddf3636dc30a5742a0c7d9a1645e5765f289e741908527470b548365990');
    assert.equal(auth.bindingPolicy, 'fresh-r942-result-identity-incident-before-lease-v1');
    assert.equal(auth.reason, 'official-result-post-cutoff-gate-identity-regression');
    assert.deepEqual(repair.candidateAuthorization(candidateRoot, auth), auth);
    assert.equal(Object.keys(R942_BASELINE_TARGET_HASHES).length, repair.R942_RESULT_IDENTITY_TARGETS.length);

    const service = {
      ActiveState: 'active',
      MainPID: '3597946',
      ExecMainStartTimestamp: new Date(obs.incident.workerStartedAt).toUTCString(),
    };
    const repeatedCycleStart = new Date(nowMs - 60_000).toISOString();
    const repeatedCycleEnd = new Date(nowMs - 2_000).toISOString();
    const repeatedTsUs = String((nowMs - 2_050) * 1000);
    const workerRetrying = {
      checkedAt: new Date(nowMs).toISOString(),
      serviceBefore: service,
      serviceAfter: service,
      processMatches: true,
      status: {
        pid: 3597946,
        checkedAt: new Date(nowMs - 1_000).toISOString(),
        ok: true,
        phase: 'official-result',
        lastCycle: {
          ok: false,
          startedAt: repeatedCycleStart,
          finishedAt: repeatedCycleEnd,
          phase: 'official-result-failed',
          errorCode: 'SYNC_WORKER_COMMAND_FAILED',
          error: 'npm run postgres:sync exited with 1',
        },
      },
    };
    const journal = JSON.stringify(obs.incident.failure, null, 2).split('\n').map((message) => ({
      unit: 'football-sync-worker.service',
      pid: '3609999',
      timestampUs: repeatedTsUs,
      timestampMs: Number(repeatedTsUs) / 1000,
      message,
    }));
    const observed = {
      runtimeSha256: auth.baseRuntimeSha256,
      completeSha256: auth.baseRuntimeSha256,
      recoveryPending: false,
      files: auth.files.map((r) => ({ path: r.path, sha256: r.beforeSha256 })),
      dataContract: structuredClone(auth.dataContract),
      migrationNames: ['001_core.sql'],
      publication: structuredClone(auth.publication),
      unchangedSources: structuredClone(auth.unchangedSources),
      addedSourcesAbsent: [...repair.R942_RESULT_IDENTITY_ADDED],
      journal,
    };

    // 1-blocker retrying worker
    const res1 = repair.evaluateWorkerCodeRepair(auth, workerRetrying, observed);
    assert.equal(res1.ok, true);
    assert.equal(res1.workerHealthy, false);
    assert.equal(res1.readyToCutover, false);
    assert.equal(res1.productionWrites, 0);
    assert.deepEqual(res1.workerReport.blockers, ['worker-official-recovery-unproven']);

    // 2-blocker sleeping failed worker
    const workerSleeping = structuredClone(workerRetrying);
    workerSleeping.status.ok = false;
    workerSleeping.status.phase = 'failed';
    workerSleeping.status.eventCycle = structuredClone(workerSleeping.status.lastCycle);
    const res2 = repair.evaluateWorkerCodeRepair(auth, workerSleeping, observed);
    assert.equal(res2.ok, true);
    assert.deepEqual(res2.workerReport.blockers, ['worker-latest-official-cycle-failed', 'worker-official-recovery-unproven']);

    // Healthy worker bypasses repair route
    const healthyWorker = structuredClone(workerRetrying);
    healthyWorker.status.lastCycle.ok = true;
    const selected = repair.selectWorkerCodeRepairPreparation(auth, healthyWorker, () => {
      throw new Error('inactive incident');
    });
    assert.equal(selected.useRepair, false);
    assert.equal(selected.report.ok, true);

    // Sealed fresh capture & assertRepairPair
    const state = {
      key: hex('4'),
      sha: hex('5'),
      oldSha: auth.baseRuntimeSha256,
      createdAt: new Date(nowMs - 30_000).toISOString(),
      oldDatabaseOid: '28598409',
      dataPlane: 'code-only',
      repairCapturePolicy: auth.bindingPolicy,
      committedGenerationRepairAuthorizationHash: hex('6'),
    };
    const context = (id) => ({
      pointer: id,
      manifest: {
        generationId: id.generationId,
        manifestHash: id.manifestHash,
        sourceCycleId: id.sourceCycleId,
        files: [{ path: 'matches-current.json', bytes: 2 }],
      },
    });
    const contexts = {
      committed: context(observed.publication.committed),
      rawCurrent: context(observed.publication.rawCurrent),
      rawPrevious: context(observed.publication.rawPrevious),
    };
    const actualIncident = repair.repeatedRepairIncident(auth, workerSleeping, observed.journal);
    const body = {
      sha: state.sha,
      oldSha: state.oldSha,
      stateHash: sha256(JSON.stringify(state)),
      authorizationHash: hex('6'),
      checkedAt: new Date(nowMs).toISOString(),
      worker: workerSleeping,
      observed,
      publication: observed.publication,
      route: 'repair',
      incident: actualIncident,
      generationEvidence: Object.fromEntries(Object.entries(contexts).map(([k, v]) => [k, code.generationVerificationEvidence(v)])),
    };
    const capture = code.sealFreshRepairCapture(state, body);
    const session = {
      identity: body.publication.committed,
      publication: { context: contexts.committed, pairing: { reason: 'exact-committed-postgres-generation' } },
    };
    assert.deepEqual(code.assertFreshRepairCapture(state, capture, auth, hex('6')), body);
    assert.equal(code.assertRepairPair(state, session, contexts.rawCurrent, contexts.rawPrevious, auth, hex('6'), capture).productionWrites, 0);

    // Rejects tampering
    for (const mutate of [
      (a) => { a.baseRuntimeSha256 = hex('9'); },
      (a) => { a.bindingPolicy = 'other'; },
      (a) => { a.unchangedSources[0].sha256 = hex('9'); },
      (a) => { a.addedSources.pop(); },
      (a) => { a.incident.failure.incomingMatchId = 'sporttery_2042994'; },
    ]) {
      const bad = structuredClone(auth);
      mutate(bad);
      assert.equal(repair.evaluateWorkerCodeRepair(bad, workerSleeping, observed).ok, false);
    }

    // Observation and serialized probes compile cleanly
    new vm.Script(buildR942ObservationProbe());
    new vm.Script(repair.buildWorkerCodeRepairProbe(auth));
    assert.equal(base.evaluateWorkerPreflight(workerSleeping).ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
