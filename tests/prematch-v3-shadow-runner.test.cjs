'use strict';

// Literal synthetic facts and actual fitting exercise the offline CLI contract.
// These fixtures are not source admission, measured accuracy or deployment evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { stableHash } = require('../src/services/webConsensusEvidence.cjs');
const { predictionRecordHash } = require('../src/services/prematchV3Learning.cjs');
const reader = require('../scripts/readPrematchV3OnlineInputs.cjs');
const runner = require('../scripts/runPrematchV3Shadow.cjs');
const synthetic = require('./fixtures/prematch-v3-synthetic.cjs');
const repo = path.resolve(__dirname, '..'), cli = path.join(repo, 'scripts/runPrematchV3Shadow.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const at = milliseconds => new Date(milliseconds).toISOString();

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prematch-v3-shadow-cli-'));
  t.after(() => {
    const resolved = path.resolve(directory), allowed = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(allowed));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, input: path.join(directory, 'synthetic-online-read.json'),
    raw: path.join(directory, 'synthetic.remote-response.json'), output: path.join(directory, 'new-shadow-report.json') };
}
function packet(artifactKey, payload, artifactVersion) {
  const payloadJson = JSON.stringify(payload);
  return { artifactKey, artifactVersion, generatedAt: payload.createdAt, updatedAt: payload.availableAt,
    payloadJson, payloadSha256: hash(payloadJson), payloadBytes: Buffer.byteLength(payloadJson), oversized: false };
}
function payload() {
  const now = Date.now(), match = clone(synthetic.match), date = at(now + 8 * 3600000).slice(0, 10);
  match.businessDate = date; match.kickoffTime = match.eventVersion = at(now + 6 * 3600000);
  match.predictionMeta.cutoffTime = at(now + 4 * 3600000);
  match.oddsObservedAt = at(now - 180000); match.oddsReceivedAt = at(now - 120000);
  for (const row of match.externalSignals.prematchV3.teamObservations) {
    row.eventVersion = match.eventVersion;
    row.providerObservedAt = at(now - 600000); row.receivedAt = at(now - 540000);
  }
  for (const [index, row] of match.externalSignals.prematchV3.asianHandicapObservations.entries()) {
    row.eventVersion = match.eventVersion;
    row.providerObservedAt = at(now - (index % 2 ? 3600000 : 7200000));
    row.receivedAt = at(Date.parse(row.providerObservedAt) + 60000);
  }
  const modelArtifacts = [packet('prematch-v3-baseline', clone(synthetic.baseline), synthetic.baseline.artifact.version),
    packet('prematch-v3-parameters', clone(synthetic.parameters), synthetic.parameters.version)];
  return { version: reader.VERSION, readOnly: 'on', productionWrites: 0, businessDate: date,
    observedAt: at(now - 2000), generation: { data_generation_id: 'synthetic-shadow-generation',
      manifest_hash: 'a'.repeat(64), committed_at: at(now - 3000) }, matches: [match], modelArtifacts,
    modelArtifactInventory: modelArtifacts.map(row => ({ key: row.artifactKey, version: row.artifactVersion,
      generatedAt: row.generatedAt, sha256: row.payloadSha256, bytes: row.payloadBytes })) };
}
function writeOnline(files, value = payload()) {
  const raw = Buffer.from(JSON.stringify(value));
  const transport = { hostKeyPinVerified: true, hostKeyFingerprint: `SHA256:${'a'.repeat(43)}`,
    startedAt: at(Date.parse(value.observedAt) - 500), finishedAt: at(Date.parse(value.observedAt) + 500),
    remoteResponseSha256: hash(raw), remoteResponseFile: path.basename(files.raw), bytes: raw.length };
  Object.assign(transport, reader.validateTransport(transport, value.observedAt));
  fs.writeFileSync(files.raw, raw); fs.writeFileSync(files.input, JSON.stringify({ ...value, transport }, null, 2));
  return value;
}
function execute(files, extra = [], output = files.output) {
  return cp.spawnSync(process.execPath, [cli, '--input', files.input, '--output', output, ...extra],
    { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}
function success(files) {
  const result = execute(files);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined);
  return { result, report: JSON.parse(fs.readFileSync(files.output, 'utf8')) };
}

test('child CLI consumes both fixed-key packets and actually produces a sourced team candidate plus a new frozen record', t => {
  const files = sandbox(t), value = writeOnline(files), inputBefore = fs.readFileSync(files.input), rawBefore = fs.readFileSync(files.raw);
  const started = Date.now(), { result, report } = success(files), finished = Date.now();
  assert.equal(report.summary.modelRegistryReadStatus, 'shadow-ready'); assert.equal(report.summary.zeroMarketBaselines, 1);
  assert.equal(report.summary.calculatedTeamCandidates, 1); assert.equal(report.summary.newFrozenLearningRecords, 1);
  assert.equal(report.summary.formalRecommendations, 0); assert.equal(report.formalEligible, false); assert.equal(report.productionEligible, false);
  assert.equal(report.learning.status, 'not-trained-on-this-read'); assert.equal(report.learning.accuracyMeasured, false);
  assert.equal(report.learning.hitRate, null); assert.equal(report.invariants.productionWrites, 0);
  assert.ok(Date.parse(report.calculatedAt) >= started && Date.parse(report.calculatedAt) <= finished);
  assert.equal(report.implementation.nodeVersion, process.version);
  for (const file of runner.IMPLEMENTATION_FILES) assert.equal(report.implementation.files[file], hash(fs.readFileSync(path.join(repo, file))));
  const { contentHash, ...body } = report;
  assert.equal(contentHash, stableHash(body)); assert.equal(JSON.parse(result.stdout).contentHash, contentHash);
  const row = report.rows[0], frozen = row.frozenLearningRecord;
  assert.equal(row.assessment.effects.receipt.parameterHash, synthetic.parameters.contentHash);
  assert.equal(row.assessment.sourceVerification, 'unverified'); assert.equal(row.assessment.comparisons.marketOnly.available, true);
  assert.ok(row.assessment.comparisons.teamOnly); assert.ok(row.assessment.comparisons.hybrid);
  assert.equal(frozen.result, null); assert.equal(frozen.asOf, report.calculatedAt); assert.equal(frozen.frozen, true);
  assert.equal(frozen.event.eventVersion, value.matches[0].eventVersion); assert.equal(frozen.predictionHash, predictionRecordHash(frozen));
  assert.equal(frozen.baseRatesEvidence.marketIncluded, false); assert.deepEqual(frozen.baseRates, row.assessment.baseline.baseRates);
  assert.deepEqual(fs.readFileSync(files.input), inputBefore); assert.deepEqual(fs.readFileSync(files.raw), rawBefore);
  assert.deepEqual(fs.readdirSync(files.directory).sort(), [path.basename(files.input), path.basename(files.raw), path.basename(files.output)].sort());
});

test('missing parameters can bootstrap a base-feature freeze, but source JSON cannot fill a missing fixed-key namespace', t => {
  const files = sandbox(t), value = payload(); value.modelArtifacts = value.modelArtifacts.filter(row => row.artifactKey.endsWith('baseline'));
  value.matches[0].externalSignals.prematchV3.parameters = clone(synthetic.parameters);
  writeOnline(files, value); const { report } = success(files);
  assert.equal(report.summary.modelRegistryReadStatus, 'partial'); assert.equal(report.summary.zeroMarketBaselines, 1);
  assert.equal(report.summary.calculatedTeamCandidates, 0); assert.equal(report.summary.newFrozenLearningRecords, 1);
  assert.equal(report.rows[0].assessment.comparisons.teamOnly, null); assert.equal(report.rows[0].assessment.comparisons.hybrid, null);
  assert.ok(report.rows[0].assessment.parameterCheck.reasons.includes('trained-parameters-missing'));
});

test('a recomputed storage/outer seal cannot bypass the fitted parameter inner hash', t => {
  const files = sandbox(t), value = payload(), artifact = clone(synthetic.parameters);
  const feature = artifact.featureNames[0]; artifact.model.coefficients.home[feature] += .001;
  const { contentHash, ...body } = artifact; artifact.contentHash = stableHash(body);
  value.modelArtifacts[1] = packet('prematch-v3-parameters', artifact, artifact.version);
  writeOnline(files, value); const { report } = success(files);
  assert.equal(report.summary.modelRegistryReadStatus, 'partial'); assert.equal(report.summary.calculatedTeamCandidates, 0);
  assert.equal(report.summary.newFrozenLearningRecords, 1); assert.equal(report.rows[0].assessment.comparisons.teamOnly, null);
  assert.ok(report.rows[0].assessment.modelRegistry.blockers.includes('parameters:parameters-hash-mismatch'));
});

test('missing model packets and passed sale cutoffs never mint candidate probabilities or a learning record', t => {
  for (const mutate of [value => { value.modelArtifacts = []; },
    value => { value.matches[0].predictionMeta.cutoffTime = at(Date.now() - 60000); }]) {
    const files = sandbox(t), value = payload(); mutate(value); writeOnline(files, value);
    const { report } = success(files);
    assert.equal(report.summary.calculatedTeamCandidates, 0); assert.equal(report.summary.newFrozenLearningRecords, 0);
    assert.equal(report.rows[0].assessment.comparisons.teamOnly, null); assert.equal(report.rows[0].assessment.comparisons.hybrid, null);
    assert.equal(report.rows[0].frozenLearningRecord, null); assert.equal(report.formalEligible, false);
  }
});

test('append-only CLI output preserves existing reports and input bytes', t => {
  const files = sandbox(t); writeOnline(files); const inputBefore = fs.readFileSync(files.input);
  fs.writeFileSync(files.output, 'synthetic-existing-report\n');
  const existing = execute(files); assert.notEqual(existing.status, 0); assert.match(existing.stderr, /NEW_OUTPUT_REQUIRED/);
  assert.equal(fs.readFileSync(files.output, 'utf8'), 'synthetic-existing-report\n');
  const sameInput = execute(files, [], files.input); assert.notEqual(sameInput.status, 0);
  assert.deepEqual(fs.readFileSync(files.input), inputBefore);
});

test('changed raw response or injected companion paths fail before creating a report', t => {
  for (const mutate of [files => { fs.appendFileSync(files.raw, '\nsynthetic-tamper'); }, files => {
    const receipt = JSON.parse(fs.readFileSync(files.input, 'utf8')); receipt.transport.remoteResponseFile = '../outside.json';
    fs.writeFileSync(files.input, JSON.stringify(receipt));
  }]) {
    const files = sandbox(t); writeOnline(files); mutate(files); const result = execute(files);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /ONLINE_READ_BINDING|RAW_INPUT_BOUND/);
    assert.equal(fs.existsSync(files.output), false);
  }
});

test('future online clocks, caller --as-of and legacy reads cannot backdate a calculation', t => {
  const futureFiles = sandbox(t), future = payload(); future.observedAt = at(Date.now() + 86400000);
  writeOnline(futureFiles, future); const futureResult = execute(futureFiles);
  assert.notEqual(futureResult.status, 0); assert.match(futureResult.stderr, /CALCULATION_CLOCK/); assert.equal(fs.existsSync(futureFiles.output), false);
  const files = sandbox(t); writeOnline(files);
  for (const clock of ['2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
    const result = execute(files, ['--as-of', clock]); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /V3_SHADOW_ARGS/); assert.equal(fs.existsSync(files.output), false);
  }
  const legacy = payload(); legacy.version = 'prematch-v3-online-readonly-v1'; delete legacy.modelArtifacts;
  writeOnline(files, legacy); const old = execute(files); assert.notEqual(old.status, 0);
  assert.match(old.stderr, /ONLINE_READ_BINDING/); assert.equal(fs.existsSync(files.output), false);
});
