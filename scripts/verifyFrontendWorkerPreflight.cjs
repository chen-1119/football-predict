'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const {
  evaluateWorkerPreflight,
  evaluateFrontendWorkerPreflight,
  buildReadOnlyWorkerProbe,
} = require('./releaseWorkerPreflight.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const base = {
  checkedAt: '2026-09-08T03:00:00.000Z', processMatches: true,
  serviceBefore: { ActiveState: 'active', MainPID: '42', ExecMainStartTimestamp: 'Tue 2026-09-08 02:00:00 UTC' },
  serviceAfter: { ActiveState: 'active', MainPID: '42', ExecMainStartTimestamp: 'Tue 2026-09-08 02:00:00 UTC' },
  status: { pid: 42, checkedAt: '2026-09-08T02:59:00Z', phase: 'official-result', ok: true },
};
const failed = { ...base.status, phase: 'failed', ok: false, errorCode: 'SYNC_WORKER_COMMAND_FAILED',
  lastCycle: { phase: 'official-result-failed', ok: false }, lastSuccessAt: '2026-09-08T02:58:00Z' };
const retry = { ...failed, ok: true, phase: 'official-result' };
const recovered = { ...retry,
  lastCycle: { phase: 'official-result-failed', ok: false, finishedAt: '2026-09-08T02:30:00Z' },
  eventCycle: { phase: 'official-result-published', ok: true, startedAt: '2026-09-08T02:31:00Z', finishedAt: '2026-09-08T02:58:00Z' } };
const observation = patch => ({ ...structuredClone(base), ...patch });
const dataBlockers = ['worker-latest-official-cycle-failed', 'worker-official-recovery-unproven'];

// The serialized SSH program sees only the real collector's approved reads.
// There is no shell, network, service mutation, or production status file here.
function serializedProbe(source, input = base, fault = null) {
  const output = [], calls = [];
  let serviceReads = 0, statReads = 0, closed = 0;
  const info = { isFile: () => fault !== 'not-file', nlink: fault === 'hard-link' ? 2 : 1,
    size: fault === 'oversized' ? 4 * 1024 * 1024 + 1 : 100, mtimeMs: 1 };
  const filesystem = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1 },
    openSync(file, flags) {
      assert.equal(file, '/var/lib/football-predict/sync-worker-status.json');
      assert.equal(flags, 1); calls.push('open-readonly-nofollow');
      if (fault === 'missing-file') throw new Error('fixture-status-missing');
      return 9;
    },
    fstatSync(fd) { assert.equal(fd, 9); statReads++; return { ...info, mtimeMs: fault === 'changed-file' ? statReads : 1 }; },
    closeSync(fd) { assert.equal(fd, 9); closed++; },
    readlinkSync(file) { assert.equal(file, '/proc/42/cwd'); return fault === 'wrong-process' ? '/fixture/unrelated' : '/opt/football-predict'; },
    readFileSync(file) {
      if (file === 9) return fault === 'malformed-json' ? '{' : JSON.stringify(input.status);
      assert.equal(file, '/proc/42/cmdline');
      return fault === 'wrong-process' ? '/opt/node-v22.22.1/bin/node\0unrelated.cjs\0'
        : '/opt/node-v22.22.1/bin/node\0scripts/runSyncWorker.cjs\0';
    },
  };
  const child = { execFileSync(command, args, options) {
    assert.equal(command, 'systemctl');
    assert.deepEqual(Array.from(args), ['show', 'football-sync-worker.service', '--property=ActiveState,MainPID,ExecMainStartTimestamp', '--no-pager']);
    assert.equal(options.timeout, 5000); assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.env.TZ, 'UTC');
    calls.push('systemctl-show');
    const service = serviceReads++ === 0 ? input.serviceBefore : input.serviceAfter;
    return Object.entries(service).map(([key, value]) => key + '=' + value).join('\n');
  } };
  const processMock = { env: {}, exitCode: 0 };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [input.checkedAt])); } }
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'node:fs') return filesystem;
      if (name === 'node:child_process') return child;
      throw new Error('unexpected probe dependency: ' + name);
    },
    process: processMock, console: { log: value => output.push(JSON.parse(value)) }, Date: FixedDate,
  }, { timeout: 1000 });
  assert.equal(output.length, 1); assert.equal(output[0].productionWrites, 0); assert.equal(output[0].readyToCutover, false);
  assert.equal(processMock.exitCode, output[0].ok ? 0 : 1);
  assert.equal(closed, fault === 'missing-file' ? 0 : 1);
  return { report: output[0], calls, serviceReads, exitCode: processMock.exitCode };
}

