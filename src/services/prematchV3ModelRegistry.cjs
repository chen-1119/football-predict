'use strict';

// Read-only shadow inputs. These keys never select an active production model,
// and PostgreSQL misses/errors never fall back to public or local match data.
const crypto = require('node:crypto');
const { readPrivateModelArtifact } = require('../../scripts/runtimePrivateModelArtifactStore.cjs');
const { createPostgresPool } = require('../../server/postgresStore.cjs');
const strength = require('../../scripts/dynamicGoalStrengthModel.cjs');
const team = require('./prematchTeamEvidenceV3.cjs');
const learning = require('./prematchV3Learning.cjs');
const { stableHash } = require('./webConsensusEvidence.cjs');
const { epochNanoseconds } = require('./prematchV3Clock.cjs');
const { validateResponse: validateOnlineResponse, MAX_MODEL_ARTIFACT_BYTES,IDENTITY_VERSION } = require('./prematchV3OnlineResponse.cjs');

const VERSION = 'prematch-v3-private-model-read-v1';
const KEYS = Object.freeze({ baseline: 'prematch-v3-baseline', parameters: 'prematch-v3-parameters' });
const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => { try { return stableHash(value); } catch { return null; } };
const clock = epochNanoseconds;
const unique = values => [...new Set(values)].sort();
const clone = value => JSON.parse(JSON.stringify(value));

function storedBlockers(stored, namespace, asOf) {
  const blockers = [], key = KEYS[namespace], at = clock(asOf);
  if (!object(stored) || stored.storage !== 'postgres' || stored.artifactKey !== key) return ['storage-or-key-mismatch'];
  if (typeof stored.payloadJson !== 'string' || !HASH.test(stored.payloadSha256 || '')
    || sha(stored.payloadJson) !== stored.payloadSha256) blockers.push('storage-payload-hash-invalid');
  if (!Number.isSafeInteger(stored.payloadBytes) || stored.payloadBytes < 1 || stored.payloadBytes > MAX_BYTES
    || typeof stored.payloadJson !== 'string' || Buffer.byteLength(stored.payloadJson) !== stored.payloadBytes) blockers.push('storage-payload-size-invalid');
  let parsed;
  try { parsed = JSON.parse(stored.payloadJson); } catch { blockers.push('storage-payload-json-invalid'); }
  if (!object(parsed) || !object(stored.payload) || digest(parsed) !== digest(stored.payload)) blockers.push('storage-payload-binding-invalid');
  const generated = clock(stored.generatedAt), available = clock(stored.updatedAt);
  if (at === null || generated === null || available === null || generated > available) blockers.push('storage-clock-invalid');
  // pg's default timestamptz decoder returns a Date, losing its microseconds.
  // Conservatively require the entire returned millisecond before as-of.
  else if (generated + 999999n >= at || available + 999999n >= at) blockers.push('storage-not-available-before-as-of');
  return unique(blockers);
}

function payloadClockBlockers(payload, stored, asOf) {
  const created = clock(payload?.createdAt), available = clock(payload?.availableAt);
  const at = clock(asOf), generated = clock(stored.generatedAt), persisted = clock(stored.updatedAt);
  const blockers = [];
  if (created === null || available === null || created > available) blockers.push('payload-clock-invalid');
  else {
    if (at === null || created >= at || available >= at) blockers.push('payload-not-available-before-as-of');
    // Persisted metadata is another availability bound, never a replacement for
    // the signed payload's clocks. A row cannot predate its own creation.
    if (generated === null || persisted === null || created > generated + 999999n || available > persisted + 999999n) blockers.push('payload-and-storage-clock-conflict');
  }
  return blockers;
}

