'use strict';

// Only synthetic artifact rows and a fake PostgreSQL client are used here.
// No production connection, local historic match data or registry write occurs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const registry = require('../src/services/prematchV3ModelRegistry.cjs');
const strength = require('../scripts/dynamicGoalStrengthModel.cjs');
const learning = require('../src/services/prematchV3Learning.cjs');
const team = require('../src/services/prematchTeamEvidenceV3.cjs');
const { DEFAULT_THRESHOLDS, REGISTRY_VERSION } = require('../scripts/modelLearningRegistry.cjs');
const { verifyRow } = require('../scripts/postgresPrivateModelArtifactStore.cjs');
const { stableHash } = require('../src/services/webConsensusEvidence.cjs');
const onlineReader = require('../scripts/readPrematchV3OnlineInputs.cjs');

test('runtime model registry loads without the SSH reader or its transport module', () => {
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const source = `const Module=require('node:module');
    const forbidden=new Set(${JSON.stringify([require.resolve('../scripts/readPrematchV3OnlineInputs.cjs'), require.resolve('../scripts/releaseSshHostKeyPin.cjs')])});
    const original=Module._load;
    Module._load=function(request,parent,isMain){
      if(forbidden.has(Module._resolveFilename(request,parent,isMain)))throw Error('SSH_TRANSPORT_REACHED_RUNTIME');
      return original.apply(this,arguments);
    };
    const registry=require(${JSON.stringify(require.resolve('../src/services/prematchV3ModelRegistry.cjs'))});
    if(typeof registry.readPrematchV3RegistryFromOnlineInput!=='function')throw Error('REGISTRY_API_MISSING');
    process.stdout.write('runtime-contract-only');`;
  const result = spawnSync(process.execPath, ['-e', source], {cwd: root, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'runtime-contract-only');
});

const CREATED = '2026-09-15T10:00:00.000Z', AVAILABLE = '2026-09-15T10:00:01.000Z';
const AS_OF = '2026-10-06T10:00:00.000Z';
const FEATURE = 'home.roster.confirmed.attackReplacementGapPer90';
const seal = value => { const { contentHash, ...body } = value; return { ...body, contentHash: stableHash(body) }; };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function baseline() {
  const events = [1, 2].map(day => ({ sourceEventId: `synthetic-baseline-${day}`,
    sourceDataset: 'synthetic/model-registry-test', competition: 'synthetic-league', date: `2024-01-0${day}`,
    homeTeam: { raw: 'Alpha', normalized: 'alpha', entityId: 'synthetic-alpha' },
    awayTeam: { raw: 'Bravo', normalized: 'bravo', entityId: 'synthetic-bravo' },
    historicalOutcome: { homeGoals: day, awayGoals: 0 }, availableAt: `2024-01-0${day + 2}T06:00:00.000Z` }));
  return { artifact: strength.buildDynamicGoalStrengthArtifact(events), createdAt: CREATED, availableAt: AVAILABLE };
}
function parameters() {
  const names = [FEATURE], inputs = Array.from({ length: 8 }, (_, i) => stableHash({ synthetic: i }));
  const model = { kind: 'lambda-loglinear', intercept: { home: 0.01, away: -0.01 },
    coefficients: { home: { [FEATURE]: -0.1 }, away: { [FEATURE]: 0.1 } },
    maxAbsLogShift: learning.FIT_LIMITS.maxAbsLogShift,
    lambdaFloor: learning.FIT_LIMITS.minRate, lambdaCeiling: learning.FIT_LIMITS.maxRate };
  return seal({ version: learning.PARAMETER_VERSION, codeVersion: learning.CODE_VERSION,
    status: 'shadow-candidate', shadowOnly: true, formalEligible: false, productionEligible: false,
    createdAt: CREATED, availableAt: AVAILABLE, trainedThrough: '2026-09-02T14:01:00.000Z',
    featureSchema: team.FEATURE_SCHEMA, featureSchemaHash: team.FEATURE_SCHEMA_HASH, featureNames: names,
    model, parametersHash: stableHash(model),
    training: { split: 'time-ordered', sampleCount: 8,
      trainingEventIds: inputs.map((_, i) => `synthetic-event-${i}`),
      trainingSourceMatchIds: inputs.map((_, i) => `synthetic-match-${i}`),
      inputHashes: inputs, artifactHash: stableHash(inputs), knowledgeThrough: '2026-09-02T14:01:00.000Z',
      codeVersion: learning.CODE_VERSION, trainingMatchDays: ['2026-09-01', '2026-09-02'] },
    evaluationPlan: { mode: 'retrospective-shadow-replay', calibrated: false,
      trainDays: ['2026-09-01', '2026-09-02'], calibrationDays: [], testDays: ['2026-09-03'] },
    registration: { status: 'not-registered', allowedAutomaticState: 'REGISTERED_SHADOW',
      registryVersion: REGISTRY_VERSION, prospectiveGateRequired: true, promotionThresholds: DEFAULT_THRESHOLDS },
    comparators: learning.COMPARATORS });
}
function row(namespace, payload, overrides = {}) {
  const json = JSON.stringify(payload);
  return { artifact_key: registry.KEYS[namespace],
    artifact_version: namespace === 'baseline' ? strength.DYNAMIC_GOAL_STRENGTH_MODEL_VERSION : learning.PARAMETER_VERSION,
    generated_at: new Date(CREATED), updated_at: new Date(AVAILABLE),
    payload_json: json, payload_sha256: hash(json), payload_bytes: Buffer.byteLength(json), ...overrides };
}
function fakePool(rows = {}, fail = {}) {
  const calls = []; let released = 0, ended = 0, connected = 0;
  const client = { async query(sql, args) {
    calls.push({ sql, args });
    if (fail[sql] || (args && fail[args[0]])) throw new Error(fail[sql] || fail[args[0]]);
    if (/^SELECT /.test(sql)) return { rows: rows[args[0]] ? [rows[args[0]]] : [] };
    return { rows: [] };
  }, release() { released++; } };
  return { calls, get released() { return released; }, get ended() { return ended; }, get connected() { return connected; },
    async connect() { connected++; if (fail.connect) throw new Error(fail.connect); return client; },
    async end() { ended++; } };
}
function inputs() { return { [registry.KEYS.baseline]: row('baseline', baseline()),
  [registry.KEYS.parameters]: row('parameters', parameters()) }; }
function onlinePacket(namespace, payload, overrides = {}) {
  const stored = row(namespace, payload);
  return { artifactKey: stored.artifact_key, artifactVersion: stored.artifact_version,
    generatedAt: stored.generated_at.toISOString(), updatedAt: stored.updated_at.toISOString(),
    payloadJson: stored.payload_json, payloadSha256: stored.payload_sha256,
    payloadBytes: stored.payload_bytes, oversized: false, ...overrides };
}
function onlineInput(packets = []) {
  return { version: onlineReader.VERSION, businessDate: '2026-10-06', observedAt: '2026-10-06T09:59:59.999999999Z',
    readOnly: 'on', productionWrites: 0, generation: { data_generation_id: 'synthetic-online-model-snapshot', manifest_hash: 'a'.repeat(64) },
    matches: [], modelArtifactInventory: [], modelArtifacts: packets };
}
async function load(rows = inputs(), options = {}, fail = {}) {
  const pool = fakePool(rows, fail); return { pool, result: await registry.loadPrematchV3ModelRegistry({ asOf: AS_OF, pool, ...options }) };
}

test('reads exactly two fixed PG keys in a bounded repeatable read read-only transaction', async () => {
  assert.equal(learning.verifyPrematchV3ParameterArtifact(parameters()).valid, true);
  const old = process.env.PRIVATE_MODEL_ARTIFACT_STORAGE; process.env.PRIVATE_MODEL_ARTIFACT_STORAGE = 'sqlite';
  try {
    const { pool, result } = await load();
    assert.equal(result.status, 'shadow-ready', JSON.stringify(result.blockers));
    assert.equal(result.productionEligible, false); assert.equal(result.formalEligible, false); assert.equal(result.shadowOnly, true);
    assert.equal(result.baseline.createdAt, CREATED); assert.equal(result.baseline.availableAt, AVAILABLE);
    assert.equal(result.parameters.contentHash, parameters().contentHash);
    const selects = pool.calls.filter(call => /^SELECT /.test(call.sql));
    assert.deepEqual(selects.map(call => call.args), [[registry.KEYS.baseline], [registry.KEYS.parameters]]);
    assert.ok(selects.every(call => /FROM football\.private_model_artifacts WHERE artifact_key = \$1$/.test(call.sql)));
    assert.equal(pool.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(pool.calls[1].sql, 'SET LOCAL statement_timeout = 5000');
    assert.equal(pool.calls[2].sql, 'SET LOCAL lock_timeout = 1000');
    assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(pool.released, 1); assert.equal(pool.ended, 0); assert.equal(pool.connected, 1);
    assert.ok(pool.calls.every(call => !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT)\b/i.test(call.sql)));
    assert.deepEqual(result.receipts.map(receipt => receipt.status), ['shadow-readable', 'shadow-readable']);
    assert.equal(result.receipts[0].payloadSha256, inputs()[registry.KEYS.baseline].payload_sha256);
    assert.equal(result.receipts[0].metadataClockPrecision.originalClockBytesPreserved, false);
  } finally { if (old === undefined) delete process.env.PRIVATE_MODEL_ARTIFACT_STORAGE; else process.env.PRIVATE_MODEL_ARTIFACT_STORAGE = old; }
});

test('missing fixed key stays missing and leaves the other namespace usable without fallback', async () => {
  const first = await load({ [registry.KEYS.baseline]: row('baseline', baseline()) });
  assert.equal(first.result.status, 'partial'); assert.ok(first.result.baseline); assert.equal(first.result.parameters, null);
  assert.deepEqual(first.result.blockers, ['parameters:missing']);
  assert.equal(first.pool.calls.filter(call => /^SELECT /.test(call.sql)).length, 2);
  const empty = await load({}); assert.equal(empty.result.status, 'missing');
  assert.deepEqual(empty.result.blockers, ['baseline:missing', 'parameters:missing']);
  assert.equal(empty.pool.calls.length, 6);
});

test('raw hash and byte failures are visible, sanitized and isolated from the other namespace', async () => {
  for (const [changes, blocker] of [[{ payload_sha256: '0'.repeat(64) }, 'storage-payload-hash-invalid'],
    [{ payload_bytes: 1 }, 'storage-payload-size-invalid'], [{ artifact_version: 12 }, 'storage-artifact-version-invalid']]) {
    const rows = inputs(); Object.assign(rows[registry.KEYS.baseline], changes);
    const { result } = await load(rows); assert.equal(result.status, 'partial');
    assert.equal(result.baseline, null); assert.ok(result.parameters);
    assert.deepEqual(result.blockers, [`baseline:${blocker}`]);
  }
  const { result } = await load(inputs(), {}, { [registry.KEYS.parameters]: 'password=synthetic-secret postgres://sensitive detail' });
  assert.equal(result.status, 'partial'); assert.ok(result.baseline); assert.equal(result.parameters, null);
  assert.deepEqual(result.blockers, ['parameters:storage-read-failed']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|sensitive detail/);
});

test('future or equal payload clocks are blocked without replacing them with database metadata', async () => {
  for (const stamp of [AS_OF, '2026-10-06T10:00:00.000000001Z', '2026-10-06T10:00:01Z']) {
    const packet = baseline(); packet.availableAt = stamp;
    const param = seal({ ...parameters(), availableAt: stamp });
    const { result } = await load({ [registry.KEYS.baseline]: row('baseline', packet), [registry.KEYS.parameters]: row('parameters', param) });
    assert.equal(result.status, 'blocked'); assert.equal(result.baseline, null); assert.equal(result.parameters, null);
    assert.ok(result.blockers.includes('baseline:payload-not-available-before-as-of'));
    assert.ok(result.blockers.includes('parameters:payload-not-available-before-as-of'));
  }
  const packet = baseline(); delete packet.createdAt;
  const { result } = await load({ [registry.KEYS.baseline]: row('baseline', packet) });
  assert.ok(result.blockers.includes('baseline:payload-clock-invalid')); assert.equal(result.baseline, null);
});

test('actual PG generation and persistence clocks bind availability including decoder precision', async () => {
  for (const key of ['generated_at', 'updated_at']) {
    const rows = inputs(); rows[registry.KEYS.baseline][key] = new Date(AS_OF);
    const { result } = await load(rows); assert.equal(result.baseline, null);
    assert.ok(result.blockers.some(code => /baseline:storage-(?:not-available-before-as-of|clock-invalid)/.test(code)));
  }
  const sameMs = await load(inputs(), { asOf: '2026-09-15T10:00:01.000000001Z' });
  assert.equal(sameMs.result.baseline, null); assert.equal(sameMs.result.parameters, null);
  assert.ok(sameMs.result.blockers.includes('baseline:storage-not-available-before-as-of'));
  const nextMs = await load(inputs(), { asOf: '2026-09-15T10:00:01.001Z' });
  assert.equal(nextMs.result.status, 'shadow-ready', JSON.stringify(nextMs.result.blockers));
  const rows = inputs(); rows[registry.KEYS.parameters].updated_at = new Date(CREATED);
  const { result } = await load(rows); assert.equal(result.parameters, null);
  assert.ok(result.blockers.includes('parameters:payload-and-storage-clock-conflict'));
});

test('rejects old market-lambda payloads, forged booleans, fitted hash changes and schema substitution', async () => {
  const old = { ...baseline(), artifact: { version: 'old-market-model', baseRates: { home: 2, away: 1 }, verified: true } };
  const oldResult = await load({ [registry.KEYS.baseline]: row('baseline', old) });
  assert.equal(oldResult.result.baseline, null); assert.ok(oldResult.result.blockers.includes('baseline:baseline-schema-or-hash-invalid'));
  for (const param of [
    seal({ ...parameters(), formalEligible: true, verified: true }),
    seal({ ...parameters(), productionEligible: true }),
    seal({ ...parameters(), featureSchema: { version: 'fake', features: [FEATURE] }, featureSchemaHash: stableHash({ version: 'fake', features: [FEATURE] }) }),
    { ...parameters(), model: { ...parameters().model, intercept: { home: 0.02, away: -0.01 } } },
    seal({ ...parameters(), trainedThrough: '2026-09-16T10:00:00Z' }),
  ]) {
    const { result } = await load({ [registry.KEYS.parameters]: row('parameters', param) });
    assert.equal(result.parameters, null); assert.equal(result.status, 'blocked');
    assert.ok(result.blockers.some(code => code.startsWith('parameters:')));
  }
});

test('baseline ablation and ambiguous legacy training clocks cannot become a ready input', async () => {
  const packet = structuredClone(baseline());
  packet.artifact.model.config.researchAblation = 'without-venue';
  packet.artifact.model.configHash = stableHash(packet.artifact.model.config);
  const { modelHash, ...modelBody } = packet.artifact.model; packet.artifact.model.modelHash = stableHash(modelBody);
  const { artifactHash, ...artifactBody } = packet.artifact; packet.artifact.artifactHash = stableHash(artifactBody);
  const ablation = await load({ [registry.KEYS.baseline]: row('baseline', packet) });
  assert.equal(ablation.result.baseline, null); assert.ok(ablation.result.blockers.includes('baseline:baseline-config-invalid-or-ablation'));
  const precise = baseline(); const last = precise.artifact.featureArtifact.watermark.maxConsumedAvailableAt;
  precise.createdAt = precise.availableAt = last;
  const overlap = await load({ [registry.KEYS.baseline]: row('baseline', precise,
    { generated_at: new Date(last), updated_at: new Date(last) }) });
  assert.equal(overlap.result.baseline, null);
  assert.ok(overlap.result.blockers.includes('baseline:baseline-training-clock-precision-overlap'));
});

test('clock notation preserves original bytes and exact nanosecond boundary on signed payload', async () => {
  const packet = baseline(); packet.createdAt = '2026-09-15T18:00:00+08:00';
  packet.availableAt = '2026-09-15T18:00:00.999999999+08:00';
  const { result } = await load({ [registry.KEYS.baseline]: row('baseline', packet) });
  assert.ok(result.baseline, JSON.stringify(result.blockers));
  assert.equal(result.baseline.createdAt, packet.createdAt); assert.equal(result.baseline.availableAt, packet.availableAt);
  const future = await load({ [registry.KEYS.baseline]: row('baseline', packet) }, { asOf: packet.availableAt });
  assert.equal(future.result.baseline, null);
});

test('bad as-of never connects; transaction failures are sanitized and always clean up', async () => {
  for (const asOf of [undefined, null, '2026-10-06T10:00:00', '2026-02-30T00:00:00Z']) {
    const { pool, result } = await load(inputs(), { asOf });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.blockers, ['registry-as-of-invalid']); assert.equal(pool.connected, 0);
  }
  for (const fail of [ { connect: 'password=synthetic-secret' },
    { 'SET LOCAL statement_timeout = 5000': 'postgres://synthetic-secret' },
    { ROLLBACK: 'synthetic-secret' } ]) {
    const { pool, result } = await load(inputs(), {}, fail);
    assert.equal(result.status, 'blocked'); assert.equal(result.baseline, null); assert.equal(result.parameters, null);
    assert.ok(result.blockers.some(code => code.startsWith('registry:')));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
    if (!fail.connect) { assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.equal(pool.released, 1); }
    assert.ok(pool.calls.filter(call => /^SELECT /.test(call.sql)).length <= 2);
  }
});

