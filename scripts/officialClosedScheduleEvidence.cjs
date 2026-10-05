'use strict';
// An empty current list can be structurally valid during signed official stop-sale.
// This never establishes fresh odds, independent collector redundancy or a recommendation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { strictInstant } = require('../src/services/strictInstant.cjs');
const { verifyCollectorAttestation } = require('../src/services/collectorAttestation.cjs');
const { expectedCollectorCommitment } = require('../server/relayCollectorEvidence.cjs');
const { SPORTTERY_CURRENT_URL, SPORTTERY_CALCULATOR_URL } = require('./sportteryEndpointContract.cjs');
const MAX_AGE_NS = 1200n * 1000000000n;
const STOP_MESSAGE = '抱歉，本彩种已停止销售';
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const PROOF_VERSION = 'official-closed-schedule-proof-v1';
function instantNs(value) {
  if (!strictInstant(value)) return null;
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/.exec(value)?.[1] || '';
  const whole = value.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, '');
  return BigInt(Date.parse(whole)) * 1000000n + BigInt(fraction.padEnd(9, '0') || '0');
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function emptyMatchList(value) {
  if (!object(value)) return false;
  if (value.matchInfoList === undefined) return true;
  return Array.isArray(value.matchInfoList) && value.matchInfoList.every(day => object(day)
    && Array.isArray(day.subMatchList) && day.subMatchList.length === 0);
}
function auditOfficialClosedSchedule(snapshot, options = {}) {
  const blockers = new Set(), audits = [];
  const asOf = instantNs(options.asOf), captureAt = instantNs(snapshot?.capturedAt);
  if (asOf === null) blockers.add('closure-observation-clock-invalid');
  if (!object(snapshot) || !Array.isArray(snapshot.endpoints)) blockers.add('closure-snapshot-invalid');
  if (typeof snapshot?.sourceCycleId !== 'string' || !snapshot.sourceCycleId.trim()
    || snapshot.sourceCycleId !== snapshot.sourceCycleId.trim()) blockers.add('closure-cycle-missing');
  if (asOf !== null && (captureAt === null || captureAt > asOf || asOf - captureAt > MAX_AGE_NS)) blockers.add('closure-envelope-clock-invalid');
  const endpoints = Array.isArray(snapshot?.endpoints) ? snapshot.endpoints : [];
  for (const [method, url] of [['current', SPORTTERY_CURRENT_URL], ['calculator', SPORTTERY_CALCULATOR_URL]]) {
    const matches = endpoints.filter(entry => entry?.method === method || entry?.sourceRequest?.role === method);
    if (matches.length !== 1) { blockers.add('closure-' + method + '-endpoint-count-invalid'); continue; }
    const entry = matches[0], request = entry.sourceRequest, payload = entry.payload;
    if (entry.method !== method || !object(request) || request.url !== url || request.method !== 'GET'
      || request.role !== method || request.page !== null || (entry.page !== null && entry.page !== undefined)) blockers.add('closure-' + method + '-scope-invalid');
    if (entry.ok !== true || entry.httpStatus !== 200 || entry.rows !== 0 || !object(payload)
      || payload.success !== true || String(payload.errorCode) !== '0' || !emptyMatchList(payload.value)) blockers.add('closure-' + method + '-response-invalid');
    if (entry.sourceCycleId !== snapshot?.sourceCycleId) blockers.add('closure-' + method + '-cycle-mismatch');
    const requested = instantNs(entry.requestedAt), received = instantNs(entry.receivedAt);
    if (asOf !== null && (requested === null || received === null || requested > received || received > asOf
      || asOf - received > MAX_AGE_NS || captureAt === null || requested < captureAt)) blockers.add('closure-' + method + '-clock-invalid');
    if (method === 'current' && payload?.value?.totalCount !== 0) blockers.add('closure-current-total-not-zero');
    if (method === 'calculator') {
      const config = payload?.value?.vtoolsConfig;
      if (!object(config) || config.offLineSaleStatus !== 1 || config.onLineSaleStatus !== 1
        || config.offLineStopMessage !== STOP_MESSAGE || config.onLineStopMessage !== STOP_MESSAGE) blockers.add('closure-stop-sale-unproven');
      if (payload?.value?.totalCount !== undefined && payload.value.totalCount !== 0) blockers.add('closure-calculator-total-not-zero');
    }
    const signature = verifyCollectorAttestation(entry.collectorAttestation, {
      trustRegistry: options.trustRegistry, payload: entry.payload, expected: expectedCollectorCommitment(entry),
    });
    // The shared verifier compares millisecond canonical clocks. This narrow
    // proof additionally binds all original sub-millisecond clock precision.
    for (const field of ['requestedAt', 'receivedAt']) {
      if (instantNs(entry[field]) !== instantNs(signature.attestation?.commitment?.[field])) blockers.add('closure-' + method + '-signed-clock-mismatch');
    }
    if (!signature.eligible) for (const blocker of signature.blockers) blockers.add(method + ':' + blocker);
    if (!signature.independenceDomain) blockers.add('closure-' + method + '-runtime-unassigned');
    audits.push({ method, signatureVerified: signature.eligible, keyId: signature.keyId,
      independenceDomain: signature.independenceDomain, commitmentHash: signature.commitmentHash,
      canonicalPayloadSha256: signature.attestation?.commitment?.canonicalPayloadSha256 || null,
      rawSha256: signature.attestation?.commitment?.response?.rawSha256 || null,
      requestedAt: entry.requestedAt || null, receivedAt: entry.receivedAt || null });
  }
  if (audits.length === 2 && (audits[0].independenceDomain !== audits[1].independenceDomain
    || audits[0].keyId !== audits[1].keyId)) blockers.add('closure-collector-runtime-mismatch');
  return { version: 'official-closed-schedule-integrity-v1', asOf: options.asOf || null,
    emptyCurrentIntegrityEligible: blockers.size === 0, state: blockers.size ? 'unproven-empty' : 'official-stop-sale',
    blockers: [...blockers].sort(), sourceCycleId: snapshot?.sourceCycleId || null, capturedAt: snapshot?.capturedAt || null,
    maxAgeSeconds: 1200, endpoints: audits, marketDataEligible: false,
    recommendationEligible: false, independentCollectorRedundancyEligible: false,
    note: 'Validates an empty current array only. Does not alter source freshness, odds, result authority, collector counts or recommendation gates.' };
}
function readBounded(file, maximumBytes) {
  if (typeof file !== 'string' || !file.trim()) throw Error('closure-proof-path-missing');
  const resolved = path.resolve(file), before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximumBytes)
    || fs.realpathSync(resolved) !== resolved) throw Error('closure-proof-file-invalid');
  const handle = fs.openSync(resolved, 'r');
  try {
    const opened = fs.fstatSync(handle, { bigint: true }), raw = fs.readFileSync(handle);
    const after = fs.fstatSync(handle, { bigint: true }), final = fs.lstatSync(resolved, { bigint: true });
    for (const stat of [opened, after, final]) if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => stat[key] !== before[key])) throw Error('closure-proof-file-changed');
    if (raw.length > maximumBytes) throw Error('closure-proof-file-invalid');
    return { value: JSON.parse(raw.toString('utf8')), receipt: { name: path.basename(resolved), bytes: raw.length, sha256: hash(raw) } };
  } finally { fs.closeSync(handle); }
}
function readOfficialClosedScheduleEvidence(options = {}) {
  try {
    const snapshot = readBounded(options.snapshotPath, 20 * 1024 * 1024);
    const registry = readBounded(options.trustRegistryPath, 262144);
    return { ...auditOfficialClosedSchedule(snapshot.value, { asOf: options.asOf, trustRegistry: registry.value }),
      files: [snapshot.receipt, registry.receipt] };
  } catch (error) {
    return { version: 'official-closed-schedule-integrity-v1', asOf: options.asOf || null,
      emptyCurrentIntegrityEligible: false, state: 'unproven-empty', blockers: [
        /^closure-proof-/.test(error?.message || '') ? error.message : 'closure-proof-unavailable-or-invalid',
      ], marketDataEligible: false, recommendationEligible: false, independentCollectorRedundancyEligible: false, files: [] };
  }
}
const failure = (asOf, blocker) => ({ version: 'official-closed-schedule-integrity-v1', asOf: asOf || null,
  emptyCurrentIntegrityEligible: false, state: 'unproven-empty', blockers: [blocker],
  marketDataEligible: false, recommendationEligible: false, independentCollectorRedundancyEligible: false });

