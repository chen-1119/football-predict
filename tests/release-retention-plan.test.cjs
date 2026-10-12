'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { planReleaseRetention } = require('../scripts/releaseRetentionPlan.cjs');
const now = Date.parse('2026-10-08T10:00:00Z'), sha = n => n.toString(16).padStart(64, '0');
function fixture() {
  const rows = [1, 2, 3, 4].map(n => ({ sha: sha(n),
    state: { sha: sha(n), kind: 'runtime-only', oldSha: sha(n - 1), clusterId: '123', oldDatabaseOid: '10', candidateOid: String(n + 20),
      candidateDatabase: `football_release_${sha(n).slice(0, 12)}_${n}`, contract: { kind: 'runtime-only', clusterId: '123',
        oldDatabaseOid: '10', newDatabaseOid: '10', candidateDatabase: null, archiveDatabase: null } },
    status: { fields: { status: 'complete', ok: '1', exitCode: '0', releaseKind: 'full', bundleSha256: sha(n), releaseSequence: String(n),
      startedAt: '2026-10-01T01:00:00Z', finishedAt: '2026-10-01T02:00:00Z' } },
    evidence: { 'data-finalized.json': { ok: true, sha: sha(n), databaseOid: '10', databaseWrites: 0, databaseRenames: 0 },
      'seed-accepted.json': { ok: true, sha: sha(n) }, 'backup.json': { sha256: sha(999), bytes: 1234,
        archive: `/var/lib/football-release/native/${sha(n)}/football.dump` },
      'build-access-dropped.json': { ok: true }, 'candidate-access-dropped.json': { ok: true } }, stores: ['seed-123456-store'] }));
  return { observedAt: new Date(now).toISOString(), runtimeSha: sha(4), completeSha: sha(4), recoveryPending: false, rows,
    pg: { clusterId: '123', databases: [{ datname: 'football', oid: 10, bytes: 9999, connections: 3 },
      ...rows.map(r => ({ datname: r.state.candidateDatabase, oid: Number(r.state.candidateOid), bytes: 1000, connections: 0 }))] } };
}
test('only old completed candidates; current and latest rollback protected', () => {
  const p = planReleaseRetention(fixture(), now);
  assert.equal(p.candidateCount, 2); assert.equal(p.candidateDatabaseLogicalBytes, 2000);
  assert.deepEqual(p.firstBatch, [sha(1), sha(2)]); assert.equal(p.deletionAuthorized, false);
  assert(p.rows.every(r => r.deletionAuthorized === false)); assert.equal(p.productionWrites, 0);
});
for (const [name, mutate, reason] of [
  ['failed transaction', r => { r.status.fields.status = 'failed'; }, 'not-proven-completed-full-release'],
  ['new completion', r => { r.status.fields.finishedAt = new Date(now - 1000).toISOString(); }, 'completed-less-than-24-hours'],
  ['renamed production contract', r => { r.state.contract.newDatabaseOid = '999'; }, 'not-disposable-runtime-only-clone'],
  ['non-null candidate contract', r => { r.state.contract.candidateDatabase = r.state.candidateDatabase; }, 'not-disposable-runtime-only-clone'],
  ['other cluster', r => { r.state.clusterId = '456'; }, 'not-disposable-runtime-only-clone'],
  ['OID reuse', r => { r.state.candidateOid = '999'; }, 'candidate-database-identity-mismatch'],
  ['missing dump', r => { delete r.evidence['backup.json']; }, 'retained-evidence-metadata-incomplete'],
  ['unretired access', r => { delete r.evidence['candidate-access-dropped.json']; }, 'access-retirement-not-proven'],
  ['wrong finalized release', r => { r.evidence['data-finalized.json'].sha = sha(3); }, 'retained-evidence-metadata-incomplete'],
]) test(name + ' retained', () => { const s = fixture(); mutate(s.rows[0]); const r = planReleaseRetention(s, now).rows[0];
  assert.equal(r.classification, 'retain'); assert(r.reasons.includes(reason)); });
test('busy candidate retained', () => { const s = fixture(); s.pg.databases[1].connections = 1;
  assert(planReleaseRetention(s, now).rows[0].reasons.includes('candidate-has-connections-or-unknown')); });
test('already removed database is not scheduled twice', () => { const s = fixture(); s.pg.databases.splice(1, 1);
  const r = planReleaseRetention(s, now).rows[0]; assert.equal(r.database, null); assert.equal(r.databaseAlreadyAbsent, true);
  s.rows[0].stores = []; assert(planReleaseRetention(s, now).rows[0].reasons.includes('nothing-left-to-reclaim')); });
for (const [name, mutate] of [
  ['active recovery', s => { s.recoveryPending = true; }],
  ['uncompleted runtime', s => { s.completeSha = sha(3); }],
  ['stale snapshot', s => { s.observedAt = new Date(now - 300001).toISOString(); }],
  ['future clock', s => { s.observedAt = new Date(now + 1).toISOString(); }],
  ['unknown rollback', s => { delete s.rows[3].state.oldSha; }],
  ['duplicate release', s => { s.rows.push(s.rows[0]); }],
  ['duplicate OID', s => { s.pg.databases[1].oid = 10; }],
  ['path traversal', s => { s.rows[0].stores = ['../../football']; }],
]) test(name + ' rejects entire plan', () => { const s = fixture(); mutate(s); assert.throws(() => planReleaseRetention(s, now)); });
