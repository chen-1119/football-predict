'use strict';
// Synthetic integration fixtures; never real accuracy or production admission.
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/prematch-v3-synthetic.cjs');
const feedback = require('../src/services/prematchV3FeedbackLoop.cjs');
const { stableHash: hash } = require('../src/services/webConsensusEvidence.cjs');
const packet = () => feedback.buildValidatedParameterPacket({ artifact: fixture.parameters,
  records: fixture.learningRecords, asOf: '2026-09-15T11:00:00Z' });
const reseal = value => { const { contentHash, ...body } = value; return { ...body, contentHash: hash(body) }; };
test('held-out probabilities and metrics replay before a parameter packet can load', () => {
  const p = packet(), verified = feedback.verifyValidatedParameterPacket(p, fixture.asOf);
  assert.equal(verified.valid, true, JSON.stringify(verified.blockers));
  assert.equal(verified.receipt.heldOutRows, 8);
  assert.equal(verified.receipt.parameterArtifactHash, fixture.parameters.contentHash);
  assert.deepEqual(p.validation.metrics, fixture.learned.validation.metrics);
  assert.equal(verified.receipt.formalEligible, false);
});
test('rehashed false validation metrics are rejected by arithmetic replay', () => {
  const p = packet(); p.validation.metrics.candidate.brier = 0;
  assert.equal(feedback.verifyValidatedParameterPacket(reseal(p), fixture.asOf).valid, false);
});
test('training rows cannot be substituted for the held-out rows', () => {
  const p = packet(); p.heldOutRecords = fixture.learningRecords.slice(0, 8);
  assert.equal(feedback.verifyValidatedParameterPacket(reseal(p), fixture.asOf).valid, false);
});
test('zero effects do not pass a strict improvement gate', () => {
  const p = structuredClone(fixture.parameters);
  for (const side of ['home', 'away']) {
    p.model.intercept[side] = 0;
    for (const name of Object.keys(p.model.coefficients[side])) p.model.coefficients[side][name] = 0;
  }
  p.parametersHash = hash(p.model);
  assert.throws(() => feedback.buildValidatedParameterPacket({ artifact: reseal(p), records: fixture.learningRecords,
    asOf: '2026-09-15T11:00:00Z' }), /HOLDOUT_NOT_IMPROVED/);
});
test('packet unavailable at the decision clock fails closed', () => {
  const p = packet(); assert.equal(feedback.verifyValidatedParameterPacket(p, p.availableAt).valid, false);
});
function memoryPool(failure = null) {
  const rows = new Map(), calls = []; let backup;
  const query = async (sql, args = []) => {
    calls.push(sql);
    if (sql.startsWith('BEGIN')) backup = structuredClone(rows);
    if (sql === 'ROLLBACK') { rows.clear(); for (const [key, row] of backup) rows.set(key, row); }
    if (failure === 'commit' && sql === 'COMMIT') throw Error('synthetic-connection-lost');
    if (failure === 'parameter-write' && sql.startsWith('INSERT INTO') && args[0] === 'prematch-v3-parameters') throw Error('synthetic-write-failed');
    if (sql.startsWith('SELECT clock_timestamp')) return { rows: [{ now: new Date() }] };
    if (sql.includes('SELECT artifact_key')) return { rows: rows.has(args[0]) ? [structuredClone(rows.get(args[0]))] : [] };
    if (sql.startsWith('INSERT INTO')) rows.set(args[0], { artifact_key: args[0], artifact_version: args[1],
      generated_at: new Date(args[2]), updated_at: new Date(args[3]), payload_json: args[4],
      payload_sha256: args[5], payload_bytes: args[6] });
    return { rows: [] };
  };
  return { query, rows, calls, async connect() { return { query, release() {} }; } };
}
test('registration commits, separate readback succeeds, then the real loader and future assessment use that exact artifact', async () => {
  const registry = require('../src/services/prematchV3ModelRegistry.cjs');
  const { installValidatedPacket } = require('../scripts/registerPrematchV3Parameters.cjs');
  const pool = memoryPool(), original = JSON.stringify(fixture.match), p = packet();
  const stored = await installValidatedPacket({ packet: p, baseline: fixture.trainingBaseline,
    expectedPreviousSha256: null, expectedBaselineSha256: null, pool });
  assert.equal(stored.readbackVerified, true); assert.equal(stored.recommendationAdoptionConfirmed, false);
  // A real later knowledge clock is required; advance the synthetic match too.
  const futureDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const asOf = `${futureDay}T10:00:00Z`;
  const loaded = await registry.loadPrematchV3ModelRegistry({ pool, asOf });
  assert.equal(loaded.parameters.contentHash, fixture.parameters.contentHash);
  assert.equal(loaded.parameterValidation.packetHash, p.contentHash);
  assert.ok(pool.calls.slice(pool.calls.indexOf('COMMIT') + 1).some(sql => sql.includes('SELECT artifact_key')));
  const futureMatch = JSON.parse(JSON.stringify(fixture.match).replaceAll('2026-10-06', futureDay));
  const assessment = fixture.build(futureMatch, { ...fixture.options, asOf,
    modelRegistry: { storage: 'postgres', asOf, parameterValidation: loaded.parameterValidation } });
  assert.equal(assessment.parameterAdoption.status, 'applied');
  assert.equal(assessment.parameterAdoption.parameterArtifactHash, p.parameterArtifactHash);
  assert.equal(assessment.parameterAdoption.outputProbabilityHash, hash(assessment.comparisons.teamOnly.probabilities));
  assert.notDeepEqual(assessment.effects.before, assessment.effects.after);
  assert.equal(JSON.stringify(fixture.match), original);
  assert.equal(assessment.formalEligible, false);
});
test('concurrent model change aborts without consuming or replacing the prior artifact', async () => {
  const { installValidatedPacket } = require('../scripts/registerPrematchV3Parameters.cjs');
  const pool = memoryPool(), p = packet();
  await installValidatedPacket({ packet: p, baseline: fixture.trainingBaseline,
    expectedPreviousSha256: null, expectedBaselineSha256: null, pool });
  const before = JSON.stringify([...pool.rows]);
  await assert.rejects(installValidatedPacket({ packet: p, baseline: fixture.trainingBaseline,
    expectedPreviousSha256: null, expectedBaselineSha256: null, pool }), /CONCURRENT_CHANGE/);
  assert.equal(JSON.stringify([...pool.rows]), before);
});
test('unknown commit outcome is never reported as installed or blindly retried', async () => {
  const { installValidatedPacket } = require('../scripts/registerPrematchV3Parameters.cjs');
  await assert.rejects(installValidatedPacket({ packet: packet(), baseline: fixture.trainingBaseline,
    expectedPreviousSha256: null, expectedBaselineSha256: null,
    pool: memoryPool('commit') }), /COMMIT_OUTCOME_UNKNOWN_READ_BEFORE_RETRY/);
});
test('a parameter write failure rolls back the baseline and both histories too', async () => {
  const { installValidatedPacket } = require('../scripts/registerPrematchV3Parameters.cjs');
  const pool = memoryPool('parameter-write');
  await assert.rejects(installValidatedPacket({ packet: packet(), baseline: fixture.trainingBaseline,
    expectedPreviousSha256: null, expectedBaselineSha256: null, pool }), /synthetic-write-failed/);
  assert.equal(pool.rows.size, 0);
});
test('a different baseline invalidates later parameter adoption even with matching parameter hashes', () => {
  const validation = feedback.verifyValidatedParameterPacket(packet(), fixture.asOf).receipt;
  validation.baselineArtifactHashes = ['a'.repeat(64)];
  const assessment = fixture.build(fixture.match, { ...fixture.options,
    modelRegistry: { storage: 'postgres', asOf: fixture.asOf, parameterValidation: validation } });
  assert.equal(assessment.parameterAdoption.status, 'blocked');
  assert.equal(assessment.comparisons.teamOnly, null);
});
test('the natural runtime path blocks raw unvalidated parameters and mismatched validation', () => {
  for (const validation of [null, { parameterArtifactHash: 'a'.repeat(64), parametersHash: fixture.parameters.parametersHash,
    availableAt: '2026-09-16T00:00:00Z' }]) {
    const assessment = fixture.build(fixture.match, { ...fixture.options,
      modelRegistry: { storage: 'postgres', asOf: fixture.asOf, parameterValidation: validation } });
    assert.equal(assessment.parameterAdoption.status, 'blocked');
    assert.equal(assessment.comparisons.teamOnly, null);
    assert.ok(assessment.blockers.includes('trained-parameter-holdout-validation-missing'));
  }
});
test('training CLI generates a registrable packet and a changed coefficient fails deterministic fit replay', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-feedback-test-'));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true }); });
  const input = path.join(dir, 'request.json'), output = path.join(dir, 'report.json');
  fs.writeFileSync(input, JSON.stringify({ version: 'prematch-v3-learning-request-v1', researchOnly: true,
    records: fixture.learningRecords, featureNames: fixture.parameters.featureNames,
    split: { trainDays: fixture.learningDays.slice(0, 3), calibrationDays: fixture.learningDays.slice(3, 5), testDays: fixture.learningDays.slice(5) } }));
  const run = spawnSync(process.execPath, ['scripts/runPrematchV3Learning.cjs', '--input', input, '--output', output],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(fs.readFileSync(output)), bytes = fs.readFileSync(input);
  const { verifyTrainingRun } = require('../scripts/registerPrematchV3Parameters.cjs');
  assert.equal(verifyTrainingRun(bytes, report).parameterArtifactHash, report.learning.artifact.contentHash);
  const changed = structuredClone(report);
  changed.learning.artifact.model.intercept.home += .001;
  changed.learning.artifact.parametersHash = hash(changed.learning.artifact.model);
  changed.learning.artifact = reseal(changed.learning.artifact);
  assert.throws(() => verifyTrainingRun(bytes, reseal(changed)), /FIT_REPLAY/);
});
