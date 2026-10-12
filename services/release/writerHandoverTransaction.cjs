'use strict';
// Durable ordering for the future installed writer controller. This library
// issues no grants and has no CLI; production task startup stays disabled.
const path = require('node:path');
const { store, hash } = require('./componentTransaction.cjs');
const ROLES = ['official', 'market', 'team', 'recommendation', 'settlement', 'combo-archive'];
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => hash(Buffer.from(JSON.stringify(value) + '\n'));
const fail = code => { throw Object.assign(new Error(code), { code }); };
function owner(value) {
  const keys = ['version', 'role', 'epoch', 'unit', 'archiveSha256', 'head'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.version !== 'writer-owner-v1' || !ROLES.includes(value.role)
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || !HASH.test(value.archiveSha256 || '') || !/^[a-f0-9]{40}$/.test(value.head || '')
    || !(value.unit === 'football-sync-worker.service'
      || new RegExp('^football-writer-' + value.role + '-[a-f0-9]{24}\\.service$').test(value.unit || ''))) fail('INVALID_WRITER_OWNER');
  return value;
}
function authorization(body) {
  const keys = ['version', 'attemptId', 'role', 'candidate', 'previousOwnerSha256', 'controllerSha256', 'expectedAppSha256', 'issuedAtMs', 'expiresAtMs'];
  if (!body || Object.keys(body).sort().join(',') !== keys.sort().join(',')
    || body.version !== 'writer-handover-authorization-v1' || !ID.test(body.attemptId || '')
    || !ROLES.includes(body.role) || !HASH.test(body.previousOwnerSha256 || '')
    || !HASH.test(body.controllerSha256 || '') || !HASH.test(body.expectedAppSha256 || '')
    || !Number.isSafeInteger(body.issuedAtMs) || body.issuedAtMs < 0
    || !Number.isSafeInteger(body.expiresAtMs) || body.expiresAtMs <= body.issuedAtMs
    || body.expiresAtMs - body.issuedAtMs > 900_000) fail('INVALID_WRITER_AUTHORIZATION');
  owner(body.candidate);
  if (body.candidate.role !== body.role || body.candidate.unit !== 'football-writer-' + body.role + '-' + body.attemptId + '.service'
    || body.candidate.epoch < 1 || body.candidate.epoch >= Number.MAX_SAFE_INTEGER) fail('INVALID_WRITER_AUTHORIZATION');
  return body;
}
const active = s => path.join(s.base, 'active-transaction.json');
const selected = s => path.join(s.base, 'owner.json');
function record(value) {
  const keys = ['version', 'id', 'phase', 'request', 'authorization', 'previous', 'candidate', 'fenceReceipt', 'restored', 'restoredReceipt', 'error'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.version !== 'writer-handover-transaction-v1' || !ID.test(value.id || '')
    || !['prepared', 'quiescing', 'installing-fence', 'fenced', 'starting', 'accepted', 'rolling-back', 'rolled-back', 'commit-unknown', 'recovery-required'].includes(value.phase)
    || !value.request || Object.keys(value.request).sort().join(',') !== 'body,signature'
    || typeof value.request.signature !== 'string' || value.request.signature.length > 2048
    || !(value.error === null || /^[A-Z0-9_]{1,100}$/.test(value.error))) fail('INVALID_WRITER_TRANSACTION');
  authorization(value.authorization); owner(value.previous); owner(value.candidate);
  if (value.id !== value.authorization.attemptId || !same(value.request.body, value.authorization)
    || !same(value.candidate, value.authorization.candidate) || value.previous.role !== value.authorization.role
    || value.previous.epoch >= value.candidate.epoch
    || digest(value.previous) !== value.authorization.previousOwnerSha256) fail('INVALID_WRITER_TRANSACTION');
  if (value.restored !== null) {
    owner(value.restored);
    if (value.restored.role !== value.previous.role || value.restored.unit !== value.previous.unit
      || value.restored.head !== value.previous.head || value.restored.archiveSha256 !== value.previous.archiveSha256
      || value.restored.epoch !== value.candidate.epoch + 1) fail('INVALID_WRITER_RESTORATION');
  }
  if (value.fenceReceipt !== null && !HASH.test(value.fenceReceipt || '')) fail('INVALID_WRITER_FENCE_RECEIPT');
  if (value.restoredReceipt !== null && (!value.restored || !HASH.test(value.restoredReceipt || ''))) fail('INVALID_WRITER_FENCE_RECEIPT');
  if (['fenced', 'starting', 'accepted'].includes(value.phase) && value.fenceReceipt === null) fail('INVALID_WRITER_FENCE_RECEIPT');
  if (value.phase === 'rolled-back' && value.restoredReceipt === null) fail('INVALID_WRITER_FENCE_RECEIPT');
  return value;
}
function phase(s, old, name, updates = {}) {
  const current = s.read(active(s));
  if (!same(current.value, old)) fail('WRITER_TRANSACTION_CHANGED');
  const next = record({ ...old, ...updates, phase: name });
  s.replace(active(s), next, current.sha256); return next;
}
function finish(s, value) {
  const file = path.join(s.base, 'attempt-' + value.id + '.json'), prior = s.read(file, true);
  if (prior && !same(prior.value, value)) fail('WRITER_ATTEMPT_RECEIPT_CONFLICT');
  if (!prior) s.writeNew(file, value);
  const current = s.read(active(s));
  if (!same(current.value, value)) fail('WRITER_TRANSACTION_CHANGED');
  s.remove(active(s), current.sha256); return value;
}
function confirmedFence(receipt, expected) {
  if (!receipt || receipt.outcome !== 'committed' || !same(owner(receipt.owner), expected)
    || !HASH.test(receipt.receiptSha256 || '')) fail('WRITER_FENCE_COMMIT_UNKNOWN');
  return receipt.receiptSha256;
}
async function verifyRequest(runtime, request, recovery) {
  // The separately installed controller must verify its domain-separated
  // signature and live code identity. Recovery authenticates recorded intent;
  // it cannot use the expired request to start a fresh candidate.
  const checked = await runtime.verifyRequest(request, { recovery });
  if (checked?.signatureVerified !== true || !same(checked.body, request.body)) fail('WRITER_SIGNATURE_UNPROVEN');
  return authorization(checked.body);
}
async function rollback(s, runtime, value) {
  await verifyRequest(runtime, value.request, true);
  await runtime.assertBoundary(value.authorization, { recovery: true });
  // A lost COMMIT response is resolved by a read before another fence write.
  const live = await runtime.readFence(value.authorization.role);
  if (live?.outcome !== 'committed' || !HASH.test(live.receiptSha256 || '')) fail('WRITER_FENCE_COMMIT_UNKNOWN');
  if (![value.candidate, value.previous, value.restored].filter(Boolean).some(v => same(v, live.owner))) fail('WRITER_FENCE_OWNER_CONFLICT');
  await runtime.stopOwner(value.candidate);
  await runtime.assertQuiescent(value.candidate);
  // Never reuse the old fencing epoch after the new owner may have existed.
  const restored = value.restored || { ...value.previous, epoch: value.candidate.epoch + 1 };
  value = phase(s, value, 'rolling-back', { restored });
  if (!same(live.owner, restored)) {
    await runtime.assertQuiescent(value.previous);
    const receipt = await runtime.commitFence(restored, live.owner, value.id + ':restore');
    value = phase(s, value, 'rolling-back', { restoredReceipt: confirmedFence(receipt, restored) });
  } else {
    const readBack = confirmedFence(live, restored);
    if (value.restoredReceipt !== null && readBack !== value.restoredReceipt) fail('WRITER_FENCE_RECEIPT_CHANGED');
    value = phase(s, value, 'rolling-back', { restoredReceipt: readBack });
  }
  await runtime.assertFrozenHistory(value.authorization);
  await runtime.startOwner(restored);
  await runtime.verifyOwner(restored);
  const selection = s.read(selected(s));
  if (![value.previous, value.candidate, restored].some(v => same(v, selection.value))) fail('WRITER_SELECTION_RECOVERY_CONFLICT');
  if (!same(selection.value, restored)) s.replace(selected(s), restored, selection.sha256);
  return finish(s, phase(s, value, 'rolled-back'));
}
async function handover(s, runtime, request) {
  const auth = await verifyRequest(runtime, request, false);
  const startMonotonic = runtime.monotonicNow();
  let priorMonotonic = startMonotonic, priorWall = null;
  const clock = () => {
    const now = runtime.wallNow(), monotonic = runtime.monotonicNow();
    if (!Number.isSafeInteger(now) || now < auth.issuedAtMs || now >= auth.expiresAtMs
      || (priorWall !== null && now < priorWall) || !Number.isFinite(startMonotonic)
      || !Number.isFinite(monotonic) || monotonic < priorMonotonic
      || monotonic - startMonotonic >= 900_000) fail('WRITER_AUTHORIZATION_EXPIRED');
    priorWall = now; priorMonotonic = monotonic;
  };
  clock(); await runtime.assertBoundary(auth, { recovery: false });
  if (s.read(active(s), true)) fail('WRITER_TRANSACTION_PENDING');
  if (s.read(path.join(s.base, 'attempt-' + auth.attemptId + '.json'), true)) fail('WRITER_ATTEMPT_ALREADY_USED');
  const prior = s.read(selected(s));
  if (prior.sha256 !== auth.previousOwnerSha256 || digest(prior.value) !== auth.previousOwnerSha256) fail('WRITER_PREVIOUS_OWNER_CHANGED');
  owner(prior.value);
  let value = record({ version: 'writer-handover-transaction-v1', id: auth.attemptId, phase: 'prepared', request,
    authorization: auth, previous: prior.value, candidate: auth.candidate, fenceReceipt: null, restored: null, restoredReceipt: null, error: null });
  s.writeNew(active(s), value);
  try {
    await runtime.assertFrozenHistory(auth);
    value = phase(s, value, 'quiescing');
    await runtime.stopOwner(value.previous);
    await runtime.assertQuiescent(value.previous);
    clock(); await runtime.assertBoundary(auth, { recovery: false });
    value = phase(s, value, 'installing-fence');
    const receipt = await runtime.commitFence(value.candidate, value.previous, value.id + ':activate');
    value = phase(s, value, 'fenced', { fenceReceipt: confirmedFence(receipt, value.candidate) });
    // No candidate starts until the durable fence COMMIT is read back.
    if (confirmedFence(await runtime.readFence(auth.role), value.candidate) !== value.fenceReceipt) fail('WRITER_FENCE_RECEIPT_CHANGED');
    await runtime.assertFrozenHistory(auth);
    clock(); value = phase(s, value, 'starting');
    await runtime.startOwner(value.candidate);
    await runtime.verifyOwner(value.candidate);
    await runtime.assertFrozenHistory(auth);
    clock(); await runtime.assertBoundary(auth, { recovery: false });
    const current = s.read(selected(s));
    if (current.sha256 !== auth.previousOwnerSha256) fail('WRITER_PREVIOUS_OWNER_CHANGED');
    s.replace(selected(s), value.candidate, current.sha256);
    value = phase(s, value, 'accepted');
    await runtime.finalizeAccepted(value);
    return finish(s, value);
  } catch (error) {
    const latest = s.read(active(s));
    if (latest.value.phase === 'accepted') throw error;
    const code = /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'WRITER_HANDOVER_FAILED';
    if (['COMMIT_UNKNOWN', 'WRITER_FENCE_COMMIT_UNKNOWN'].includes(code)) {
      phase(s, latest.value, 'commit-unknown', { error: code });
      fail('WRITER_RECOVERY_REQUIRED');
    }
    value = phase(s, latest.value, latest.value.phase, { error: code });
    try { await rollback(s, runtime, value); }
    catch (cause) {
      const pending = s.read(active(s), true);
      if (pending) phase(s, pending.value, 'recovery-required', { error: 'WRITER_ROLLBACK_UNPROVEN' });
      throw Object.assign(new Error('WRITER_RECOVERY_REQUIRED'), { code: 'WRITER_RECOVERY_REQUIRED', cause });
    }
    throw error;
  }
}
async function recover(s, runtime) {
  const current = s.read(active(s), true);
  if (!current) fail('NO_WRITER_TRANSACTION_PENDING');
  const value = record(current.value);
  if (value.phase === 'rolled-back') {
    await verifyRequest(runtime, value.request, true);
    await runtime.assertBoundary(value.authorization, { recovery: true });
    if (confirmedFence(await runtime.readFence(value.authorization.role), value.restored) !== value.restoredReceipt) fail('WRITER_FENCE_RECEIPT_CHANGED');
    await runtime.verifyOwner(value.restored); return finish(s, value);
  }
  if (value.phase === 'accepted') {
    await verifyRequest(runtime, value.request, true);
    await runtime.assertBoundary(value.authorization, { recovery: true });
    if (!same(s.read(selected(s)).value, value.candidate)) fail('WRITER_SELECTION_RECOVERY_CONFLICT');
    if (confirmedFence(await runtime.readFence(value.authorization.role), value.candidate) !== value.fenceReceipt) fail('WRITER_FENCE_RECEIPT_CHANGED');
    await runtime.verifyOwner(value.candidate); await runtime.assertFrozenHistory(value.authorization);
    await runtime.finalizeAccepted(value); return finish(s, value);
  }
  return rollback(s, runtime, value);
}
module.exports = { store, handover, recover, owner, authorization, digest };