test('independent stored verifier checks raw payload binding and refuses namespace substitution', () => {
  const stored = verifyRow(row('baseline', baseline()), registry.KEYS.baseline);
  assert.equal(registry.validateStoredPrematchV3Artifact(stored, 'baseline', AS_OF).valid, true);
  assert.equal(registry.validateStoredPrematchV3Artifact(stored, 'parameters', AS_OF).valid, false);
  assert.equal(registry.validateStoredPrematchV3Artifact(stored, '__proto__', AS_OF).valid, false);
  assert.equal(registry.validateStoredPrematchV3Artifact({ ...stored, payload: { ...stored.payload, createdAt: '2025-01-01T00:00:00Z' } }, 'baseline', AS_OF).valid, false);
});

test('pure online registry consumes both fixed raw packets and preserves precise PG clocks without reads', () => {
  const base = baseline(), param = parameters(), packets = [onlinePacket('baseline', base,
    { generatedAt: '2026-09-15T10:00:00.000001Z', updatedAt: '2026-09-15T10:00:01.000002Z' }), onlinePacket('parameters', param)];
  const input = onlineInput(packets), before = JSON.stringify(input);
  const result = registry.readPrematchV3RegistryFromOnlineInput(input, { asOf: AS_OF });
  assert.equal(result.status, 'shadow-ready', JSON.stringify(result.blockers));
  assert.deepEqual(result.baseline, base); assert.deepEqual(result.parameters, param);
  assert.equal(result.formalEligible, false); assert.equal(result.productionEligible, false);
  assert.equal(result.receipts[0].generatedAt, packets[0].generatedAt); assert.equal(result.receipts[0].updatedAt, packets[0].updatedAt);
  assert.equal(result.receipts[0].metadataClockPrecision.originalClockBytesPreserved, true);
  assert.equal(result.baseline.availableAt, AVAILABLE, 'PG metadata never refreshes signed payload availability');
  assert.equal(JSON.stringify(input), before);
});

