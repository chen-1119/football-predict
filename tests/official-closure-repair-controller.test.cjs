'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const policy = require('../scripts/officialClosureRepairPolicy.cjs');
const controller = require('../scripts/officialClosureRepairController.cjs');
const sha = 'a'.repeat(64), other = 'b'.repeat(64), capsule = 'c'.repeat(64);
function load(overrides) {
  const file = require.resolve('../scripts/officialClosureRepairController.cjs'), mod = new Module(file, module);
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  const original = mod.require.bind(mod); mod.require = name => Object.hasOwn(overrides, name) ? overrides[name] : original(name);
  mod._compile(fs.readFileSync(file, 'utf8'), file); return mod.exports;
}
function proofFixture() {
  const plan = { observation: { relay: { sha256: sha }, registry: { sha256: sha } }, files: [{ path: 'scripts/validateData.cjs', beforeSha256: sha, sha256: other }] };
  const negative = ['server-complete', 'public-distribution'].map(scope => ({ scope, expectedPass: false, passed: true, exitCode: 1 }));
  const proof = { version: 'official-closure-repair-proof-v1', ok: true, capsuleSha256: capsule, actualClockOnly: true,
    dataIntegrityPreserved: true, baselineRejected: true, productionWrites: false, postgresWrites: false, generationPublished: false,
    marketDataPromoted: false, recommendationsPromoted: false, sourceHealthPromoted: false, networkRequests: 0,
    relay: { sha256: sha }, registry: { sha256: sha }, baselineValidator: { sha256: sha }, candidateValidator: { sha256: other },
    positive: negative.map(row => ({ ...row, expectedPass: true, exitCode: 0 })),
    negative: ['expired-envelope-with-unchanged-signed-payloads', 'missing-current-file', 'tampered-collector-signature'].map(name => ({ name, validators: structuredClone(negative) })),
    finalClosureAudit: { emptyCurrentIntegrityEligible: true } };
  return { plan, proof };
}
test('candidate proof requires baseline rejection, both validator modes and all negative controls', () => {
  const { plan, proof } = proofFixture(), dir = '/var/lib/football-release/closure-repairs/' + capsule;
  assert.doesNotThrow(() => controller.assertProof(proof, dir, plan));
  for (const mutate of [p => p.ok = false, p => p.baselineRejected = false, p => p.productionWrites = true,
    p => p.dataIntegrityPreserved = false, p => p.networkRequests = 1, p => p.positive.pop(), p => p.positive[0].exitCode = 1,
    p => p.negative.pop(), p => p.negative[0].validators[0].passed = false, p => p.relay.sha256 = other,
    p => p.finalClosureAudit.emptyCurrentIntegrityEligible = false, p => p.candidateValidator.sha256 = sha]) {
    const altered = structuredClone(proof); mutate(altered); assert.throws(() => controller.assertProof(altered, dir, plan));
  }
});
test('rollback is limited to exact before/after hashes including a partially swapped new helper', () => {
  const files = [{ path: 'scripts/syncData.cjs', beforeSha256: sha, sha256: other },
    { path: 'scripts/validateData.cjs', beforeSha256: sha, sha256: other },
    { path: 'scripts/officialClosedScheduleEvidence.cjs', beforeSha256: null, sha256: other }];
  const states = Object.fromEntries(files.map(row => [row.path, row.sha256]));
  assert.deepEqual(controller.rollbackPlan(files, states).map(row => row.action), ['restore', 'restore', 'quarantine']);
  states[files[0].path] = sha; states[files[2].path] = null;
  assert.deepEqual(controller.rollbackPlan(files, states).map(row => row.action), ['unchanged', 'restore', 'unchanged']);
  states[files[1].path] = capsule; assert.throws(() => controller.rollbackPlan(files, states), /unrelated code/);
});
test('acceptance rejects changed, missing or extra production validation flags', () => {
  const before = { flags: { WRITE_LEGACY_STATIC_PAYLOADS: '0', MIRROR_PUBLISHED_DATA_TO_DIST: '0', ALLOW_LARGE_STATIC_DIST: '0' } };
  assert.doesNotThrow(() => controller.assertStableFlags(before, structuredClone(before)));
  for (const key of Object.keys(before.flags)) {
    const changed = structuredClone(before); changed.flags[key] = '1';
    assert.throws(() => controller.assertStableFlags(before, changed), /validation flags changed/);
    const missing = structuredClone(before); delete missing.flags[key];
    assert.throws(() => controller.assertStableFlags(before, missing), /validation flags changed/);
  }
  assert.throws(() => controller.assertStableFlags(before, { flags: { ...before.flags, EXTRA: '0' } }), /validation flags changed/);
});
test('backup durability includes intermediate and capsule directories in child-to-parent order', () => {
  const dir = '/var/lib/football-release/closure-repairs/' + capsule, events = [], handles = new Map(); let fd = 0;
  const api = load({ 'node:fs': {
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: file => file,
    openSync(file, mode) { assert.equal(mode, 'r'); handles.set(++fd, file); return fd; },
    fsyncSync(handle) { events.push(handles.get(handle)); }, closeSync(handle) { handles.delete(handle); },
  } });
  const files = policy.FILES.map((file, i) => ({ path: file, beforeSha256: i === 2 ? null : sha }));
  api.syncBackupDirectories(dir, files);
  assert.deepEqual(events, [dir + '/backup/scripts', dir + '/backup', dir]); assert.equal(handles.size, 0);
  assert.throws(() => api.syncBackupDirectories(dir, [{ path: '../escape.cjs', beforeSha256: sha }]), /outside reviewed file scope/);
});
test('backup fsync error closes its descriptor and aborts before proceeding to any parent', () => {
  const dir = '/var/lib/football-release/closure-repairs/' + capsule, opened = [], closed = [];
  const api = load({ 'node:fs': {
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: file => file,
    openSync(file) { opened.push(file); return 42; }, fsyncSync() { throw new Error('durability failure'); }, closeSync(fd) { closed.push(fd); },
  } });
  assert.throws(() => api.syncBackupDirectories(dir, [{ path: 'scripts/syncData.cjs', beforeSha256: sha }]), /durability failure/);
  assert.deepEqual(opened, [dir + '/backup/scripts']); assert.deepEqual(closed, [42]);
});
test('timer has no PID; actual writer PID or stopping service is never considered drained', () => {
  const timer = { LoadState: 'loaded', ActiveState: 'inactive', MainPID: '' };
  assert.doesNotThrow(() => controller.assertDrained({ 'test.timer': timer, 'test.service': { ...timer, MainPID: '0' } }));
  assert.throws(() => controller.assertDrained({ 'test.service': { ...timer, MainPID: '123' } }), /PID active/);
  assert.throws(() => controller.assertDrained({ 'test.service': { ...timer, ActiveState: 'deactivating', MainPID: '0' } }), /writer active/);
});
test('worker observation requests and retains startup timestamp required for real acceptance', () => {
  const calls = [], api = load({ 'node:child_process': { execFileSync(command, args) {
    calls.push({ command, args }); return 'LoadState=loaded\nActiveState=active\nMainPID=456\nInvocationID=test\nExecMainStartTimestamp=Sat 2026-10-03 09:00:00 CST\n';
  } } });
  assert.equal(api.unitStates()['football-sync-worker.service'].ExecMainStartTimestamp, 'Sat 2026-10-03 09:00:00 CST');
  assert.ok(calls.every(row => row.args.includes('--property=LoadState,ActiveState,MainPID,InvocationID,ExecMainStartTimestamp')));
});
test('closure helper receives a real module filename for relative dependency resolution', () => {
  class FakeModule { constructor(id) { this.id = id; } static _nodeModulePaths() { return []; }
    _compile(source, filename) { assert.equal(this.filename, '/opt/football-predict/scripts/officialClosedScheduleEvidence.cjs'); assert.equal(filename, this.filename); this.exports = { resolved: true }; } }
  assert.equal(load({ 'node:module': FakeModule }).helper(Buffer.from('// signed helper')).resolved, true);
});
test('retained baseline authenticates signature and archive before comparing installed business/dependency hashes', () => {
  const crypto = require('node:crypto'), keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const directory = '/var/lib/football-release/source-baselines/' + policy.BASE_RUNTIME, archive = Buffer.from('fixture archive');
  const installed = policy.FILES.map((file, i) => ({ path: file, sha256: i === 2 ? null : sha }));
  const dependencies = policy.DEPENDENCIES.map(file => ({ path: file, sha256: sha }));
  const manifest = { ok: true, manifestVersion: 3, site: 'football-predict', channel: 'production', releaseSequence: 785,
    sha256: policy.BASE_RUNTIME, bytes: archive.length, expiresAt: '2020-01-01T00:00:00Z', archiveSourceEvidence: { archiveSha256: policy.BASE_RUNTIME,
      inventory: { entries: [...installed, ...dependencies].filter(row => row.sha256 !== null).map(row => ({ ...row, kind: 'file' })) } } };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const files = new Map([[directory + '/manifest.json', manifestBytes], [directory + '/manifest.sig', crypto.sign('sha256', manifestBytes, keys.privateKey)],
    [directory + '/original.tgz', archive], ['/etc/football-release/signing-public.pem', Buffer.from(keys.publicKey.export({ type: 'spki', format: 'pem' }))]]);
  const api = load({ './officialClosureRepairPolicy.cjs': { ...policy, hash: raw => Buffer.from(raw).equals(archive) ? policy.BASE_RUNTIME : policy.hash(raw) },
    'node:fs': { realpathSync: file => file, readFileSync: file => files.get(file), lstatSync: file => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: files.get(file).length }) } });
  assert.equal(api.signedBaseline(installed, dependencies).signatureVerified, true);
  assert.equal(api.signedBaseline(installed, dependencies).historicalExpiryIgnoredForBaselineAuthenticationOnly, true);
  const drift = structuredClone(installed); drift[0].sha256 = other;
  assert.throws(() => api.signedBaseline(drift, dependencies), /installed source differs/);
  const patched = installed.map(row => ({ ...row, sha256: other })), plan = { files: installed.map(row => ({ path: row.path, beforeSha256: row.sha256, sha256: other })) };
  assert.equal(api.signedBaseline(patched, dependencies, plan).signatureVerified, true);
  plan.files[0].beforeSha256 = other; assert.throws(() => api.signedBaseline(patched, dependencies, plan), /signed before bytes/);
  const signature = files.get(directory + '/manifest.sig'); files.set(directory + '/manifest.sig', Buffer.alloc(signature.length));
  assert.throws(() => api.signedBaseline(installed, dependencies), /signature invalid/); files.set(directory + '/manifest.sig', signature);
  files.set(directory + '/original.tgz', Buffer.alloc(archive.length)); assert.throws(() => api.signedBaseline(installed, dependencies), /archive differs/);
});
function pgFixture({ corrupt = false } = {}) {
  const commands = [], decision = { contentHash: sha, evidenceBinding: { bound: true } }, evidence = { referenceHash: sha }, archive = { prediction: 'kept' };
  const client = { async query(sql, params) {
    commands.push(sql);
    if (sql.startsWith('SELECT decision_id')) return { rows: [{ decision_id: 'd', record: '{"protected":true}' }] };
    if (sql.includes('FROM football.match_snapshots')) return { rows: [{ source_id: 'match', event_version: null, kickoff: 'kickoff', archive }] };
    if (sql.includes('FROM football.source_snapshots')) return { rows: [{ payload: JSON.stringify(params[0] === 'index' ? { root: sha } : { record: corrupt ? { ...decision, changed: true } : decision, entry: evidence }) }] };
    return { rows: [] };
  }, release() { commands.push('release'); } };
  class Pool { async connect() { return client; } async end() { commands.push('end'); } }
  const api = load({
    '/opt/football-predict/server/dataGenerationStore.cjs': { readGenerationFile: () => [{ sourceMatchId: 'match', kickoffTime: 'kickoff', archivedPreMatchPrediction: archive }] },
    '/opt/football-predict/server/streamedJsonObjectArrays.cjs': { streamJsonObjectArrays(file, options) { options.onItem('publicReferenceDecisions', decision); options.onItem('publicReferenceEvidence', evidence); } },
    '/opt/football-predict/scripts/nativeReleasePostgresTransport.cjs': { NativeReleasePostgresPool: Pool },
    '/opt/football-predict/scripts/nativeReleaseDatabaseSession.cjs': { publication: async () => ({ generationId: 'g-' + sha }) },
    '/opt/football-predict/scripts/nativeReleaseDataPlane.cjs': { protectedFrozenRecommendationHash: () => sha },
    '/opt/football-predict/server/publicReferenceArchive.cjs': { INDEX_ID: 'index', MAX_AUDIT_BYTES: 1024, indexRowId: () => 'shard', resolveIndexedPublicReferenceEvidence: () => ({ ok: true }) },
  });
  return { api, commands, context: { manifest: { files: [{ path: 'prediction-snapshots.json', bytes: 123, sha256: sha }] }, generationDir: '/generation' }, identity: { database: 'football', oid: '1', systemIdentifier: '123' } };
}
test('frozen capture verifies actual PG reference shards and archives in one read-only snapshot', async () => {
  const f = pgFixture(), result = await f.api.frozen(f.context, f.identity);
  assert.equal(result.records.publicDecisions.length, 2); assert.equal(result.records.publicEvidence.length, 2);
  assert.equal(result.records.archives.length, 2); assert.ok(result.records.archives.some(row => row.id.startsWith('postgres:')));
  assert.equal(f.commands[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(f.commands.slice(-3), ['ROLLBACK', 'release', 'end']);
  assert.equal(f.commands.some(sql => /\b(UPDATE|INSERT|DELETE|COMMIT)\b/.test(sql)), false);
});
test('frozen capture refuses a served PG decision that differs from the immutable generation', async () => {
  const f = pgFixture({ corrupt: true });
  await assert.rejects(() => f.api.frozen(f.context, f.identity), /served reference decision differs/);
  assert.deepEqual(f.commands.slice(-3), ['ROLLBACK', 'release', 'end']);
});
test('a pause failure before swap restores service state and only then clears durable interlock', async () => {
  const dir = '/var/lib/football-release/closure-repairs/' + capsule, guard = Buffer.from('signed guard');
  const files = new Map([
    [dir + '/activation-started.json', Buffer.from(JSON.stringify({ units: { 'football-predict.service': { LoadState: 'loaded', ActiveState: 'active', MainPID: '123' } } }))],
    ['/var/lib/football-release/closure-repairs/current', Buffer.from(JSON.stringify({ capsuleSha256: capsule }))],
    ['/usr/local/sbin/football-release', guard],
  ]), events = [], fds = new Map(); let nextFd = 1, active = true;
  const stat = file => { if (!files.has(file)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: files.get(file).length }; };
  const api = load({ 'node:fs': { existsSync: file => files.has(file), lstatSync: stat, realpathSync: file => file,
    readFileSync: file => files.get(file), openSync(file, flags) { if (flags === 'wx') { assert.equal(files.has(file), false); files.set(file, Buffer.alloc(0)); } const fd = nextFd++; fds.set(fd, file); return fd; },
    writeFileSync(fd, bytes) { files.set(fds.get(fd), Buffer.from(bytes)); }, fsyncSync(fd) { events.push('fsync:' + fds.get(fd)); }, closeSync(fd) { fds.delete(fd); },
    renameSync(source, target) { events.push('rename:' + source); files.set(target, files.get(source)); files.delete(source); } },
    'node:child_process': { execFileSync(command, args) { const unit = args[1];
      if (args[0] === 'stop') { active = false; events.push('stop:' + unit); return ''; }
      if (args[0] === 'start') { active = true; events.push('start:' + unit); return ''; }
      return unit === 'football-predict.service' ? 'LoadState=loaded\nActiveState=' + (active ? 'active' : 'inactive') + '\nMainPID=' + (active ? '123' : '0') : 'LoadState=not-found\nActiveState=inactive\nMainPID=0';
    } } });
  const result = await api.recover(dir, { entrypointGuard: { sha256: policy.hash(guard) } });
  assert.equal(result.servicesRestored, true); assert.equal(result.dataRestored, false);
  const restored = events.indexOf('start:football-predict.service'), cleared = events.findIndex(item => item.startsWith('rename:') && item.endsWith('/current'));
  assert.ok(restored >= 0 && cleared > restored); assert.ok(events.slice(cleared + 1).some(item => item.startsWith('fsync:')));
});
