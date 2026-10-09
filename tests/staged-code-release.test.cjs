'use strict';
const { test } = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const lane = read('deploy/light-server/release-native.sh');
const body = name => { const m = lane.match(new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?^\\}', 'm')); a(m); return m[0]; };
const sha = 'a'.repeat(64), start = Date.parse('2026-10-09T08:00:00Z'), iso = seconds => new Date(start + seconds * 1000).toISOString();
const acceptance = require('../scripts/codeReleaseAcceptance.cjs');
const receipt = () => ({ version: 'code-release-acceptance-v1', bundleSha256: sha,
  engineeringAccepted: true, businessAccepted: false, dataPlane: 'code-only', databaseCopies: 0,
  parameterPromotion: false, workerStartedAt: iso(0), acceptedAt: iso(1) });
function worker() {
  const identity = { generationId: 'g-' + 'b'.repeat(64), manifestHash: 'c'.repeat(64), sourceCycleId: 'fixture-cycle', committedAt: iso(30) };
  const official = { ok: true, phase: 'official-result-published', startedAt: iso(2), finishedAt: iso(60) };
  return { ok: true, cycleState: 'sleeping', phase: 'sleeping', checkedAt: iso(91), eventCycle: official,
    lastCycle: { ok: true, startedAt: iso(2), finishedAt: iso(90), officialPhase: official,
      modelStrategyStep: { ok: true, skipped: true }, readinessSourceCycleObservation: {
        ready: true, blockers: [], generation: { mode: 'active-generation', ...identity },
        sqlite: { generationId: identity.generationId, manifestHash: identity.manifestHash,
          generationSourceCycleId: identity.sourceCycleId, committedAt: identity.committedAt, readable: true } } } };
}
test('engineering receipt with no new cycle remains pending', () => {
  const r = acceptance.assess(receipt(), {}, sha, start + 100000);
  a.equal(r.naturalCycleAccepted, false); a.equal(r.recommendationAdoptionAccepted, false);
});
test('new complete natural cycle has its own read-only acceptance, never model adoption', () => {
  const r = acceptance.assess(receipt(), worker(), sha, start + 100000);
  a.equal(r.naturalCycleAccepted, true); a.equal(r.recommendationAdoptionAccepted, false); a.equal(r.productionWrites, 0);
});
for (const change of ['old-cycle', 'old-official', 'failed', 'skipped', 'future', 'wrong-pg']) test('business observation rejects ' + change, () => {
  const s = worker();
  if (change === 'old-cycle') s.lastCycle.startedAt = iso(-1);
  if (change === 'old-official') s.lastCycle.officialPhase.startedAt = iso(-1);
  if (change === 'failed') s.lastCycle.ok = false;
  if (change === 'skipped') s.lastCycle.skipped = true;
  if (change === 'future') s.lastCycle.finishedAt = iso(200);
  if (change === 'wrong-pg') s.lastCycle.readinessSourceCycleObservation.sqlite.generationId = 'other';
  a.equal(acceptance.assess(receipt(), s, sha, start + 100000).naturalCycleAccepted, false);
});
for (const elapsed of [0, 599, 600, 901]) test('real Bash cutover elapsed boundary ' + elapsed, () => {
  const input = 'set -euo pipefail\nNATIVE_CODE_RELEASE=1\nSECONDS=0\nCODE_CUTOVER_STARTED_SECONDS=-' + elapsed + '\n' +
    'NODE_HOME=/fixture NEXT_DIR=/fixture CANDIDATE_TRANSITION_LEASE=/fixture/lease\n' +
    'log() { :; }\n/fixture/bin/node() { printf "verified\\n"; }\n' + body('native_code_verify_cutover_lease') + '\nnative_code_verify_cutover_lease 300\n';
  const r = spawnSync(process.platform === 'win32' ? 'D:/app/Git/bin/bash.exe' : '/bin/bash', ['--noprofile', '--norc', '-s'], {
    input, encoding: 'utf8', timeout: 5000, windowsHide: true });
  a.equal(r.status, elapsed < 600 ? 0 : 1, r.stderr);
  a.equal(r.stdout.includes('verified'), elapsed < 600);
});
test('receipt cannot silently promote business or use another code version', () => {
  a.throws(() => acceptance.assess({ ...receipt(), businessAccepted: true }, worker(), sha, start + 100000));
  a.throws(() => acceptance.assess(receipt(), worker(), 'd'.repeat(64), start + 100000));
});
const identity = { generationId: 'g-x', manifestHash: 'hash', sourceCycleId: 'cycle', committedAt: iso(0) };
test('unchanged publication may cross the code handover', () => acceptance.assertSamePublication(identity, { ...identity }));
for (const field of Object.keys(identity)) test('any publication component changing rejects cutover: ' + field, () => {
  a.throws(() => acceptance.assertSamePublication(identity, { ...identity, [field]: 'changed' }));
});
const transitions = require('../scripts/releaseTransitionLease.cjs');
test('code lease is durable before recovery exists, without creating recovery', () => {
  a.match(body('run_native_release'), /CANDIDATE_TRANSITION_LEASE="\$NATIVE_STATE_DIR\/code-transition-lease\.json"/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-lease-before-recovery-'));
  try {
    const native = path.join(dir, 'native'), recovery = path.join(dir, 'recovery');
    fs.mkdirSync(native); const current = path.join(dir, 'current.json'), lease = path.join(native, 'code-transition-lease.json');
    fs.writeFileSync(current, JSON.stringify([{ id: 'fixture', status: 'SCHEDULED', kickoffTime: iso(4800) }]));
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/releaseTransitionLease.cjs'), 'create', '--current', current,
      '--lease', lease, '--at', iso(0), '--verifier-runtime-max-seconds', '300', '--preverify-refresh-budget-seconds', '570', '--atomic-swap-margin-seconds', '30'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const r = run(); a.equal(r.status, 0, r.stderr); a.equal(fs.existsSync(recovery), false);
    a.equal(JSON.parse(fs.readFileSync(lease)).minimumHorizonSeconds, 900);
    a.notEqual(run().status, 0, 'existing lease cannot be overwritten');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const payload = () => [{ id: 'fixture', sourceMatchId: 'fixture', status: 'SCHEDULED', kickoffTime: iso(4800), predictionMeta: { cutoffTime: iso(1200) } }];
test('short lease covers only code handover and rejects a crossed deadline or modified data', () => {
  const p = payload(), lease = transitions.createTransitionLease(p, { refreshAt: iso(0), verifierRuntimeMaxSeconds: 300, preverifyRefreshBudgetSeconds: 570, atomicSwapMarginSeconds: 30 });
  a.equal(lease.minimumHorizonSeconds, 900);
  a.equal(transitions.verifyTransitionLease(p, lease, { verifiedAt: iso(300), requiredMarginSeconds: 300 }).ok, true);
  a.throws(() => transitions.verifyTransitionLease(p, lease, { verifiedAt: iso(1200) }));
  const changed = payload(); changed[0].predictionMeta.cutoffTime = iso(600);
  a.throws(() => transitions.verifyTransitionLease(changed, lease, { verifiedAt: iso(300) }));
});
test('near cutoff rejects instead of extending or disabling the code lease', () => {
  const p = payload(); p[0].predictionMeta.cutoffTime = iso(899);
  a.throws(() => transitions.createTransitionLease(p, { refreshAt: iso(0), verifierRuntimeMaxSeconds: 300, preverifyRefreshBudgetSeconds: 570, atomicSwapMarginSeconds: 30 }));
});
test('signed native upload preparation does not acquire a match window; legacy does', () => {
  const source = read('scripts/deployReleaseBundle.cjs'), begin = source.indexOf('  // Reject a closed window before the archive scan'), end = source.indexOf('  if (!nativeFullRelease) {', begin);
  for (const nativeFullRelease of [true, false]) {
    const calls = [], context = { dryRun: false, nativeFullRelease, releaseWindowPreflight: null,
      fail: m => { throw new Error(m); }, require: name => name.includes('Window')
        ? { runLiveReleaseWindowPreflight: () => { calls.push('window'); return { ok: false }; } }
        : { runLiveArchivePreflight: () => { calls.push('archive'); return { report: { ok: true } }; } } };
    const run = () => vm.runInNewContext(source.slice(begin, end), context);
    if (nativeFullRelease) { run(); a.deepEqual(calls, ['archive']); a.equal(context.releaseWindowPreflight.readyToCutover, false); }
    else { a.throws(run); a.deepEqual(calls, ['window']); }
  }
});
test('upload-only stops after remote byte verification, activation does not upload', () => {
  const source = read('scripts/deployReleaseBundle.cjs');
  a(source.indexOf('if (uploadOnly) {') > source.indexOf('const uploadedProof ='));
  a(source.indexOf('if (uploadOnly) {') < source.indexOf('const release = runCommand'));
  a.match(source, /for \(const artifact of \(activateOnly \? \[\] : uploads\)\)/);
  const begin = source.indexOf('if (uploadOnly) {'), end = source.indexOf('const release = runCommand', begin), output = [];
  vm.runInNewContext('(function(){' + source.slice(begin, end) + 'throw Error("fell through");})()', {
    uploadOnly: true, dryRun: false, actualSha256: sha, releaseWindowPreflight: {}, steps: [], console: { log: v => output.push(JSON.parse(v)) } });
  a.equal(output[0].controllerStarted, false); a.equal(output[0].serverSequenceConsumed, false);
});
const stubs = ['log', 'prepare_release_enrichment_reuse_request', 'clear_release_enrichment_reuse_request',
  'prepare_release_worker_priority_request', 'start_worker_for_live_release', 'release_stage_observe',
  'wait_for_worker_official_publish_after', 'wait_for_worker_readiness_idle_after', 'wait_for_health',
  'refresh_candidate_capture_heartbeat_for_readiness', 'freeze_worker_for_readiness', 'wait_for_frozen_worker_children_to_drain',
  'start_release_candidate_heartbeat_keeper', 'clear_release_worker_priority_request', 'run_as_service_user_with_runtime_env',
  'wait_for_release_candidate_heartbeat_keeper_healthy', 'wait_for_release_candidate_heartbeat_public_budget',
  'stop_release_candidate_heartbeat_keeper', 'resume_worker_after_readiness', 'write_recovery_phase',
  'restore_native_auxiliary_states_after_readiness', 'enable_managed_timers_after_readiness', 'commit_release_transaction',
  'clear_release_recovery_snapshot', 'cleanup_release_static_attestations', 'systemctl', 'install', 'sync', 'chown', 'chmod', 'mv'];
for (const spec of [{ code: 1 }, { code: 0 }, { code: 1, fail: 'run_as_service_user_with_runtime_env' }, { code: 1, fail: 'start_worker_for_live_release' }]) {
  test('real Bash finish path ' + JSON.stringify(spec), () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-code-bash-'));
    try {
      fs.mkdirSync(path.join(dir, 'node/bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node/bin/node'), '#!/usr/bin/env bash\nprintf "node:%s\\n" "$*"\n', { mode: 0o700 });
      const func = body('native_finish_readiness'), variables = [...new Set([...func.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map(m => m[1]))];
      const input = 'set -euo pipefail\n' + variables.filter(v => !['PATH', 'HOME'].includes(v)).map(v => v + '=fixture').join('\n') + '\n' +
        'APP_DIR="$PWD"\nNODE_HOME="$PWD/node"\nNATIVE_CODE_RELEASE=' + spec.code + '\n' +
        stubs.map(n => n + '() { printf "' + n + '\\n"; ' + (spec.fail === n ? 'return 1;' : 'return 0;') + ' }').join('\n') + '\n' + func + '\nnative_finish_readiness\n';
      const r = spawnSync(process.platform === 'win32' ? 'D:/app/Git/bin/bash.exe' : '/bin/bash', ['--noprofile', '--norc', '-s'], { cwd: dir, input, encoding: 'utf8', timeout: 10000, windowsHide: true });
      a.equal(r.status, spec.fail ? 1 : 0, r.stderr);
      const events = r.stdout.split('\n');
      a.equal(events.includes('wait_for_worker_official_publish_after'), spec.code === 0);
      a.equal(events.includes('wait_for_worker_readiness_idle_after'), spec.code === 0);
      a.equal(events.includes('commit_release_transaction'), !spec.fail);
      if (!spec.fail) {
        a(events.includes('start_worker_for_live_release'));
        a(events.indexOf('run_as_service_user_with_runtime_env') < events.indexOf('commit_release_transaction'));
        a.equal(r.stdout.includes('codeReleaseAcceptance.cjs write'), spec.code === 1);
      }
    } finally { a(path.basename(dir).startsWith('staged-code-bash-')); a.equal(fs.realpathSync(dir).toLowerCase(), path.resolve(dir).toLowerCase()); fs.rmSync(dir, { recursive: true }); }
  });
}