function baselineBlockers(packet, stored, asOf) {
  const blockers = payloadClockBlockers(packet, stored, asOf), artifact = packet?.artifact;
  if (!object(packet) || !object(artifact) || stored.artifactVersion !== strength.DYNAMIC_GOAL_STRENGTH_MODEL_VERSION
    || !strength.verifyDynamicGoalStrengthArtifact(artifact)
    || (packet.formalEligible !== undefined && packet.formalEligible !== false)
    || (packet.productionEligible !== undefined && packet.productionEligible !== false)
    || (artifact.formalEligible !== undefined && artifact.formalEligible !== false)) blockers.push('baseline-schema-or-hash-invalid');
  if (blockers.includes('baseline-schema-or-hash-invalid')) return unique(blockers);
  try {
    const normalized = strength.normalizeConfig(artifact.model.config);
    if (digest(normalized) !== artifact.model.configHash) blockers.push('baseline-config-invalid-or-ablation');
    const features = artifact.featureArtifact, watermark = features.watermark;
    const trained = clock(watermark?.maxConsumedAvailableAt), created = clock(packet.createdAt), at = clock(asOf);
    const clocks = [trained, ...features.labels.map(row => clock(row.availableAt))];
    if (clocks.some(value => value === null) || trained === null || created === null || at === null
      || trained > created || trained >= at || digest(artifact.model.trainingWatermark) !== digest(watermark)
      || watermark.consumedRows !== features.input.rows || watermark.consumedBatches !== features.input.dateBatches
      || features.finalState.appliedRows !== watermark.consumedRows
      || features.finalState.appliedBatches !== watermark.consumedBatches
      || clock(features.finalState.lastAvailableAt) !== trained) blockers.push('baseline-training-watermark-invalid');
    else {
      const latest = clocks.reduce((a, b) => a > b ? a : b);
      // Existing historical artifacts retain millisecond clocks. Their full
      // quantization interval must precede creation and the requested as-of.
      if (latest + 999999n >= at || latest + 999999n > created) blockers.push('baseline-training-clock-precision-overlap');
    }
  } catch { blockers.push('baseline-schema-or-hash-invalid'); }
  return unique(blockers);
}

function parameterBlockers(artifact, stored, asOf) {
  const blockers = payloadClockBlockers(artifact, stored, asOf);
  if (stored.artifactVersion !== learning.PARAMETER_VERSION || artifact?.featureSchemaHash !== team.FEATURE_SCHEMA_HASH
    || digest(artifact?.featureSchema) !== team.FEATURE_SCHEMA_HASH) blockers.push('parameters-schema-or-hash-invalid');
  if (typeof learning.verifyPrematchV3ParameterArtifact !== 'function') blockers.push('parameters-schema-verifier-unavailable');
  else {
    try {
      const verification = learning.verifyPrematchV3ParameterArtifact(artifact, { featureSchema: team.FEATURE_SCHEMA,
        featureNames: artifact?.featureNames });
      if (verification?.valid !== true) {
        blockers.push('parameters-schema-or-hash-invalid');
        // Public verifier codes only; its free-form data never enters a receipt.
        for (const code of verification?.reasons || []) if (typeof code === 'string' && /^[a-z0-9-]{1,120}$/.test(code)) blockers.push(code);
      }
    } catch { blockers.push('parameters-schema-or-hash-invalid'); }
  }
  const trained = clock(artifact?.trainedThrough), created = clock(artifact?.createdAt), at = clock(asOf);
  if (trained === null || created === null || at === null || trained > created || trained >= at) blockers.push('parameters-training-clock-invalid');
  return unique(blockers);
}

function validateStoredPrematchV3Artifact(stored, namespace, asOf) {
  if (!Object.hasOwn(KEYS, namespace)) return { valid: false, blockers: ['namespace-invalid'], value: null };
  const blockers = storedBlockers(stored, namespace, asOf);
  if (!blockers.length) blockers.push(...(namespace === 'baseline' ? baselineBlockers : parameterBlockers)(stored.payload, stored, asOf));
  const value = blockers.length ? null : namespace === 'baseline' ? clone({ artifact: stored.payload.artifact,
    createdAt: stored.payload.createdAt, availableAt: stored.payload.availableAt }) : clone(stored.payload);
  return { valid: !blockers.length, blockers: unique(blockers), value };
}

