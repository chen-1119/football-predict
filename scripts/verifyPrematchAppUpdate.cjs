'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), vm = require('node:vm');
const { applyRemote } = require('./deployPrematchAppUpdate.cjs');
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const manifest = () => ({ version: 'prematch-app-update-v1', commit: 'a'.repeat(40), baseBundle: 'b'.repeat(64),
  createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), files: [] });
const signed = value => { const bytes = Buffer.from(JSON.stringify(value)); return { payload: bytes.toString('base64'), signature: crypto.sign('sha256', bytes, keys.privateKey).toString('base64') }; };
let applicationWrites = 0, restarts = 0;
const fs = {
  readFileSync(file) {
    if (file === '/etc/football-release/signing-public.pem') return publicKey;
    if (file === '/opt/football-predict/.release-bundle-sha256') return 'b'.repeat(64);
    throw new Error('Unexpected read: ' + file);
  },
  existsSync: () => false,
  mkdirSync(file) { if (file.startsWith('/opt/')) applicationWrites++; },
  writeFileSync() { applicationWrites++; },
};
const apply = vm.runInNewContext('(' + applyRemote.toString() + ')', {
  require(name) { return name === 'node:fs' ? fs : name === 'node:child_process' ? { execFileSync() { restarts++; } } : require(name); },
  Buffer, console, Date,
});
(async () => {
  const invalid = signed(manifest()); invalid.signature = Buffer.alloc(256).toString('base64');
  await assert.rejects(apply(invalid), /Invalid update signature/);
  await assert.rejects(apply(signed({ ...manifest(), expiresAt: '2000-01-01T00:00:00Z' })), /Update expired/);
  await assert.rejects(apply(signed({ ...manifest(), baseBundle: 'c'.repeat(64) })), /Application baseline changed/);
  for (const file of ['server/../../etc/passwd', 'public/data/prediction-snapshots.json', 'server/other.cjs']) {
    await assert.rejects(apply(signed({ ...manifest(), files: [{ path: file, content: '', sha256: crypto.createHash('sha256').update('').digest('hex') }] })));
  }
  assert.equal(applicationWrites, 0); assert.equal(restarts, 0);
  console.log(JSON.stringify({ ok: true, checks: 6, applicationWrites, restarts }));
})().catch(error => { console.error(error); process.exitCode = 1; });
