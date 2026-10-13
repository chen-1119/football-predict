'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../scripts/verifyNativeCodeServing.cjs');
const identity = n => ({ generationId: 'g-' + n, manifestHash: n.repeat(64), sourceCycleId: 'cycle-' + n,
  committedAt: '2026-10-13T0' + n + ':00:00.000Z' });
function fixture(repair = true) {
  const committed = identity('1'), raw = repair ? identity('2') : committed;
  const blockers = repair ? ['generationId', 'manifestHash', 'sourceCycleId', 'committedAt']
    .map(k => 'public-postgres-publication-identity-mismatch:' + k).concat('public-postgres-source-cycle-mismatch') : [];
  const healthReport = { ok: true, storage: { publication: committed } };
  return { healthReport, identity: committed,
    pair: repair ? { version: 'signed-committed-generation-repair-pair-v1', reason: 'exact-signed-incident-pair',
      committed, rawCurrent: raw, productionWrites: 0 } : null,
    workerObservation: { ready: !repair, blockers, validationReady: true, generationReady: true, projectionReady: true,
      postgres: { ...committed, readable: true, generationSourceCycleId: committed.sourceCycleId }, generation: raw } };
}
test('signed serving acceptance retains all five original worker blockers', () => {
  const f = fixture(), before = structuredClone(f), r = gate.assessServing(f);
  assert.equal(r.ok, true); assert.equal(r.originalWorkerReadiness, false);
  assert.equal(r.originalWorkerBlockers.length, 5); assert.equal(r.naturalCycleAcceptance, false);
  assert.equal(r.newSourceFreshnessAccepted, false); assert.deepEqual(f, before);
});
test('ordinary route accepts equal publications only', () => assert.equal(gate.assessServing(fixture(false)).ok, true));
test('missing repair pair cannot authorize raw/PG divergence', () => assert.throws(() => gate.assessServing({ ...fixture(), pair: null })));
for (const key of ['generationId', 'manifestHash', 'sourceCycleId', 'committedAt']) {
  test('health publication drift rejected: ' + key, () => {
    const f = structuredClone(fixture()); f.healthReport.storage.publication = { ...f.identity, [key]: 'changed' };
    assert.throws(() => gate.assessServing(f));
  });
}
for (const field of ['validationReady', 'generationReady', 'projectionReady']) {
  test('unrelated worker failure rejected: ' + field, () => {
    const f = fixture(); f.workerObservation[field] = false; assert.throws(() => gate.assessServing(f));
  });
}
test('extra worker blocker rejected', () => {
  const f = fixture(); f.workerObservation.blockers.push('postgres-unreadable'); assert.throws(() => gate.assessServing(f));
});
test('falsely promoted worker readiness rejected', () => {
  const f = fixture(); f.workerObservation.ready = true; assert.throws(() => gate.assessServing(f));
});
function normal() {
  const sha = 'a'.repeat(64), pub = identity('1'), contract = { version: 'fixed-contract' };
  return [{ version: 'native-release-preparation-v1', sha, oldSha: 'b'.repeat(64), key: 'c'.repeat(64),
    kind: 'runtime-only', dataPlane: 'code-only', candidateDatabase: 'football', oldDatabaseOid: '17', candidateOid: '17',
    contract, schemaCatalogHash: 'd'.repeat(64) },
  { bundleSha: sha, phase: 'swap-complete', newIdentity: { sha }, native: { contract } }, sha, sha,
  { ok: true, sha, kind: 'runtime-only', databaseOid: '17', databaseWrites: 0, databaseRenames: 0, publication: pub },
  { ok: true, sha, dataPlane: 'code-only', databaseCopies: 0, identity: pub }, { sha, identity: pub }];
}
test('normal transaction requires finalized seed identity', () => gate.assertNormalState(...normal()));
for (const [label, mutate] of [
  ['cold recovery capsule', x => { x[0].coldRecoveryAuthorizationId = 'old-capsule'; }],
  ['wrong phase', x => { x[1].phase = 'candidate-validated'; }],
  ['wrong installed marker', x => { x[3] = 'b'.repeat(64); }],
  ['different database', x => { x[0].candidateOid = '18'; }],
  ['changed transaction', x => { x[1].native.contract = { version: 'other' }; }],
  ['unfinalized data', x => { x[4].ok = false; }],
  ['changed seed', x => { x[5].identity = identity('2'); }],
  ['changed captured identity', x => { x[6].identity = identity('2'); }],
]) test('normal transaction rejects ' + label, () => { const x = normal(); mutate(x); assert.throws(() => gate.assertNormalState(...x)); });

