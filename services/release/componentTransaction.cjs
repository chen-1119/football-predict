'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const authority = require('./componentActivationAuthorization.cjs');
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{24}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function safeSelection(value) {
  const keys = ['version', 'attemptId', 'archiveSha256', 'head', 'unit', 'port', 'acceptedAt'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.version !== 'readonly-component-selection-v1' || !ID.test(value.attemptId || '') || !HASH.test(value.archiveSha256 || '')
    || !/^[a-f0-9]{40}$/.test(value.head || '') || value.unit !== 'football-read-api-component-' + value.attemptId + '.service'
    || ![8790, 8791].includes(value.port) || !Number.isFinite(Date.parse(value.acceptedAt))) fail('INVALID_COMPONENT_SELECTION');
  return value;
}
// The production CLI constructs the context from fixed, root-owned paths only.
// Test contexts are passed directly to this library and are never a CLI mode.
function store({ base, uid, boundary, fixture = false }) {
  if (!path.isAbsolute(base) || !path.isAbsolute(boundary) || base !== path.resolve(base)) fail('COMPONENT_STORE_PATH');
  function directory(name) {
    for (let item = name; ; item = path.dirname(item)) {
      const stat = fs.lstatSync(item);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(item) !== item
        || (!fixture && (stat.uid !== uid || (stat.mode & 0o022)))) fail('UNSAFE_COMPONENT_DIRECTORY');
      if (item === boundary) break;
      if (item === path.dirname(item)) fail('COMPONENT_BOUNDARY_UNREACHABLE');
    }
  }
  function syncDirectory(name) {
    if (fixture && process.platform === 'win32') return;
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function read(name, optional = false) {
    directory(path.dirname(name));
    let stat; try { stat = fs.lstatSync(name); } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024
      || (!fixture && (stat.uid !== uid || (stat.mode & 0o077)))) fail('UNSAFE_COMPONENT_RECORD');
    const fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail('COMPONENT_RECORD_CHANGED');
      const raw = fs.readFileSync(fd), end = fs.fstatSync(fd), after = fs.lstatSync(name);
      if (end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs || end.size !== opened.size
        || after.ino !== end.ino || after.dev !== end.dev || after.mtimeMs !== end.mtimeMs || after.ctimeMs !== end.ctimeMs) fail('COMPONENT_RECORD_CHANGED');
      const value = JSON.parse(raw);
      if (!raw.equals(Buffer.from(JSON.stringify(value) + '\n'))) fail('NONCANONICAL_COMPONENT_RECORD');
      return { value, sha256: hash(raw) };
    } finally { fs.closeSync(fd); }
  }
  function writeNew(name, value) {
    directory(path.dirname(name));
    const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(name));
  }
  function replace(name, value, expected) {
    if (read(name, true)?.sha256 !== expected) fail('COMPONENT_RECORD_CAS');
    const tmp = name + '.next-' + crypto.randomBytes(12).toString('hex');
    writeNew(tmp, value);
    if (read(name, true)?.sha256 !== expected) fail('COMPONENT_RECORD_CAS');
    fs.renameSync(tmp, name); syncDirectory(path.dirname(name));
  }
  function remove(name, expected) {
    if (read(name)?.sha256 !== expected) fail('COMPONENT_RECORD_CAS');
    fs.unlinkSync(name); syncDirectory(path.dirname(name));
  }
  directory(base);
  return { base, read, writeNew, replace, remove, directory, syncDirectory };
}
const activePath = s => path.join(s.base, 'active-transaction.json');
const selectionPath = s => path.join(s.base, 'selection.json');
function intent(value) {
  const keys = ['version', 'id', 'phase', 'authorization', 'previous', 'candidate', 'error'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.version !== 'readonly-component-transaction-v1' || !ID.test(value.id || '')
    || !['prepared', 'starting', 'verified', 'selecting', 'accepted', 'rolling-back', 'rolled-back', 'recovery-required'].includes(value.phase)
    || value.authorization?.attemptId !== value.id || (value.authorization?.action === 'activate' && value.candidate?.attemptId !== value.id)
    || !(value.previous === null || safeSelection(value.previous)) || !(value.error === null || /^[A-Z0-9_]{1,100}$/.test(value.error))) fail('INVALID_COMPONENT_TRANSACTION');
  safeSelection(value.candidate);
  authority.validate(value.authorization);
  return value;
}
function phase(s, record, name, error = null, updates = {}) {
  const current = s.read(activePath(s));
  if (!same(current.value, record)) fail('COMPONENT_TRANSACTION_CHANGED');
  const next = intent({ ...record, ...updates, phase: name, error });
  s.replace(activePath(s), next, current.sha256);
  return next;
}
function finish(s, record) {
  const file = path.join(s.base, 'attempt-' + record.id + '.json');
  const old = s.read(file, true);
  if (old && !same(old.value, record)) fail('COMPONENT_ATTEMPT_RECEIPT_CONFLICT');
  if (!old) s.writeNew(file, record);
  const current = s.read(activePath(s));
  if (!same(current.value, record)) fail('COMPONENT_TRANSACTION_CHANGED');
  s.remove(activePath(s), current.sha256);
  return record;
}
async function rollback(s, runtime, record, error) {
  // Recovery checks identity and ownership even after the activation lease expires.
  await runtime.assertRecoveryBoundary(record);
  record = phase(s, record, 'rolling-back', error);
  if (record.authorization.action === 'activate') await runtime.stopCandidate(record.candidate);
  const selected = s.read(selectionPath(s), true);
  if (selected && same(selected.value, record.candidate)) {
    if (record.previous) s.replace(selectionPath(s), record.previous, selected.sha256);
    else s.remove(selectionPath(s), selected.sha256);
  } else if (!same(selected?.value || null, record.previous)) fail('COMPONENT_SELECTION_RECOVERY_CONFLICT');
  await runtime.assertRecoveryBoundary(record);
  return finish(s, phase(s, record, 'rolled-back', error));
}
async function activate(s, runtime, authorization) {
  authority.validate(authorization);
  await runtime.assertActivationBoundary(authorization);
  if (s.read(activePath(s), true)) fail('COMPONENT_TRANSACTION_PENDING');
  if (s.read(path.join(s.base, 'attempt-' + authorization.attemptId + '.json'), true)) fail('COMPONENT_ATTEMPT_ALREADY_USED');
  const previousFile = s.read(selectionPath(s), true);
  if ((previousFile?.sha256 || null) !== authorization.previousSelectionSha256) fail('COMPONENT_PREVIOUS_SELECTION_CHANGED');
  const previous = previousFile ? safeSelection(previousFile.value) : null;
  if (previous?.port === authorization.port) fail('COMPONENT_CANDIDATE_PORT_CONFLICT');
  let candidate = safeSelection({ version: 'readonly-component-selection-v1', attemptId: authorization.attemptId,
    archiveSha256: authorization.archiveSha256, head: authorization.sourceHead,
    unit: 'football-read-api-component-' + authorization.attemptId + '.service', port: authorization.port,
    acceptedAt: new Date(runtime.wallNow()).toISOString() });
  if (authorization.action === 'rollback') {
    const receipt = s.read(path.join(s.base, 'attempt-' + authorization.rollbackOfAttemptId + '.json'));
    const installed = intent(receipt.value);
    if (installed.phase !== 'accepted' || !same(previous, installed.candidate) || !installed.previous
      || installed.previous.archiveSha256 !== authorization.archiveSha256 || installed.previous.head !== authorization.sourceHead
      || installed.previous.port !== authorization.port) fail('COMPONENT_SIGNED_ROLLBACK_TARGET_CHANGED');
    candidate = safeSelection(installed.previous);
  }
  let record = intent({ version: 'readonly-component-transaction-v1', id: authorization.attemptId, phase: 'prepared',
    authorization, previous, candidate, error: null });
  s.writeNew(activePath(s), record);
  try {
    record = phase(s, record, 'starting');
    await runtime.assertActivationBoundary(authorization);
    if (authorization.action === 'activate') await runtime.startCandidate(candidate);
    await runtime.verifyCandidate(candidate);
    candidate = { ...candidate, acceptedAt: new Date(runtime.wallNow()).toISOString() };
    record = phase(s, record, 'verified', null, { candidate });
    await runtime.assertActivationBoundary(authorization);
    record = phase(s, record, 'selecting');
    if (previousFile) s.replace(selectionPath(s), candidate, previousFile.sha256);
    else s.writeNew(selectionPath(s), candidate);
    await runtime.assertActivationBoundary(authorization, { selected: candidate });
    record = phase(s, record, 'accepted');
    await runtime.finalizeAccepted(record);
    return finish(s, record);
  } catch (error) {
    // An accepted receipt is never rolled back just because receipt delivery failed.
    const current = s.read(activePath(s), true);
    if (current?.value.phase === 'accepted') throw error;
    const code = /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'COMPONENT_ACTIVATION_FAILED';
    try { await rollback(s, runtime, current?.value || record, code); }
    catch (rollbackError) {
      const latest = s.read(activePath(s), true);
      if (latest?.value.phase === 'rolled-back') throw Object.assign(new Error('COMPONENT_RECEIPT_DELIVERY_PENDING'), { code: 'COMPONENT_RECEIPT_DELIVERY_PENDING', cause: rollbackError });
      if (latest) phase(s, latest.value, 'recovery-required', 'COMPONENT_ROLLBACK_UNPROVEN');
      throw Object.assign(new Error('COMPONENT_RECOVERY_REQUIRED'), { code: 'COMPONENT_RECOVERY_REQUIRED', cause: rollbackError });
    }
    throw error;
  }
}
async function recover(s, runtime) {
  const current = s.read(activePath(s), true);
  if (!current) fail('NO_COMPONENT_TRANSACTION_PENDING');
  const record = intent(current.value);
  if (record.phase === 'accepted') {
    await runtime.assertRecoveryBoundary(record);
    if (!same(s.read(selectionPath(s))?.value, record.candidate)) fail('COMPONENT_SELECTION_RECOVERY_CONFLICT');
    await runtime.finalizeAccepted(record);
    return finish(s, record);
  }
  if (record.phase === 'rolled-back') { await runtime.assertRecoveryBoundary(record); return finish(s, record); }
  return rollback(s, runtime, record, record.error || 'INTERRUPTED_COMPONENT_ACTIVATION');
}
module.exports = { store, activate, recover, safeSelection, hash };