async function verifyFrontendWorkerPreflight() {
  const checks = [];
  const check = async (name, run) => { await run(); checks.push({ name, ok: true }); };
  await check('default and explicit full serialized policy are identical', () => {
    assert.equal(buildReadOnlyWorkerProbe(), buildReadOnlyWorkerProbe({ releaseKind: 'full' }));
    assert.equal(buildReadOnlyWorkerProbe({}), buildReadOnlyWorkerProbe());
  });
  for (const releaseKind of ['ui', '', null, false, 0, {}, [], 'FULL', 'frontend-only '])
    await check('unsupported probe kind rejected: ' + JSON.stringify(releaseKind), () =>
      assert.throws(() => buildReadOnlyWorkerProbe({ releaseKind }), /unsupported-worker-preflight-release-kind/));

  for (const [name, status, blocker] of [
    ['failed latest official cycle', failed, dataBlockers[0]],
    ['running retry without official recovery receipt', retry, dataBlockers[1]],
  ]) await check(name + ' remains a visible warning only for frontend', () => {
    const input = observation({ status }), full = evaluateWorkerPreflight(input), frontend = evaluateFrontendWorkerPreflight(input);
    assert.equal(full.ok, false); assert.ok(full.blockers.includes(blocker));
    assert.equal(frontend.ok, true); assert.deepEqual(frontend.blockers, []); assert.deepEqual(frontend.warnings, [blocker]);
    assert.equal(frontend.state, 'prepare-may-continue'); assert.equal(frontend.officialPublicationRequired, false);
    assert.equal(frontend.readyToCutover, false); assert.equal(frontend.productionWrites, 0);
    assert.equal(frontend.errorCode, full.errorCode); assert.equal(frontend.phase, full.phase); assert.equal(frontend.statusAt, full.statusAt);
  });
  const unsafe = [
    ['inactive before', { serviceBefore: { ...base.serviceBefore, ActiveState: 'inactive' } }, 'worker-service-inactive'],
    ['inactive after', { serviceAfter: { ...base.serviceAfter, ActiveState: 'inactive' } }, 'worker-service-inactive'],
    ['PID changed', { serviceAfter: { ...base.serviceAfter, MainPID: '43' } }, 'worker-process-changed'],
    ['PID reused', { serviceAfter: { ...base.serviceAfter, ExecMainStartTimestamp: 'Tue 2026-09-08 02:30:00 UTC' } }, 'worker-process-changed'],
    ['invalid PID', { serviceAfter: { ...base.serviceAfter, MainPID: '0' } }, 'worker-process-changed'],
    ['unconfirmed executable', { processMatches: false }, 'worker-process-not-confirmed'],
    ['status PID mismatch', { status: { ...failed, pid: 41 } }, 'worker-status-pid-mismatch'],
    ['status before process', { status: { ...failed, checkedAt: '2026-09-08T01:59:00Z' } }, 'worker-status-clock-unbound'],
    ['future status', { status: { ...failed, checkedAt: '2026-09-08T04:00:00Z' } }, 'worker-status-clock-unbound'],
    ['invalid service start', { serviceAfter: { ...base.serviceAfter, ExecMainStartTimestamp: 'bad' } }, 'worker-status-clock-unbound'],
    ['invalid probe clock', { checkedAt: 'bad' }, 'invalid-probe-clock'],
    ['missing status', { status: null }, 'worker-status-missing'],
    ['array status', { status: [] }, 'worker-status-missing'],
    ['unknown status', { status: { ...failed, ok: undefined } }, 'worker-status-not-understood'],
    ['failure without failed phase', { status: { ...failed, phase: 'official-result' } }, 'worker-status-not-understood'],
  ];
  for (const [name, patch, blocker] of unsafe) await check('frontend still rejects ' + name, () => {
    const input = observation({ status: failed, ...patch }), full = evaluateWorkerPreflight(input), frontend = evaluateFrontendWorkerPreflight(input);
    assert.equal(frontend.ok, false); assert.equal(frontend.state, 'prepare-rejected'); assert.ok(frontend.blockers.includes(blocker));
    assert.deepEqual(frontend.blockers, full.blockers.filter(code => !dataBlockers.includes(code)));
    assert.deepEqual(frontend.warnings, [...full.warnings, ...full.blockers.filter(code => dataBlockers.includes(code))]);
  });
  await check('healthy and real recovery remain preparation only', () => {
    for (const status of [base.status, recovered]) {
      const report = evaluateFrontendWorkerPreflight(observation({ status }));
      assert.equal(report.ok, true); assert.deepEqual(report.warnings, []); assert.equal(report.readyToCutover, false);
    }
  });
  await check('existing slow-enrichment warning preserved without duplication', () => {
    const status = { ...failed, lastCycle: { phase: 'slow-enrichment-failed', ok: false }, eventCycle: { phase: 'official-result-published', ok: true } };
    const report = evaluateFrontendWorkerPreflight(observation({ status }));
    assert.equal(report.ok, true); assert.deepEqual(report.warnings, ['worker-slow-enrichment-failed-official-phase-published']);
  });
  await check('frontend report still redacts arbitrary error text', () => {
    const report = evaluateFrontendWorkerPreflight(observation({ status: { ...failed, error: 'fixture-secret', errorCode: 'https://fixture-secret' } }));
    assert.equal(report.errorCode, null); assert.ok(!JSON.stringify(report).includes('fixture-secret'));
  });

  for (const kind of ['full', 'frontend-only']) {
    const evaluator = kind === 'full' ? evaluateWorkerPreflight : evaluateFrontendWorkerPreflight;
    for (const [name, status] of [['healthy', base.status], ['failed', failed], ['retry', retry], ['recovered', recovered],
      ['wrong PID', { ...failed, pid: 41 }], ['future clock', { ...failed, checkedAt: '2026-09-08T04:00:00Z' }]])
      await check(kind + ' VM executes actual serialized evaluator: ' + name, () => {
        const input = observation({ status }), result = serializedProbe(buildReadOnlyWorkerProbe({ releaseKind: kind }), input);
        assert.deepEqual(result.report, evaluator(input)); assert.equal(result.serviceReads, 2);
        assert.deepEqual(result.calls, ['systemctl-show', 'open-readonly-nofollow', 'systemctl-show']);
      });
    for (const fault of ['missing-file', 'malformed-json', 'not-file', 'hard-link', 'oversized', 'changed-file', 'wrong-process'])
      await check(kind + ' VM rejects unsafe collector input: ' + fault, () => {
        const result = serializedProbe(buildReadOnlyWorkerProbe({ releaseKind: kind }), observation({ status: failed }), fault);
        assert.equal(result.report.ok, false);
        assert.ok(result.report.blockers.includes(fault === 'wrong-process' ? 'worker-process-not-confirmed' : 'worker-probe-unavailable'));
      });
  }

  // Exercise the controller's real bounded health function, without HTTP.
  const controller = read('scripts/frontendReleaseController.cjs');
  const healthStart = controller.indexOf('async function health(base, expectedState) {');
  const healthEnd = controller.indexOf('\nfunction activeServices()', healthStart);
  assert.ok(healthStart > 0 && healthEnd > healthStart);
  const expected = { frontendSha256: 'b'.repeat(64), frontendSequence: 712, runtimeSha256: 'a'.repeat(64), runtimeSequence: 711 };
  const healthValue = { apiVersion: 'v1', status: { serviceOk: true, dataFresh: false, recommendationReliable: false },
    frontendRelease: { ...expected, available: true, consistent: true } };
  const health = (value, status = 200) => vm.runInNewContext(controller.slice(healthStart, healthEnd) + '\nhealth(base, expected);', {
    URL, Buffer, base: new URL('https://fixture.invalid/'), expected,
    request: async (url, limit) => {
      assert.equal(url.href, 'https://fixture.invalid/api/v1/health'); assert.equal(limit, 2 * 1024 * 1024);
      return { status, bytes: Buffer.from(JSON.stringify(value)) };
    },
    fail: message => { throw new Error(message); },
  }, { timeout: 1000 });
  await check('actual frontend health permits unresolved data with exact service identity', async () => {
    const result = await health(healthValue); assert.equal(result.status.dataFresh, false); assert.equal(result.status.recommendationReliable, false);
  });
  for (const [name, value, status] of [
    ['unavailable service', { ...healthValue, status: { serviceOk: false } }, 200],
    ['wrong API version', { ...healthValue, apiVersion: 'v0' }, 200], ['non-200', healthValue, 503],
  ]) await check('actual frontend health rejects ' + name, () => assert.rejects(health(value, status), /frontend-acceptance-service-unavailable/));
  for (const change of [{ available: false }, { consistent: false }, { frontendSha256: 'c'.repeat(64) }, { frontendSequence: 713 },
    { runtimeSha256: 'c'.repeat(64) }, { runtimeSequence: 710 }])
    await check('actual frontend health rejects identity drift ' + JSON.stringify(change), () =>
      assert.rejects(health({ ...healthValue, frontendRelease: { ...healthValue.frontendRelease, ...change } }), /frontend-acceptance-health-identity-mismatch/));

  // Authenticate real RSA-signed synthetic manifests, then execute the actual
  // client route and upload loop in a VM. Only tar reads a disposable fixture;
  // every SSH/SCP/clone/window operation below is an observed test double.
  const deploy = read('scripts/deployReleaseBundle.cjs');
  const slice = (startText, endText) => {
    const start = deploy.indexOf(startText), end = deploy.indexOf(endText, start);
    assert.ok(start > 0 && end > start, 'missing actual client section: ' + startText); return deploy.slice(start, end);
  };
  const fileHelpers = slice('const readShaFile =', 'const remoteJoin =');
  const commandHelpers = slice('const shellQuote =', '\nif (recoverMode) {');
  const authenticated = slice('const shaPath = `${bundlePath}.sha256`;', '// End authenticated local routing;');
  const preflightBuilder = slice('const remotePreflightCommand = buildRemotePreflightCommand(', 'const remoteBundlePath =');
  const preflightAndUploads = slice('const remotePreflight = runCommand(', 'const release = runCommand(');
  assert.ok(deploy.indexOf('verifyManifestSignature({') < deploy.indexOf('const releaseCandidate ='));
  assert.ok(deploy.indexOf('const remotePreflight = runCommand(') < deploy.indexOf('for (const artifact of uploads)'));
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'football-frontend-worker-preflight-'));
  const fixtureInfo = fs.lstatSync(fixture);
  const bundlePath = path.join(fixture, 'fixture.tgz'), source = path.join(fixture, 'source');
  const signing = require('./releaseSigning.cjs'), archive = require('./releaseArchiveSourceInventory.cjs');
  const policy = require('./releaseBundlePolicy.cjs'), rotation = require('./releaseRecoveryHelperRotation.cjs');
  try {
    for (const [name, bytes] of [['src/App.tsx', 'export default () => null;\n'],
      ['deploy/light-server/football-release-recovery.cjs', 'fixture-only-helper'], [rotation.RELEASE_SHELL_ENTRY, 'fixture-only-shell']]) {
      const target = path.join(source, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    }
    const tar = spawnSync('tar', ['-czf', bundlePath, '-C', source, './src', './deploy'], { encoding: 'utf8', windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    const evidence = await archive.captureReleaseArchiveSourceEvidence(bundlePath), keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    const publicKeyPath = path.join(fixture, 'fixture-public.pem');
    fs.writeFileSync(publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(bundlePath + '.sha256', evidence.archiveSha256 + '\n');
    const hash = 'a'.repeat(64);
    const manifest = { manifestVersion: signing.RELEASE_MANIFEST_VERSION, site: 'football-predict', channel: 'production', releaseSequence: 712,
      createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), ok: true,
      signature: { algorithm: signing.RELEASE_SIGNATURE_ALGORITHM, keyId: signing.publicKeyId(keys.publicKey) },
      policyVersion: policy.RELEASE_BUNDLE_POLICY_VERSION, sha256: evidence.archiveSha256, bytes: evidence.archiveBytes,
      entries: evidence.archiveEntryCount, sensitiveEntries: [], releaseActions: [], releaseKind: 'frontend-only', archiveSourceEvidence: evidence,
      frontendAuthorization: { version: 'source-authorized-frontend-v1',
        baseline: { runtimeSha256: hash, runtimeSequence: 711, inventorySha256: hash, frontendStateSha256: hash, indexSha256: hash, distTreeHash: hash },
        candidateInventorySha256: evidence.inventorySha256,
        runtime: { nodeSha256: hash, nodeVersion: 'v22.22.1', dependencyLockSha256: hash, buildDependencySha256: hash, installedRuntimeSha256: hash },
        policies: { authorizationSha256: hash, runtimeBoundarySha256: hash, sandboxSha256: hash }, changedPaths: ['src/App.tsx'] } };
    const route = async ({ kind = 'frontend-only', status = failed, signedMutation, unsignedMutation, transportFailure = false, keyMismatch = false,
      helperMismatch = false, processFault = null, omittedSuccessMarker = false } = {}) => {
      const value = structuredClone(manifest);
      if (kind !== 'frontend-only') { delete value.frontendAuthorization; if (kind === 'legacy') delete value.releaseKind; else value.releaseKind = kind; }
      if (signedMutation) signedMutation(value);
      const bytes = Buffer.from(JSON.stringify(value));
      fs.writeFileSync(bundlePath + '.manifest.json', bytes); fs.writeFileSync(bundlePath + '.manifest.sig', signing.signManifestBytes(bytes, keys.privateKey));
      if (unsignedMutation) { unsignedMutation(value); fs.writeFileSync(bundlePath + '.manifest.json', JSON.stringify(value)); }
      const events = [], reports = []; let probeSource;
      const context = {
        fs, path, crypto, Buffer, bundlePath, rootDir: fixture, dryRun: false,
        // A hostile environment claim must not determine the probe kind.
        process: { execPath: 'fixture-node', env: { RELEASE_KIND: 'frontend-only', RELEASE_FRONTEND_ONLY: '1' }, exit: code => { throw new Error('fixture-exit:' + code); } },
        spawnSync: (command, args, options) => { assert.equal(command, 'tar'); return spawnSync(command, args, options); },
        RELEASE_MANIFEST_VERSION: signing.RELEASE_MANIFEST_VERSION, RELEASE_SIGNATURE_ALGORITHM: signing.RELEASE_SIGNATURE_ALGORITHM,
        RELEASE_BUNDLE_POLICY_VERSION: policy.RELEASE_BUNDLE_POLICY_VERSION, findSensitiveReleaseEntries: policy.findSensitiveReleaseEntries,
        RELEASE_SHELL_ENTRY: rotation.RELEASE_SHELL_ENTRY, recoveryHelperEntry: 'deploy/light-server/football-release-recovery.cjs',
        resolvePublicKeyPath: () => publicKeyPath,
        verifyManifestSignature: input => { events.push('signature'); return signing.verifyManifestSignature(input); },
        fail: (message, details) => { throw new Error(message + ':' + (details?.reason || '')); },
        require: name => {
          if (name === './releaseArchiveSourceInventory.cjs') return { verifyArchiveSourceEvidence: async (...args) => {
            events.push('signed-inventory'); return archive.verifyArchiveSourceEvidence(...args);
          } };
          if (name === './runReleaseWindowPreflight.cjs') return { runLiveReleaseWindowPreflight: () => {
            events.push('full-window'); return { ok: true, productionWrites: 0, readyToCutover: false };
          } };
          assert.equal(name, './runReleaseArchivePreflight.cjs'); return { runLiveArchivePreflight: () => { events.push('full-archive'); return { report: { ok: true } }; } };
        },
        remoteEntrypoint: '/fixture/entrypoint', remoteDir: '/fixture/incoming', remoteRecoveryHelperPath: '/fixture/recovery.cjs',
        recoveryHelperRotationContract: { ok: true }, sshOptions: [], scpOptions: [], sshTarget: 'fixture.invalid',
        steps: [], uploads: ['bundle', 'sha256', 'manifest', 'signature'].map(name => ({ name, localPath: path.join(fixture, name), remotePath: '/fixture/' + name })),
        uploadAttempts: 1, console: { log: () => {} },
        buildReadOnlyWorkerProbe: options => { events.push('probe-kind:' + options.releaseKind); probeSource = buildReadOnlyWorkerProbe(options); return probeSource; },
        runCommand: (command, args) => {
          if (command === 'fixture-node') { assert.equal(args[0], 'scripts/verifyFastResultProductionClone.cjs'); events.push('full-clone'); return { status: 0 }; }
          if (command === 'scp') { events.push('upload'); return { status: 0, stdout: '', stderr: '' }; }
          assert.equal(command, 'ssh'); assert.equal(args[0], 'fixture.invalid');
          events.push('remote-preflight');
          assert.ok(args[1].includes(context.quoteProbe(probeSource)), 'actual remote command embeds the selected serialized probe');
          const result = serializedProbe(probeSource, observation({ status }), processFault); reports.push(result.report);
          const remoteKey = keyMismatch ? '0'.repeat(64) : signing.publicKeyId(keys.publicKey);
          const remoteHelper = helperMismatch ? '0'.repeat(64) : crypto.createHash('sha256').update('fixture-only-helper').digest('hex');
          return { status: transportFailure ? 255 : result.exitCode,
            stdout: JSON.stringify(result.report) + '\nkeyId=' + remoteKey + '\nrecoveryHelperSha=' + remoteHelper
              + '\nrecoveryHelperRotationRequired=0\n' + (result.report.ok && !omittedSuccessMarker ? 'preflight-ok\n' : '') };
        },
      };
      const script = '(async()=>{\n' + fileHelpers + '\n' + commandHelpers + '\nquoteProbe = shellQuote;\n' + authenticated
        + '\nconst expectedRecoveryHelperSha256 = recoveryHelperInspection.sha256;\n' + preflightBuilder + '\n' + preflightAndUploads + '\n})()';
      try { await vm.runInNewContext(script, context, { timeout: 1000 }); return { ok: true, events, reports }; }
      catch (error) { return { ok: false, events, reports, error: error.message }; }
    };
    await check('authenticated frontend kind reaches actual probe before four uploads', async () => {
      const result = await route(); assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.events, ['signature', 'signed-inventory', 'probe-kind:frontend-only', 'remote-preflight', 'upload', 'upload', 'upload', 'upload']);
      assert.deepEqual(result.reports[0].warnings, [dataBlockers[0]]); assert.equal(result.reports[0].readyToCutover, false);
    });
    for (const kind of ['full', 'legacy']) await check('signed ' + kind + ' ignores frontend env claim and rejects before uploads', async () => {
      const result = await route({ kind }); assert.equal(result.ok, false); assert.match(result.error, /fixture-exit:1/);
      assert.deepEqual(result.events, ['signature', 'full-window', 'full-archive', 'full-clone', 'probe-kind:full', 'remote-preflight']);
      assert.ok(result.reports[0].blockers.includes(dataBlockers[0]));
    });
    await check('signed frontend retry warning also permits preparation only', async () => {
      const result = await route({ status: retry }); assert.equal(result.ok, true, result.error); assert.deepEqual(result.reports[0].warnings, [dataBlockers[1]]);
    });
    await check('healthy signed full still follows the original gates then uploads', async () => {
      const result = await route({ kind: 'full', status: base.status }); assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.events, ['signature', 'full-window', 'full-archive', 'full-clone', 'probe-kind:full', 'remote-preflight', 'upload', 'upload', 'upload', 'upload']);
    });
    for (const [name, options] of [
      ['unsupported signed kind', { kind: 'ui' }], ['unsigned frontend routing mutation', { kind: 'full', unsignedMutation: m => { m.releaseKind = 'frontend-only'; } }],
      ['signed frontend action', { signedMutation: m => { m.releaseActions = ['enable-ip-tls']; } }],
      ['signed unreviewed path', { signedMutation: m => { m.frontendAuthorization.changedPaths = ['src/services/prediction.ts']; } }],
    ]) await check(name + ' stops at signature verification', async () => {
      const result = await route(options); assert.equal(result.ok, false); assert.match(result.error, /signature verification failed/); assert.deepEqual(result.events, ['signature']);
    });
    for (const [name, options] of [
      ['worker PID mismatch', { status: { ...failed, pid: 41 } }], ['worker future clock', { status: { ...failed, checkedAt: '2026-09-08T04:00:00Z' } }],
      ['wrong worker executable', { processFault: 'wrong-process' }], ['unsafe worker status', { processFault: 'hard-link' }],
      ['SSH failure', { transportFailure: true }], ['trusted key mismatch', { keyMismatch: true }],
      ['recovery helper mismatch', { helperMismatch: true }], ['missing remote success marker', { omittedSuccessMarker: true }],
    ]) await check('actual frontend preflight rejects ' + name + ' before any upload', async () => {
      const result = await route(options); assert.equal(result.ok, false); assert.match(result.error, /fixture-exit:1/);
      assert.deepEqual(result.events, ['signature', 'signed-inventory', 'probe-kind:frontend-only', 'remote-preflight']);
    });
  } finally {
    const current = fs.lstatSync(fixture);
    assert.equal(current.dev, fixtureInfo.dev); assert.equal(current.ino, fixtureInfo.ino); assert.equal(current.isSymbolicLink(), false);
    assert.equal(fs.realpathSync(fixture), fixture); assert.equal(path.dirname(fixture), fs.realpathSync(os.tmpdir()));
    fs.rmSync(fixture, { recursive: true });
  }
  return { ok: true, checks, productionWrites: 0, synthetic: true, deploymentAuthorized: false };
}

module.exports = { verifyFrontendWorkerPreflight };
if (require.main === module) verifyFrontendWorkerPreflight().then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
