'use strict';
// Pure inventory classification. A candidate is NOT deletion authorization.
// The executor must independently re-prove identity, references, retained
// backups/signatures and exclusive release lock immediately before mutation.
const assert = require('node:assert/strict');
const SHA = /^[a-f0-9]{64}$/;
const DAY = 86400000;
const POLICY = Object.freeze({ version: 'release-retention-plan-v1', minimumAgeMs: DAY,
  keepCompletedReleases: 2, maxReleasesPerRun: 2 });
const REQUIRED_EXECUTION_PROOFS = Object.freeze([
  'fresh-exclusive-release-fd9-lock', 'unchanged-runtime-and-complete-markers',
  'no-active-publisher-or-unresolved-recovery', 'exact-cluster-database-name-oid-owner',
  'zero-connections-no-external-references', 'original-archive-signature-and-inventory',
  'retained-dump-exact-bytes-hash', 'retained-generation-recovery-dependency-audit',
  'retired-build-and-candidate-access', 'durable-intent-and-per-operation-receipt',
  'post-operation-production-and-frozen-record-continuity'
]);
function planReleaseRetention(snapshot, now = Date.now()) {
  assert(Number.isSafeInteger(now) && now > 0, 'invalid-clock');
  assert(snapshot && Array.isArray(snapshot.rows) && snapshot.rows.length <= 128, 'invalid-inventory');
  assert(SHA.test(snapshot.runtimeSha) && snapshot.runtimeSha === snapshot.completeSha, 'runtime-not-complete');
  assert(snapshot.recoveryPending === false, 'recovery-state-not-clear');
  const observed = Date.parse(snapshot.observedAt);
  assert(Number.isFinite(observed) && observed <= now && now - observed <= 300000, 'inventory-stale');
  assert(snapshot.pg && typeof snapshot.pg.clusterId === 'string' && /^\d+$/.test(snapshot.pg.clusterId), 'cluster-missing');
  const dbs = snapshot.pg.databases;
  assert(Array.isArray(dbs) && dbs.length <= 256, 'invalid-databases');
  assert(new Set(dbs.map(d => d.datname)).size === dbs.length && new Set(dbs.map(d => String(d.oid))).size === dbs.length, 'duplicate-database');
  assert(new Set(snapshot.rows.map(r => r.sha)).size === snapshot.rows.length, 'duplicate-release');
  const production = dbs.find(d => d.datname === 'football');
  assert(production && Number.isSafeInteger(Number(production.oid)) && Number(production.oid) > 0, 'production-missing');
  const current = snapshot.rows.find(r => r.sha === snapshot.runtimeSha);
  assert(current?.state && SHA.test(current.state.oldSha), 'rollback-identity-missing');
  for (const r of snapshot.rows) assert(SHA.test(r.sha), 'invalid-release-sha');
  function terminal(r) {
    const s = r.status?.fields, end = Date.parse(s?.finishedAt), start = Date.parse(s?.startedAt);
    return Boolean(s && s.status === 'complete' && s.ok === '1' && s.exitCode === '0' && s.releaseKind === 'full'
      && s.bundleSha256 === r.sha && /^[1-9]\d*$/.test(s.releaseSequence) && Number.isSafeInteger(Number(s.releaseSequence))
      && Number.isFinite(start) && start <= end && end <= now);
  }
  const completed = snapshot.rows.filter(terminal).sort((a, b) => Number(b.status.fields.releaseSequence) - Number(a.status.fields.releaseSequence));
  const protectedShas = new Set([snapshot.runtimeSha, current.state.oldSha,
    ...completed.slice(0, POLICY.keepCompletedReleases).map(r => r.sha)]);
  const rows = snapshot.rows.map(r => {
    const reasons = [], s = r.state, status = r.status?.fields;
    if (protectedShas.has(r.sha)) reasons.push('current-or-recent-rollback-release');
    if (!terminal(r)) reasons.push('not-proven-completed-full-release');
    else if (now - Date.parse(status.finishedAt) < POLICY.minimumAgeMs) reasons.push('completed-less-than-24-hours');
    const c = s?.contract, p = String(production.oid);
    if (!s || s.sha !== r.sha || s.kind !== 'runtime-only' || s.clusterId !== snapshot.pg.clusterId
      || String(s.oldDatabaseOid) !== p || !c || c.kind !== 'runtime-only' || c.clusterId !== snapshot.pg.clusterId
      || String(c.oldDatabaseOid) !== p || String(c.newDatabaseOid) !== p || c.candidateDatabase !== null || c.archiveDatabase !== null)
      reasons.push('not-disposable-runtime-only-clone');
    const db = dbs.find(d => d.datname === s?.candidateDatabase);
    if (db && (!new RegExp('^football_release_' + r.sha.slice(0, 12) + '_[1-9][0-9]*$').test(db.datname)
      || String(db.oid) !== String(s?.candidateOid) || String(db.oid) === p || !Number.isSafeInteger(db.bytes) || db.bytes <= 0))
      reasons.push('candidate-database-identity-mismatch');
    if (!db && dbs.some(d => String(d.oid) === String(s?.candidateOid))) reasons.push('candidate-oid-renamed');
    if (db && db.connections !== 0) reasons.push('candidate-has-connections-or-unknown');
    const f = r.evidence?.['data-finalized.json'], seed = r.evidence?.['seed-accepted.json'], backup = r.evidence?.['backup.json'];
    if (!f || f.ok !== true || f.sha !== r.sha || String(f.databaseOid) !== p || f.databaseWrites !== 0 || f.databaseRenames !== 0
      || !seed || seed.ok !== true || seed.sha !== r.sha || !backup || !SHA.test(backup.sha256)
      || !Number.isSafeInteger(backup.bytes) || backup.bytes <= 0
      || backup.archive !== '/var/lib/football-release/native/' + r.sha + '/football.dump') reasons.push('retained-evidence-metadata-incomplete');
    if (r.evidence?.['build-access-dropped.json']?.ok !== true || r.evidence?.['candidate-access-dropped.json']?.ok !== true)
      reasons.push('access-retirement-not-proven');
    assert(Array.isArray(r.stores) && r.stores.every(n => /^(seed|refresh)-[1-9][0-9]*-store$/.test(n)), 'invalid-store-target');
    const stores = r.stores.map(n => '/var/lib/football-release/native/' + r.sha + '/' + n);
    if (!db && !stores.length) reasons.push('nothing-left-to-reclaim');
    return { sha: r.sha, sequence: status?.releaseSequence || null, classification: reasons.length ? 'retain' : 'candidate-needs-execution-proof',
      reasons, database: db ? { name: db.datname, oid: String(db.oid), logicalBytes: db.bytes } : null,
      storePaths: stores, databaseAlreadyAbsent: !db, deletionAuthorized: false };
  });
  const candidates = rows.filter(r => r.classification === 'candidate-needs-execution-proof')
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  return { version: POLICY.version, observedAt: snapshot.observedAt, plannedAt: new Date(now).toISOString(),
    policy: POLICY, runtimeSha: snapshot.runtimeSha, protectedShas: [...protectedShas], rows,
    candidateCount: candidates.length, candidateDatabaseLogicalBytes: candidates.reduce((n, r) => n + (r.database?.logicalBytes || 0), 0),
    firstBatch: candidates.slice(0, POLICY.maxReleasesPerRun).map(r => r.sha),
    requiredExecutionProofs: REQUIRED_EXECUTION_PROOFS, deletionAuthorized: false, productionWrites: 0,
    retained: ['production-and-legacy-databases', 'failed-or-unresolved-transactions', 'football.dump-and-backup.json',
      'original-signed-archives', 'state-status-journals-and-audit-receipts'],
    note: 'Logical database sizes are estimates, not measured filesystem space freed. No deletion or timer installation is performed.' };
}
module.exports = { POLICY, REQUIRED_EXECUTION_PROOFS, planReleaseRetention };
