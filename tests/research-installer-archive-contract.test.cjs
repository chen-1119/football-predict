'use strict';
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib'), vm = require('node:vm');
const { installRoot } = require('../scripts/installResearchBroker.cjs');
const archive = require('../scripts/releaseArchiveSourceInventory.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'football-installer-archive-'));
let manifest;
function member(name, value, type = '0', mode = 0o644) {
  const bytes = Buffer.from(value), header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  const octal = (n, start, length) => header.write(n.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii');
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header.write(type, 156, 1, 'ascii'); header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  header.write(header.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
before(async () => {
  const bundle = path.join(directory, 'normal-source.tgz');
  fs.writeFileSync(bundle, zlib.gzipSync(Buffer.concat([
    member('./server/', '', '5', 0o755), member('./server/example.cjs', 'module.exports = "真实原件";\n'), Buffer.alloc(1024),
  ])));
  // Actual normal release archive producer, rather than a hand-made inventory
  // digest that repeats the consumer implementation.
  const evidence = await archive.captureReleaseArchiveSourceEvidence(bundle);
  manifest = { ok: true, manifestVersion: 3, releaseSequence: 868, sha256: evidence.archiveSha256,
    bytes: evidence.archiveBytes, entries: evidence.archiveEntryCount, archiveSourceEvidence: evidence,
    signature: { keyId: 'a'.repeat(64), algorithm: 'rsa-sha256-pkcs1-v1_5' } };
});
after(() => {
  assert.equal(fs.realpathSync(directory).toLowerCase(), path.resolve(directory).toLowerCase());
  assert(path.basename(directory).startsWith('football-installer-archive-')); fs.rmSync(directory, { recursive: true });
});
function executeActualInstallerChecks(value, expected = manifest) {
  const source = installRoot.toString(), start = source.indexOf('const manifest=JSON.parse(bytes[3])');
  const end = source.indexOf("if(inventory.get('scripts/installResearchBroker.cjs')", start);
  assert(start > 0 && end > start, 'actual installer release gate missing');
  const invocation = source.match(/visit\(APP\+'\/scripts\/releaseArchiveSourceInventory\.cjs'\);\s*require\(APP\+'\/scripts\/releaseArchiveSourceInventory\.cjs'\)\.validateSignedArchiveSourceEvidence\(manifest\);/);
  assert(invocation, 'actual installer must close and invoke the normal source validator');
  let closed = false, called = 0;
  vm.runInNewContext(source.slice(start, end) + '\n' + invocation[0], {
    APP: '/opt/football-predict', bytes: [null, null, null, Buffer.from(JSON.stringify(value))],
    body: { releaseSha: expected.sha256, keyId: expected.signature.keyId }, hash,
    fail: code => { throw Error(code); },
    visit: p => { assert.equal(p, '/opt/football-predict/scripts/releaseArchiveSourceInventory.cjs'); closed = true; },
    require: p => {
      assert(closed); assert.equal(p, '/opt/football-predict/scripts/releaseArchiveSourceInventory.cjs');
      return { validateSignedArchiveSourceEvidence: m => { called++; return archive.validateSignedArchiveSourceEvidence(m); } };
    },
  });
  return { closed, called };
}
test('actual installer accepts the normal producer commitment without hashing treeHash into itself', () => {
  const evidence = manifest.archiveSourceEvidence;
  assert.equal(evidence.inventorySha256, evidence.inventory.treeHash);
  assert.notEqual(evidence.inventorySha256, hash(JSON.stringify(evidence.inventory)));
  assert.deepEqual(executeActualInstallerChecks(manifest), { closed: true, called: 1 });
});
for (const [label, change] of Object.entries({
  'wrong outer release': m => { m.sha256 = '0'.repeat(64); },
  'wrong signing identity': m => { m.signature.keyId = '0'.repeat(64); },
  'old self-referential digest': m => { m.archiveSourceEvidence.inventorySha256 = hash(JSON.stringify(m.archiveSourceEvidence.inventory)); },
  'forged tree hash': m => { m.archiveSourceEvidence.inventory.treeHash = '0'.repeat(64); m.archiveSourceEvidence.inventorySha256 = '0'.repeat(64); },
  'changed source bytes': m => { m.archiveSourceEvidence.inventory.entries[1].bytes++; },
  'changed entry count': m => { m.archiveSourceEvidence.inventory.entryCount++; },
  'unsafe member path': m => { m.archiveSourceEvidence.inventory.entries[1].path = '../outside.cjs'; },
  'wrong archive byte count': m => { m.archiveSourceEvidence.archiveBytes++; },
})) test('actual installer source gate rejects ' + label, () => {
  const changed = structuredClone(manifest); change(changed); assert.throws(() => executeActualInstallerChecks(changed));
});
