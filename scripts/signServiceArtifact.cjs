'use strict';
const fs = require('node:fs'), path = require('node:path');
const signing = require('../services/release/componentSigning.cjs');
const { loadReleasePrivateKey, loadReleasePublicKey, publicKeyId } = require('./releaseSigning.cjs');
function read(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > maximum) throw new Error('ARTIFACT_FILE_BOUND'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
function artifact(archive) {
  if (!archive || !path.isAbsolute(archive)) throw new Error('Absolute archive path required');
  // A Linux image also inventories lock-installed dependencies. Its actual
  // 12,083-file manifest exceeds 2 MiB; retain a fixed 4 MiB metadata bound.
  const raw = read(archive, 512 * 1024 * 1024), manifestBytes = read(archive + '.manifest.json', 4 * 1024 * 1024);
  const manifest = JSON.parse(manifestBytes);
  if (raw.length !== manifest.archiveBytes || signing.sha(raw) !== manifest.archiveSha256) throw new Error('COMPONENT_ARCHIVE_MISMATCH');
  return { manifest, manifestBytes };
}
function verify(archive) {
  const { manifest, manifestBytes } = artifact(archive);
  const receipt = JSON.parse(read(archive + '.signed.json', 32 * 1024));
  const publicKey = loadReleasePublicKey();
  const expected = signing.envelope(manifest, manifestBytes, publicKeyId(publicKey.key));
  if (JSON.stringify(expected) !== JSON.stringify(receipt.envelope) || !signing.verify(receipt.envelope, receipt.signature, publicKey.key, expected.keyId)) throw new Error('COMPONENT_SIGNATURE_INVALID');
  return { ...receipt, verified: true, activationEligible: false };
}
function sign(archive) {
  const { manifest, manifestBytes } = artifact(archive), privateKey = loadReleasePrivateKey();
  const envelope = signing.envelope(manifest, manifestBytes, privateKey.keyId);
  const signature = signing.sign(envelope, privateKey.key);
  const receipt = { envelope, signature, signedAt: new Date().toISOString(), signed: true, activationEligible: false };
  // Signature covers this artifact only. No global full-release sequence,
  // installation, writer handover or activation authority is consumed.
  fs.writeFileSync(archive + '.signed.json', JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  return verify(archive);
}
if (require.main === module) {
  const result = process.argv[2] === '--verify' ? verify(process.argv[3]) : sign(process.argv[2]);
  console.log(JSON.stringify({ component: result.envelope.component, head: result.envelope.head, archiveSha256: result.envelope.archiveSha256,
    signed: result.signed, verified: result.verified, activationEligible: false }));
}
module.exports = { sign, verify, artifact };
