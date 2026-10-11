'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const signing = require('../services/release/componentSigning.cjs');
const { plan } = require('../services/release/readOnlyActivationPlan.cjs');
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyId = 'a'.repeat(64), now = Date.parse('2026-10-12T00:00:00Z');
const manifest = { version: 'independent-component-artifact-v1', component: 'read-api', head: 'b'.repeat(40),
  archiveSha256: 'c'.repeat(64), archiveBytes: 100, apiContract: 'separated-read-api-v1', schemaSha256: 'd'.repeat(64),
  entry: 'services/read-api/server.cjs', artifactPlatform: 'source', inventory: [], signed: false, activationEligible: false, databaseCopies: 0, migrations: false };
const envelope = signing.envelope(manifest, Buffer.from(JSON.stringify(manifest)), keyId);
const signature = signing.sign(envelope, key.privateKey);
test('component signatures bind exact source, archive, contract, platform and inventory in their own domain', () => {
  assert(signing.verify(envelope, signature, key.publicKey, keyId));
  for (const field of ['head', 'archiveSha256', 'manifestSha256', 'inventorySha256', 'schemaSha256']) {
    const changed = { ...envelope, [field]: 'e'.repeat(field === 'head' ? 40 : 64) };
    assert.equal(signing.verify(changed, signature, key.publicKey, keyId), false);
  }
  assert.equal(signing.verify(envelope, signature, key.publicKey, 'e'.repeat(64)), false);
  const fullManifestSignature = crypto.sign('RSA-SHA256', Buffer.from(JSON.stringify(envelope)), key.privateKey).toString('base64');
  assert.equal(signing.verify(envelope, fullManifestSignature, key.publicKey, keyId), false);
  for (const changed of [{ ...envelope, activationEligible: true }, { ...envelope, migrations: true }, { ...envelope, databaseCopies: 1 }, { ...envelope, extra: true }]) {
    assert.equal(signing.verify(changed, signature, key.publicKey, keyId), false);
  }
});
const actual = { signatureVerified: true, archiveSha256: envelope.archiveSha256, sourceHead: envelope.head,
  platform: 'linux', runtimeVerified: true, runtimeArchiveSha256: envelope.archiveSha256,
  apiContract: envelope.apiContract, schemaSha256: envelope.schemaSha256, releaseLockHeld: true,
  releaseProcesses: [], recoveryPending: false, appSha256: 'f'.repeat(64), completeSha256: 'f'.repeat(64),
  databaseOid: '28598409', databaseWritesEnabled: false, migrations: false, observedAtMs: now,
  leaseStartedAtMs: now - 1000, elapsedMonotonicMs: 1000, requiredBytes: 1000, availableBytes: 2000,
  loopbackPortAvailable: true, existingProductionServicesUnchanged: true };
test('read-only installation design isolates the component and keeps database and writer ownership', () => {
  const result = plan(envelope, actual, now);
  assert.equal(result.databaseCopies, 0); assert.equal(result.migrations, false); assert.equal(result.installed, false);
  assert.equal(result.executableControllerImplemented, false); assert.equal(result.productionWriterStarted, false);
  assert.throws(() => plan({ ...envelope, component: 'recommendation', entry: 'services/tasks/run.cjs' }, actual, now), { code: 'WRITER_HANDOVER_UNIMPLEMENTED' });
});
test('signing alone never admits Windows web, unknown runtime or stale/inconsistent production state', () => {
  for (const change of [{ signatureVerified: false }, { runtimeVerified: false }, { runtimeArchiveSha256: 'e'.repeat(64) },
    { schemaSha256: 'e'.repeat(64) }, { recoveryPending: true }, { releaseLockHeld: false }, { releaseProcesses: [123] },
    { completeSha256: 'e'.repeat(64) }, { databaseWritesEnabled: true }, { databaseOid: '1' }, { observedAtMs: now - 60001 },
    { leaseStartedAtMs: now - 900000 }, { elapsedMonotonicMs: 900000 }, { availableBytes: 1 },
    { loopbackPortAvailable: false }, { existingProductionServicesUnchanged: false }]) assert.throws(() => plan(envelope, { ...actual, ...change }, now));
  assert.throws(() => plan({ ...envelope, component: 'web', entry: 'apps/web/server.js', artifactPlatform: 'win32' }, actual, now), { code: 'LINUX_RUNTIME_REQUIRED' });
});