function readErrorCode(error) {
  if (error?.message === 'PostgreSQL private artifact: required artifact missing') return 'missing';
  const knownIntegrity = {
    'payload byte count mismatch': 'storage-payload-size-invalid',
    'payload SHA-256 mismatch': 'storage-payload-hash-invalid',
    'invalid artifact version': 'storage-artifact-version-invalid',
    'raw JSON text required': 'storage-raw-json-required',
    'invalid JSON payload': 'storage-payload-json-invalid',
    'JSON object required': 'storage-payload-shape-invalid',
    'invalid generatedAt': 'storage-clock-invalid',
    'invalid updatedAt': 'storage-clock-invalid',
    'required artifact missing or key mismatched': 'storage-key-mismatch',
  };
  for (const [message, code] of Object.entries(knownIntegrity)) {
    if (error?.message === `PostgreSQL private artifact: ${message}`) return code;
  }
  if (typeof error?.message === 'string' && error.message.startsWith('PostgreSQL private artifact: ')) return 'storage-integrity-invalid';
  const postgresCodes = { '57014': 'storage-statement-timeout', '55P03': 'storage-lock-timeout',
    '08001': 'storage-connection-failed', '08006': 'storage-connection-failed',
    '28P01': 'storage-authentication-failed', '42P01': 'storage-table-missing', '42703': 'storage-schema-invalid' };
  if (typeof error?.code === 'string' && Object.hasOwn(postgresCodes, error.code)) return postgresCodes[error.code];
  // Connection strings, passwords, remote SQL errors and captured payloads are
  // deliberately excluded. A classified failure remains visible to callers.
  return 'storage-read-failed';
}

async function loadPrematchV3ModelRegistry(options = {}) {
  const asOf = options?.asOf, result = { version: VERSION, asOf, storage: 'postgres', shadowOnly: true,
    formalEligible: false, productionEligible: false, baseline: null, parameters: null, status: 'blocked', blockers: [], receipts: [] };
  if (!object(options) || clock(asOf) === null) { result.blockers = ['registry-as-of-invalid']; return result; }
  let pool, client;
  const transactionFailure = code => {
    result.baseline = null; result.parameters = null; result.blockers.push(`registry:${code}`);
  };
  try {
    pool = options.pool || createPostgresPool({ applicationName: 'football-prematch-v3-private-read',
      max: 1, min: 0, connectionTimeoutMillis: 5000, queryTimeoutMillis: 7000 });
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query('SET LOCAL lock_timeout = 1000');
    // Deliberately bounded to these two independent namespaces in one snapshot;
    // no inventory, active-pointer lookup, local lookup, promotion or write.
    for (const namespace of Object.keys(KEYS)) {
      const key = KEYS[namespace], receipt = { namespace, artifactKey: key, storage: 'postgres', status: 'blocked',
        generatedAt: null, updatedAt: null, artifactVersion: null, payloadSha256: null, payloadBytes: null, blockers: [],
        metadataClockPrecision: { kind: 'legacy-millisecond-clock-upper-bound',
          originalClockBytesPreserved: false, quantizationUpperOffsetNanoseconds: 999999 } };
      try {
        const stored = await readPrivateModelArtifact({ storage: 'postgres', artifactKey: key, maxBytes: MAX_BYTES, pool: client });
        Object.assign(receipt, { generatedAt: stored.generatedAt, updatedAt: stored.updatedAt,
          artifactVersion: stored.artifactVersion, payloadSha256: stored.payloadSha256, payloadBytes: stored.payloadBytes });
        const verified = validateStoredPrematchV3Artifact(stored, namespace, asOf);
        receipt.blockers = verified.blockers; receipt.status = verified.valid ? 'shadow-readable' : 'blocked';
        if (verified.valid) result[namespace] = verified.value;
      } catch (error) {
        const code = readErrorCode(error); receipt.status = code === 'missing' ? 'missing' : 'blocked'; receipt.blockers = [code];
      }
      result.receipts.push(receipt);
      result.blockers.push(...receipt.blockers.map(code => `${namespace}:${code}`));
    }
  } catch { transactionFailure('read-transaction-failed'); }
  finally {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { transactionFailure('read-transaction-rollback-failed'); }
      try { client.release(result.blockers.includes('registry:read-transaction-rollback-failed') ? true : undefined); }
      catch { transactionFailure('read-client-release-failed'); }
    }
    if (pool && !options.pool) {
      try { await pool.end(); } catch { transactionFailure('read-pool-close-failed'); }
    }
  }
  const present = Number(result.baseline !== null) + Number(result.parameters !== null);
  result.status = present === 2 ? 'shadow-ready' : present === 1 ? 'partial'
    : result.receipts.length === 2 && result.receipts.every(receipt => receipt.status === 'missing')
      && !result.blockers.some(code => code.startsWith('registry:')) ? 'missing' : 'blocked';
  result.blockers = unique(result.blockers);
  return result;
}