test('pure online registry reports missing keys and oversized payloads without inventing or loading artifacts', () => {
  const missing = registry.readPrematchV3RegistryFromOnlineInput(onlineInput(), { asOf: AS_OF });
  assert.equal(missing.status, 'missing'); assert.deepEqual(missing.blockers, ['baseline:missing', 'parameters:missing']);
  const packet = onlinePacket('baseline', baseline(), { oversized: true, payloadJson: null,
    payloadBytes: onlineReader.MAX_MODEL_ARTIFACT_BYTES + 1 });
  const input = onlineInput([packet, onlinePacket('parameters', parameters())]);
  const result = registry.readPrematchV3RegistryFromOnlineInput(input, { asOf: AS_OF });
  assert.equal(result.status, 'partial'); assert.equal(result.baseline, null); assert.ok(result.parameters);
  assert.deepEqual(result.blockers, ['baseline:storage-payload-oversized']);
});

test('pure online registry rejects duplicate, foreign, bad hash, malformed JSON and future actual availability', () => {
  const packet = onlinePacket('baseline', baseline());
  for (const packets of [[packet, packet], [{ ...packet, artifactKey: 'legacy-market-lambda' }],
    [{ ...packet, payloadSha256: '0'.repeat(64) }]]) {
    const result = registry.readPrematchV3RegistryFromOnlineInput(onlineInput(packets), { asOf: AS_OF });
    assert.equal(result.status, 'blocked'); assert.equal(result.baseline, null);
    assert.deepEqual(result.blockers, ['registry:online-input-contract-invalid']);
  }
  const malformed = '{synthetic-private-marker';
  const badJson = registry.readPrematchV3RegistryFromOnlineInput(onlineInput([{ ...packet, payloadJson: malformed,
    payloadSha256: hash(malformed), payloadBytes: Buffer.byteLength(malformed) }]), { asOf: AS_OF });
  assert.ok(badJson.blockers.includes('baseline:storage-payload-json-invalid'));
  assert.doesNotMatch(JSON.stringify(badJson), /synthetic-private-marker/);
  const future = registry.readPrematchV3RegistryFromOnlineInput(onlineInput([{ ...packet, updatedAt: '2026-10-06T10:00:00.000000001Z' }]), { asOf: AS_OF });
  assert.equal(future.baseline, null); assert.ok(future.blockers.includes('baseline:storage-not-available-before-as-of'));
  const beforeObserve = registry.readPrematchV3RegistryFromOnlineInput(onlineInput([packet]), { asOf: '2026-10-06T09:59:59.999999998Z' });
  assert.deepEqual(beforeObserve.blockers, ['registry:online-read-as-of-invalid']);
});
