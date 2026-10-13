'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const authorization = require('../services/release/componentActivationAuthorization.cjs');
const signing = require('../services/release/componentSigning.cjs');
const transaction = require('../services/release/componentTransaction.cjs');
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = Date.parse('2026-10-12T01:00:00Z');
const body = () => ({ version: 'readonly-component-activation-v1', attemptId: crypto.randomBytes(12).toString('hex'),
  action: 'activate', rollbackOfAttemptId: null,
  component: 'read-api', archiveSha256: 'a'.repeat(64), sourceHead: 'b'.repeat(40), controllerSha256: 'c'.repeat(64),
  runtimeProofSha256: 'd'.repeat(64), expectedAppSha256: 'e'.repeat(64), expectedApiPid: '100', expectedWorkerPid: '200',
  databaseOid: '28598409', schemaSha256: 'f'.repeat(64), port: 8790, previousSelectionSha256: null,
  issuedAtMs: now, expiresAtMs: now + 900000, keyId: '1'.repeat(64) });
function receipt(request = body()) { return { body: request, signature: authorization.sign(request, key.privateKey) }; }
function fixture(t, previous = false) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'football-component-test-')));
  const store = transaction.store({ base, boundary: base, uid: process.getuid?.() || 0, fixture: true });
  t.after(() => { assert.equal(fs.realpathSync(base), base); assert(path.basename(base).startsWith('football-component-test-')); fs.rmSync(base, { recursive: true }); });
  if (previous) store.writeNew(path.join(base, 'selection.json'), {
    version: 'readonly-component-selection-v1', attemptId: '0'.repeat(24), archiveSha256: '0'.repeat(64), head: '0'.repeat(40),
    unit: 'football-read-api-component-' + '0'.repeat(24) + '.service', port: 8791, acceptedAt: new Date(now - 1).toISOString()
  });
  const request = { ...body(), previousSelectionSha256: store.read(path.join(base, 'selection.json'), true)?.sha256 || null };
  const calls = [], hooks = {};
  const runtime = {
    wallNow: () => now + 1000,
    async assertActivationBoundary(...args) { calls.push('boundary'); await hooks.boundary?.(...args); },
    async assertRecoveryBoundary(...args) { calls.push('recovery-boundary'); await hooks.recovery?.(...args); },
    async startCandidate(...args) { calls.push('start'); await hooks.start?.(...args); },
    async verifyCandidate(...args) { calls.push('verify'); await hooks.verify?.(...args); },
    async stopCandidate(...args) { calls.push('stop'); await hooks.stop?.(...args); },
    async finalizeAccepted(...args) { calls.push('finalize'); await hooks.finalize?.(...args); }
  };
  return { store, base, request, runtime, hooks, calls, selection: () => store.read(path.join(base, 'selection.json'), true)?.value || null,
    pending: () => store.read(path.join(base, 'active-transaction.json'), true)?.value || null };
}
test('activation authority uses a separate signature domain and is bound to exact source, artifact and current services', () => {
  const r = receipt(), result = authorization.verify(r, key.publicKey, r.body.keyId, now + 1);
  assert.deepEqual(result, r.body);
  for (const change of [{ archiveSha256: '2'.repeat(64) }, { controllerSha256: '2'.repeat(64) }, { sourceHead: '2'.repeat(40) },
    { expectedApiPid: '101' }, { expectedWorkerPid: '201' }, { port: 8791 }, { runtimeProofSha256: '2'.repeat(64) }, { previousSelectionSha256: '2'.repeat(64) }]) {
    assert.throws(() => authorization.verify({ ...r, body: { ...r.body, ...change } }, key.publicKey, r.body.keyId, now + 1));
  }
  for (const time of [now - 1, now + 900000]) assert.throws(() => authorization.verify(r, key.publicKey, r.body.keyId, time));
  for (const change of [{ component: 'collector' }, { component: 'web' }, { databaseOid: '1' }, { expiresAtMs: now + 900001 }, { port: 80 }, { extra: true }]) assert.throws(() => authorization.validate({ ...r.body, ...change }));
  assert.throws(() => authorization.verify({ ...r, signature: crypto.sign('RSA-SHA256', Buffer.from(JSON.stringify(r.body)), key.privateKey).toString('base64') }, key.publicKey, r.body.keyId, now + 1));
});
test('activation binding rejects a runtime or serving identity that changed after signing', () => {
  const request = body();
  const envelope = signing.envelope({ version: 'independent-component-artifact-v1', component: 'read-api', head: request.sourceHead,
    archiveSha256: request.archiveSha256, archiveBytes: 1, inventory: [], apiContract: 'separated-read-api-v1', schemaSha256: request.schemaSha256,
    entry: 'services/read-api/server.cjs', artifactPlatform: 'linux', databaseCopies: 0, migrations: false, signed: false, activationEligible: false }, Buffer.from('{}'), request.keyId);
  const actual = { controllerSha256: request.controllerSha256, runtimeProofSha256: request.runtimeProofSha256,
    appSha256: request.expectedAppSha256, completeSha256: request.expectedAppSha256, apiPid: '100', workerPid: '200',
    previousSelectionSha256: null, databaseOid: '28598409', databaseReadOnly: true, schemaSha256: request.schemaSha256, port: 8790 };
  authorization.bind(request, envelope, actual, now + 1);
  for (const change of [{ databaseReadOnly: false }, { databaseOid: '1' }, { schemaSha256: '0'.repeat(64) },
    { appSha256: '0'.repeat(64) }, { completeSha256: '0'.repeat(64) }, { apiPid: '101' }, { workerPid: '201' },
    { port: 8791 }, { previousSelectionSha256: '0'.repeat(64) }, { controllerSha256: '0'.repeat(64) }, { runtimeProofSha256: '0'.repeat(64) }]) assert.throws(() => authorization.bind(request, envelope, { ...actual, ...change }, now + 1));
});
test('a healthy initial activation persists an accepted selector and a create-only receipt; replay cannot start a unit', async t => {
  const f = fixture(t);
  const result = await transaction.activate(f.store, f.runtime, f.request);
  assert.equal(result.phase, 'accepted'); assert.equal(f.pending(), null); assert.deepEqual(f.selection(), result.candidate);
  assert.equal(result.candidate.acceptedAt, new Date(now + 1000).toISOString()); assert.equal(f.calls.filter(x => x === 'start').length, 1);
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request), { code: 'COMPONENT_ATTEMPT_ALREADY_USED' });
  assert.equal(f.calls.filter(x => x === 'start').length, 1);
});
for (const phase of ['start', 'verify', 'after-select']) test('failure at ' + phase + ' restores the exact previous selector and stops only the candidate', async t => {
  const f = fixture(t, true), original = f.selection();
  if (phase === 'after-select') f.hooks.boundary = async (auth, selected) => { if (selected) throw Object.assign(new Error('changed'), { code: 'COMPONENT_BOUNDARY_CHANGED' }); };
  else f.hooks[phase] = async () => { throw Object.assign(new Error('failed'), { code: 'COMPONENT_TEST_FAILURE' }); };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request));
  assert.deepEqual(f.selection(), original); assert.equal(f.pending(), null); assert.equal(f.calls.filter(x => x === 'stop').length, 1);
  assert.equal(f.store.read(path.join(f.base, 'attempt-' + f.request.attemptId + '.json')).value.phase, 'rolled-back');
});
test('initial failure leaves no new selector and preserves the failure receipt', async t => {
  const f = fixture(t); f.hooks.verify = async () => { throw new Error('failed'); };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request));
  assert.equal(f.selection(), null); assert.equal(f.pending(), null);
  assert.equal(f.store.read(path.join(f.base, 'attempt-' + f.request.attemptId + '.json')).value.error, 'COMPONENT_ACTIVATION_FAILED');
});
test('unproven stop keeps durable pending recovery; another activation is refused and normal recovery completes', async t => {
  const f = fixture(t, true), original = f.selection();
  f.hooks.verify = async () => { throw new Error('failed'); }; f.hooks.stop = async () => { throw new Error('still alive'); };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request), { code: 'COMPONENT_RECOVERY_REQUIRED' });
  assert.equal(f.pending().phase, 'recovery-required'); assert.deepEqual(f.selection(), original);
  await assert.rejects(transaction.activate(f.store, f.runtime, { ...f.request, attemptId: '9'.repeat(24) }), { code: 'COMPONENT_TRANSACTION_PENDING' });
  delete f.hooks.stop;
  const result = await transaction.recover(f.store, f.runtime);
  assert.equal(result.phase, 'rolled-back'); assert.deepEqual(f.selection(), original); assert.equal(f.pending(), null);
});
test('source or lease failure before intent produces no transaction, no selector and no service start', async t => {
  const f = fixture(t); f.hooks.boundary = async () => { throw Object.assign(new Error('expired'), { code: 'COMPONENT_ACTIVATION_LEASE_EXPIRED' }); };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request), { code: 'COMPONENT_ACTIVATION_LEASE_EXPIRED' });
  assert.equal(f.pending(), null); assert.equal(f.selection(), null); assert(!f.calls.includes('start'));
});
test('changing a selector concurrently is never overwritten by rollback', async t => {
  const f = fixture(t, true), unexpected = { ...f.selection(), archiveSha256: '8'.repeat(64) };
  f.hooks.boundary = async (auth, selected) => {
    if (selected) { const filename = path.join(f.base, 'selection.json'); f.store.replace(filename, unexpected, f.store.read(filename).sha256); throw new Error('changed'); }
  };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request), { code: 'COMPONENT_RECOVERY_REQUIRED' });
  assert.deepEqual(f.selection(), unexpected); assert.equal(f.pending().phase, 'recovery-required');
  await assert.rejects(transaction.recover(f.store, f.runtime), { code: 'COMPONENT_SELECTION_RECOVERY_CONFLICT' });
  assert.deepEqual(f.selection(), unexpected);
});
test('receipt-delivery failure after acceptance is finished by recovery without rolling back or restarting', async t => {
  const f = fixture(t), remove = f.store.remove;
  f.store.remove = () => { throw new Error('receipt delivery interrupted'); };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request));
  assert.equal(f.pending().phase, 'accepted'); const selected = f.selection();
  assert(!f.calls.includes('stop')); f.store.remove = remove;
  const result = await transaction.recover(f.store, f.runtime);
  assert.equal(result.phase, 'accepted'); assert.deepEqual(f.selection(), selected); assert.equal(f.pending(), null);
  assert.equal(f.calls.filter(x => x === 'start').length, 1); assert(!f.calls.includes('stop'));
});
test('boot-selection finalization failure keeps accepted intent and recovery retries only finalization', async t => {
  const f = fixture(t); f.hooks.finalize = async () => { throw new Error('enable interrupted'); };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request));
  assert.equal(f.pending().phase, 'accepted'); assert.equal(f.selection().archiveSha256, f.request.archiveSha256); assert(!f.calls.includes('stop'));
  delete f.hooks.finalize; await transaction.recover(f.store, f.runtime);
  assert.equal(f.pending(), null); assert.equal(f.calls.filter(x => x === 'start').length, 1); assert(!f.calls.includes('stop'));
});
test('receipt-delivery failure after rollback is also recoverable without changing the stored failure', async t => {
  const f = fixture(t), remove = f.store.remove;
  f.hooks.verify = async () => { throw Object.assign(new Error('failed'), { code: 'COMPONENT_TEST_FAILURE' }); };
  f.store.remove = () => { throw new Error('receipt delivery interrupted'); };
  await assert.rejects(transaction.activate(f.store, f.runtime, f.request), { code: 'COMPONENT_RECEIPT_DELIVERY_PENDING' });
  assert.equal(f.pending().phase, 'rolled-back'); f.store.remove = remove;
  const result = await transaction.recover(f.store, f.runtime);
  assert.equal(result.error, 'COMPONENT_TEST_FAILURE'); assert.equal(f.pending(), null);
});
test('private transaction records reject linked files and noncanonical JSON', t => {
  const f = fixture(t), record = path.join(f.base, 'selection.json'), external = path.join(f.base, 'ordinary.json');
  fs.writeFileSync(external, '{}\n'); fs.linkSync(external, record);
  assert.throws(() => f.store.read(record), { code: 'UNSAFE_COMPONENT_RECORD' });
  fs.unlinkSync(record);
  if (process.platform === 'linux') { fs.symlinkSync(external, record); assert.throws(() => f.store.read(record), { code: 'UNSAFE_COMPONENT_RECORD' }); fs.unlinkSync(record); }
  fs.writeFileSync(record, '{ "test": true }\n');
  assert.throws(() => f.store.read(record), { code: 'NONCANONICAL_COMPONENT_RECORD' });
});
test('an accepted update can select its verified original component again using a fresh signed rollback request', async t => {
  const f = fixture(t, true), original = f.selection();
  await transaction.activate(f.store, f.runtime, f.request);
  const request = { ...f.request, action: 'rollback', attemptId: '7'.repeat(24), rollbackOfAttemptId: f.request.attemptId,
    archiveSha256: original.archiveSha256, sourceHead: original.head, port: original.port,
    previousSelectionSha256: f.store.read(path.join(f.base, 'selection.json')).sha256 };
  const starts = f.calls.filter(x => x === 'start').length;
  const result = await transaction.activate(f.store, f.runtime, request);
  assert.equal(result.phase, 'accepted');
  assert.equal(f.selection().unit, original.unit); assert.equal(f.selection().archiveSha256, original.archiveSha256);
  assert.equal(f.calls.filter(x => x === 'start').length, starts); assert(!f.calls.includes('stop'));
});
test('a failed explicit rollback restores the current healthy selector and does not stop the previous component', async t => {
  const f = fixture(t, true), original = f.selection();
  await transaction.activate(f.store, f.runtime, f.request); const current = f.selection();
  const request = { ...f.request, action: 'rollback', attemptId: '7'.repeat(24), rollbackOfAttemptId: f.request.attemptId,
    archiveSha256: original.archiveSha256, sourceHead: original.head, port: original.port,
    previousSelectionSha256: f.store.read(path.join(f.base, 'selection.json')).sha256 };
  f.hooks.verify = async () => { throw new Error('old health failed'); };
  await assert.rejects(transaction.activate(f.store, f.runtime, request));
  assert.deepEqual(f.selection(), current); assert(!f.calls.includes('stop')); assert.equal(f.pending(), null);
});
test('production controller entry refuses direct execution outside its installed root authority', async () => {
  if (process.platform === 'linux' && process.getuid?.() === 0 && process.execPath === '/opt/node-v22.22.1/bin/node') {
    await assert.rejects(require('../services/release/componentController.cjs').main());
  } else await assert.rejects(require('../services/release/componentController.cjs').main(), { code: 'FIXED_CLEAN_ROOT_COMPONENT_CONTROLLER_REQUIRED' });
});
test('persistent unit definition stays within the immutable image and non-root read API scope', () => {
  const controller = require('../services/release/componentController.cjs');
  const selected = { attemptId: 'a'.repeat(24), archiveSha256: 'b'.repeat(64), port: 8790,
    unit: 'football-read-api-component-' + 'a'.repeat(24) + '.service' };
  const unit = controller.unitText(selected);
  assert(unit.includes('User=football\n')); assert(unit.includes('ProtectSystem=strict\n'));
  assert(unit.includes('WorkingDirectory=/opt/football-services/read-api/releases/' + selected.archiveSha256 + '\n'));
  assert(unit.includes('default_transaction_read_only=on')); assert(!unit.includes('ExecStartPre=')); assert(!unit.includes('/opt/football-predict'));
  for (const change of [{ port: 8080 }, { unit: 'football-sync-worker.service' }, { archiveSha256: '../APP' }, { attemptId: 'x\nExecStart=/bin/sh' }]) assert.throws(() => controller.unitText({ ...selected, ...change }));
});
