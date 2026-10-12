'use strict';
const crypto = require('node:crypto');
const signing = require('./componentSigning.cjs');
const DOMAIN = Buffer.from('football-readonly-component-activation-v1\0');
const HASH = /^[a-f0-9]{64}$/;
const KEYS = ['version', 'attemptId', 'action', 'rollbackOfAttemptId', 'component', 'archiveSha256', 'sourceHead', 'controllerSha256',
  'runtimeProofSha256', 'expectedAppSha256', 'expectedApiPid', 'expectedWorkerPid', 'databaseOid',
  'schemaSha256', 'port', 'previousSelectionSha256', 'issuedAtMs', 'expiresAtMs', 'keyId'];
function fail(code) { throw Object.assign(new Error(code), { code }); }
function validate(body) {
  if (!body || Array.isArray(body) || Object.keys(body).length !== KEYS.length || KEYS.some(k => !Object.hasOwn(body, k))
    || body.version !== 'readonly-component-activation-v1' || !/^[a-f0-9]{24}$/.test(body.attemptId || '')
    || !['activate', 'rollback'].includes(body.action)
    || (body.action === 'activate' ? body.rollbackOfAttemptId !== null : !/^[a-f0-9]{24}$/.test(body.rollbackOfAttemptId || ''))
    || body.component !== 'read-api' || !/^[a-f0-9]{40}$/.test(body.sourceHead || '')
    || ['archiveSha256', 'controllerSha256', 'runtimeProofSha256', 'expectedAppSha256', 'schemaSha256', 'keyId'].some(k => !HASH.test(body[k] || ''))
    || ['expectedApiPid', 'expectedWorkerPid'].some(k => !/^[1-9][0-9]{0,9}$/.test(body[k] || ''))
    || body.databaseOid !== '28598409' || ![8790, 8791].includes(body.port)
    || !(body.previousSelectionSha256 === null || HASH.test(body.previousSelectionSha256 || ''))
    || !Number.isSafeInteger(body.issuedAtMs) || !Number.isSafeInteger(body.expiresAtMs)
    || body.issuedAtMs < 0 || body.expiresAtMs <= body.issuedAtMs || body.expiresAtMs - body.issuedAtMs > 900_000) fail('INVALID_COMPONENT_ACTIVATION_AUTHORITY');
  return Object.fromEntries(KEYS.map(k => [k, body[k]]));
}
function bytes(body) { return Buffer.concat([DOMAIN, Buffer.from(JSON.stringify(validate(body)))]); }
function sign(body, privateKey) {
  return crypto.sign('RSA-SHA256', bytes(body), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
}
function verify(receipt, publicKey, expectedKeyId, now = Date.now()) {
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'body,signature') fail('INVALID_COMPONENT_ACTIVATION_RECEIPT');
  const body = validate(receipt.body);
  if (body.keyId !== expectedKeyId || now < body.issuedAtMs || now >= body.expiresAtMs
    || typeof receipt.signature !== 'string' || receipt.signature.length > 2048
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt.signature)
    || !crypto.verify('RSA-SHA256', bytes(body), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(receipt.signature, 'base64'))) fail('COMPONENT_ACTIVATION_SIGNATURE_OR_TIME');
  return body;
}
function bind(body, artifact, actual, now = Date.now()) {
  validate(body); const envelope = signing.validate(artifact);
  if (envelope.component !== body.component || envelope.archiveSha256 !== body.archiveSha256 || envelope.head !== body.sourceHead
    || envelope.schemaSha256 !== body.schemaSha256 || envelope.keyId !== body.keyId
    || actual.controllerSha256 !== body.controllerSha256 || actual.runtimeProofSha256 !== body.runtimeProofSha256
    || actual.appSha256 !== body.expectedAppSha256 || actual.completeSha256 !== body.expectedAppSha256
    || actual.apiPid !== body.expectedApiPid || actual.workerPid !== body.expectedWorkerPid
    || actual.previousSelectionSha256 !== body.previousSelectionSha256 || actual.databaseOid !== body.databaseOid
    || actual.port !== body.port || actual.databaseReadOnly !== true || actual.schemaSha256 !== body.schemaSha256) fail('COMPONENT_ACTIVATION_BINDING_CHANGED');
  if (now < body.issuedAtMs || now >= body.expiresAtMs) fail('COMPONENT_ACTIVATION_SIGNATURE_OR_TIME');
  return body;
}
module.exports = { validate, sign, verify, bind };
