'use strict';
const crypto = require('node:crypto');
const { plan } = require('./componentPolicy.cjs');
const DOMAIN = Buffer.from('football-independent-component-envelope-v1\0', 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const KEYS = ['version', 'component', 'head', 'archiveSha256', 'archiveBytes', 'manifestSha256', 'inventorySha256',
  'apiContract', 'schemaSha256', 'entry', 'artifactPlatform', 'databaseCopies', 'migrations', 'activationEligible', 'keyId', 'algorithm'];
const algorithm = 'rsa-sha256-pkcs1-v1_5';
function validate(body) {
  if (!body || typeof body !== 'object' || Object.keys(body).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(body, key))) throw new Error('INVALID_COMPONENT_ENVELOPE');
  const policy = plan(body.component);
  if (body.version !== 'independent-component-signed-envelope-v1' || !/^[a-f0-9]{40}$/.test(body.head || '')
    || ['archiveSha256', 'manifestSha256', 'inventorySha256', 'schemaSha256', 'keyId'].some(key => !/^[a-f0-9]{64}$/.test(body[key] || ''))
    || !Number.isSafeInteger(body.archiveBytes) || body.archiveBytes < 1 || body.archiveBytes > 512 * 1024 * 1024
    || body.apiContract !== 'separated-read-api-v1' || body.entry !== policy.entry
    || (body.component === 'web' ? !['linux', 'win32'].includes(body.artifactPlatform)
      : body.component === 'read-api' ? !['source', 'linux'].includes(body.artifactPlatform) : body.artifactPlatform !== 'source')
    || body.databaseCopies !== 0 || body.migrations !== false || body.activationEligible !== false || body.algorithm !== algorithm) throw new Error('INVALID_COMPONENT_ENVELOPE');
  return Object.fromEntries(KEYS.map(key => [key, body[key]]));
}
function envelope(manifest, manifestBytes, keyId) {
  if (manifest.version !== 'independent-component-artifact-v1' || !Array.isArray(manifest.inventory)
    || manifest.signed !== false || manifest.activationEligible !== false) throw new Error('INVALID_COMPONENT_MANIFEST');
  return validate({ version: 'independent-component-signed-envelope-v1', component: manifest.component, head: manifest.head,
    archiveSha256: manifest.archiveSha256, archiveBytes: manifest.archiveBytes, manifestSha256: sha(manifestBytes),
    inventorySha256: sha(JSON.stringify(manifest.inventory)), apiContract: manifest.apiContract, schemaSha256: manifest.schemaSha256,
    entry: manifest.entry, artifactPlatform: manifest.artifactPlatform, databaseCopies: manifest.databaseCopies,
    migrations: manifest.migrations, activationEligible: false, keyId, algorithm });
}
function bytes(body) { return Buffer.concat([DOMAIN, Buffer.from(JSON.stringify(validate(body)), 'utf8')]); }
function sign(body, privateKey) {
  return crypto.sign('RSA-SHA256', bytes(body), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
}
function verify(body, signature, publicKey, expectedKeyId) {
  if (body?.keyId !== expectedKeyId || typeof signature !== 'string' || signature.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  try { return crypto.verify('RSA-SHA256', bytes(body), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'base64')); }
  catch { return false; }
}
module.exports = { envelope, sign, verify, validate, bytes, sha };