// Only these public response/commitment fields leave the private relay file.
// In particular never copy producer/env, HTTP request headers or registry keys.
function projectEndpoint(entry) {
  const expected = expectedCollectorCommitment(entry);
  const attestation = entry.collectorAttestation;
  const commitment = attestation.commitment;
  const safeCommitment = Object.fromEntries(['version', 'provider', 'endpoint', 'collectorCycleId', 'requestedAt',
    'receivedAt', 'providerObservedAt', 'response', 'canonicalPayloadSha256', 'marketExtractionHashes']
    .filter(key => commitment[key] !== undefined).map(key => [key, commitment[key]]));
  // Unknown signed commitment fields cannot be stripped without breaking the
  // signature; reject instead of accidentally publishing an extended secret.
  if (Object.keys(commitment).some(key => !(key in safeCommitment))) throw Error('closure-proof-commitment-shape-invalid');
  for (const [value, keys] of [[commitment.endpoint, ['url', 'method', 'page', 'role']],
    [commitment.response, ['httpStatus', 'httpDate', 'httpEtag', 'contentType', 'headersSha256', 'rawSha256', 'rawBytes']],
    [entry.payload, ['dataFrom', 'emptyFlag', 'errorCode', 'errorMessage', 'success', 'value']],
    [entry.payload.value, ['totalCount', 'lastUpdateTime', 'matchInfoList', 'vtoolsConfig']]]) {
    if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('closure-proof-public-shape-invalid');
  }
  for (const key of ['dataFrom', 'errorCode', 'errorMessage']) {
    if (entry.payload[key] !== undefined && !['string', 'number'].includes(typeof entry.payload[key])) throw Error('closure-proof-public-shape-invalid');
  }
  const config = entry.payload.value.vtoolsConfig;
  if (config && Object.keys(config).some(key => !['offLineSaleStatus', 'offLineStopMessage', 'onLineSaleStatus', 'onLineStopMessage'].includes(key))) throw Error('closure-proof-public-shape-invalid');
  if (entry.payload.value.lastUpdateTime !== undefined && typeof entry.payload.value.lastUpdateTime !== 'string') throw Error('closure-proof-public-shape-invalid');
  for (const day of entry.payload.value.matchInfoList || []) {
    if (Object.keys(day).some(key => !['businessDate', 'subMatchList'].includes(key))
      || (day.businessDate !== undefined && typeof day.businessDate !== 'string')) throw Error('closure-proof-public-shape-invalid');
  }
  return { method: entry.method, page: null, sourceRequest: { ...expected.endpoint },
    sourceCycleId: entry.sourceCycleId, requestedAt: entry.requestedAt, receivedAt: entry.receivedAt,
    providerObservedAt: expected.providerObservedAt, ...expected.response,
    canonicalPayloadSha256: expected.canonicalPayloadSha256, ok: entry.ok, rows: entry.rows, payload: entry.payload,
    collectorAttestation: Object.fromEntries(['version', 'algorithm', 'keyId', 'keyFingerprint', 'commitmentHash', 'signature']
      .map(key => [key, attestation[key]]).concat([['commitment', safeCommitment]])) };
}
function captureOfficialClosedSchedule(options = {}) {
  try {
    if (options.alternateSnapshotPath && path.resolve(options.snapshotPath) !== path.resolve(options.alternateSnapshotPath)) throw Error('closure-proof-path-conflict');
    const snapshot = readBounded(options.snapshotPath, 20 * 1024 * 1024);
    const registry = readBounded(options.trustRegistryPath, 262144);
    const audit = auditOfficialClosedSchedule(snapshot.value, { asOf: options.asOf, trustRegistry: registry.value });
    if (!audit.emptyCurrentIntegrityEligible) return { ...audit, proof: null };
    if (typeof options.publicationSourceCycleId !== 'string' || !options.publicationSourceCycleId.trim()
      || !strictInstant(options.currentListEvaluatedAt)) throw Error('closure-proof-publication-binding-invalid');
    const proof = { version: PROOF_VERSION, publicationSourceCycleId: options.publicationSourceCycleId,
      currentListEvaluatedAt: options.currentListEvaluatedAt, originalSnapshot: snapshot.receipt,
      snapshot: { capturedAt: snapshot.value.capturedAt, sourceCycleId: snapshot.value.sourceCycleId,
        endpoints: snapshot.value.endpoints.filter(entry => ['current', 'calculator'].includes(entry?.method)).map(projectEndpoint) } };
    if (Buffer.byteLength(JSON.stringify(proof)) > 32768) throw Error('closure-proof-size-invalid');
    return { ...audit, proof };
  } catch (error) {
    return { ...failure(options.asOf, /^closure-proof-/.test(error?.message || '') ? error.message : 'closure-proof-unavailable-or-invalid'), proof: null };
  }
}
function auditPublishedOfficialClosedSchedule(syncMeta, options = {}) {
  try {
    const proof = syncMeta?.currentListPolicy?.officialClosedSchedule?.proof;
    if (!object(proof) || proof.version !== PROOF_VERSION) return failure(options.asOf, 'closure-publication-proof-missing');
    if (Buffer.byteLength(JSON.stringify(proof)) > 32768) return failure(options.asOf, 'closure-proof-size-invalid');
    if (typeof syncMeta.sourceCycleId !== 'string' || !syncMeta.sourceCycleId.trim()
      || syncMeta.sourceCycleId !== proof.publicationSourceCycleId || syncMeta.files?.current !== 0
      || syncMeta.currentListPolicy?.evaluatedAt !== proof.currentListEvaluatedAt
      || !strictInstant(proof.currentListEvaluatedAt)) return failure(options.asOf, 'closure-publication-binding-mismatch');
    if (!Number.isSafeInteger(proof.originalSnapshot?.bytes) || proof.originalSnapshot.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(proof.originalSnapshot?.sha256 || '')) return failure(options.asOf, 'closure-original-receipt-invalid');
    const registry = readBounded(options.trustRegistryPath, 262144);
    // Audit actual payload/signatures, never the saved eligible flag or a key
    // supplied inside sync-meta. Source timestamps are never rewritten.
    return { ...auditOfficialClosedSchedule(proof.snapshot, { asOf: options.asOf, trustRegistry: registry.value }),
      publicationSourceCycleId: proof.publicationSourceCycleId, originalSnapshot: proof.originalSnapshot,
      trustRegistry: registry.receipt };
  } catch { return failure(options.asOf, 'closure-proof-unavailable-or-invalid'); }
}
module.exports = { auditOfficialClosedSchedule, readOfficialClosedScheduleEvidence,
  captureOfficialClosedSchedule, auditPublishedOfficialClosedSchedule };
