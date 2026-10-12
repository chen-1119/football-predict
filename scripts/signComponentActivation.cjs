'use strict';
const fs = require('node:fs');
const path = require('node:path');
const activation = require('../services/release/componentActivationAuthorization.cjs');
const { loadReleasePrivateKey } = require('./releaseSigning.cjs');
function sign(requestPath, outputPath, now = Date.now()) {
  if (!path.isAbsolute(requestPath || '') || !path.isAbsolute(outputPath || '')) throw new Error('Absolute create-only activation request and output paths required');
  const fd = fs.openSync(requestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let body;
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Activation request bound'); body = activation.validate(JSON.parse(fs.readFileSync(fd))); }
  finally { fs.closeSync(fd); }
  const key = loadReleasePrivateKey();
  if (body.keyId !== key.keyId || body.issuedAtMs > now || now - body.issuedAtMs > 60_000 || now >= body.expiresAtMs) throw new Error('Fresh source-bound activation request required');
  const receipt = { body, signature: activation.sign(body, key.key) };
  fs.writeFileSync(outputPath, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  return { attemptId: body.attemptId, component: body.component, archiveSha256: body.archiveSha256, expiresAt: new Date(body.expiresAtMs).toISOString() };
}
if (require.main === module) console.log(JSON.stringify(sign(process.argv[2], process.argv[3])));
module.exports = { sign };
