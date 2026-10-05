'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../scripts/officialClosureRepairPolicy.cjs');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const now = Date.parse('2026-10-03T01:00:00.000Z');
const sha = 'a'.repeat(64), other = 'b'.repeat(64);
const iso = offset => new Date(now + offset).toISOString();
const material = value => ({ sha256: policy.hash(value), base64: Buffer.from(value).toString('base64') });
function fixture() {
  const entry = Buffer.from('#!/bin/bash\nacquire_release_lock() {\n  exec 9>"$LOCK_FILE"\n  flock -n 9 || die "another release or recovery is active"\n  [ ! -e "/var/lib/football-release/reference-repairs/current" ] || die "old guard"\n}\n');
  const generation = { generationId: 'g-' + sha, manifestHash: sha, sourceCycleId: 'original-generation', committedAt: iso(-3600000) };
  const observation = {
    checkedAt: iso(-1000), runtime: policy.BASE_RUNTIME, complete: policy.BASE_RUNTIME, productionWrites: 0,
    frontendStateSha256: sha, frontendSequence: policy.BASE_FRONTEND.sequence, frontendSha256: policy.BASE_FRONTEND.sha256,
    generation, postgres: { database: 'football', oid: '28598409', systemIdentifier: '1234567890123456789', publication: { mode: 'active-generation', ...generation } },
    workerFault: { pid: 123, invocationId: 'a'.repeat(32), statusCheckedAt: iso(-1500), lastCycleStartedAt: iso(-90000), lastCycleFinishedAt: iso(-2000),
      phase: 'official-result-failed', error: 'npm run validate:data exited with 1', assertion: 'matches-current.json must contain a non-empty array.',
      journalEntries: [{ pid: 124, at: iso(-3000), messageSha256: sha }] },
    relay: { path: '/var/lib/football-relay/active.json', bytes: 2780000, sha256: sha, capturedAt: iso(-60000), sourceCycleId: 'new-relay-cycle', emptyCurrentIntegrityEligible: true, proofHash: sha },
    registry: { path: '/etc/football-predict/trust-registry.json', bytes: 1240, sha256: sha },
    files: policy.FILES.map((file, i) => ({ path: file, sha256: i === 2 ? null : sha })),
    dependencies: policy.DEPENDENCIES.map(file => ({ path: file, sha256: sha })),
    frozenRecords: Object.fromEntries(policy.FROZEN_GROUPS.map(group => [group, [{ id: group + '-1', hash: sha }]])),
    entrypoint: { path: policy.ENTRYPOINT, ...material(entry) },
  };
  const guard = policy.guardedEntrypoint(entry);
  return { version: policy.VERSION, site: 'football-predict', channel: 'production', createdAt: iso(0), expiresAt: iso(30 * 60000),
    baseRuntimeSha256: policy.BASE_RUNTIME, baseSequence: 785, baseFrontendSequence: 787, baseFrontendSha256: policy.BASE_FRONTEND.sha256,
    observation, files: policy.FILES.map((file, i) => ({ path: file, beforeSha256: i === 2 ? null : sha, ...material('// reviewed patch: ' + file + '\n') })),
    artifacts: Object.fromEntries(policy.ARTIFACTS.map(name => [name, material('// ' + name + '\n')])),
    entrypointGuard: { path: policy.ENTRYPOINT, beforeSha256: observation.entrypoint.sha256, ...material(guard), preserveOnRollback: true },
    modelPromotion: false, storageMigration: false, dataRewrite: false };
}
function verify(value, at = now) {
  const bytes = Buffer.from(JSON.stringify(value));
  return policy.verify(bytes, crypto.sign('sha256', bytes, keys.privateKey), publicKey, at);
}
test('accepts a complete signed r785/r787 three-file closure capsule without promotion', () => {
  const p = verify(fixture()); assert.equal(p.baseSequence, 785); assert.equal(p.modelPromotion, false);
  assert.deepEqual(p.files.map(row => row.path), policy.FILES);
});
test('signature covers exact capsule bytes and cannot be substituted or mutated', () => {
  const bytes = Buffer.from(JSON.stringify(fixture())), signature = crypto.sign('sha256', bytes, keys.privateKey);
  assert.throws(() => policy.verify(bytes, Buffer.alloc(signature.length), publicKey, now), /signature/);
  assert.throws(() => policy.verify(Buffer.concat([bytes, Buffer.from(' ')]), signature, publicKey, now), /signature/);
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => policy.verify(bytes, crypto.sign('sha256', bytes, weak.privateKey), weak.publicKey.export({ type: 'spki', format: 'pem' }), now), /key too small/);
});
const mutations = {
  version: p => p.version = 'postgres-reference-repair-v1',
  site: p => p.site = 'another-site',
  channel: p => p.channel = 'staging',
  'base runtime': p => p.baseRuntimeSha256 = other,
  'base sequence': p => p.baseSequence = 786,
  'frontend sequence': p => p.baseFrontendSequence = 788,
  'frontend SHA': p => p.baseFrontendSha256 = other,
  'observed runtime': p => p.observation.runtime = other,
  'observed complete': p => p.observation.complete = other,
  'observed frontend': p => p.observation.frontendSha256 = other,
  'missing frontend state': p => delete p.observation.frontendStateSha256,
  'expired capsule': p => p.expiresAt = iso(0),
  'future creation': p => p.createdAt = iso(1),
  'overlong TTL': p => p.expiresAt = iso(30 * 60000 + 1),
  'stale observation': p => p.observation.checkedAt = iso(-15 * 60000 - 1),
  'future observation': p => p.observation.checkedAt = iso(1),
  'unsigned clock zone': p => p.createdAt = '2026-10-03T01:00:00',
  'normalized impossible clock': p => p.createdAt = '2026-02-30T01:00:00Z',
  'extra business file': p => p.files.push({ ...p.files[0], path: 'server/index.cjs' }),
  'missing business file': p => p.files.pop(),
  'duplicate business file': p => p.files[1] = p.files[0],
  'path traversal': p => p.files[0].path = 'scripts/../server/index.cjs',
  'wrong before hash': p => p.files[0].beforeSha256 = other,
  'new existing file': p => p.files[0].beforeSha256 = null,
  'existing new helper': p => p.observation.files[2].sha256 = other,
  'unchanged patched file': p => { p.files[0].beforeSha256 = p.files[0].sha256; p.observation.files[0].sha256 = p.files[0].sha256; },
  'content tampering': p => p.files[0].base64 = Buffer.from('unreviewed bytes').toString('base64'),
  'noncanonical base64': p => p.files[0].base64 += '\n',
  'missing controller': p => delete p.artifacts.controller,
  'extra executable artifact': p => p.artifacts.shell = material('danger'),
  'missing dependency': p => p.observation.dependencies.pop(),
  'unknown dependency': p => p.observation.dependencies[0].path = 'scripts/extra.cjs',
  'invalid dependency hash': p => p.observation.dependencies[0].sha256 = null,
  'model promotion': p => p.modelPromotion = true,
  'storage migration': p => p.storageMigration = true,
  'data rewrite': p => p.dataRewrite = true,
  'production writes': p => p.observation.productionWrites = 1,
  'wrong database': p => p.observation.postgres.database = 'other',
  'PG generation drift': p => p.observation.postgres.publication.sourceCycleId = 'other-cycle',
  'invalid pointer': p => p.observation.generation.generationId = 'g-' + other,
  'missing frozen baseline': p => p.observation.frozenRecords.archives = [],
  'duplicate frozen baseline': p => p.observation.frozenRecords.archives.push(p.observation.frozenRecords.archives[0]),
  'generic worker error': p => p.observation.workerFault.error = 'SYNC_WORKER_COMMAND_FAILED',
  'unproven assertion': p => p.observation.workerFault.assertion = 'fetch failed',
  'wrong worker phase': p => p.observation.workerFault.phase = 'official-result-published',
  'invalid invocation': p => p.observation.workerFault.invocationId = 'unknown',
  'missing journal': p => p.observation.workerFault.journalEntries = [],
  'future worker status': p => p.observation.workerFault.statusCheckedAt = iso(1),
  'journal outside cycle': p => p.observation.workerFault.journalEntries[0].at = iso(-90001),
  'journal after cycle': p => p.observation.workerFault.journalEntries[0].at = iso(-1999),
  'missing message hash': p => delete p.observation.workerFault.journalEntries[0].messageSha256,
  'stale source proof': p => p.observation.relay.capturedAt = iso(-1200001),
  'future source proof': p => p.observation.relay.capturedAt = iso(1),
  'unproven empty closure': p => p.observation.relay.emptyCurrentIntegrityEligible = false,
  'missing source proof hash': p => delete p.observation.relay.proofHash,
  'relay traversal': p => p.observation.relay.path = '/var/../etc/passwd',
  'empty registry': p => p.observation.registry.bytes = 0,
  'guard rollback removed': p => p.entrypointGuard.preserveOnRollback = false,
  'guard arbitrary command': p => { const bytes = Buffer.from(p.entrypointGuard.base64, 'base64'); Object.assign(p.entrypointGuard, material(Buffer.concat([bytes, Buffer.from('\necho unreviewed\n')]))); },
  'guard before mismatch': p => p.entrypointGuard.beforeSha256 = other,
  'guard target changed': p => p.entrypointGuard.path = '/etc/sudoers',
};
for (const [name, mutate] of Object.entries(mutations)) test('rejects ' + name, () => {
  const p = fixture(); mutate(p); assert.throws(() => verify(p));
});
test('proof expires at real verification time without rewriting its clock', () => {
  const p = fixture(); p.observation.relay.capturedAt = iso(-1199000);
  assert.doesNotThrow(() => verify(p)); assert.throws(() => verify(p, now + 1001), /source proof stale/);
});
test('entrypoint guard preserves all old bytes and is idempotent on LF and CRLF', () => {
  const original = Buffer.from(fixture().observation.entrypoint.base64, 'base64');
  for (const source of [original, Buffer.from(original.toString().replace(/\n/g, '\r\n'))]) {
    const result = policy.guardedEntrypoint(source), newline = source.toString().includes('\r\n') ? '\r\n' : '\n';
    assert.deepEqual(policy.guardedEntrypoint(result), result);
    assert.equal(result.toString().replace(policy.GUARD_LINES.join(newline) + newline, ''), source.toString());
    assert.ok(result.toString().includes('reference-repairs/current'));
  }
  const actual = fs.readFileSync(path.join(__dirname, '../deploy/light-server/football-release'));
  assert.ok(policy.guardedEntrypoint(actual).toString().includes('closure-repairs/current'));
});
test('entrypoint guard rejects unknown, duplicated, displaced or weakened guards', () => {
  const source = Buffer.from(fixture().observation.entrypoint.base64, 'base64').toString();
  const guard = policy.GUARD_LINES.join('\n') + '\n', patched = policy.guardedEntrypoint(Buffer.from(source)).toString();
  for (const bad of [source.replace('flock -n 9', 'flock -w 3 9'), source + source, patched + guard,
    guard + source, patched.replace('&& [ ! -L', '|| [ ! -L'), patched + '# /var/lib/football-release/closure-repairs/current\n']) {
    assert.throws(() => policy.guardedEntrypoint(Buffer.from(bad)));
  }
});
test('every prior frozen object must survive, additions may advance without rewriting history', () => {
  const before = fixture().observation.frozenRecords, after = structuredClone(before);
  for (const group of policy.FROZEN_GROUPS) after[group].push({ id: 'new-' + group, hash: other });
  assert.equal(policy.compareFrozen(before, after).ok, true);
  for (const group of policy.FROZEN_GROUPS) {
    const changed = structuredClone(after); changed[group][0].hash = other;
    assert.throws(() => policy.compareFrozen(before, changed), /changed frozen/);
    const deleted = structuredClone(after); deleted[group].shift();
    assert.throws(() => policy.compareFrozen(before, deleted), /changed frozen/);
    const duplicate = structuredClone(after); duplicate[group].push(duplicate[group][0]);
    assert.throws(() => policy.compareFrozen(before, duplicate), /duplicate/);
  }
});
function official() {
  return { service: { MainPID: '456', ActiveState: 'active', ExecMainStartTimestamp: 'Sat 2026-10-03 09:00:00 CST' },
    status: { pid: 456, ok: true, lastError: null, checkedAt: iso(61000), lastCycle: { ok: true, skipped: false, startedAt: iso(600), finishedAt: iso(60000),
      officialPhase: { ok: true, phase: 'official-result-published', startedAt: iso(800), finishedAt: iso(59000) } } } };
}
test('official acceptance binds new PID and complete new cycle with no later failure', () => {
  const { status, service } = official();
  assert.equal(policy.assessOfficial(status, service, iso(550), 123, iso(62000)), true);
  assert.equal(policy.assessOfficial(status, service, iso(550), 456, iso(62000)), false);
  assert.equal(policy.assessOfficial(status, service, iso(550), 123, iso(58000)), false);
  for (const mutate of [x => x.status.pid = 123, x => x.service.ActiveState = 'inactive', x => x.status.lastError = { code: 'failure' },
    x => x.status.lastCycle.skipped = true, x => x.status.lastCycle.ok = false, x => x.status.lastCycle.officialPhase.phase = 'event-result-published',
    x => x.status.lastCycle.startedAt = iso(549), x => x.status.lastCycle.officialPhase.finishedAt = iso(60001),
    x => x.service.ExecMainStartTimestamp = 'Sat 2026-10-03 08:59:59 CST',
    x => x.status.eventCycle = { ok: false, startedAt: iso(60000), finishedAt: iso(61000) }]) {
    const value = official(); mutate(value);
    assert.equal(policy.assessOfficial(value.status, value.service, iso(550), 123, iso(62000)), false);
  }
  assert.equal(policy.assessOfficial(null, null, iso(550), 123, iso(62000)), false);
});
