'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const t = require('../services/release/writerHandoverTransaction.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clone = value => structuredClone(value);
async function fixture(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'football-writer-handover-'));
  const s = t.store({ base, boundary: base, uid: 0, fixture: true });
  const old = { version: 'writer-owner-v1', role: 'official', epoch: 0, unit: 'football-sync-worker.service', archiveSha256: 'a'.repeat(64), head: 'b'.repeat(40) };
  s.writeNew(path.join(base, 'owner.json'), old);
  const id = 'c'.repeat(24), candidate = { ...old, epoch: 1, unit: 'football-writer-official-' + id + '.service', archiveSha256: 'd'.repeat(64), head: 'e'.repeat(40) };
  const body = { version: 'writer-handover-authorization-v1', attemptId: id, role: 'official', candidate, previousOwnerSha256: t.digest(old), controllerSha256: 'f'.repeat(64), expectedAppSha256: old.archiveSha256, issuedAtMs: 10_000, expiresAtMs: 20_000 };
  const request = { body, signature: 'fixture-signature-verified-by-fixture-adapter' };
  let fence = clone(old), now = 11_000;
  const running = new Set([old.unit]), events = [], commits = [];
  const runtime = {
    wallNow: () => now,
    monotonicNow: () => now,
    async verifyRequest(r, options) { events.push(['verify', options.recovery]); return { signatureVerified: true, body: r.body }; },
    async assertBoundary(_auth, options) { events.push(['boundary', options.recovery]); },
    async assertFrozenHistory() { events.push(['frozen']); },
    async stopOwner(o) { events.push(['stop', o.unit]); a(s.read(path.join(base, 'active-transaction.json'))); running.delete(o.unit); },
    async assertQuiescent(o) { events.push(['quiescent', o.unit]); if (running.has(o.unit)) fail('WRITER_STILL_RUNNING'); },
    async commitFence(o, previous, operation) {
      events.push(['commit', operation]); a.deepEqual(fence, previous); commits.push(operation); fence = clone(o);
      return { outcome: 'committed', owner: clone(fence), receiptSha256: '1'.repeat(64) };
    },
    async readFence() { events.push(['read-fence']); return { outcome: 'committed', owner: clone(fence), receiptSha256: '1'.repeat(64) }; },
    async startOwner(o) { events.push(['start', o.unit]); a.deepEqual(fence, o); a(![...running].some(u => u !== o.unit)); running.add(o.unit); },
    async verifyOwner(o) { events.push(['health', o.unit]); a(running.has(o.unit)); },
    async finalizeAccepted() { events.push(['finalize']); },
  };
  const x = { base, s, old, candidate, request, runtime, events, commits, running, advance: v => { now = v; } };
  try { await run(x); }
  finally {
    a.equal(fs.realpathSync(base).toLowerCase(), path.resolve(base).toLowerCase());
    a(path.basename(base).startsWith('football-writer-handover-'));
    fs.rmSync(base, { recursive: true });
  }
}
test('old owner quiesces before fence commit and candidate startup; accepted receipt is durable', () => fixture(async x => {
  const r = await t.handover(x.s, x.runtime, x.request); a.equal(r.phase, 'accepted');
  const event = name => x.events.findIndex(v => v[0] === name);
  a(event('stop') < event('quiescent')); a(event('quiescent') < event('commit'));
  a(event('commit') < event('read-fence')); a(event('read-fence') < event('start'));
  a.deepEqual(x.s.read(path.join(x.base, 'owner.json')).value, x.candidate);
  a.equal(x.s.read(path.join(x.base, 'active-transaction.json'), true), null);
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_ATTEMPT_ALREADY_USED' });
  a.equal(x.commits.length, 1);
}));
test('unsigned or stale request changes neither a fence nor a process', () => fixture(async x => {
  x.runtime.verifyRequest = async r => ({ signatureVerified: false, body: r.body });
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_SIGNATURE_UNPROVEN' }); a.equal(x.commits.length, 0);
  x.runtime.verifyRequest = async r => ({ signatureVerified: true, body: r.body }); x.advance(20_000);
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_AUTHORIZATION_EXPIRED' });
  a.equal(x.s.read(path.join(x.base, 'active-transaction.json'), true), null); a(x.running.has(x.old.unit));
}));
test('remaining old consumers prevent candidate startup and keep recovery pending', () => fixture(async x => {
  x.runtime.stopOwner = async () => {};
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_RECOVERY_REQUIRED' });
  a.equal(x.commits.length, 0); a(!x.running.has(x.candidate.unit));
  a.equal(x.s.read(path.join(x.base, 'active-transaction.json')).value.phase, 'recovery-required');
}));
test('unknown COMMIT never starts candidate or retries the unresolved fence write', () => fixture(async x => {
  const commit = x.runtime.commitFence;
  x.runtime.commitFence = async (...args) => { await commit(...args); fail('COMMIT_UNKNOWN'); };
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_RECOVERY_REQUIRED' });
  a.equal(x.commits.length, 1); a(!x.running.has(x.candidate.unit));
  a.equal(x.s.read(path.join(x.base, 'active-transaction.json')).value.phase, 'commit-unknown');
  x.runtime.readFence = async () => ({ outcome: 'unknown' });
  await a.rejects(t.recover(x.s, x.runtime), { code: 'WRITER_FENCE_COMMIT_UNKNOWN' }); a.equal(x.commits.length, 1);
}));
test('confirmed unknown-commit recovery restores old code using a higher epoch, never starts candidate', () => fixture(async x => {
  const commit = x.runtime.commitFence;
  x.runtime.commitFence = async (...args) => { await commit(...args); fail('COMMIT_UNKNOWN'); };
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_RECOVERY_REQUIRED' });
  x.runtime.commitFence = commit; x.advance(90_000);
  const r = await t.recover(x.s, x.runtime); a.equal(r.phase, 'rolled-back'); a.equal(r.restored.epoch, 2);
  a.equal(r.restored.archiveSha256, x.old.archiveSha256); a(x.running.has(x.old.unit));
  a(!x.events.some(v => v[0] === 'start' && v[1] === x.candidate.unit));
  a.deepEqual(x.commits, [x.request.body.attemptId + ':activate', x.request.body.attemptId + ':restore']);
}));
test('candidate health failure stops it before restoring the old writer', () => fixture(async x => {
  const healthy = x.runtime.verifyOwner;
  x.runtime.verifyOwner = async o => { if (o.unit === x.candidate.unit) fail('WRITER_HEALTH_FAILED'); await healthy(o); };
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_HEALTH_FAILED' });
  const r = x.s.read(path.join(x.base, 'attempt-' + x.request.body.attemptId + '.json')).value;
  a.equal(r.phase, 'rolled-back'); a.equal(r.restored.epoch, 2);
  a(x.running.has(x.old.unit)); a(!x.running.has(x.candidate.unit));
}));
test('failed candidate stop cannot restore or start another writer', () => fixture(async x => {
  const stop = x.runtime.stopOwner;
  x.runtime.stopOwner = async o => { if (o.unit === x.candidate.unit) fail('WRITER_STOP_UNPROVEN'); await stop(o); };
  x.runtime.verifyOwner = async () => fail('WRITER_HEALTH_FAILED');
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_RECOVERY_REQUIRED' });
  a.equal(x.commits.length, 1); a(!x.running.has(x.old.unit));
  a.equal(x.s.read(path.join(x.base, 'active-transaction.json')).value.phase, 'recovery-required');
}));
test('frozen history mismatch is retained and no legacy writer restarts over corrupt history', () => fixture(async x => {
  let calls = 0;
  x.runtime.assertFrozenHistory = async () => { if (++calls >= 3) fail('FROZEN_HISTORY_CHANGED'); };
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_RECOVERY_REQUIRED' });
  a.equal(x.running.size, 0); a.equal(x.s.read(path.join(x.base, 'active-transaction.json')).value.phase, 'recovery-required');
}));
test('accepted finalization interruption is completed by recovery without stopping or restarting writers', () => fixture(async x => {
  x.runtime.finalizeAccepted = async () => fail('RECEIPT_UNAVAILABLE');
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'RECEIPT_UNAVAILABLE' });
  a.equal(x.s.read(path.join(x.base, 'active-transaction.json')).value.phase, 'accepted');
  const starts = x.events.filter(v => v[0] === 'start').length, stops = x.events.filter(v => v[0] === 'stop').length;
  x.runtime.finalizeAccepted = async () => {}; x.advance(90_000);
  a.equal((await t.recover(x.s, x.runtime)).phase, 'accepted');
  a.equal(x.events.filter(v => v[0] === 'start').length, starts); a.equal(x.events.filter(v => v[0] === 'stop').length, stops);
}));
test('foreign fence ownership is never overwritten during recovery', () => fixture(async x => {
  x.runtime.commitFence = async () => fail('COMMIT_UNKNOWN');
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_RECOVERY_REQUIRED' });
  x.runtime.readFence = async () => ({ outcome: 'committed', owner: { ...x.old, epoch: 99 }, receiptSha256: '1'.repeat(64) });
  await a.rejects(t.recover(x.s, x.runtime), { code: 'WRITER_FENCE_OWNER_CONFLICT' }); a.equal(x.commits.length, 0);
}));
test('layout flag alone cannot launch a production writer CLI or default runner', () => {
  const { runTask } = require('../services/tasks/run.cjs');
  a.throws(() => runTask('team', { env: { FOOTBALL_SERVICE_LAYOUT: 'separated-v1' } }), { code: 'WRITER_HANDOVER_UNIMPLEMENTED' });
  const r = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../services/tasks/run.cjs'), 'team'],
    { env: { ...process.env, FOOTBALL_SERVICE_LAYOUT: 'separated-v1' }, encoding: 'utf8', timeout: 5000, windowsHide: true });
  a.equal(r.status, 75); a.equal(r.stderr.trim(), 'WRITER_HANDOVER_UNIMPLEMENTED');
  const plan = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../services/tasks/run.cjs'), 'team', '--plan'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  a.equal(plan.status, 0); a.equal(JSON.parse(plan.stdout).role, 'team');
});
test('tampered prior-owner code cannot become a recovery target', () => fixture(async x => {
  x.runtime.commitFence = async () => fail('COMMIT_UNKNOWN');
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_RECOVERY_REQUIRED' });
  const file = path.join(x.base, 'active-transaction.json'), current = x.s.read(file);
  x.s.replace(file, { ...current.value, previous: { ...current.value.previous, head: '9'.repeat(40) } }, current.sha256);
  await a.rejects(t.recover(x.s, x.runtime), { code: 'INVALID_WRITER_TRANSACTION' }); a.equal(x.commits.length, 0);
}));
test('a changed fence read-back receipt is refused before candidate startup', () => fixture(async x => {
  const readFence = x.runtime.readFence;
  x.runtime.readFence = async () => ({ ...await readFence(), receiptSha256: '2'.repeat(64) });
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_FENCE_RECEIPT_CHANGED' });
  a(!x.events.some(v => v[0] === 'start' && v[1] === x.candidate.unit)); a(x.running.has(x.old.unit));
}));
test('wall rollback and elapsed monotonic budget are rejected before installing a candidate fence', () => fixture(async x => {
  const quiet = x.runtime.assertQuiescent;
  x.runtime.assertQuiescent = async o => { await quiet(o); if (o.unit === x.old.unit) x.advance(10_500); };
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_AUTHORIZATION_EXPIRED' });
  a(!x.commits.some(v => v.endsWith(':activate')));
}));
test('monotonic exhaustion cannot be hidden by a valid wall-clock grant', () => fixture(async x => {
  let reads = 0;
  x.runtime.monotonicNow = () => ++reads <= 2 ? 0 : 900_000;
  await a.rejects(t.handover(x.s, x.runtime, x.request), { code: 'WRITER_AUTHORIZATION_EXPIRED' });
  a(!x.commits.some(v => v.endsWith(':activate'))); a(!x.running.has(x.candidate.unit));
}));
