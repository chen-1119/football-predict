'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MESSAGE, readStableMeta, verifySyncMetaFailure, incidentAnchor, verifyRepeatedIncident } = require('../scripts/syncMetaIncidentEvidence.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
function fixture() {
  const service = { ActiveState: 'active', MainPID: '123', ExecMainStartTimestamp: '2026-10-27T06:00:00.000Z' };
  const cycle = { ok: false, phase: 'official-result-failed', startedAt: '2026-10-27T06:10:00.000Z',
    finishedAt: '2026-10-27T06:20:00.000Z', error: 'npm run validate:data exited with 1', errorCode: 'SYNC_WORKER_COMMAND_FAILED' };
  return { worker: { checkedAt: '2026-10-27T06:20:30.000Z', serviceBefore: structuredClone(service),
    serviceAfter: structuredClone(service), processMatches: true, status: { pid: 123, ok: true,
      phase: 'official-result', checkedAt: '2026-10-27T06:20:10.000Z', lastCycle: cycle, eventCycle: cycle } },
    journal: [{ unit: 'football-sync-worker.service', pid: '456', message: MESSAGE, timestampMs: Date.parse('2026-10-27T06:19:59.000Z'), timestampUs: String(Date.parse('2026-10-27T06:19:59.000Z') * 1000) }],
    meta: { path: '/opt/football-predict/public/data/sync-meta.json', bytes: 1093301, sha256: 'a'.repeat(64), stableIdentity: true } };
}
test('verifies only the observed failure and never grants preparation', () => {
  const result = verifySyncMetaFailure(fixture());
  assert.equal(result.verified, true); assert.equal(result.workerHealthy, false);
  assert.equal(result.preparationAllowed, false); assert.equal(result.readyToCutover, false); assert.equal(result.productionWrites, 0);
});
for (const [name, mutate] of [
  ['different failure', x => { x.journal[0].message = 'another failure'; }],
  ['ambiguous journal', x => { x.journal.push(x.journal[0]); }],
  ['journal outside cycle', x => { x.journal[0].timestampMs -= 900000; }],
  ['worker changed', x => { x.worker.serviceAfter.MainPID = '124'; }],
  ['healthy cycle', x => { x.worker.status.lastCycle.ok = true; }],
  ['different command', x => { x.worker.status.lastCycle.error = 'npm run another exited with 1'; }],
  ['size exactly permitted threshold', x => { x.meta.bytes = 1000000; }],
  ['oversized evidence', x => { x.meta.bytes = 8 * 1024 * 1024; }],
  ['unstable file', x => { x.meta.stableIdentity = false; }],
  ['bad digest', x => { x.meta.sha256 = 'no'; }],
  ['stale observation', x => { x.worker.checkedAt = '2026-10-27T08:00:00.000Z'; }],
]) test(`rejects ${name}`, () => { const value = fixture(); mutate(value); assert.throws(() => verifySyncMetaFailure(value)); });

test('anchors the same failure without granting a release', () => {
  const value = fixture(), anchor = incidentAnchor(value);
  assert.equal(verifyRepeatedIncident(anchor, value).preparationAllowed, false);
});
test('admits only a later nonoverlapping same-worker observation as repeated evidence', () => {
  const first = fixture(), next = fixture(), anchor = incidentAnchor(first);
  next.worker.checkedAt = '2026-10-27T06:31:00.000Z';
  next.worker.status.checkedAt = '2026-10-27T06:30:30.000Z';
  next.worker.status.lastCycle.startedAt = '2026-10-27T06:21:00.000Z';
  next.worker.status.lastCycle.finishedAt = '2026-10-27T06:30:00.000Z';
  next.worker.status.eventCycle = next.worker.status.lastCycle;
  next.journal[0].timestampMs = Date.parse('2026-10-27T06:29:59.000Z');
  next.journal[0].timestampUs = String(next.journal[0].timestampMs * 1000);
  next.meta.sha256 = 'b'.repeat(64);
  assert.equal(verifyRepeatedIncident(anchor, next).preparationAllowed, false);
  next.worker.status.lastCycle.startedAt = '2026-10-27T06:19:00.000Z';
  assert.throws(() => verifyRepeatedIncident(anchor, next));
});
for (const [name, mutate] of [
  ['same cycle file changed', x => { x.meta.sha256 = 'b'.repeat(64); }],
  ['same cycle child changed', x => { x.journal[0].pid = '457'; }],
  ['wrong worker incarnation', x => { x.worker.serviceBefore.MainPID = x.worker.serviceAfter.MainPID = '124'; x.worker.status.pid = 124; }],
  ['forged journal clock', x => { x.journal[0].timestampUs = '1793081998000000'; }],
  ['journal child is worker', x => { x.journal[0].pid = '123'; }],
]) test(`anchor rejects ${name}`, () => {
  const original = fixture(), current = structuredClone(original); mutate(current);
  assert.throws(() => verifyRepeatedIncident(incidentAnchor(original), current));
});

test('reads complete UTF-8 JSON from a stable file without changing its bytes', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-meta-proof-')));
  try {
    fs.mkdirSync(path.join(root, 'public', 'data'), { recursive: true });
    const file = path.join(root, 'public', 'data', 'sync-meta.json');
    const bytes = Buffer.from(JSON.stringify({ observations: [], payload: 'x'.repeat(1000000) }));
    fs.writeFileSync(file, bytes);
    const proof = readStableMeta(root);
    assert.equal(proof.bytes, bytes.length);
    assert.deepEqual(fs.readFileSync(file), bytes);
    fs.writeFileSync(file, Buffer.from('x'.repeat(1000001)));
    assert.throws(() => readStableMeta(root));
    fs.writeFileSync(file, Buffer.concat([Buffer.from('{"data":"'), Buffer.alloc(1000001, 0xff), Buffer.from('"}')]));
    assert.throws(() => readStableMeta(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