function orchestration() {
  const f = fixture(), calls = [], session = { identity: f.identity,
    client: { query: async () => ({ rows: [{ readonly: 'on', isolation: 'repeatable read' }] }) },
    guardedFinals: async () => calls.push('guard'), close: async () => calls.push('close') };
  const ops = { finalized: { publication: f.identity }, assertPersistent: () => calls.push('persistent'),
    verifyClock: () => calls.push('clock'), health: async () => structuredClone(f.healthReport),
    worker: async () => f.workerObservation, openSession: async () => session,
    bindPair: received => { assert.equal(received, session); return () => structuredClone(f.pair); },
    archives: async received => { assert.equal(received, session); calls.push('archives'); return { ok: true }; } };
  return { ops, calls, session };
}
test('same protected session covers serving, archive and before/after checks', async () => {
  const x = orchestration(), r = await gate.verifyServingSession(x.ops);
  assert.deepEqual(x.calls, ['persistent','clock','guard','archives','guard','persistent','clock','close']);
  assert.equal(r.recommendationAdoptionAccepted, false); assert.equal(r.originalWorkerReadiness, false);
});
for (const [label, mutate] of [
  ['archive mismatch', x => { x.ops.archives = async () => { throw Error('archive mismatch'); }; }],
  ['receipt failure', x => { x.session.guardedFinals = async () => { throw Error('receipt failure'); }; }],
  ['writable transaction', x => { x.session.client.query = async () => ({ rows: [{ readonly: 'off', isolation: 'repeatable read' }] }); }],
  ['after-health drift', x => { let n=0; x.ops.health = async () => ({ ok: true, storage: { publication: identity(++n===1?'1':'2') } }); }],
  ['after-pointer drift', x => { let n=0; x.ops.bindPair = () => () => ({ ...fixture().pair, captureSha256: String(++n) }); }],
  ['worker restart', x => { let n=0; x.ops.assertPersistent = () => { if (++n===2) throw Error('worker restarted'); }; }],
  ['lease expired', x => { let n=0; x.ops.verifyClock = () => { if (++n===2) throw Error('lease expired'); }; }],
]) test('session closes and rejects ' + label, async () => {
  const x = orchestration(); mutate(x); await assert.rejects(gate.verifyServingSession(x.ops));
  assert.equal(x.calls.at(-1), 'close');
});

test('actual Bash dispatch uses the new code gate and retains the database gate', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const source = fs.readFileSync(path.join(__dirname, '../deploy/light-server/release-native.sh'), 'utf8').replace(/\r\n/g, '\n');
  const body = source.match(/^native_finish_readiness\(\) \{[\s\S]*?^\}/m)[0];
  const vars = [...new Set([...body.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map(m => m[1]))];
  const stubs = ['prepare_release_enrichment_reuse_request','clear_release_enrichment_reuse_request',
    'prepare_release_worker_priority_request','start_worker_for_live_release','release_stage_observe',
    'wait_for_worker_official_publish_after','wait_for_worker_readiness_idle_after','systemctl','wait_for_health',
    'assert_release_stopped_code_worker','refresh_candidate_capture_heartbeat_for_readiness','freeze_worker_for_readiness',
    'wait_for_frozen_worker_children_to_drain','start_release_candidate_heartbeat_keeper','clear_release_worker_priority_request',
    'wait_for_release_candidate_heartbeat_keeper_healthy','install','sync','wait_for_release_candidate_heartbeat_public_budget',
    'stop_release_candidate_heartbeat_keeper','resume_worker_after_readiness','write_recovery_phase',
    'restore_native_auxiliary_states_after_readiness','enable_managed_timers_after_readiness','chown','chmod','mv',
    'commit_release_transaction','clear_release_recovery_snapshot','cleanup_release_static_attestations','log'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'normal-serving-bash-'));
  // Fixtures contain only generated scripts and logs under this new temp root.
  try {
    for (const mode of [0,1]) for (const rejected of [false,true]) {
      const dir = path.join(root, mode + '-' + rejected); fs.mkdirSync(path.join(dir,'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir,'bin/node'), '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$1" >> "$EVENTS"\ncase "$1" in *verifyNativeCodeServing.cjs|*verifyNativeDeploymentCore.cjs) [ "$REJECT_GATE" = 0 ] || exit 42;; esac\n', { mode: 0o700 });
      const setup = vars.filter(v => !['PATH','HOME','SECONDS'].includes(v)).map(v => v + '=0').join('\n') + '\n' +
        'export EVENTS="$PWD/events" REJECT_GATE=' + (rejected?1:0) + '\nNODE_HOME="$PWD"\nAPP_DIR="$PWD"\nTRUSTED_SOURCE_DIR="$PWD"\n' +
        'PUBLIC_BASE_URL=\nNATIVE_CODE_RELEASE=' + mode + '\nCODE_CUTOVER_STARTED_SECONDS=$SECONDS\n' +
        stubs.map(n => n + '() { printf "%s\\n" ' + n + ' >> "$EVENTS"; }').join('\n') + '\n' +
        'run_as_service_user_with_runtime_env() { "$@"; }\n';
      const result = spawnSync(process.platform==='win32'?'D:/app/Git/bin/bash.exe':'/bin/bash', ['--noprofile','--norc','-s'],
        { cwd: dir, input: 'set -euo pipefail\n' + setup + body + '\nnative_finish_readiness\n', encoding: 'utf8', windowsHide: true, timeout: 10000 });
      assert.equal(result.status, rejected?42:0, result.stderr);
      const events = fs.readFileSync(path.join(dir,'events'),'utf8');
      assert.equal(events.includes('verifyNativeCodeServing.cjs'), mode===1);
      assert.equal(events.includes('verifyNativeDeploymentCore.cjs'), mode===0);
      assert.equal(events.includes('commit_release_transaction'), !rejected);
      if (!rejected && mode===0) assert(events.includes('verifyReleaseArchiveSuccessor.cjs'));
      if (rejected) assert(!events.includes('codeReleaseAcceptance.cjs'));
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});
