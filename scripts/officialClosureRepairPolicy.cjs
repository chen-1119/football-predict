'use strict';
// This policy authorizes one incident on r785/r787. It is not a full release,
// a source freshness override, a model promotion, or permission to rewrite data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const VERSION = 'official-closure-repair-v1';
const BASE_RUNTIME = '4ffe4a6f7328d68b6084b8ef2d51c399306b18e78d05abea9db4566a555f9042';
const BASE_FRONTEND = Object.freeze({ sequence: 787, sha256: 'eef4d05777bbe03818b38780c1c26be474e9a09154e8475de9a0520998139f72' });
const FILES = Object.freeze(['scripts/syncData.cjs', 'scripts/validateData.cjs', 'scripts/officialClosedScheduleEvidence.cjs']);
const DEPENDENCIES = Object.freeze(['src/services/strictInstant.cjs', 'src/services/collectorAttestation.cjs', 'server/relayCollectorEvidence.cjs', 'scripts/sportteryEndpointContract.cjs']);
const ARTIFACTS = Object.freeze(['controller', 'proof', 'policy']);
const FROZEN_GROUPS = Object.freeze(['recommendations', 'publicDecisions', 'publicEvidence', 'archives']);
const ENTRYPOINT = '/usr/local/sbin/football-release';
const GUARD_LINES = Object.freeze([
  '  [ ! -e "/var/lib/football-release/closure-repairs/current" ] && [ ! -L "/var/lib/football-release/closure-repairs/current" ] \\',
  '    || die "a signed official closure repair requires its own recovery"',
]);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = value => assert.match(value || '', /^[a-f0-9]{64}$/, 'invalid SHA-256');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function instant(value) {
  assert.equal(typeof value, 'string', 'missing timestamp');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  assert.ok(m, 'timestamp must have an explicit timezone');
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  assert.ok(year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour < 24 && minute < 60 && second < 60, 'invalid calendar timestamp');
  assert.ok(m[8] === 'Z' || (Number(m[8].slice(1, 3)) <= 23 && Number(m[8].slice(4, 6)) < 60), 'invalid timezone');
  const at = Date.parse(value); assert.ok(Number.isFinite(at), 'invalid timestamp'); return at;
}
function guardedEntrypoint(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length < 256 * 1024, 'entrypoint size invalid');
  const source = bytes.toString('utf8');
  assert.equal(Buffer.from(source).compare(bytes), 0, 'entrypoint is not UTF-8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const anchor = '  flock -n 9 || die "another release or recovery is active"' + newline;
  const guard = GUARD_LINES.join(newline) + newline;
  assert.equal(source.split(anchor).length, 2, 'unexpected fixed publisher lock anchor');
  if (source.includes(guard)) {
    assert.equal(source.split(guard).length, 2, 'duplicate closure repair guard');
    assert.ok(source.includes(anchor + guard), 'closure repair guard must immediately follow lock acquisition');
    assert.equal(source.split('/var/lib/football-release/closure-repairs/current').length, 3, 'unknown closure repair guard');
    return Buffer.from(source);
  }
  assert.equal(source.includes('/var/lib/football-release/closure-repairs/current'), false, 'unknown closure repair guard');
  return Buffer.from(source.replace(anchor, anchor + guard));
}
function validateRows(rows, label) {
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 1000000, 'missing frozen baseline: ' + label);
  const ids = new Set();
  for (const row of rows) {
    assert.ok(object(row) && typeof row.id === 'string' && row.id.length > 0, 'invalid frozen ID');
    assert.equal(ids.has(row.id), false, 'duplicate frozen ID: ' + label); ids.add(row.id); sha(row.hash);
  }
}
function generation(value, now) {
  assert.ok(object(value), 'generation missing'); sha(value.manifestHash);
  assert.equal(value.generationId, 'g-' + value.manifestHash);
  assert.ok(typeof value.sourceCycleId === 'string' && value.sourceCycleId.trim().length > 0);
  assert.ok(instant(value.committedAt) <= now, 'generation clock is in the future');
}
function fileSet(rows, names, label) {
  assert.ok(Array.isArray(rows), label + ' missing');
  assert.deepEqual(rows.map(row => row.path).sort(), [...names].sort(), label + ' must exactly match reviewed scope');
}
function validateObservation(o, now = Date.now()) {
  assert.ok(Number.isFinite(now) && object(o), 'invalid observation');
  const at = instant(o.checkedAt);
  assert.ok(at <= now && now - at <= 15 * 60000, 'repair observation stale or future');
  assert.equal(o.productionWrites, 0);
  assert.equal(o.runtime, BASE_RUNTIME); assert.equal(o.complete, BASE_RUNTIME);
  assert.equal(o.frontendSequence, BASE_FRONTEND.sequence); assert.equal(o.frontendSha256, BASE_FRONTEND.sha256); sha(o.frontendStateSha256);
  generation(o.generation, at);
  assert.equal(o.postgres?.database, 'football'); assert.match(String(o.postgres.oid || ''), /^[1-9][0-9]{0,9}$/);
  assert.match(String(o.postgres.systemIdentifier || ''), /^[0-9]{10,20}$/);
  assert.equal(o.postgres.publication?.mode, 'active-generation'); generation(o.postgres.publication, at);
  for (const key of ['generationId', 'manifestHash', 'sourceCycleId', 'committedAt']) {
    assert.equal(o.postgres.publication[key], o.generation[key], 'PostgreSQL publication differs from active generation: ' + key);
  }
  fileSet(o.files, FILES, 'observed files');
  for (const f of o.files) { if (f.path === FILES[2]) assert.equal(f.sha256, null, 'closure helper already exists'); else sha(f.sha256); }
  fileSet(o.dependencies, DEPENDENCIES, 'existing dependencies'); for (const f of o.dependencies) sha(f.sha256);
  for (const name of FROZEN_GROUPS) validateRows(o.frozenRecords?.[name], name);
  const fault = o.workerFault;
  assert.ok(Number.isSafeInteger(fault?.pid) && fault.pid > 0); assert.match(fault.invocationId || '', /^[a-f0-9]{32}$/);
  assert.equal(fault.phase, 'official-result-failed');
  assert.equal(fault.error, 'npm run validate:data exited with 1');
  assert.equal(fault.assertion, 'matches-current.json must contain a non-empty array.');
  const [start, finish, status] = [fault.lastCycleStartedAt, fault.lastCycleFinishedAt, fault.statusCheckedAt].map(instant);
  assert.ok(start <= finish && finish <= status && status <= at, 'worker failure clocks are not bound');
  assert.ok(Array.isArray(fault.journalEntries) && fault.journalEntries.length > 0 && fault.journalEntries.length <= 3000, 'worker journal evidence missing');
  for (const entry of fault.journalEntries) {
    const stamp = instant(entry.at); assert.ok(stamp >= start && stamp <= finish, 'journal evidence outside failed cycle');
    assert.ok(Number.isSafeInteger(entry.pid) && entry.pid > 0); sha(entry.messageSha256);
  }
  for (const [label, value] of [['relay', o.relay], ['registry', o.registry]]) {
    assert.ok(object(value) && typeof value.path === 'string' && value.path.startsWith('/') && !value.path.split('/').includes('..'), label + ' path invalid');
    assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= (label === 'relay' ? 32 * 1024 * 1024 : 262144), label + ' size invalid'); sha(value.sha256);
  }
  const captured = instant(o.relay.capturedAt);
  assert.ok(captured <= at && now - captured <= 1200000, 'source proof stale or future');
  assert.ok(typeof o.relay.sourceCycleId === 'string' && o.relay.sourceCycleId.trim().length > 0);
  assert.equal(o.relay.emptyCurrentIntegrityEligible, true, 'official closure proof is not eligible'); sha(o.relay.proofHash);
  assert.equal(o.entrypoint?.path, ENTRYPOINT); sha(o.entrypoint.sha256);
  const entry = Buffer.from(o.entrypoint.base64 || '', 'base64');
  assert.equal(entry.toString('base64'), o.entrypoint.base64); assert.equal(hash(entry), o.entrypoint.sha256); guardedEntrypoint(entry);
  return o;
}
function verify(bytes, signature, publicKey, now = Date.now()) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length < 8 * 1024 * 1024, 'repair capsule size invalid');
  const key = crypto.createPublicKey(publicKey);
  assert.equal(key.asymmetricKeyType, 'rsa'); assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072, 'signing key too small');
  assert.ok(crypto.verify('sha256', bytes, key, signature), 'repair signature invalid');
  const p = JSON.parse(bytes);
  assert.equal(p.version, VERSION); assert.equal(p.site, 'football-predict'); assert.equal(p.channel, 'production');
  assert.equal(p.baseRuntimeSha256, BASE_RUNTIME); assert.equal(p.baseSequence, 785);
  assert.equal(p.baseFrontendSequence, BASE_FRONTEND.sequence); assert.equal(p.baseFrontendSha256, BASE_FRONTEND.sha256);
  const start = instant(p.createdAt), end = instant(p.expiresAt);
  assert.ok(start <= now && end > now && end > start && end - start <= 30 * 60000, 'repair expired or invalid lifetime');
  validateObservation(p.observation, now); assert.ok(instant(p.observation.checkedAt) <= start, 'observation is newer than signature creation');
  fileSet(p.files, FILES, 'repair files');
  const content = f => {
    sha(f.sha256); const value = Buffer.from(f.base64 || '', 'base64');
    assert.ok(value.length > 0 && value.length < 2 * 1024 * 1024, 'invalid artifact size');
    assert.equal(value.toString('base64'), f.base64, 'non-canonical base64'); assert.equal(hash(value), f.sha256, 'content hash mismatch');
  };
  for (const f of p.files) {
    assert.equal(f.beforeSha256, p.observation.files.find(row => row.path === f.path).sha256, 'before hash differs from observed source');
    assert.equal(f.beforeSha256 === null, f.path === FILES[2], 'only closure helper may be newly created');
    content(f); assert.notEqual(f.sha256, f.beforeSha256, 'unchanged file is outside repair delta');
  }
  assert.ok(object(p.artifacts)); assert.deepEqual(Object.keys(p.artifacts).sort(), [...ARTIFACTS].sort());
  for (const value of Object.values(p.artifacts)) content(value);
  for (const flag of ['modelPromotion', 'storageMigration', 'dataRewrite']) assert.equal(p[flag], false, 'repair cannot enable ' + flag);
  const guard = p.entrypointGuard;
  assert.equal(guard?.path, ENTRYPOINT); assert.equal(guard.beforeSha256, p.observation.entrypoint.sha256);
  const target = guardedEntrypoint(Buffer.from(p.observation.entrypoint.base64, 'base64'));
  assert.equal(guard.sha256, hash(target)); assert.equal(guard.base64, target.toString('base64'));
  assert.equal(guard.preserveOnRollback, true, 'crash interlock must survive code rollback');
  return p;
}
function compareFrozen(before, after) {
  for (const group of FROZEN_GROUPS) {
    validateRows(before?.[group], group); validateRows(after?.[group], group);
    const records = new Map(after[group].map(row => [row.id, row.hash]));
    for (const row of before[group]) assert.equal(records.get(row.id), row.hash, 'changed frozen ' + group + ': ' + row.id);
  }
  return { ok: true, retained: Object.fromEntries(FROZEN_GROUPS.map(group => [group, before[group].length])) };
}
function assessOfficial(status, service, startedAt, oldPid, observedAt = new Date().toISOString()) {
  try {
    const pid = Number(service?.MainPID), cycle = status?.lastCycle, event = cycle?.officialPhase;
    const times = [startedAt, String(service?.ExecMainStartTimestamp || '').replace(/\bCST$/, '+0800'), cycle?.startedAt,
      event?.startedAt, event?.finishedAt, cycle?.finishedAt, status?.checkedAt, observedAt].map(Date.parse);
    const lateFailure = status?.eventCycle?.ok === false
      && (Date.parse(status.eventCycle.startedAt) >= Date.parse(cycle?.startedAt) || Date.parse(status.eventCycle.finishedAt) >= Date.parse(cycle?.finishedAt));
    // Only systemctl's rounded timestamp receives subsecond tolerance.
    const clocks = times.every(Number.isFinite) && times[1] >= Math.floor(times[0] / 1000) * 1000
      && times[2] >= times[0] && times.slice(2).every((value, i) => value >= times[i + 1]);
    return Boolean(service?.ActiveState === 'active' && Number.isSafeInteger(oldPid) && oldPid > 0
      && Number.isSafeInteger(pid) && pid > 0 && pid !== oldPid && status?.pid === pid && status.ok === true
      && status.lastError == null && cycle?.ok === true && cycle.skipped !== true && event?.ok === true
      && event.phase === 'official-result-published' && clocks && !lateFailure);
  } catch { return false; }
}
module.exports = { VERSION, BASE_RUNTIME, BASE_FRONTEND, FILES, DEPENDENCIES, ARTIFACTS, FROZEN_GROUPS,
  ENTRYPOINT, GUARD_LINES, hash, guardedEntrypoint, validateObservation, verify, compareFrozen, assessOfficial };