function readPrematchV3RegistryFromOnlineInput(value, { asOf,trustRegistry } = {}) {
  const result = { version: VERSION, asOf, storage: 'postgres', shadowOnly: true,
    formalEligible: false, productionEligible: false, baseline: null, parameters: null, status: 'blocked', blockers: [], receipts: [],
    inputObservedAt: value?.observedAt || null,
    evidenceScope: 'fixed-model-packets-from-recorded-online-read;caller-must-verify-immutable-raw-binding;not-model-promotion' };
  const at = clock(asOf), observed = clock(value?.observedAt);
  if (at === null || observed === null || at < observed || (value?.version===IDENTITY_VERSION
    &&(clock(value.identitySource?.inputCapturedAt)===null||clock(value.identitySource.inputCapturedAt)>at))) {
    result.blockers = ['registry:online-read-as-of-invalid']; return result;
  }
  try { validateOnlineResponse(value, value.businessDate,{trustRegistry}); }
  catch { result.blockers = ['registry:online-input-contract-invalid']; return result; }
  for (const namespace of Object.keys(KEYS)) {
    const packet = value.modelArtifacts.find(packet => packet.artifactKey === KEYS[namespace]);
    const receipt = { namespace, artifactKey: KEYS[namespace], storage: 'postgres', status: 'missing',
      generatedAt: packet?.generatedAt || null, updatedAt: packet?.updatedAt || null,
      artifactVersion: packet?.artifactVersion || null, payloadSha256: packet?.payloadSha256 || null,
      payloadBytes: packet?.payloadBytes || null, blockers: [],
      metadataClockPrecision: { kind: 'original-PG-clock-bytes-with-conservative-upper-bound',
        originalClockBytesPreserved: true, quantizationUpperOffsetNanoseconds: 999999 } };
    if (!packet) receipt.blockers = ['missing'];
    else if (packet.oversized || packet.payloadBytes > MAX_MODEL_ARTIFACT_BYTES) {
      receipt.status = 'blocked'; receipt.blockers = ['storage-payload-oversized'];
    } else {
      try {
        let payload;
        try { payload = JSON.parse(packet.payloadJson); } catch { throw new Error('PostgreSQL private artifact: invalid JSON payload'); }
        const stored = { storage: 'postgres', artifactKey: packet.artifactKey, artifactVersion: packet.artifactVersion,
          generatedAt: packet.generatedAt, updatedAt: packet.updatedAt, payload, payloadJson: packet.payloadJson,
          payloadSha256: packet.payloadSha256, payloadBytes: packet.payloadBytes };
        const verified = validateStoredPrematchV3Artifact(stored, namespace, asOf);
        receipt.blockers = verified.blockers; receipt.status = verified.valid ? 'shadow-readable' : 'blocked';
        if (verified.valid) result[namespace] = verified.value;
      } catch (error) { receipt.status = 'blocked'; receipt.blockers = [readErrorCode(error)]; }
    }
    result.receipts.push(receipt);
    result.blockers.push(...receipt.blockers.map(code => `${namespace}:${code}`));
  }
  const present = Number(result.baseline !== null) + Number(result.parameters !== null);
  result.status = present === 2 ? 'shadow-ready' : present === 1 ? 'partial'
    : result.receipts.every(receipt => receipt.status === 'missing') ? 'missing' : 'blocked';
  result.blockers = unique(result.blockers);
  return result;
}

module.exports = { VERSION, KEYS, MAX_BYTES, loadPrematchV3ModelRegistry, validateStoredPrematchV3Artifact,
  readPrematchV3RegistryFromOnlineInput };
