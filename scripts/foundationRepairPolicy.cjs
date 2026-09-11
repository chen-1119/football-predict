'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const VERSION = 'football-foundation-repair-v1';
const FILES = Object.freeze(['scripts/syncData.cjs','server/dataGenerationBundle.cjs','server/dataGenerationStore.cjs',
  'scripts/exportDataStoreSqlite.cjs','scripts/migrateArchivedPreMatchReferences.cjs','scripts/optimizePredictionStrategy.cjs',
  'scripts/predictionCapabilityAudit.cjs','scripts/validateData.cjs','scripts/verifyDecisionSnapshotClockLineage.cjs',
  'scripts/verifyDecisionSnapshots.cjs','scripts/verifyPredictionAudit.cjs','server/chunkedJsonFile.cjs']);
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const sha = x => assert.match(x || '', /^[a-f0-9]{64}$/);
function verify(bytes, signature, publicKey, now = Date.now()) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length < 4 * 1024 ** 2, 'capsule size invalid');
  const key = crypto.createPublicKey(publicKey);
  assert.equal(key.asymmetricKeyType, 'rsa'); assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072);
  assert.ok(crypto.verify('sha256', bytes, key, signature), 'repair signature invalid');
  const p = JSON.parse(bytes); assert.equal(p.version, VERSION);
  assert.equal(p.site, 'football-predict'); assert.equal(p.channel, 'production');
  const start = Date.parse(p.createdAt), end = Date.parse(p.expiresAt);
  assert.ok(Number.isFinite(start) && start <= now + 5000 && end > now && end > start
    && end - start <= 4 * 3600000, 'repair expired or time invalid');
  sha(p.baseRuntimeSha256); sha(p.frontendStateSha256); sha(p.snapshot.sha256); sha(p.snapshot.compactSha256);
  assert.ok(Number.isSafeInteger(p.snapshot.bytes) && p.snapshot.bytes > 0 && p.snapshot.bytes < 2 * 1024 ** 3);
  assert.ok(Number.isSafeInteger(p.snapshot.compactBytes) && p.snapshot.compactBytes > 0);
  assert.equal(p.snapshot.validBindings, 198);
  sha(p.publication.sha256);
  assert.ok(Number.isSafeInteger(p.publication.bytes)&&p.publication.bytes>0);
  assert.ok(Number.isSafeInteger(p.publication.validBindings)&&p.publication.validBindings>0
    &&p.publication.validBindings<=p.snapshot.validBindings);
  assert.deepEqual(p.files.map(f => f.path).sort(), [...FILES].sort(), 'repair paths must exactly match reviewed foundation scope');
  for (const f of p.files) {
    assert.ok(f.beforeSha256 === null || /^[a-f0-9]{64}$/.test(f.beforeSha256));
    assert.equal(f.beforeSha256 === null, f.path === 'server/chunkedJsonFile.cjs');
    sha(f.sha256); const b = Buffer.from(f.base64, 'base64');
    assert.equal(b.toString('base64'), f.base64); assert.equal(hash(b), f.sha256);
    assert.ok(b.length > 0 && b.length < 2 * 1024 ** 2);
  }
  for (const name of ['controller','proof','policy']) {
    sha(p[name].sha256); assert.equal(hash(Buffer.from(p[name].base64,'base64')),p[name].sha256);
  }
  assert.equal(p.modelPromotion, false); assert.equal(p.storageMigration, false);
  return p;
}
function objectFingerprint(value) {
  // Every top-level field and every array entry participates; no selected-field comparison.
  const h = crypto.createHash('sha256');
  for (const [k,v] of Object.entries(value)) {
    h.update(JSON.stringify(k)); h.update(':');
    if (Array.isArray(v)) { h.update('['); for(const row of v){h.update(JSON.stringify(row));h.update(',');} h.update(']'); }
    else h.update(JSON.stringify(v));
    h.update(';');
  }
  return h.digest('hex');
}
module.exports = { VERSION, FILES, hash, verify, objectFingerprint };
